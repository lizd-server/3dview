module.exports = {
  apps: [
    {
      name: "voxel-viewer-backend",
      script: "server/remote-server.mjs",
      interpreter: "node",
      cwd: __dirname,
      env: {
        REMOTE_VIEWER_PORT: "5175",
      },
      autorestart: true,
      watch: false,
    },
    {
      name: "voxel-viewer-vite",
      script: "node_modules/vite/bin/vite.js",
      interpreter: "node",
      args: "--host 127.0.0.1",
      cwd: __dirname,
      autorestart: true,
      watch: false,
    },
  ],
};
