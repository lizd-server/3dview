import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const appPath = path.join(process.env.HOME ?? "", "Applications", "Voxel Mesh Viewer.app");
const bundleId = "com.lizd.voxel-mesh-viewer";
const vxzType = "com.lizd.ovoxel-vxz";
const launchServices = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const dutiCandidates = ["/opt/homebrew/bin/duti", "/usr/local/bin/duti"];

await access(appPath);
const duti = await firstAvailable(dutiCandidates);
if (!duti) {
  throw new Error("duti is required to set the default VXZ application");
}

run(launchServices, ["-f", appPath]);
run(duti, ["-s", bundleId, vxzType, "all"]);
run(duti, ["-x", "vxz"]);

async function firstAvailable(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next Homebrew prefix.
    }
  }
  return null;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}
