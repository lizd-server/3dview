const { spawn } = require("node:child_process");
const {
  createRemoteHostPolicy,
  REMOTE_HOST_ALLOWLIST_ENV,
} = require("./remote-host-policy.cjs");

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

function createRemoteApi(options = {}) {
  const sshBin = options.sshBin
    ?? process.env.REMOTE_VIEWER_SSH_BIN
    ?? (process.platform === "win32" ? "ssh.exe" : process.platform === "darwin" ? "/usr/bin/ssh" : "ssh");
  const hostPolicy = options.hostPolicy
    ?? createRemoteHostPolicy(process.env[REMOTE_HOST_ALLOWLIST_ENV]);
  const spawnSsh = options.spawn ?? spawn;

  function handle(request, response, url) {
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
    if (!hostPolicy.isAllowed(host)) {
      sendText(response, 400, "Unsupported remote host. Check REMOTE_VIEWER_ALLOWED_HOSTS.");
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
      handleFile(request, response, host, url.searchParams.get("path") ?? "");
      return;
    }
    sendText(response, 404, "Not found");
  }

  function handleFile(request, response, host, remotePath) {
    if (!remotePath) {
      sendText(response, 400, "Missing remote path");
      return;
    }

    const child = startSsh(host, FILE_SCRIPT, [remotePath]);
    const fileName = remotePath.split(/[\\/]/).at(-1)?.replace(/["\r\n]/g, "") || "download";
    const downloadHeaders = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    };
    let stderr = "";
    let started = false;

    child.stdout.on("data", (chunk) => {
      if (!started) {
        started = true;
        response.writeHead(200, downloadHeaders);
      }
      response.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (started) {
        response.destroy(error);
      } else {
        sendText(response, 502, errorMessage(error));
      }
    });
    child.on("close", (code) => {
      if (response.writableEnded || response.destroyed) {
        return;
      }
      if (started || code === 0) {
        if (!started) {
          response.writeHead(200, downloadHeaders);
        }
        response.end();
      } else {
        sendText(response, 502, stderr.trim() || `ssh exited with code ${code}`);
      }
    });
    request.on("close", () => child.kill("SIGTERM"));
  }

  function sshJson(host, script, args = []) {
    return new Promise((resolve, reject) => {
      const child = startSsh(host, script, args);
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

  function startSsh(host, script, args) {
    return spawnSsh(sshBin, [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      host,
      remoteCommand(script, args),
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  }

  return { handle };
}

function remoteCommand(script, args) {
  return ["python3", "-c", shellQuote(script), ...args.map(shellQuote)].join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text) {
  if (!response.headersSent) {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  }
  response.end(String(text));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = { createRemoteApi };
