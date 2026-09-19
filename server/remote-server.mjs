import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { basename } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vxzApiModule from "./vxz-api.cjs";

const PORT = Number(process.env.REMOTE_VIEWER_PORT ?? 5175);
const HOST = process.env.REMOTE_VIEWER_HOST ?? "0.0.0.0";
const LOCAL_HOST = "local";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_HOSTS = new Set(
  (process.env.REMOTE_SSH_HOSTS ?? "126781,hl_gpu_2")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const LOCAL_ROOTS = (process.env.LOCAL_VIEWER_ROOTS ?? path.join(PROJECT_ROOT, "temp_output"))
  .split(path.delimiter)
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => path.resolve(value));
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const NPY_SLICE_SCRIPT = path.join(PROJECT_ROOT, "server", "npy-slice.py");
const NPY_PYTHON = process.env.VXZ_PYTHON
  ?? (existsSync(path.join(PROJECT_ROOT, ".venv-vxz", "bin", "python"))
    ? path.join(PROJECT_ROOT, ".venv-vxz", "bin", "python")
    : "python3");
const vxzApi = vxzApiModule.createVxzApi({
  projectRoot: PROJECT_ROOT,
  allowedOrigins: configuredOrigins(),
});

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
import os
import shutil
import sys

path = os.path.abspath(os.path.expanduser(sys.argv[1]))
with open(path, "rb") as handle:
    shutil.copyfileobj(handle, sys.stdout.buffer)
`;

const server = http.createServer((request, response) => {
  setCorsHeaders(request, response);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (!request.url) {
    sendText(response, 400, "Missing URL");
    return;
  }
  const url = new URL(request.url, `http://${request.headers.host ?? `127.0.0.1:${PORT}`}`);
  if (url.pathname.startsWith("/api/vxz/")) {
    vxzApi.handle(request, response, url);
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname.startsWith("/api/remote/")) {
    handleRemoteRequest(request, response, url);
    return;
  }

  void serveStatic(request, response, url);
});

function handleRemoteRequest(request, response, url) {
  if (request.method !== "GET") {
    sendText(response, 405, "Only GET is supported");
    return;
  }

  const host = url.searchParams.get("host") ?? "";
  if (host !== LOCAL_HOST && !ALLOWED_HOSTS.has(host)) {
    sendText(response, 400, "Unsupported remote host");
    return;
  }

  if (url.pathname === "/api/remote/home") {
    if (host === LOCAL_HOST) {
      sendJson(response, 200, { host, home: LOCAL_ROOTS[0] });
      return;
    }
    void handleHome(response, host);
    return;
  }

  if (url.pathname === "/api/remote/list") {
    const path = url.searchParams.get("path") ?? "";
    if (host === LOCAL_HOST) {
      void handleLocalList(response, path);
      return;
    }
    void handleList(response, host, path);
    return;
  }

  if (url.pathname === "/api/remote/file") {
    const path = url.searchParams.get("path") ?? "";
    if (host === LOCAL_HOST) {
      void handleLocalFile(response, path);
      return;
    }
    handleFile(request, response, host, path);
    return;
  }

  if (url.pathname === "/api/remote/volume-metadata") {
    const path = url.searchParams.get("path") ?? "";
    if (host !== LOCAL_HOST) {
      sendText(response, 400, "Server-side NPY slicing is only available for local files");
      return;
    }
    void handleLocalNpyMetadata(response, path);
    return;
  }

  if (url.pathname === "/api/remote/volume-slice") {
    const path = url.searchParams.get("path") ?? "";
    if (host !== LOCAL_HOST) {
      sendText(response, 400, "Server-side NPY slicing is only available for local files");
      return;
    }
    void handleLocalNpySlice(
      request,
      response,
      path,
      url.searchParams.get("axis") ?? "",
      url.searchParams.get("index") ?? "",
    );
    return;
  }

  sendText(response, 404, "Not found");
}

