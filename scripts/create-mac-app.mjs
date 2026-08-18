import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdir,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appName = "Voxel Mesh Viewer";
const outDir = path.join(projectDir, "dist-mac");
const iconPath = path.join(projectDir, "assets", "app-icon.icns");
const dockIconPath = path.join(projectDir, "assets", "app-icon.png");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const appDir = path.join(outDir, `${appName}-darwin-${arch}`, `${appName}.app`);
const installDir = path.join(process.env.HOME ?? "", "Applications", `${appName}.app`);
const vxzRuntimeDir = path.join(projectDir, ".vxz-runtime-build");
const venvPython = path.join(projectDir, ".venv-vxz", "bin", "python");
const venvSitePackages = path.join(projectDir, ".venv-vxz", "lib", "python3.11", "site-packages");
const vxzWorkerScript = path.join(projectDir, "vxz_worker.py");
const vxzDecoderScript = path.join(projectDir, "decode_vxz.py");

await Promise.all([
  access(venvPython),
  access(venvSitePackages),
  access(vxzWorkerScript),
  access(vxzDecoderScript),
]);

run("swift", ["scripts/create-app-icon.swift"]);
run("npm", ["run", "build"]);
await rm(outDir, { recursive: true, force: true });
await prepareVxzRuntime();

try {
  run("npx", [
    "electron-packager",
    ".",
    appName,
    "--platform=darwin",
    `--arch=${arch}`,
    `--out=${outDir}`,
    "--overwrite",
    "--prune=true",
    "--app-bundle-id=com.lizd.voxel-mesh-viewer",
    "--app-version=0.1.0",
    `--icon=${iconPath}`,
    `--extra-resource=${dockIconPath}`,
    `--extra-resource=${vxzRuntimeDir}`,
    `--executable-name=${appName}`,
    "--ignore=^/dist-mac($|/)",
    "--ignore=^/\\.git($|/)",
    "--ignore=^/\\.logs($|/)",
    "--ignore=^/\\.venv-vxz($|/)",
    "--ignore=^/\\.vxz-runtime-build($|/)",
    "--ignore=^/node_modules/electron/dist($|/)",
  ], { env: { ...process.env, npm_config_yes: "true" } });
} finally {
  await rm(vxzRuntimeDir, { recursive: true, force: true });
}

applyBundleIcon(appDir);
await rm(installDir, { recursive: true, force: true });
run("ditto", [appDir, installDir]);
applyBundleIcon(installDir);
await chmod(path.join(installDir, "Contents", "MacOS", appName), 0o755);
run("xattr", ["-dr", "com.apple.quarantine", installDir], { allowFailure: true });
run("touch", [installDir], { allowFailure: true });

console.log(`Created ${appDir}`);
console.log(`Installed ${installDir}`);

async function prepareVxzRuntime() {
  const pythonExecutable = await realpath(venvPython);
  const pythonHome = path.resolve(path.dirname(pythonExecutable), "..");
  await rm(vxzRuntimeDir, { recursive: true, force: true });
  await mkdir(vxzRuntimeDir, { recursive: true });
  const runtimePythonHome = path.join(vxzRuntimeDir, "python");
  await cp(pythonHome, runtimePythonHome, { recursive: true });
  await materializeSymlinks(pythonHome, runtimePythonHome, runtimePythonHome);
  await cp(venvSitePackages, path.join(vxzRuntimeDir, "site-packages"), { recursive: true });
  await cp(vxzWorkerScript, path.join(vxzRuntimeDir, "vxz_worker.py"));
  await cp(vxzDecoderScript, path.join(vxzRuntimeDir, "decode_vxz.py"));
}

async function materializeSymlinks(sourceRoot, runtimeRoot, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await materializeSymlinks(sourceRoot, runtimeRoot, entryPath);
      continue;
    }
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const resolvedTarget = await realpath(entryPath);
    if (!isWithin(sourceRoot, resolvedTarget) && !isWithin(runtimeRoot, resolvedTarget)) {
      throw new Error(`Python runtime symlink escapes its roots: ${entryPath} -> ${resolvedTarget}`);
    }
    await rm(entryPath, { force: true });
    await cp(resolvedTarget, entryPath, { recursive: true });
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    env: options.env ?? process.env,
    stdio: options.quiet ? "ignore" : "inherit",
  });

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function applyBundleIcon(bundleDir) {
  const resourcesDir = path.join(bundleDir, "Contents", "Resources");
  const plistPath = path.join(bundleDir, "Contents", "Info.plist");
  run("cp", [iconPath, path.join(resourcesDir, "app-icon.icns")]);
  run("cp", [dockIconPath, path.join(resourcesDir, "app-icon.png")]);
  run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIconFile app-icon.icns", plistPath]);
  configureVxzDocumentType(plistPath);
}

function configureVxzDocumentType(plistPath) {
  const plistBuddy = "/usr/libexec/PlistBuddy";
  run(plistBuddy, ["-c", "Delete :CFBundleDocumentTypes", plistPath], { allowFailure: true, quiet: true });
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes array", plistPath]);
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes:0 dict", plistPath]);
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes:0:CFBundleTypeName string O-Voxel VXZ", plistPath]);
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer", plistPath]);
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes:0:LSHandlerRank string Owner", plistPath]);
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes:0:CFBundleTypeIconFile string app-icon.icns", plistPath]);
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array", plistPath]);
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string vxz", plistPath]);
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes:0:LSItemContentTypes array", plistPath]);
  run(plistBuddy, ["-c", "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string com.lizd.ovoxel-vxz", plistPath]);

  run(plistBuddy, ["-c", "Delete :UTExportedTypeDeclarations", plistPath], { allowFailure: true, quiet: true });
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations array", plistPath]);
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations:0 dict", plistPath]);
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations:0:UTTypeIdentifier string com.lizd.ovoxel-vxz", plistPath]);
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations:0:UTTypeDescription string O-Voxel VXZ", plistPath]);
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations:0:UTTypeConformsTo array", plistPath]);
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations:0:UTTypeConformsTo:0 string public.data", plistPath]);
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification dict", plistPath]);
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension array", plistPath]);
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:0 string vxz", plistPath]);
  run(plistBuddy, ["-c", "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.mime-type string application/x-vxz", plistPath]);
}
