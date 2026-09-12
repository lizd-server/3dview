import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(process.env.HOME ?? "", "Applications", "Voxel Mesh Viewer.app");
const bundleId = "com.lizd.voxel-mesh-viewer";
const npyType = "com.lizd.numpy-array";
const launchServices = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const handlerScript = path.join(projectDir, "scripts", "set-default-file-handler.swift");

await Promise.all([access(appPath), access(handlerScript)]);
run(launchServices, ["-f", appPath]);
run("/usr/bin/swift", [handlerScript, bundleId, npyType, "npy"]);

console.log(`Registered ${appPath} as the default application for .npy files.`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}
