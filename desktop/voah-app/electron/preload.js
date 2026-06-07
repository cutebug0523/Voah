import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("voah", {
  getState: () => ipcRenderer.invoke("voah:getState"),
  createBatch: (payload) => ipcRenderer.invoke("voah:createBatch", payload),
  runTask: (payload) => ipcRenderer.invoke("voah:runTask", payload),
  retryTask: (payload) => ipcRenderer.invoke("voah:retryTask", payload),
  revealPath: (path) => ipcRenderer.invoke("voah:revealPath", path),
  saveSettings: (payload) => ipcRenderer.invoke("voah:saveSettings", payload),
  saveModelKey: (payload) => ipcRenderer.invoke("voah:saveModelKey", payload),
  deleteModelKey: (payload) => ipcRenderer.invoke("voah:deleteModelKey", payload),
  validateModelKeys: (payload) => ipcRenderer.invoke("voah:validateModelKeys", payload)
});
