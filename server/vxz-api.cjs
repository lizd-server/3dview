const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const JOB_ID_PATTERN = /^[a-f0-9]{64}$/;
const AXES = new Set(["x", "y", "z"]);
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function createVxzApi(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, ".."));
  const workerScript = path.resolve(options.workerScript ?? path.join(projectRoot, "vxz_worker.py"));
  const cacheRoot = path.resolve(options.cacheRoot ?? path.join(
    os.homedir(),
    "Library",
    "Caches",
    "voxel-mesh-viewer",
    "vxz",
  ));
  const python = resolvePython(projectRoot, options.python);
  const workerEnv = resolveWorkerEnvironment(projectRoot);
  const requestedPrepareWorkers = Number(options.maxPrepareWorkers ?? 1);
  const maxPrepareWorkers = Number.isInteger(requestedPrepareWorkers) && requestedPrepareWorkers > 0
    ? requestedPrepareWorkers
    : 1;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const jobs = new Map();
  const activeSliceWorkers = new Map();
  const prepareQueue = [];
  let activePrepareWorkers = 0;
  let disposed = false;

  function handle(request, response, url) {
    const origin = String(request.headers.origin ?? "");
    if (origin && !isAllowedOrigin(origin, request.headers.host, allowedOrigins)) {
      sendText(response, 403, "VXZ API only accepts requests from the local viewer");
      return true;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return true;
    }

    if (url.pathname === "/api/vxz/open" && request.method === "POST") {
      runAsync(response, handleUpload(request, response, url));
      return true;
    }

    if (request.method !== "GET") {
      sendText(response, 405, "VXZ API supports POST open and GET data requests");
      return true;
    }

    if (url.pathname === "/api/vxz/status") {
      runAsync(response, handleStatus(response, url.searchParams.get("id") ?? ""));
      return true;
    }

    if (url.pathname === "/api/vxz/data") {
      runAsync(response, handleData(response, url.searchParams.get("id") ?? "", url.searchParams.get("kind") ?? ""));
      return true;
    }

    if (url.pathname === "/api/vxz/slice") {
      handleSlice(request, response, url);
      return true;
    }

    sendText(response, 404, "Unknown VXZ API route");
    return true;
  }

  async function handleUpload(request, response, url) {
    const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/octet-stream") {
      sendText(response, 415, "VXZ upload Content-Type must be application/octet-stream");
      return;
    }
    const expectedSize = Number(request.headers["content-length"] ?? 0);
    if (!Number.isFinite(expectedSize) || expectedSize <= 0 || expectedSize > MAX_UPLOAD_BYTES) {
      sendText(response, 400, "VXZ upload needs a valid Content-Length up to 2 GiB");
      return;
    }

    const sourceName = safeFileName(url.searchParams.get("name") ?? "input.vxz");
    const requestedResolution = parseOptionalResolution(url.searchParams.get("resolution"));
    if (requestedResolution === undefined) {
      sendText(response, 400, "VXZ resolution must be a positive integer");
      return;
    }
    await fsp.mkdir(cacheRoot, { recursive: true });
    const staged = path.join(cacheRoot, `.upload-${process.pid}-${crypto.randomUUID()}.tmp`);
    const hash = crypto.createHash("sha256");
    const output = fs.createWriteStream(staged, { flags: "wx" });
    let received = 0;
    let settled = false;

    const fail = async (status, error) => {
      if (settled) {
        return;
      }
      settled = true;
      output.destroy();
      await fsp.rm(staged, { force: true });
      sendText(response, status, errorMessage(error));
    };

    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        request.destroy(new Error("VXZ upload exceeds 2 GiB"));
        return;
      }
      hash.update(chunk);
    });
    request.on("aborted", () => void fail(400, "VXZ upload was cancelled"));
    request.on("error", (error) => void fail(400, error));
    output.on("error", (error) => void fail(500, error));
    request.pipe(output);

    const finalizeUpload = async () => {
      if (settled) {
        return;
      }
      if (received !== expectedSize) {
        await fail(400, `Incomplete VXZ upload: expected ${expectedSize}, received ${received}`);
        return;
      }

      const sourceHash = hash.digest("hex");
      const id = requestedResolution === null
        ? sourceHash
        : crypto.createHash("sha256").update(`${sourceHash}:r=${requestedResolution}`).digest("hex");
      const jobDir = path.join(cacheRoot, id);
      const sourcePath = path.join(jobDir, "source.vxz");
      const metadataPath = path.join(jobDir, "metadata.json");
      await fsp.mkdir(jobDir, { recursive: true });

      const metadata = await readCompleteCache(jobDir);
      if (metadata) {
        await fsp.rm(staged, { force: true });
        const job = readyJob(id, sourceName, jobDir, sourcePath, metadata);
        jobs.set(id, job);
        settled = true;
        sendJson(response, 200, publicJob(job));
        return;
      }

      const existing = jobs.get(id);
      if (existing?.status === "processing") {
        await fsp.rm(staged, { force: true });
        settled = true;
        sendJson(response, 202, publicJob(existing));
        return;
      }

      const job = {
        id,
        sourceName,
        sourcePath,
        jobDir,
        status: "processing",
        stage: "queued",
        progress: 0,
        message: "Queued VXZ decode",
        error: null,
        metadata: null,
        resolution: requestedResolution,
        child: null,
      };
      jobs.set(id, job);
      try {
        await fsp.rm(metadataPath, { force: true });
        await fsp.rename(staged, sourcePath);
        enqueuePrepare(job);
      } catch (error) {
        if (jobs.get(id) === job) {
          jobs.delete(id);
        }
        throw error;
      }
      settled = true;
      sendJson(response, 202, publicJob(job));
    };
    output.on("finish", () => {
      void finalizeUpload().catch((error) => fail(500, error));
    });
  }

  function enqueuePrepare(job) {
    prepareQueue.push(job);
    pumpPrepareQueue();
  }

  function pumpPrepareQueue() {
    while (!disposed && activePrepareWorkers < maxPrepareWorkers && prepareQueue.length > 0) {
      const job = prepareQueue.shift();
      if (job.status !== "processing" || job.child) {
        continue;
      }
      try {
        startPrepare(job);
      } catch (error) {
        job.status = "failed";
        job.error = errorMessage(error);
        job.message = job.error;
        job.child = null;
        activePrepareWorkers = Math.max(0, activePrepareWorkers - 1);
      }
    }
  }

  function startPrepare(job) {
    activePrepareWorkers += 1;
    const args = [workerScript, "prepare", job.sourcePath, job.jobDir];
    if (job.resolution !== null) {
      args.push("--resolution", String(job.resolution));
    }
    const child = spawn(python, args, {
      cwd: projectRoot,
      env: workerEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.child = child;
    let stdout = "";
    let stderr = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 5_000_000) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderr = stderr.slice(-20_000);
      stderrBuffer += text;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("PROGRESS ")) {
          continue;
        }
        try {
          const progress = JSON.parse(line.slice("PROGRESS ".length));
          job.stage = String(progress.stage ?? job.stage);
          job.progress = Number(progress.fraction ?? job.progress);
          job.message = String(progress.message ?? job.message);
        } catch {
          // Keep decoding even if one progress line is malformed.
        }
      }
    });
    child.on("error", (error) => {
      job.status = "failed";
      job.error = errorMessage(error);
      job.message = job.error;
      job.child = null;
    });
    child.on("close", (code) => {
      void finalizePrepare(job, code, stdout, stderr);
    });
  }

  async function finalizePrepare(job, code, stdout, stderr) {
    try {
      job.child = null;
      if (code !== 0) {
        job.status = "failed";
        job.error = lastUsefulLine(stderr) || `VXZ worker exited with code ${code}`;
        job.message = job.error;
        return;
      }
      try {
        const metadataPath = path.join(job.jobDir, "metadata.json");
        job.metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
        job.status = "ready";
        job.stage = "ready";
        job.progress = 1;
        job.message = "VXZ mesh, voxels, and slices are ready";
      } catch (error) {
        job.status = "failed";
        job.error = `Could not read VXZ metadata: ${errorMessage(error)}; ${stdout.slice(-1000)}`;
        job.message = job.error;
      }
    } finally {
      activePrepareWorkers = Math.max(0, activePrepareWorkers - 1);
      pumpPrepareQueue();
    }
  }

  async function handleStatus(response, id) {
    if (!validJobId(id)) {
      sendText(response, 400, "Invalid VXZ job id");
      return;
    }
    let job = jobs.get(id);
    if (!job) {
      const jobDir = path.join(cacheRoot, id);
      const metadataPath = path.join(jobDir, "metadata.json");
      if (!fs.existsSync(metadataPath)) {
        sendText(response, 404, "Unknown VXZ job");
        return;
      }
      const metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
      job = readyJob(id, metadata.sourceName ?? "cached.vxz", jobDir, "", metadata);
      jobs.set(id, job);
    }
    sendJson(response, 200, publicJob(job));
  }

  async function handleData(response, id, kind) {
    if (!validJobId(id) || !new Set(["voxels", "mesh"]).has(kind)) {
      sendText(response, 400, "Invalid VXZ data request");
      return;
    }
    const job = jobs.get(id);
    if (job && job.status !== "ready") {
      sendText(response, 409, job.message);
      return;
    }
    const target = path.join(cacheRoot, id, `${kind}.bin`);
    try {
      const stat = await fsp.stat(target);
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "private, max-age=31536000, immutable",
      });
      fs.createReadStream(target).pipe(response);
    } catch (error) {
      sendText(response, 404, errorMessage(error));
    }
  }

  function handleSlice(request, response, url) {
    const id = url.searchParams.get("id") ?? "";
    const axis = url.searchParams.get("axis") ?? "";
    const index = Number(url.searchParams.get("index"));
    if (!validJobId(id) || !AXES.has(axis) || !Number.isInteger(index) || index < 0) {
      sendText(response, 400, "Invalid VXZ slice request");
      return;
    }
    const job = jobs.get(id);
    if (job && job.status !== "ready") {
      sendText(response, 409, job.message);
      return;
    }
    const jobDir = path.join(cacheRoot, id);
    if (!fs.existsSync(path.join(jobDir, "metadata.json"))) {
      sendText(response, 404, "Unknown VXZ job");
      return;
    }

    activeSliceWorkers.get(id)?.kill("SIGTERM");
    const child = spawn(python, [workerScript, "slice", jobDir, axis, String(index)], {
      cwd: projectRoot,
      env: workerEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeSliceWorkers.set(id, child);
    let started = false;
    let stderr = "";
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
      stderr += chunk.toString();
      stderr = stderr.slice(-20_000);
    });
    child.on("error", (error) => {
      if (!started) {
        sendText(response, 500, errorMessage(error));
      } else {
        response.destroy(error);
      }
    });
    child.on("close", (code) => {
      if (activeSliceWorkers.get(id) === child) {
        activeSliceWorkers.delete(id);
      }
      if (response.destroyed) {
        return;
      }
      if (started) {
        response.end();
      } else if (code === 0) {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end();
      } else {
        sendText(response, 500, lastUsefulLine(stderr) || `VXZ slice worker exited with code ${code}`);
      }
    });
    request.on("aborted", () => child.kill("SIGTERM"));
    response.on("close", () => {
      if (!response.writableEnded) {
        child.kill("SIGTERM");
      }
    });
  }

  function dispose() {
    disposed = true;
    for (const job of prepareQueue.splice(0)) {
      job.status = "failed";
      job.error = "VXZ backend stopped before queued preparation started";
      job.message = job.error;
    }
    for (const job of jobs.values()) {
      job.child?.kill("SIGTERM");
    }
    for (const child of activeSliceWorkers.values()) {
      child.kill("SIGTERM");
    }
    activeSliceWorkers.clear();
  }

  return { handle, dispose, cacheRoot, python, workerScript };
}

