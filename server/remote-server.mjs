import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import remoteApiModule from "./remote-api.cjs";
import vxzApiModule from "./vxz-api.cjs";

const PORT = Number(process.env.REMOTE_VIEWER_PORT ?? 5175);
const HOST = "127.0.0.1";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remoteApi = remoteApiModule.createRemoteApi();
const vxzApi = vxzApiModule.createVxzApi({
  projectRoot: PROJECT_ROOT,
  allowedOrigins: ["http://127.0.0.1:5173"],
});

const server = http.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (!request.url) {
    sendText(response, 400, "Missing URL");
    return;
  }

  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith("/api/vxz/")) {
    vxzApi.handle(request, response, url);
  } else if (url.pathname.startsWith("/api/remote/")) {
    remoteApi.handle(request, response, url);
  } else {
    sendText(response, 404, "Not found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`remote backend listening at http://${HOST}:${PORT}`);
});

function sendText(response, status, text) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}
