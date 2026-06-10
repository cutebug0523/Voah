const { contextBridge, ipcRenderer } = require("electron");

// 渲染层只能通过这个白名单接口访问主进程，不暴露 node。
contextBridge.exposeInMainWorld("voah", {
  listProducts: () => ipcRenderer.invoke("voah:listProducts"),
  listBatches: () => ipcRenderer.invoke("voah:listBatches"),
  taskDetail: (taskDir) => ipcRenderer.invoke("voah:taskDetail", taskDir),
  createBatch: (params) => ipcRenderer.invoke("voah:createBatch", params),
  retryTask: (params) => ipcRenderer.invoke("voah:retryTask", params),
  reveal: (target) => ipcRenderer.invoke("voah:reveal", target),
  openFile: (target) => ipcRenderer.invoke("voah:openFile", target)
});
