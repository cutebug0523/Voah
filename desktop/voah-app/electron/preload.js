import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("voah", {
  getState: () => ipcRenderer.invoke("voah:getState"),
  saveProduct: (payload) => ipcRenderer.invoke("voah:saveProduct", payload),
  startIntakeJob: (payload) => ipcRenderer.invoke("voah:startIntakeJob", payload),
  createBatch: (payload) => ipcRenderer.invoke("voah:createBatch", payload),
  runTask: (payload) => ipcRenderer.invoke("voah:runTask", payload),
  retryTask: (payload) => ipcRenderer.invoke("voah:retryTask", payload),
  previewTts: (payload) => ipcRenderer.invoke("voah:previewTts", payload),
  reviewOutput: (payload) => ipcRenderer.invoke("voah:reviewOutput", payload),
  revealPath: (path) => ipcRenderer.invoke("voah:revealPath", path),
  saveSettings: (payload) => ipcRenderer.invoke("voah:saveSettings", payload),
  saveModelKey: (payload) => ipcRenderer.invoke("voah:saveModelKey", payload),
  deleteModelKey: (payload) => ipcRenderer.invoke("voah:deleteModelKey", payload),
  validateModelKeys: (payload) => ipcRenderer.invoke("voah:validateModelKeys", payload)
});
