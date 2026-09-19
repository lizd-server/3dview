module.exports = {
  apps: [
    {
      name: "voxel-viewer-backend",
      script: "server/remote-server.mjs",
      interpreter: "node",
      cwd: __dirname,
      env: {
        REMOTE_VIEWER_HOST: "0.0.0.0",
        REMOTE_VIEWER_PORT: "5175",
        LOCAL_VIEWER_ROOTS: `${__dirname}/temp_output`,
      },
      autorestart: true,
      watch: false,
    },
  ],
};