server.listen(PORT, HOST, () => {
  console.log(`viewer listening on http://${HOST}:${PORT}`);
});

server.on("close", () => vxzApi.dispose());

async function handleLocalList(response, requestedPath) {
  try {
    const resolved = await resolveLocalPath(requestedPath || LOCAL_ROOTS[0]);
    const stat = await fs.stat(resolved.path);
    if (!stat.isDirectory()) {
      sendText(response, 400, "Local path is not a directory");
      return;
    }

    const entries = [];
    for (const entry of await fs.readdir(resolved.path, { withFileTypes: true })) {
      const entryPath = path.join(resolved.path, entry.name);
      try {
        const safeEntry = await resolveLocalPath(entryPath);
        const entryStat = await fs.stat(safeEntry.path);
        entries.push({
          name: entry.name,
          path: entryPath,
          type: entryStat.isDirectory() ? "directory" : "file",
          size: entryStat.isDirectory() ? null : entryStat.size,
          mtimeMs: Math.trunc(entryStat.mtimeMs),
        });
      } catch {
        // Hide broken links and links that leave the configured roots.
      }
    }
    entries.sort((left, right) => (
      (left.type !== "directory") - (right.type !== "directory")
      || left.name.localeCompare(right.name)
    ));

    sendJson(response, 200, {
      host: LOCAL_HOST,
      path: resolved.path,
      parent: resolved.path === resolved.root ? resolved.root : path.dirname(resolved.path),
      entries,
    });
  } catch (error) {
    sendLocalPathError(response, error);
  }
}

async function handleLocalFile(response, requestedPath) {
  try {
    if (!requestedPath) {
      sendText(response, 400, "Missing local path");
      return;
    }
    const resolved = await resolveLocalPath(requestedPath);
    const stat = await fs.stat(resolved.path);
    if (!stat.isFile()) {
      sendText(response, 400, "Local path is not a file");
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${basename(resolved.path).replaceAll('"', "")}"`,
      "Cache-Control": "no-store",
    });
    const stream = createReadStream(resolved.path);
    stream.on("error", (error) => response.destroy(error));
    response.on("close", () => {
      if (!response.writableEnded) {
        stream.destroy();
      }
    });
    stream.pipe(response);
  } catch (error) {
    sendLocalPathError(response, error);
  }
}

async function handleLocalNpyMetadata(response, requestedPath) {
  try {
    const filePath = await resolveLocalNpyPath(requestedPath);
    const payload = await runNpyJson(["metadata", filePath]);
    sendJson(response, 200, payload);
  } catch (error) {
    sendLocalPathError(response, error);
  }
}

async function handleLocalNpySlice(request, response, requestedPath, axis, indexText) {
  try {
    const filePath = await resolveLocalNpyPath(requestedPath);
    if (!new Set(["x", "y", "z"]).has(axis) || !/^\d+$/.test(indexText)) {
      sendText(response, 400, "Invalid NPY slice axis or index");
      return;
    }

    const child = spawn(NPY_PYTHON, [NPY_SLICE_SCRIPT, "slice", filePath, axis, indexText], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let started = false;
    child.stdout.on("data", (chunk) => {
      if (!started) {
        started = true;
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        });
      }
      response.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-10_000);
    });
    child.on("error", (error) => {
      if (!started) {
        sendText(response, 500, errorMessage(error));
      } else {
        response.destroy(error);
      }
    });
    child.on("close", (code) => {
      if (started) {
        if (code === 0) {
          response.end();
        } else {
          response.destroy(new Error(stderr.trim() || `NPY slice worker exited with code ${code}`));
        }
      } else if (code === 0) {
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        });
        response.end();
      } else {
        sendText(response, 400, stderr.trim() || `NPY slice worker exited with code ${code}`);
      }
    });
    request.on("aborted", () => child.kill("SIGTERM"));
    response.on("close", () => {
      if (!response.writableEnded) {
        child.kill("SIGTERM");
      }
    });
  } catch (error) {
    sendLocalPathError(response, error);
  }
}

