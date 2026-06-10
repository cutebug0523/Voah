import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shell } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 仓库根：voah-studio 在 desktop/voah-studio，根目录上溯两层。
// 生产环境可由 VOAH_WORKSPACE 覆盖。
const WORKSPACE = process.env.VOAH_WORKSPACE || path.resolve(__dirname, "..", "..", "..");
const CLI_ENTRY = path.join(WORKSPACE, "cli", "src", "bin", "voah.js");
const BATCHES_DIR = path.join(WORKSPACE, "cache", "voah_batches");
const INTAKE_DIR = path.join(WORKSPACE, "cache", "voah_video_intake");

const STAGE_ORDER = ["copy", "tts", "retrieve", "subtitle", "render", "qa"];

export function registerVoahHandlers(ipcMain) {
  ipcMain.handle("voah:listProducts", () => listProducts());
  ipcMain.handle("voah:listBatches", () => listBatches());
  ipcMain.handle("voah:createBatch", (_e, params) => createBatch(params));
  ipcMain.handle("voah:retryTask", (_e, params) => retryTask(params));
  ipcMain.handle("voah:reveal", (_e, target) => revealPath(target));
}

// ---- 读取：产品与入库 run ----

async function listProducts() {
  if (!existsSync(INTAKE_DIR)) return [];
  const slugs = await safeReaddir(INTAKE_DIR);
  const products = [];
  for (const slug of slugs) {
    const productDir = path.join(INTAKE_DIR, slug);
    if (!(await isDir(productDir))) continue;
    const runs = (await safeReaddir(productDir))
      .filter((name) => existsSync(path.join(productDir, name, "shot_index.json")))
      .sort()
      .reverse();
    products.push({
      slug,
      name: slug,
      latest_intake_run: runs[0] ? path.join(productDir, runs[0]) : null,
      intake_run_count: runs.length
    });
  }
  return products;
}

// ---- 读取：批次与任务 ----

async function listBatches() {
  if (!existsSync(BATCHES_DIR)) return [];
  const batches = [];
  const productSlugs = await safeReaddir(BATCHES_DIR);
  for (const slug of productSlugs) {
    const slugDir = path.join(BATCHES_DIR, slug);
    if (!(await isDir(slugDir))) continue;
    for (const batchName of await safeReaddir(slugDir)) {
      const batchDir = path.join(slugDir, batchName);
      const manifestPath = path.join(batchDir, "batch_manifest.json");
      const manifest = await readJsonSafe(manifestPath);
      if (!manifest) continue;
      batches.push(await hydrateBatch(batchDir, manifest));
    }
  }
  // 新批次在前
  batches.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return batches;
}

async function hydrateBatch(batchDir, manifest) {
  const tasks = [];
  for (const t of manifest.tasks || []) {
    const taskDir = t.task_dir || (t.task_slug ? path.join(batchDir, t.task_slug) : null);
    const taskManifest = taskDir ? await readJsonSafe(path.join(taskDir, "task_manifest.json")) : null;
    tasks.push(summarizeTask(t, taskManifest, taskDir));
  }
  const counts = tallyTasks(tasks);
  return {
    batch_dir: batchDir,
    batch_id: manifest.batch_id || path.basename(batchDir),
    product_slug: manifest.product_slug || "",
    product_name: manifest.product_name || manifest.product_slug || "",
    label: manifest.label || "",
    target_duration_s: manifest.target_duration_s || null,
    status: manifest.status || "running",
    created_at: manifest.created_at || "",
    total: tasks.length,
    counts,
    tasks
  };
}

function summarizeTask(taskEntry, manifest, taskDir) {
  const stages = (manifest && manifest.stages) || {};
  const segments = STAGE_ORDER.map((stage) => ({
    stage,
    status: stages[stage]?.status || "pending"
  }));
  return {
    task_dir: taskDir,
    task_id: manifest?.task_id || taskEntry.task_id || path.basename(taskDir || ""),
    index: taskEntry.index ?? null,
    status: manifest?.status || taskEntry.status || "queued",
    qa_status: manifest?.qa?.status || "pending",
    current_stage: currentStage(segments),
    failed_stage: failedStage(segments),
    segments
  };
}

function currentStage(segments) {
  const running = segments.find((s) => s.status === "running");
  if (running) return running.stage;
  const pending = segments.find((s) => s.status === "pending" || s.status === "stale");
  return pending ? pending.stage : null;
}

function failedStage(segments) {
  return segments.find((s) => s.status === "failed")?.stage || null;
}

function tallyTasks(tasks) {
  const c = { queued: 0, running: 0, needs_review: 0, failed: 0, succeeded: 0 };
  for (const t of tasks) {
    if (t.status === "succeeded") c.succeeded += 1;
    else if (t.status === "failed") c.failed += 1;
    else if (t.status === "needs_review") c.needs_review += 1;
    else if (t.status === "running") c.running += 1;
    else c.queued += 1;
  }
  return c;
}

// ---- 写操作：调 voah CLI ----

function createBatch({ product, count, targetDuration, intakeRun, concurrency = 3, extraArgs = [] }) {
  const args = [
    "batch",
    "run",
    "--workspace",
    WORKSPACE,
    "--product",
    product,
    "--count",
    String(count),
    "--target-duration",
    String(targetDuration),
    "--concurrency",
    String(concurrency)
  ];
  if (intakeRun) args.push("--intake-run", intakeRun);
  args.push(...extraArgs);
  return runVoah(args);
}

function retryTask({ taskDir, fromStage }) {
  const args = ["task", "run", "--workspace", WORKSPACE, taskDir];
  if (fromStage) args.push("--from", fromStage);
  return runVoah(args);
}

function runVoah(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: WORKSPACE,
      env: { ...process.env }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => resolve({ ok: false, error: String(err.message || err) }));
    proc.on("close", (code) => {
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function revealPath(target) {
  if (target && existsSync(target)) {
    shell.showItemInFolder(target);
    return { ok: true };
  }
  return { ok: false, error: "路径不存在" };
}

// ---- 工具 ----

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
