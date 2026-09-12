import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appName = "Voxel Mesh Viewer";
const targetArch = "x64";
const outDir = path.join(projectDir, "dist-win");
const appDir = path.join(outDir, `${appName}-win32-${targetArch}`);
const archivePath = path.join(outDir, "Voxel-Mesh-Viewer-windows-x64.zip");
const checksumPath = `${archivePath}.sha256`;
const iconPath = path.join(projectDir, "assets", "app-icon.ico");
const appIconPath = path.join(projectDir, "assets", "app-icon.png");
const tscCli = path.join(projectDir, "node_modules", "typescript", "bin", "tsc");
const viteCli = path.join(projectDir, "node_modules", "vite", "bin", "vite.js");
const electronPackagerCli = path.join(
  projectDir,
  "node_modules",
  "@electron",
  "packager",
  "bin",
  "electron-packager.mjs",
);
const runtimeBuildDir = path.join(projectDir, ".vxz-runtime-build");
const runtimeDir = path.join(runtimeBuildDir, "vxz-runtime");
const runtimeCacheDir = path.join(projectDir, ".windows-runtime-cache");
const vxzWorkerScript = path.join(projectDir, "vxz_worker.py");
const vxzDecoderScript = path.join(projectDir, "decode_vxz.py");

const pythonVersion = "3.13.15";
const numpyVersion = "2.4.6";
const pythonArchive = {
  name: `python-${pythonVersion}-embed-amd64.zip`,
  url: `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`,
  sha256: "d1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf",
};
const numpyWheel = {
  name: `numpy-${numpyVersion}-cp313-cp313-win_amd64.whl`,
  url: "https://files.pythonhosted.org/packages/b5/cd/9cc4dc876fb065d5c220aae4d5e14826b2715331bb7618ce1fb07a679d99/numpy-2.4.6-cp313-cp313-win_amd64.whl",
  sha256: "c4fc99836233ea196540b17ab0983aff60ed07941751930f5f4d05bc3b3b7359",
};

await Promise.all([
  access(iconPath),
  access(appIconPath),
  access(tscCli),
  access(viteCli),
  access(electronPackagerCli),
  access(vxzWorkerScript),
  access(vxzDecoderScript),
]);

run(process.execPath, [tscCli, "--noEmit"]);
run(process.execPath, [viteCli, "build"]);
await rm(outDir, { recursive: true, force: true });

try {
  await prepareWindowsVxzRuntime();
  run(process.execPath, [
    electronPackagerCli,
    ".",
    appName,
    "--platform=win32",
    `--arch=${targetArch}`,
    `--out=${outDir}`,
    "--overwrite",
    "--prune=true",
    "--app-version=0.1.0",
    "--app-copyright=Copyright (C) 2026 lizd-server",
    `--icon=${iconPath}`,
    `--extra-resource=${appIconPath}`,
    `--extra-resource=${runtimeDir}`,
    `--executable-name=${appName}`,
    "--win32metadata.CompanyName=lizd-server",
    `--win32metadata.ProductName=${appName}`,
    `--win32metadata.FileDescription=${appName}`,
    "--win32metadata.requested-execution-level=asInvoker",
    "--ignore=^/dist-mac($|/)",
    "--ignore=^/dist-win($|/)",
    "--ignore=^/\\.git($|/)",
    "--ignore=^/\\.logs($|/)",
    "--ignore=^/\\.venv-vxz($|/)",
    "--ignore=^/\\.vxz-runtime-build($|/)",
    "--ignore=^/\\.windows-runtime-cache($|/)",
    "--ignore=^/node_modules/electron/dist($|/)",
  ], { env: { ...process.env, npm_config_yes: "true" } });

  await writeFile(path.join(appDir, "WINDOWS-README.txt"), windowsReadme(), "utf8");
  await verifyPortableApp();
  await createZipArchive();
  const archiveHash = await sha256File(archivePath);
  await writeFile(
    checksumPath,
    `${archiveHash}  ${path.basename(archivePath)}\n`,
    "utf8",
  );
} finally {
  await rm(runtimeBuildDir, { recursive: true, force: true });
}

console.log(`Created ${appDir}`);
console.log(`Created ${archivePath}`);
console.log(`SHA-256 ${await sha256File(archivePath)}`);

async function prepareWindowsVxzRuntime() {
  await mkdir(runtimeCacheDir, { recursive: true });
  const pythonArchivePath = path.join(runtimeCacheDir, pythonArchive.name);
  const numpyWheelPath = path.join(runtimeCacheDir, numpyWheel.name);
  await downloadVerified(pythonArchive, pythonArchivePath);
  await downloadVerified(numpyWheel, numpyWheelPath);

  await rm(runtimeBuildDir, { recursive: true, force: true });
  const pythonDir = path.join(runtimeDir, "python");
  const sitePackagesDir = path.join(runtimeDir, "site-packages");
  await Promise.all([
    mkdir(pythonDir, { recursive: true }),
    mkdir(sitePackagesDir, { recursive: true }),
  ]);
  extractZip(pythonArchivePath, pythonDir);
  extractZip(numpyWheelPath, sitePackagesDir);
  await writeFile(
    path.join(pythonDir, "python313._pth"),
    "python313.zip\r\n.\r\n..\r\n..\\site-packages\r\nimport site\r\n",
    "utf8",
  );
  await Promise.all([
    cp(vxzWorkerScript, path.join(runtimeDir, "vxz_worker.py")),
    cp(vxzDecoderScript, path.join(runtimeDir, "decode_vxz.py")),
    writeFile(
      path.join(runtimeDir, "runtime.json"),
      `${JSON.stringify({
        platform: "win32",
        arch: targetArch,
        python: pythonVersion,
        numpy: numpyVersion,
        sources: {
          python: { url: pythonArchive.url, sha256: pythonArchive.sha256 },
          numpy: { url: numpyWheel.url, sha256: numpyWheel.sha256 },
        },
      }, null, 2)}\n`,
      "utf8",
    ),
  ]);
}

