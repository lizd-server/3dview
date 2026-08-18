const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createVxzApi } = require("../server/vxz-api.cjs");

const HOST = "127.0.0.1";
const SSH_BIN = "/usr/bin/ssh";
const REMOTE_HOST_PATTERN = /^(?!-)[A-Za-z0-9_.@-]{1,128}$/;

let mainWindow = null;
let appServer = null;
let appServerUrl = null;
let vxzApi = null;
let rendererReadyForFiles = false;
let vxzResolutionPreference = null;
let vxzPreferenceWrite = Promise.resolve();
const pendingVxzPaths = [];
const pendingVxzRequests = new Map();

app.setName("Voxel Mesh Viewer");

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  queueVxzPath(filePath);
});

ipcMain.on("vxz:renderer-ready", (event) => {
  if (mainWindow && event.sender === mainWindow.webContents) {
    rendererReadyForFiles = true;
    void flushPendingVxzPaths();
  }
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

app.whenReady().then(async () => {
  try {
    setRuntimeAppIcon();
    await loadVxzPreferences();
    const url = await startAppServer();
    appServerUrl = url;
    createWindow(url);
  } catch (error) {
    await showStartupError(error);
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void startAppServer()
      .then((url) => {
        appServerUrl = url;
        createWindow(url);
      })
      .catch((error) => showStartupError(error));
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
  if (appServer) {
    const address = appServer.address();
    if (address && typeof address === "object") {
      return `http://${HOST}:${address.port}/`;
    }
  }

  const distDir = path.join(app.getAppPath(), "dist");
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Missing built frontend at ${indexPath}. Run npm run build before packaging.`);
  }

  const vxzRuntimeRoot = app.isPackaged
    ? path.join(process.resourcesPath, ".vxz-runtime-build")
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
      handleRemoteRequest(request, response, url);
      return;
    }

    handleStaticFile(request, response, url, distDir, indexPath);
  });

  await listen(appServer, 0);
  const address = appServer.address();
  if (!address || typeof address !== "object") {
    throw new Error("Could not start internal app server.");
  }
  return `http://${HOST}:${address.port}/`;
}

function createWindow(url) {
  const icon = loadRuntimeAppIcon();
  rendererReadyForFiles = false;
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 800,
    minWidth: 1060,
    minHeight: 660,
    title: "Voxel Mesh Viewer",
    backgroundColor: "#eef2f7",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    icon,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(app.getAppPath(), "electron", "preload.cjs"),
    },
  });

  mainWindow.on("closed", () => {
    for (const filePath of pendingVxzRequests.values()) {
      pendingVxzPaths.unshift(filePath);
    }
    pendingVxzRequests.clear();
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
  appUrl.searchParams.set("apiBase", "/api/remote");
  mainWindow.loadURL(appUrl.toString());
}

function queueVxzPath(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".vxz") {
    return;
  }
  pendingVxzPaths.push(path.resolve(filePath));
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  if (app.isReady()) {
    void flushPendingVxzPaths();
  }
}

async function flushPendingVxzPaths() {
  if (
    !rendererReadyForFiles
    || !appServerUrl
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
  const icon = loadRuntimeAppIcon();
  if (icon && process.platform === "darwin" && app.dock) {
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

function handleRemoteRequest(request, response, url) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendText(response, 405, "Only GET is supported");
    return;
  }

  const host = url.searchParams.get("host") ?? "";
  if (!isAllowedRemoteHost(host)) {
    sendText(response, 400, "Unsupported remote host. Use an SSH alias such as hl_gpu_2.");
    return;
  }

  if (url.pathname === "/api/remote/home") {
    void sshJson(host, HOME_SCRIPT)
      .then((payload) => sendJson(response, 200, { host, home: payload.home }))
      .catch((error) => sendText(response, 502, errorMessage(error)));
    return;
  }

  if (url.pathname === "/api/remote/list") {
    const remotePath = url.searchParams.get("path") ?? "";
    if (!remotePath) {
      sendText(response, 400, "Missing remote path");
      return;
    }

    void sshJson(host, LIST_SCRIPT, [remotePath])
      .then((payload) => sendJson(response, 200, { host, ...payload }))
      .catch((error) => sendText(response, 502, errorMessage(error)));
    return;
  }

  if (url.pathname === "/api/remote/file") {
    const remotePath = url.searchParams.get("path") ?? "";
    handleRemoteFile(request, response, host, remotePath);
    return;
  }

  sendText(response, 404, "Not found");
}

function isAllowedRemoteHost(host) {
  return REMOTE_HOST_PATTERN.test(host);
}

function handleRemoteFile(request, response, host, remotePath) {
  if (!remotePath) {
    sendText(response, 400, "Missing remote path");
    return;
  }

  const child = spawn(SSH_BIN, [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    host,
    remoteCommand(FILE_SCRIPT, [remotePath]),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let started = false;

  child.stdout.on("data", (chunk) => {
    if (!started) {
      started = true;
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${path.basename(remotePath).replaceAll('"', "")}"`,
      });
    }
    response.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.on("error", (error) => {
    if (!started) {
      sendText(response, 502, errorMessage(error));
    } else {
      response.destroy(error);
    }
  });

  child.on("close", (code) => {
    if (started) {
      response.end();
      return;
    }

    if (code === 0) {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end();
    } else {
      sendText(response, 502, stderr.trim() || `ssh exited with code ${code}`);
    }
  });

  request.on("close", () => child.kill("SIGTERM"));
}

function sshJson(host, script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(SSH_BIN, [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      host,
      remoteCommand(script, args),
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 10_000_000) {
        child.kill("SIGTERM");
        reject(new Error("remote response is too large"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ssh exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`could not parse remote JSON: ${errorMessage(error)}`));
      }
    });
  });
}

function remoteCommand(script, args) {
  return [
    "python3",
    "-c",
    shellQuote(script),
    ...args.map((arg) => shellQuote(arg)),
  ].join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
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

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
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

const LIST_SCRIPT = `
import json
import os
import sys

path = os.path.abspath(os.path.expanduser(sys.argv[1]))
entries = []

with os.scandir(path) as handle:
    for entry in handle:
        try:
            is_dir = entry.is_dir(follow_symlinks=True)
            stat = entry.stat(follow_symlinks=True)
        except OSError:
            continue
        entries.append({
            "name": entry.name,
            "path": os.path.join(path, entry.name),
            "type": "directory" if is_dir else "file",
            "size": None if is_dir else stat.st_size,
            "mtimeMs": int(stat.st_mtime * 1000),
        })

entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
print(json.dumps({
    "path": path,
    "parent": os.path.dirname(path) if os.path.dirname(path) != path else path,
    "entries": entries,
}))
`;

const HOME_SCRIPT = `
import json
import os

print(json.dumps({"home": os.path.expanduser("~")}))
`;

const FILE_SCRIPT = `
import shutil
import sys

with open(sys.argv[1], "rb") as handle:
    shutil.copyfileobj(handle, sys.stdout.buffer)
`;
