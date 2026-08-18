const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voxelMeshViewer", {
  onOpenVxzRequest(callback) {
    ipcRenderer.on("vxz:open-file-request", (_event, payload) => callback(payload));
  },
  openVxzFile(requestId, resolution) {
    return ipcRenderer.invoke("vxz:open-file-open", { requestId, resolution });
  },
  getVxzResolution() {
    return ipcRenderer.invoke("vxz:get-resolution");
  },
  setVxzResolution(resolution) {
    return ipcRenderer.invoke("vxz:set-resolution", resolution);
  },
  readyForOpenFiles() {
    ipcRenderer.send("vxz:renderer-ready");
  },
});