async function downloadVerified(artifact, target) {
  try {
    if (await sha256File(target) === artifact.sha256) {
      console.log(`Using cached ${artifact.name}`);
      return;
    }
  } catch {
    // Download a missing or unreadable cache entry below.
  }

  const response = await fetch(artifact.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Could not download ${artifact.name}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = sha256(bytes);
  if (actualHash !== artifact.sha256) {
    throw new Error(`${artifact.name} SHA-256 mismatch: expected ${artifact.sha256}, received ${actualHash}`);
  }
  const staged = `${target}.${process.pid}.tmp`;
  await writeFile(staged, bytes);
  await rename(staged, target);
  console.log(`Downloaded ${artifact.name}`);
}

function extractZip(archive, destination) {
  if (process.platform === "darwin") {
    run("ditto", ["-x", "-k", archive, destination]);
    return;
  }
  if (process.platform === "win32") {
    run("tar.exe", ["-xf", archive, "-C", destination]);
    return;
  }
  run("unzip", ["-q", archive, "-d", destination]);
}

async function verifyPortableApp() {
  const resourcesDir = path.join(appDir, "resources");
  const runtimeRoot = path.join(resourcesDir, "vxz-runtime");
  const pythonExe = path.join(runtimeRoot, "python", "python.exe");
  const numpyDir = path.join(runtimeRoot, "site-packages", "numpy");
  const nativeFiles = await findFiles(appDir, (name) => /\.(?:dll|exe|pyd)$/i.test(name));
  if (!nativeFiles.some((filePath) => filePath.startsWith(`${numpyDir}${path.sep}`) && /\.pyd$/i.test(filePath))) {
    throw new Error("The packaged NumPy runtime does not contain a Windows extension module");
  }
  await Promise.all([
    access(path.join(appDir, `${appName}.exe`)),
    access(pythonExe),
    access(path.join(runtimeRoot, "python", "python313.dll")),
    access(path.join(resourcesDir, "app.asar")),
    access(path.join(runtimeRoot, "vxz_worker.py")),
    access(path.join(runtimeRoot, "decode_vxz.py")),
    access(path.join(runtimeRoot, "runtime.json")),
  ]);
  const pth = await readFile(path.join(runtimeRoot, "python", "python313._pth"), "utf8");
  for (const requiredLine of ["..", "..\\site-packages", "import site"]) {
    if (!pth.split(/\r?\n/).includes(requiredLine)) {
      throw new Error(`Embedded Python path file is missing ${requiredLine}`);
    }
  }
  for (const filePath of nativeFiles) {
    await assertPeX64(filePath);
  }
  console.log(`Verified ${nativeFiles.length} x64 Windows native files`);
}

async function assertPeX64(filePath) {
  const handle = await open(filePath, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (dosRead.bytesRead !== dosHeader.length || dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      throw new Error(`${filePath} is not a PE executable`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset);
    if (peRead.bytesRead !== peHeader.length || peHeader.toString("ascii", 0, 4) !== "PE\0\0") {
      throw new Error(`${filePath} has an invalid PE header`);
    }
    if (peHeader.readUInt16LE(4) !== 0x8664) {
      throw new Error(`${filePath} is not an x64 PE executable`);
    }
  } finally {
    await handle.close();
  }
}

async function findFiles(directory, predicate, matches = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await findFiles(entryPath, predicate, matches);
    } else if (predicate(entry.name)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

async function createZipArchive() {
  await rm(archivePath, { force: true });
  if (process.platform === "win32") {
    const source = appDir.replaceAll("'", "''");
    const target = archivePath.replaceAll("'", "''");
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path '${source}' -DestinationPath '${target}' -CompressionLevel Optimal`,
    ]);
    return;
  }
  run("zip", ["-qry", archivePath, path.basename(appDir)], {
    cwd: outDir,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function windowsReadme() {
  return [
    "Voxel Mesh Viewer for Windows x64",
    "",
    `Version 0.1.0 | Python ${pythonVersion} | NumPy ${numpyVersion}`,
    "",
    `Start the app by opening ${appName}.exe. Keep the entire folder together.`,
    "The folder, field, mesh, remote, and VXZ views are included.",
    "Use Windows Open With, or pass a full path, to open a .npy or .vxz file.",
    "A .npy file also loads a supported metadata JSON file from the same folder.",
    "Remote browsing requires the Windows OpenSSH Client and matching SSH aliases.",
    "Set REMOTE_VIEWER_SSH_BIN if ssh.exe is installed outside PATH.",
    "",
    "This portable build is unsigned. Windows SmartScreen may ask you to confirm the first launch.",
    "",
  ].join("\r\n");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectDir,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}
