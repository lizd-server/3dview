import { defineConfig } from "vite";

const backendPort = Number(process.env.REMOTE_VIEWER_PORT ?? 5175);

export default defineConfig({
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${backendPort}`,
    },
  },
});
