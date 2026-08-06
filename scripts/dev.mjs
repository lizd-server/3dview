import { spawn } from "node:child_process";

const processes = [
  spawn(process.execPath, ["server/remote-server.mjs"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, ["./node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], {
    stdio: "inherit",
  }),
];

let shuttingDown = false;

for (const child of processes) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const other of processes) {
      if (other !== child) {
        other.kill("SIGTERM");
      }
    }
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  shuttingDown = true;
  for (const child of processes) {
    child.kill(signal);
  }
}
