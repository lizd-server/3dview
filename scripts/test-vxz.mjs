import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fallbackPython = process.platform === "win32" ? "python.exe" : "python3";
const candidates = [
  process.env.VXZ_TEST_PYTHON,
  process.platform === "win32"
    ? path.join(projectDir, ".venv-vxz", "Scripts", "python.exe")
    : path.join(projectDir, ".venv-vxz", "bin", "python"),
  fallbackPython,
].filter(Boolean);
const python = candidates.find((candidate) => candidate === fallbackPython || existsSync(candidate));

if (!python) {
  throw new Error("Could not find Python for the VXZ test suite.");
}

const result = spawnSync(
  python,
  ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
  { cwd: projectDir, stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
