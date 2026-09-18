const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createRemoteApi } = require("../server/remote-api.cjs");
const { createVxzApi } = require("../server/vxz-api.cjs");

const HOST = "127.0.0.1";
const remoteApi = createRemoteApi();

let mainWindow = null;
let appServer = null;
let appServerUrl = null;
let vxzApi = null;
let rendererReadyForFiles = false;
let vxzResolutionPreference = null;
let vxzPreferenceWrite = Promise.resolve();
const pendingVxzPaths = [];
const pendingVxzRequests = new Map();
const pendingFieldPaths = [];
const pendingFieldRequests = new Map();
const nativeFileRequests = new Map();
const FIELD_MANIFEST_NAMES = [
  "fields.json",
  "field_metadata.json",
  "npy_fields.json",
  "npy_labels.json",
];
let flushingFieldPaths = false;

app.setName("Voxel Mesh Viewer");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else if (process.platform === "win32") {
  queueOpenFileArguments(process.argv, process.cwd());
}

app.on("second-instance", (_event, commandLine, workingDirectory) => {
  queueOpenFileArguments(commandLine, workingDirectory);
  focusViewerWindow();
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  queueOpenFilePath(filePath);
  focusViewerWindow();
});

ipcMain.on("vxz:renderer-ready", (event) => {
  if (mainWindow && event.sender === mainWindow.webContents) {
    rendererReadyForFiles = true;
    void flushPendingVxzPaths();
    void flushPendingFieldPaths();
  }
});

ipcMain.on("field:open-file-complete", (event, requestId) => {
  assertViewerSender(event.sender);
  completeFieldOpenRequest(String(requestId ?? ""));
});

ipcMain.handle("vxz:open-file-open", async (event, payload) => {
  assertViewerSender(event.sender);
  const requestId = String(payload?.requestId ?? "");
  const filePath = pendingVxzRequests.get(requestId);
  if (!filePath) {
    throw new Error("VXZ open request is unknown or has already been used");
  }
  const resolution = payload?.resolution;
  validateVxzResolution(resolution);
  pendingVxzRequests.delete(requestId);
  return uploadLocalVxz(filePath, resolution);
});

ipcMain.handle("vxz:get-resolution", (event) => {
  assertViewerSender(event.sender);
  return vxzResolutionPreference;
});

ipcMain.handle("vxz:set-resolution", async (event, resolution) => {
  assertViewerSender(event.sender);
  validateVxzResolution(resolution);
  vxzResolutionPreference = resolution;
  await saveVxzPreferences();
});

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    try {
      setRuntimeAppIcon();
      await loadVxzPreferences();
      createWindow(await startAppServer());
    } catch (error) {
      await showStartupError(error);
      app.quit();
    }
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void startAppServer().then(createWindow).catch((error) => showStartupError(error));
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  vxzApi?.dispose();
  appServer?.close();
});

async function startAppServer() {
  if (appServerUrl) {
    return appServerUrl;
  }

  const distDir = path.join(app.getAppPath(), "dist");
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Missing built frontend at ${indexPath}. Run npm run build before packaging.`);
  }

  const vxzRuntimeRoot = app.isPackaged
    ? path.join(process.resourcesPath, "vxz-runtime")
    : app.getAppPath();
  vxzApi = createVxzApi({
    projectRoot: vxzRuntimeRoot,
    cacheRoot: path.join(app.getPath("cache"), "vxz"),
  });

  appServer = http.createServer((request, response) => {
    if (!request.url) {
      sendText(response, 400, "Missing URL");
      return;
    }

    const url = new URL(request.url, "http://viewer.local");
    if (url.pathname.startsWith("/api/vxz/")) {
      vxzApi.handle(request, response, url);
      return;
    }
    if (url.pathname.startsWith("/api/remote/")) {
      remoteApi.handle(request, response, url);
      return;
    }
    if (url.pathname === "/api/native-file") {
      handleNativeFile(request, response, url);
      return;
    }

    handleStaticFile(request, response, url, distDir, indexPath);
  });

  await listen(appServer, 0);
  const address = appServer.address();
  if (!address || typeof address !== "object") {
    throw new Error("Could not start internal app server.");
  }
  appServerUrl = `http://${HOST}:${address.port}/`;
  return appServerUrl;
}