async function resolveLocalNpyPath(requestedPath) {
  if (!requestedPath) {
    const error = new Error("Missing local NPY path");
    error.code = "EINVAL";
    throw error;
  }
  const resolved = await resolveLocalPath(requestedPath);
  const stat = await fs.stat(resolved.path);
  if (!stat.isFile() || path.extname(resolved.path).toLowerCase() !== ".npy") {
    const error = new Error("Local volume path must be an NPY file");
    error.code = "EINVAL";
    throw error;
  }
  return resolved.path;
}

function runNpyJson(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(NPY_PYTHON, [NPY_SLICE_SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1_000_000) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-10_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `NPY metadata worker exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Could not parse NPY metadata: ${errorMessage(error)}`));
      }
    });
  });
}

async function resolveLocalPath(requestedPath) {
  const realPath = await fs.realpath(path.resolve(requestedPath));
  for (const configuredRoot of LOCAL_ROOTS) {
    let realRoot;
    try {
      realRoot = await fs.realpath(configuredRoot);
    } catch {
      continue;
    }
    if (realPath === realRoot || realPath.startsWith(`${realRoot}${path.sep}`)) {
      return { path: realPath, root: realRoot };
    }
  }
  const error = new Error("Local path is outside the configured roots");
  error.code = "EACCES";
  throw error;
}

function sendLocalPathError(response, error) {
  if (error?.code === "EACCES") {
    sendText(response, 403, errorMessage(error));
  } else if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    sendText(response, 404, "Local path not found");
  } else if (error?.code === "EINVAL") {
    sendText(response, 400, errorMessage(error));
  } else {
    sendText(response, 500, errorMessage(error));
  }
}

async function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Only GET and HEAD are supported");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(response, 400, "Invalid URL path");
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(DIST_ROOT, relativePath);
  if (filePath !== DIST_ROOT && !filePath.startsWith(`${DIST_ROOT}${path.sep}`)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendText(response, 404, "Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": stat.size,
      "Cache-Control": relativePath === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendText(response, 404, "Build output not found; run npm run build first");
      return;
    }
    sendText(response, 500, errorMessage(error));
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
  })[extension] ?? "application/octet-stream";
}

function configuredOrigins() {
  const configured = (process.env.REMOTE_VIEWER_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return ["http://127.0.0.1:5173", "http://localhost:5173", ...configured];
}

function setCorsHeaders(request, response) {
  const origin = String(request.headers.origin ?? "");
  if (!origin) {
    return;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.host === request.headers.host || configuredOrigins().includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
  } catch {
    // Invalid origins are rejected by the API-specific origin check.
  }
}

async function handleHome(response, host) {
  try {
    const payload = await sshJson(host, HOME_SCRIPT);
    sendJson(response, 200, { host, home: payload.home });
  } catch (error) {
    sendText(response, 502, errorMessage(error));
  }
}

async function handleList(response, host, path) {
  if (!path) {
    sendText(response, 400, "Missing remote path");
    return;
  }

  try {
    const payload = await sshJson(host, LIST_SCRIPT, [path]);
    sendJson(response, 200, { host, ...payload });
  } catch (error) {
    sendText(response, 502, errorMessage(error));
  }
}

function handleFile(request, response, host, path) {
  if (!path) {
    sendText(response, 400, "Missing remote path");
    return;
  }

  const child = spawn("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    host,
    remoteCommand(FILE_SCRIPT, [path]),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let started = false;

  child.stdout.on("data", (chunk) => {
    if (!started) {
      started = true;
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${basename(path).replaceAll('"', "")}"`,
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

  request.on("close", () => {
    child.kill("SIGTERM");
  });
}

function sshJson(host, script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [
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

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
