import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const declaredTypes = {
  npy: "com.lizd.numpy-array",
  vxz: "com.lizd.ovoxel-vxz",
};
const extension = process.argv[2]?.toLowerCase();
const declaredType = declaredTypes[extension];
if (!declaredType) {
  throw new Error(`Usage: node scripts/register-file-default.mjs <${Object.keys(declaredTypes).join("|")}>`);
}

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(process.env.HOME ?? "", "Applications", "Voxel Mesh Viewer.app");
const handlerScript = path.join(projectDir, "scripts", "set-default-file-handler.swift");
const launchServices = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

await Promise.all([access(appPath), access(handlerScript)]);
run(launchServices, ["-f", appPath]);
run("/usr/bin/swift", [
  handlerScript,
  "com.lizd.voxel-mesh-viewer",
  declaredType,
  extension,
]);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}