function createWindow(url) {
  const icon = loadRuntimeAppIcon();
  rendererReadyForFiles = false;
  const windowOptions = {
    width: 1360,
    height: 800,
    minWidth: 1060,
    minHeight: 660,
    title: "Voxel Mesh Viewer",
    backgroundColor: "#eef2f7",
    icon,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(app.getAppPath(), "electron", "preload.cjs"),
    },
  };
  if (process.platform === "darwin") {
    windowOptions.titleBarStyle = "hiddenInset";
    windowOptions.trafficLightPosition = { x: 14, y: 14 };
  }
  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.on("closed", () => {
    for (const filePath of pendingVxzRequests.values()) {
      pendingVxzPaths.unshift(filePath);
    }
    pendingVxzRequests.clear();
    for (const request of pendingFieldRequests.values()) {
      pendingFieldPaths.unshift(request.primaryPath);
      for (const fileRequestId of request.fileRequestIds) {
        nativeFileRequests.delete(fileRequestId);
      }
    }
    pendingFieldRequests.clear();
    mainWindow = null;
    rendererReadyForFiles = false;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  const appUrl = new URL(url);
  appUrl.searchParams.set("electron", "1");
  appUrl.searchParams.set("platform", process.platform);
  appUrl.searchParams.set("apiBase", "/api/remote");
  mainWindow.loadURL(appUrl.toString());
}

function queueOpenFileArguments(commandLine, workingDirectory) {
  for (const argument of commandLine) {
    if (![".npy", ".vxz"].includes(path.extname(argument).toLowerCase())) {
      continue;
    }
    queueOpenFilePath(path.isAbsolute(argument) ? argument : path.resolve(workingDirectory, argument));
  }
}

function queueOpenFilePath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const resolvedPath = path.resolve(filePath);
  if (extension === ".vxz") {
    pendingVxzPaths.push(resolvedPath);
    if (app.isReady()) {
      flushPendingVxzPaths();
    }
  } else if (extension === ".npy") {
    pendingFieldPaths.push(resolvedPath);
    if (app.isReady()) {
      void flushPendingFieldPaths();
    }
  }
}

function focusViewerWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function flushPendingVxzPaths() {
  if (
    !rendererReadyForFiles
    || !mainWindow
    || mainWindow.isDestroyed()
  ) {
    return;
  }

  while (pendingVxzPaths.length > 0) {
    const filePath = pendingVxzPaths.shift();
    const requestId = crypto.randomUUID();
    pendingVxzRequests.set(requestId, filePath);
    mainWindow.webContents.send("vxz:open-file-request", {
      requestId,
      sourceName: path.basename(filePath),
    });
  }
}

async function flushPendingFieldPaths() {
  if (
    flushingFieldPaths
    || !rendererReadyForFiles
    || !mainWindow
    || mainWindow.isDestroyed()
  ) {
    return;
  }

  flushingFieldPaths = true;
  try {
    while (
      pendingFieldPaths.length > 0
      && rendererReadyForFiles
      && mainWindow
      && !mainWindow.isDestroyed()
    ) {
      const filePath = pendingFieldPaths.shift();
      try {
        const request = await createFieldOpenRequest(filePath);
        if (!mainWindow || mainWindow.isDestroyed()) {
          completeFieldOpenRequest(request.requestId);
          pendingFieldPaths.unshift(filePath);
          break;
        }
        mainWindow.webContents.send("field:open-file-request", request);
      } catch (error) {
        mainWindow.webContents.send("field:open-file-request", {
          requestId: crypto.randomUUID(),
          sourceName: path.basename(filePath),
          files: [],
          error: errorMessage(error),
        });
      }
    }
  } finally {
    flushingFieldPaths = false;
  }
}

