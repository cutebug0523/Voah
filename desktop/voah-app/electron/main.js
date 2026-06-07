import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StoreService } from "./services/storeService.js";
import { ProductionRecipe } from "./services/productionRecipe.js";
import { ModelKeyService } from "./services/modelKeyService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../..");

let storeService;
let productionRecipe;
let modelKeyService;

function getServices() {
  if (!storeService) {
    storeService = new StoreService({
      appDataDir: app.getPath("userData"),
      workspaceRoot
    });
    modelKeyService = new ModelKeyService({
      appDataDir: app.getPath("userData"),
      envPaths: [
        path.join(workspaceRoot, ".env"),
        path.join(app.getPath("home"), ".voah", "video_intake", ".env")
      ]
    });
    productionRecipe = new ProductionRecipe({ storeService, modelKeyService });
  }
  return { storeService, productionRecipe, modelKeyService };
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
  const { storeService: store, modelKeyService: keys } = getServices();
  const data = await store.read();
  const modelKeys = await keys.getPublicConfig();
  return {
    ...data,
    model_keys: modelKeys,
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

ipcMain.handle("voah:saveSettings", async (_event, payload = {}) => {
  const { storeService: store } = getServices();
  const next = await store.mutate(async (draft) => {
    draft.settings = {
      ...(draft.settings || {}),
      ...(payload.settings || {})
    };
    if (payload.settings?.copy) {
      draft.settings.copy = {
        ...(draft.settings.copy || {}),
        ...payload.settings.copy
      };
    }
    if (payload.settings?.tts) {
      draft.settings.tts = {
        ...(draft.settings.tts || {}),
        ...payload.settings.tts,
        voice_modify: {
          ...(draft.settings.tts?.voice_modify || {}),
          ...(payload.settings.tts.voice_modify || {})
        }
      };
    }
    if (payload.settings?.subtitle) {
      draft.settings.subtitle = {
        ...(draft.settings.subtitle || {}),
        ...payload.settings.subtitle
      };
    }
    return draft;
  });
  return { schema_version: "voah-save-settings-response.v1", settings: next.settings };
});

ipcMain.handle("voah:saveModelKey", async (_event, payload) => {
  const { modelKeyService: keys } = getServices();
  return keys.saveModuleKey(payload.module_id, payload.key);
});

ipcMain.handle("voah:deleteModelKey", async (_event, payload) => {
  const { modelKeyService: keys } = getServices();
  return keys.deleteModuleKey(payload.module_id);
});

ipcMain.handle("voah:validateModelKeys", async (_event, payload = {}) => {
  const { modelKeyService: keys } = getServices();
  return keys.validateRequiredKeys(payload.module_ids || []);
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
