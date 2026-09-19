import { spawn } from "node:child_process";

const processes = [
  spawn(process.execPath, ["server/remote-server.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      REMOTE_VIEWER_HOST: process.env.REMOTE_VIEWER_HOST ?? "0.0.0.0",
    },
  }),
  spawn(process.execPath, ["./node_modules/vite/bin/vite.js", "--host", process.env.VITE_HOST ?? "0.0.0.0"], {
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
