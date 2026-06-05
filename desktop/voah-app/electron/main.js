import { app, BrowserWindow, ipcMain } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildIntakeRunDir,
  createIntakeJobRecord,
  createIntakeJobRequest
} from "../src/lib/jobContracts.js";
import { runIntakeDryRunJob } from "./services/workerRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    title: "Voah 工作台",
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

ipcMain.handle("products:saveProfile", async (_event, productProfile) => {
  const slug = String(productProfile?.slug || "").trim();
  if (!slug) {
    throw new TypeError("productProfile.slug is required");
  }

  const productDir = path.join(app.getPath("userData"), "products", slug);
  const profilePath = path.join(productDir, "product_profile.json");
  await mkdir(productDir, { recursive: true });
  await writeFile(
    profilePath,
    `${JSON.stringify(
      {
        schema_version: "voah-product-profile.v1",
        saved_at: new Date().toISOString(),
        product: productProfile
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    schema_version: "voah-product-save-result.v1",
    status: "saved",
    persisted: true,
    product_slug: slug,
    product_profile_path: profilePath,
    message: "产品资料已保存到本机 userData。"
  };
});

ipcMain.handle("intake:createRun", async (_event, payload) => {
  const request = createIntakeJobRequest(payload);
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 14);
  const productSlug = request.product_id.replace(/^product_/, "").replaceAll("_", "-");
  const runDir = buildIntakeRunDir({
    cache_root: "cache",
    product_slug: productSlug,
    timestamp,
    run_label: request.run_label
  });
  const job = createIntakeJobRecord(request, {
    job_id: `intake_${timestamp}`,
    intake_run_id: `${productSlug}:${timestamp}_${request.run_label}`
  });
  const workerResult = await runIntakeDryRunJob({
    appDataDir: app.getPath("userData"),
    request,
    job,
    workspaceRoot: app.getPath("home"),
    cacheRoot: "cache",
    runDir
  });

  return {
    schema_version: "voah-intake-create-run-response.v1",
    accepted: workerResult.status === "succeeded",
    job,
    ...workerResult,
    note: "当前原型执行 dry-run worker，不调用模型、ffmpeg 或真实素材。"
  };
});

app.whenReady().then(() => {
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
