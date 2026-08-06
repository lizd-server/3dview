import { spawn } from "node:child_process";
import http from "node:http";
import { basename } from "node:path";

const PORT = Number(process.env.REMOTE_VIEWER_PORT ?? 5175);
const HOST = "127.0.0.1";
const ALLOWED_HOSTS = new Set(["126781"]);

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
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "GET" || !request.url) {
    sendText(response, 405, "Only GET is supported");
    return;
  }

  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const host = url.searchParams.get("host") ?? "";
  if (!ALLOWED_HOSTS.has(host)) {
    sendText(response, 400, "Unsupported remote host");
    return;
  }

  if (url.pathname === "/api/remote/home") {
    void handleHome(response, host);
    return;
  }

  if (url.pathname === "/api/remote/list") {
    const path = url.searchParams.get("path") ?? "";
    void handleList(response, host, path);
    return;
  }

  if (url.pathname === "/api/remote/file") {
    const path = url.searchParams.get("path") ?? "";
    handleFile(request, response, host, path);
    return;
  }

  sendText(response, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`remote backend listening at http://${HOST}:${PORT}`);
});

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
