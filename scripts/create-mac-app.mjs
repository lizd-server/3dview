import { spawnSync } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
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

run("swift", ["scripts/create-app-icon.swift"]);
run("npm", ["run", "build"]);
await rm(outDir, { recursive: true, force: true });

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
  `--executable-name=${appName}`,
  "--ignore=^/dist-mac($|/)",
  "--ignore=^/\\.git($|/)",
  "--ignore=^/\\.logs($|/)",
  "--ignore=^/node_modules/electron/dist($|/)",
], { env: { ...process.env, npm_config_yes: "true" } });

applyBundleIcon(appDir);
await rm(installDir, { recursive: true, force: true });
run("ditto", [appDir, installDir]);
applyBundleIcon(installDir);
await chmod(path.join(installDir, "Contents", "MacOS", appName), 0o755);
run("xattr", ["-dr", "com.apple.quarantine", installDir], { allowFailure: true });
run("touch", [installDir], { allowFailure: true });

console.log(`Created ${appDir}`);
console.log(`Installed ${installDir}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    env: options.env ?? process.env,
    stdio: "inherit",
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
}