function isAllowedOrigin(origin, host, allowedOrigins) {
  if (allowedOrigins.has(origin)) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host === host && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

async function readCompleteCache(jobDir) {
  const required = ["metadata.json", "coords.npy", "dual.npy", "intersected.npy", "ovoxel_type.npy", "qef_rank.npy", "voxels.bin", "mesh.bin"];
  try {
    await Promise.all(required.map((name) => fsp.access(path.join(jobDir, name))));
    const metadata = JSON.parse(await fsp.readFile(path.join(jobDir, "metadata.json"), "utf8"));
    return metadata.formatVersion === 3 && metadata.cacheVersion === 5 ? metadata : null;
  } catch {
    return null;
  }
}

function runAsync(response, promise) {
  void promise.catch((error) => sendText(response, 500, errorMessage(error)));
}

function resolvePython(projectRoot, explicit) {
  const candidates = [
    explicit,
    process.env.VXZ_PYTHON,
    path.join(projectRoot, "python", "bin", "python3"),
    path.join(projectRoot, ".venv-vxz", "bin", "python"),
    "python3",
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === "python3" || fs.existsSync(candidate)) ?? "python3";
}

function resolveWorkerEnvironment(projectRoot) {
  const sitePackages = path.join(projectRoot, "site-packages");
  if (!fs.existsSync(sitePackages)) {
    return process.env;
  }
  return { ...process.env, PYTHONPATH: sitePackages };
}

function readyJob(id, sourceName, jobDir, sourcePath, metadata) {
  return {
    id,
    sourceName,
    sourcePath,
    jobDir,
    status: "ready",
    stage: "ready",
    progress: 1,
    message: "Using cached VXZ data",
    error: null,
    metadata,
    child: null,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    sourceName: job.sourceName,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    error: job.error,
    metadata: job.metadata,
  };
}

function validJobId(id) {
  return JOB_ID_PATTERN.test(id);
}

function safeFileName(value) {
  const name = path.basename(String(value)).replaceAll("\0", "").replace(/[^A-Za-z0-9._-]+/g, "_");
  return name || "input.vxz";
}

function parseOptionalResolution(value) {
  if (value === null || value === "") {
    return null;
  }
  const resolution = Number(value);
  return Number.isInteger(resolution) && resolution > 0 ? resolution : undefined;
}

function lastUsefulLine(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(String(text));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = { createVxzApi };