async function createFieldOpenRequest(primaryPath) {
  const resolvedPrimaryPath = path.resolve(primaryPath);
  const primaryStat = await fs.promises.stat(resolvedPrimaryPath);
  if (!primaryStat.isFile() || primaryStat.size <= 0) {
    throw new Error("NumPy input must be a non-empty regular file");
  }

  const directoryPath = path.dirname(resolvedPrimaryPath);
  const inputFiles = [{ filePath: resolvedPrimaryPath, stat: primaryStat }];
  for (const manifestName of FIELD_MANIFEST_NAMES) {
    const manifestPath = path.join(directoryPath, manifestName);
    try {
      const stat = await fs.promises.stat(manifestPath);
      if (stat.isFile()) {
        inputFiles.push({ filePath: manifestPath, stat });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const fileRequestIds = [];
  const files = inputFiles.map(({ filePath, stat }) => {
    const fileRequestId = crypto.randomUUID();
    fileRequestIds.push(fileRequestId);
    nativeFileRequests.set(fileRequestId, { filePath, size: stat.size });
    return {
      requestId: fileRequestId,
      name: path.basename(filePath),
      size: stat.size,
    };
  });
  const requestId = crypto.randomUUID();
  pendingFieldRequests.set(requestId, {
    primaryPath: resolvedPrimaryPath,
    fileRequestIds,
  });
  return {
    requestId,
    sourceName: path.basename(resolvedPrimaryPath),
    files,
  };
}

function completeFieldOpenRequest(requestId) {
  const request = pendingFieldRequests.get(requestId);
  if (!request) {
    return;
  }
  pendingFieldRequests.delete(requestId);
  for (const fileRequestId of request.fileRequestIds) {
    nativeFileRequests.delete(fileRequestId);
  }
}

async function uploadLocalVxz(filePath, resolution) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024 * 1024) {
    throw new Error("VXZ file must be a regular file no larger than 2 GiB");
  }

  const uploadUrl = new URL("/api/vxz/open", appServerUrl);
  uploadUrl.searchParams.set("name", path.basename(filePath));
  if (resolution !== null) {
    uploadUrl.searchParams.set("resolution", String(resolution));
  }
  return new Promise((resolve, reject) => {
    const request = http.request(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
      },
    });
    const source = fs.createReadStream(filePath);
    const chunks = [];
    let responseBytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      source.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    request.on("response", (response) => {
      response.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > 1_000_000) {
          fail(new Error("VXZ backend response is too large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        const text = Buffer.concat(chunks).toString("utf8");
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(text || `VXZ backend returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`Could not parse VXZ backend response: ${errorMessage(error)}`));
        }
      });
      response.on("aborted", () => fail(new Error("VXZ backend response was aborted")));
      response.on("error", fail);
      response.on("close", () => {
        if (!response.complete) {
          fail(new Error("VXZ backend response closed before it completed"));
        }
      });
    });
    request.on("error", fail);
    source.on("error", (error) => {
      fail(error);
      request.destroy();
    });
    source.pipe(request);
  });
}

function assertViewerSender(sender) {
  if (!mainWindow || sender !== mainWindow.webContents) {
    throw new Error("VXZ request did not come from the viewer window");
  }
}

function validateVxzResolution(resolution) {
  if (resolution !== null && (!Number.isInteger(resolution) || resolution <= 0)) {
    throw new Error("VXZ resolution must be a positive integer or Auto");
  }
}

async function loadVxzPreferences() {
  try {
    const text = await fs.promises.readFile(vxzPreferencesPath(), "utf8");
    const parsed = JSON.parse(text);
    validateVxzResolution(parsed.resolution);
    vxzResolutionPreference = parsed.resolution;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Could not load VXZ preferences: ${errorMessage(error)}`);
    }
    vxzResolutionPreference = null;
  }
}

function saveVxzPreferences() {
  vxzPreferenceWrite = vxzPreferenceWrite.catch(() => undefined).then(async () => {
    const target = vxzPreferencesPath();
    const staged = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.promises.writeFile(
        staged,
        `${JSON.stringify({ resolution: vxzResolutionPreference }, null, 2)}\n`,
        "utf8",
      );
      await fs.promises.rename(staged, target);
    } finally {
      await fs.promises.rm(staged, { force: true });
    }
  });
  return vxzPreferenceWrite;
}

function vxzPreferencesPath() {
  return path.join(app.getPath("userData"), "vxz-preferences.json");
}

function findRuntimeAppIcon() {
  const candidates = [
    path.join(process.resourcesPath, "app-icon.png"),
    path.join(app.getAppPath(), "assets", "app-icon.png"),
    path.join(app.getAppPath(), "assets", "AppIcon.iconset", "icon_512x512@2x.png"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function setRuntimeAppIcon() {
  if (process.platform !== "darwin" || !app.dock) {
    return;
  }
  const icon = loadRuntimeAppIcon();
  if (icon) {
    app.dock.setIcon(icon);
  }
}

function loadRuntimeAppIcon() {
  const iconPath = findRuntimeAppIcon();
  if (!iconPath) {
    return undefined;
  }
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

function handleNativeFile(request, response, url) {
  if (request.method !== "GET") {
    sendText(response, 405, "Only GET is supported");
    return;
  }

  const requestId = url.searchParams.get("requestId") ?? "";
  const source = nativeFileRequests.get(requestId);
  if (!source) {
    sendText(response, 404, "This file-open request has expired");
    return;
  }
  nativeFileRequests.delete(requestId);

  void fs.promises.stat(source.filePath)
    .then((stat) => {
      if (!stat.isFile() || stat.size !== source.size) {
        sendText(response, 409, "The selected file changed before it could be opened");
        return;
      }

      const stream = fs.createReadStream(source.filePath);
      stream.on("error", (error) => {
        if (!response.headersSent) {
          sendText(response, 500, errorMessage(error));
        } else {
          response.destroy(error);
        }
      });
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentType(source.filePath),
        "Content-Length": stat.size,
        "X-Content-Type-Options": "nosniff",
      });
      response.on("close", () => {
        if (!response.writableEnded) {
          stream.destroy();
        }
      });
      stream.pipe(response);
    })
    .catch((error) => {
      if (!response.headersSent) {
        sendText(response, error?.code === "ENOENT" ? 404 : 500, errorMessage(error));
      }
    });
}

function handleStaticFile(request, response, url, distDir, indexPath) {
  if (request.method !== "GET") {
    sendText(response, 405, "Only GET is supported");
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.normalize(path.join(distDir, pathname));
  if (!filePath.startsWith(distDir)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (!path.extname(pathname)) {
        fs.readFile(indexPath, (indexError, indexData) => {
          if (indexError) {
            sendText(response, 404, "Not found");
            return;
          }
          sendBuffer(response, 200, indexData, "text/html; charset=utf-8");
        });
        return;
      }
      sendText(response, 404, "Not found");
      return;
    }

    sendBuffer(response, 200, data, contentType(filePath));
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".wasm")) {
    return "application/wasm";
  }
  return "application/octet-stream";
}

function sendText(response, status, text) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

function sendBuffer(response, status, buffer, type) {
  response.writeHead(status, { "Content-Type": type });
  response.end(buffer);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function showStartupError(error) {
  const message = errorMessage(error);
  await dialog.showMessageBox({
    type: "error",
    title: "Voxel Mesh Viewer",
    message: "Could not start Voxel Mesh Viewer.",
    detail: message,
  });
}
