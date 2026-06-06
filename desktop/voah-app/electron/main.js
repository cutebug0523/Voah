import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StoreService } from "./services/storeService.js";
import { ProductionRecipe } from "./services/productionRecipe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../..");

let storeService;
let productionRecipe;

function getServices() {
  if (!storeService) {
    storeService = new StoreService({
      appDataDir: app.getPath("userData"),
      workspaceRoot
    });
    productionRecipe = new ProductionRecipe({ storeService });
  }
  return { storeService, productionRecipe };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "Voah 生产工作台",
    backgroundColor: "#f6f7f8",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

ipcMain.handle("voah:getState", async () => {
  const { storeService: store } = getServices();
  const data = await store.read();
  return {
    ...data,
    paths: store.getPaths()
  };
});

ipcMain.handle("voah:createBatch", async (_event, payload) => {
  const { productionRecipe: recipe } = getServices();
  const tasks = await recipe.createBatch(payload);
  return { schema_version: "voah-create-batch-response.v1", tasks };
});

ipcMain.handle("voah:runTask", async (_event, payload) => {
  const { productionRecipe: recipe } = getServices();
  return recipe.runTask(payload.task_id, { failStage: payload.fail_stage || null });
});

ipcMain.handle("voah:retryTask", async (_event, payload) => {
  const { productionRecipe: recipe } = getServices();
  return recipe.retryFailedTask(payload.task_id);
});

ipcMain.handle("voah:revealPath", async (_event, targetPath) => {
  if (!targetPath) {
    return { ok: false };
  }
  await shell.showItemInFolder(targetPath);
  return { ok: true };
});

app.whenReady().then(() => {
  getServices();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
