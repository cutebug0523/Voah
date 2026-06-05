import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("voah", {
  products: {
    saveProfile(productProfile) {
      return ipcRenderer.invoke("products:saveProfile", productProfile);
    }
  },
  intake: {
    createRun(payload) {
      return ipcRenderer.invoke("intake:createRun", payload);
    }
  }
});
