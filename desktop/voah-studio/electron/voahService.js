import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dialog, shell } from "electron";
import { SecretService } from "../../../cli/src/services/secretService.js";
import { FALLBACK_TTS_VOICES, FONT_OPTIONS, VOICE_NAME_ZH } from "../src/lib/studioOptions.js";
import { elapsedSeconds, intakeStatusLabel, normalizeIntakeStatus, summarizeIntakeRuns } from "./intakeStatus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 仓库根：voah-studio 在 desktop/voah-studio，根目录上溯两层。
// 生产环境可由 VOAH_WORKSPACE 覆盖。
const WORKSPACE = process.env.VOAH_WORKSPACE || path.resolve(__dirname, "..", "..", "..");
const CLI_ENTRY = path.join(WORKSPACE, "cli", "src", "bin", "voah.js");
const PRODUCTS_DIR = path.join(WORKSPACE, "data", "products");
const BATCHES_DIR = path.join(WORKSPACE, "cache", "voah_batches");
const TASKS_DIR = path.join(WORKSPACE, "cache", "voah_tasks");
const INTAKE_DIR = path.join(WORKSPACE, "cache", "voah_video_intake");
const STUDIO_DIR = path.join(os.homedir(), ".voah");
const STUDIO_SETTINGS_PATH = path.join(STUDIO_DIR, "studio_settings.json");
const STUDIO_REVIEW_PATH = path.join(STUDIO_DIR, "studio_reviews.json");

const STAGE_ORDER = ["copy", "tts", "retrieve", "subtitle", "render", "qa"];
const MODEL_MODULES = [
  { id: "material_understanding", module: "素材理解", model: "qwen3.5-omni-plus", config_key: "dashscope.api_key" },
  { id: "material_vectorization", module: "素材向量化", model: "qwen3-vl-embedding", config_key: "dashscope.api_key" },
  { id: "material_retrieval", module: "素材召回", model: "qwen3-vl-embedding", config_key: "dashscope.api_key" },
  { id: "copy_generation", module: "文案生成", model: "MiniMax-M3", config_key: "minimax.api_key" },
  { id: "selection_planner", module: "选片计划", model: "MiniMax-M3", config_key: "minimax.api_key" },
  { id: "tts_primary", module: "TTS", model: "speech-2.8-hd", config_key: "minimax.api_key" },
  { id: "tts_fallback", module: "TTS备用", model: "speech-2.8-hd", config_key: "vectorengine.api_key" }
];

export function registerVoahHandlers(ipcMain) {
  ipcMain.handle("voah:listProducts", () => listProducts());
  ipcMain.handle("voah:listTaskCenter", () => listTaskCenter());
  ipcMain.handle("voah:inspectProduct", (_e, slug) => inspectProduct(slug));
  ipcMain.handle("voah:createProduct", (_e, params) => createProduct(params));
  ipcMain.handle("voah:saveProductDetail", (_e, params) => saveProductDetail(params));
  ipcMain.handle("voah:listIntakeRuns", (_e, slug) => listIntakeRuns(slug));
  ipcMain.handle("voah:startIntake", (_e, params) => startIntake(params));
  ipcMain.handle("voah:chooseDirectory", () => chooseDirectory());

  ipcMain.handle("voah:listBatches", () => listBatches());
  ipcMain.handle("voah:taskDetail", (_e, taskDir) => taskDetail(taskDir));
  ipcMain.handle("voah:createBatch", (_e, params) => createBatch(params));
  ipcMain.handle("voah:retryTask", (_e, params) => retryTask(params));
  ipcMain.handle("voah:pauseBatch", (_e, batchDir) => pauseBatch(batchDir));
  ipcMain.handle("voah:resumeBatch", (_e, batchDir) => resumeBatch(batchDir));
  ipcMain.handle("voah:readTaskLog", (_e, params) => readTaskLog(params));

  ipcMain.handle("voah:listOutputs", () => listOutputs());
  ipcMain.handle("voah:saveReview", (_e, params) => saveReview(params));

  ipcMain.handle("voah:getConfig", () => getConfig());
  ipcMain.handle("voah:setConfig", (_e, params) => setConfig(params));
  ipcMain.handle("voah:getStudioSettings", () => getStudioSettings());
  ipcMain.handle("voah:saveStudioSettings", (_e, params) => saveStudioSettings(params));
  ipcMain.handle("voah:listTtsVoices", () => listTtsVoices());
  ipcMain.handle("voah:listSubtitleFonts", () => listSubtitleFonts());
  ipcMain.handle("voah:installSubtitleFont", (_e, fontId) => installSubtitleFont(fontId));

  ipcMain.handle("voah:createSampleTask", (_e, params) => createSampleTask(params));
  ipcMain.handle("voah:runCopyStage", (_e, taskDir) => runCopyStage(taskDir));
  ipcMain.handle("voah:runTtsStage", (_e, taskDir) => runTtsStage(taskDir));
  ipcMain.handle("voah:ttsPreview", (_e, params) => ttsPreview(params));
  ipcMain.handle("voah:saveVoiceScript", (_e, params) => saveVoiceScript(params));

  ipcMain.handle("voah:reveal", (_e, target) => revealPath(target));
  ipcMain.handle("voah:openFile", (_e, target) => openFile(target));
}

// ---- 产品与入库 ----

async function listProducts() {
  const bySlug = new Map();

  for (const slug of await safeReaddir(PRODUCTS_DIR)) {
    const productDir = path.join(PRODUCTS_DIR, slug);
    if (!(await isDir(productDir))) continue;
    const product = (await readJsonSafe(path.join(productDir, "product.json"))) || {};
    bySlug.set(slug, {
      slug,
      name: product.name || slug,
      brand: product.brand || "",
      product_dir: productDir,
      latest_intake_run: null,
      intake_run_count: 0,
      status: "pending_intake"
    });
  }

  for (const slug of await safeReaddir(INTAKE_DIR)) {
    const productDir = path.join(INTAKE_DIR, slug);
    if (!(await isDir(productDir))) continue;
    const runs = await intakeRunsForSlug(slug);
    const existing = bySlug.get(slug) || {
      slug,
      name: slug,
      brand: "",
      product_dir: path.join(PRODUCTS_DIR, slug)
    };
    const mergedRun = runs.find((run) => run.name === "_merged" && run.ready);
    const latestReady = mergedRun || runs.find((run) => run.ready && !run.system);
    const running = runs.some((run) => ["running", "stalled"].includes(run.status));
    const failed = runs.some((run) => run.status === "failed");
    bySlug.set(slug, {
      ...existing,
      latest_intake_run: latestReady?.run_dir || null,
      intake_run_count: runs.filter((run) => run.ready && !run.system).length,
      intake_summary: summarizeIntakeRuns(runs),
      status: running
        ? "intaking"
        : latestReady
          ? "ready"
          : failed
            ? "intake_failed"
            : "pending_intake"
    });
  }

  const products = [...bySlug.values()];
  products.sort((a, b) => {
    const rank = { intaking: 0, intake_failed: 1, ready: 2, pending_intake: 3 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  return products;
}

async function inspectProduct(slug) {
  if (!slug) return { ok: false, error: "缺少产品 slug" };
  const productDir = path.join(PRODUCTS_DIR, slug);
  const intake_runs = await intakeRunsForSlug(slug);
  const inferredRun = intake_runs.find((run) => run.name === "_merged" && run.ready) || intake_runs.find((run) => run.ready);
  const inferred = await inferProductContext(inferredRun?.run_dir);
  const product = await readJsonSafe(path.join(productDir, "product.json"));
  const claims = await readJsonSafe(path.join(productDir, "claims.json"));
  const campaigns = await readJsonSafe(path.join(productDir, "campaigns.json"));
  const blockedTerms = await readJsonSafe(path.join(productDir, "blocked_terms.json"));
  return {
    ok: true,
    product_dir: productDir,
    product,
    claims: textPayloadWithInitial(claims, inferred.claims, "voah.product_claims.v1", "claims"),
    campaigns: textPayloadWithInitial(campaigns, inferred.campaigns, "voah.product_campaigns.v1", "campaigns"),
    blocked_terms: textPayloadWithInitial(blockedTerms, [], "voah.blocked_terms.v1", "terms"),
    intake_runs
  };
}

async function createProduct({ slug, name, brand }) {
  const args = ["product", "create", "--workspace", WORKSPACE, "--slug", slug || ""];
  if (name) args.push("--name", name);
  if (brand) args.push("--brand", brand);
  return runVoah(args);
}

async function saveProductDetail({ slug, product, claims, campaigns, blockedTerms }) {
  if (!slug) return { ok: false, error: "缺少产品 slug" };
  const productDir = path.join(PRODUCTS_DIR, slug);
  await fs.mkdir(productDir, { recursive: true });
  await writeJson(path.join(productDir, "product.json"), {
    schema_version: "voah.product.v1",
    slug,
    name: product?.name || slug,
    brand: product?.brand || "",
    cta: product?.cta || "",
    created_at: product?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  await writeJson(path.join(productDir, "claims.json"), {
    schema_version: "voah.product_claims.v1",
    claims: normalizeTextList(claims).map((text) => ({ text })),
    updated_at: new Date().toISOString()
  });
  await writeJson(path.join(productDir, "campaigns.json"), {
    schema_version: "voah.product_campaigns.v1",
    campaigns: normalizeTextList(campaigns).map((text) => ({ text })),
    updated_at: new Date().toISOString()
  });
  await writeJson(path.join(productDir, "blocked_terms.json"), {
    schema_version: "voah.blocked_terms.v1",
    terms: normalizeTextList(blockedTerms).map((text) => ({ text })),
    updated_at: new Date().toISOString()
  });
  return { ok: true };
}

async function listIntakeRuns(slug) {
  return intakeRunsForSlug(slug);
}

async function startIntake({ product, productName, sourceDir, limit, label, extraArgs = [] }) {
  const args = [
    "intake",
    "add",
    "--workspace",
    WORKSPACE,
    "--product",
    product || "",
    "--source-dir",
    sourceDir || "",
    "--label",
    label || `studio_intake_${Date.now()}`
  ];
  if (productName) args.push("--product-name", productName);
  if (limit) args.push("--limit", String(limit));
  args.push(...extraArgs);
  return runVoahDetached(args);
}

async function chooseDirectory() {
  const result = await dialog.showOpenDialog({
    title: "选择素材目录",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0] };
}

async function intakeRunsForSlug(slug) {
  if (!slug) return [];
  const dir = path.join(INTAKE_DIR, slug);
  const runs = [];
  for (const name of await safeReaddir(dir)) {
    const runDir = path.join(dir, name);
    if (!(await isDir(runDir))) continue;
    if (name === "_jobs") {
      runs.push(...(await intakeJobsForSlug(slug, runDir)));
      continue;
    }
    const shotIndex = await readJsonSafe(path.join(runDir, "shot_index.json"));
    const statusPayload = await readJsonSafe(path.join(runDir, "desktop_intake_status.json"));
    const result = await readJsonSafe(path.join(runDir, "desktop_intake_result.json"));
    const manifest =
      (await readJsonSafe(path.join(runDir, "run_manifest.json"))) ||
      (await readJsonSafe(path.join(runDir, "intake_manifest.json"))) ||
      {};
    const ready = Boolean(shotIndex);
    const status = normalizeIntakeStatus({ ready, statusPayload, result, manifest });
    const updatedAt = statusPayload?.updated_at || result?.finished_at || manifest.updated_at || manifest.finished_at || manifest.created_at || "";
    runs.push({
      run_dir: runDir,
      name,
      ready,
      system: name.startsWith("_"),
      status,
      current_stage: statusPayload?.current_stage || "",
      stage_label: statusPayload?.stage_label || intakeStatusLabel(status),
      progress: statusPayload?.progress || {},
      incremental: result?.incremental || statusPayload?.incremental || {},
      error: result?.error || statusPayload?.error || manifest.error || null,
      logs: statusPayload?.logs || result?.logs || manifest.logs || {},
      shot_count: Array.isArray(shotIndex?.shots) ? shotIndex.shots.length : Array.isArray(shotIndex?.records) ? shotIndex.records.length : null,
      created_at: statusPayload?.started_at || result?.created_at || manifest.created_at || manifest.started_at || "",
      updated_at: updatedAt,
      elapsed_s: elapsedSeconds(statusPayload?.started_at || manifest.created_at || "", updatedAt)
    });
  }
  runs.sort((a, b) => b.name.localeCompare(a.name));
  return runs;
}

async function intakeJobsForSlug(slug, jobsDir) {
  const jobs = [];
  for (const jobId of await safeReaddir(jobsDir)) {
    const jobDir = path.join(jobsDir, jobId);
    if (!(await isDir(jobDir))) continue;
    const statusPayload = await readJsonSafe(path.join(jobDir, "desktop_intake_status.json"));
    const result = await readJsonSafe(path.join(jobDir, "desktop_intake_result.json"));
    if (!statusPayload && !result) continue;
    const runDir = statusPayload?.run_dir || result?.outputs?.run_dir || jobDir;
    const ready = Boolean(result?.outputs?.merged_shot_index || result?.outputs?.shot_index);
    const status = normalizeIntakeStatus({ ready, statusPayload, result, manifest: {} });
    jobs.push({
      run_dir: runDir || jobDir,
      name: jobId,
      ready: false,
      system: true,
      status,
      current_stage: statusPayload?.current_stage || "",
      stage_label: statusPayload?.stage_label || intakeStatusLabel(status),
      progress: statusPayload?.progress || {},
      incremental: result?.incremental || statusPayload?.incremental || {},
      error: result?.error || statusPayload?.error || null,
      logs: statusPayload?.logs || result?.logs || {},
      shot_count: null,
      created_at: statusPayload?.started_at || result?.created_at || "",
      updated_at: statusPayload?.updated_at || result?.finished_at || "",
      elapsed_s: elapsedSeconds(statusPayload?.started_at || result?.created_at || "", statusPayload?.updated_at || result?.finished_at || ""),
      product_slug: slug
    });
  }
  return jobs;
}

async function inferProductContext(runDir) {
  if (!runDir) return { claims: [], campaigns: [] };
  const payloads = await Promise.all(
    ["segments.json", "assets.json", "shots.json", "shot_index.json"].map((name) => readJsonSafe(path.join(runDir, name)))
  );
  const claims = [];
  const campaigns = [];
  for (const payload of payloads) {
    for (const item of flattenRecords(payload)) {
      collectTextValues(item?.selling_points, claims);
      collectTextValues(item?.full_video_summary?.selling_points, claims);
      collectTextValues(item?.omni_summary?.selling_points, claims);
      collectCampaignCandidates(item, campaigns);
    }
  }
  return {
    claims: uniqueText(claims).slice(0, 12),
    campaigns: uniqueText(campaigns).slice(0, 8)
  };
}

function flattenRecords(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const key of ["records", "segments", "shots", "assets"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [payload];
}

function collectTextValues(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, output);
    return;
  }
  if (value && typeof value === "object") {
    collectTextValues(value.text || value.claim || value.name || value.term || value.title, output);
    return;
  }
  const text = String(value || "").trim();
  if (text) output.push(text);
}

function collectCampaignCandidates(item, output) {
  const fields = [
    item?.source_asr,
    item?.source_meaning,
    item?.visual_summary,
    item?.full_video_summary?.source_asr,
    item?.full_video_summary?.source_meaning,
    item?.omni_summary?.source_asr,
    item?.omni_summary?.source_meaning
  ];
  for (const field of fields) {
    const text = String(field || "");
    if (!text) continue;
    for (const sentence of text.split(/[。！？!?；;\n]/)) {
      const line = sentence.trim();
      if (/(直播间|活动|下单|拍下|到手|赠|礼盒|套装|优惠|福利|券|价格|自用送人)/.test(line)) {
        output.push(line);
      }
    }
  }
}

function uniqueText(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const text = String(item || "").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function textPayloadWithInitial(payload, initial, schemaVersion, key) {
  if (payload) return payload;
  const existing = Array.isArray(payload?.[key]) ? payload[key] : [];
  if (existing.length) return payload;
  return {
    ...(payload || {}),
    schema_version: payload?.schema_version || schemaVersion,
    [key]: uniqueText(initial).map((text) => ({ text }))
  };
}

// ---- 批次与任务 ----

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
    paused: Boolean(manifest.control?.paused),
    created_at: manifest.created_at || "",
    updated_at: manifest.updated_at || "",
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

async function taskDetail(taskDir) {
  if (!taskDir || !existsSync(taskDir)) return { ok: false, error: "任务目录不存在" };
  const manifest = await readJsonSafe(path.join(taskDir, "task_manifest.json"));
  const full = await readJsonSafe(path.join(taskDir, "full_pipeline_manifest.json"));
  const voiceScript = await readJsonSafe(path.join(taskDir, "voice_script.json"));
  const ttsAudio = await readJsonSafe(path.join(taskDir, "tts_audio.json"));
  const stages = (manifest && manifest.stages) || {};
  const segments = STAGE_ORDER.map((stage) => ({ stage, status: stages[stage]?.status || "pending" }));

  const finalVideoRel = manifest?.active_artifacts?.final_subtitled || "hyperframes_subtitle_burn/final_subtitled.mp4";
  const finalVideo = path.join(taskDir, finalVideoRel);
  const previewNoSub = path.join(taskDir, "preview_no_subtitles.mp4");
  const voiceWav = path.join(taskDir, "voice.wav");

  const qa = (full && (full.qa || full.export_gate)) || manifest?.qa || {};

  return {
    ok: true,
    task_dir: taskDir,
    task_id: manifest?.task_id || path.basename(taskDir),
    status: manifest?.status || "queued",
    target_duration_s: manifest?.target_duration_s ?? null,
    product_name: manifest?.product_name || manifest?.product_slug || "",
    segments,
    failed_stage: failedStage(segments),
    final_video: existsSync(finalVideo) ? finalVideo : null,
    preview_no_subtitles: existsSync(previewNoSub) ? previewNoSub : null,
    voice_wav: existsSync(voiceWav) ? voiceWav : null,
    voice_script: voiceScript,
    tts_audio: ttsAudio,
    qa: {
      status: qa.status || "pending",
      warnings: Array.isArray(qa.warnings) ? qa.warnings : [],
      resolved_warnings: Array.isArray(qa.resolved_warnings) ? qa.resolved_warnings : []
    }
  };
}

function tallyTasks(tasks) {
  const c = { queued: 0, running: 0, needs_review: 0, failed: 0, succeeded: 0 };
  for (const t of tasks) {
    if (["succeeded", "completed"].includes(t.status)) c.succeeded += 1;
    else if (t.status === "failed") c.failed += 1;
    else if (t.status === "needs_review") c.needs_review += 1;
    else if (t.status === "running") c.running += 1;
    else c.queued += 1;
  }
  return c;
}

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

function pauseBatch(batchDir) {
  return runVoah(["batch", "pause", "--workspace", WORKSPACE, batchDir]);
}

function resumeBatch(batchDir) {
  return runVoah(["batch", "resume", "--workspace", WORKSPACE, batchDir]);
}

async function readTaskLog({ taskDir, stage, maxBytes = 60000 }) {
  if (!taskDir || !existsSync(taskDir)) return { ok: false, error: "任务目录不存在" };
  const logsDir = path.join(taskDir, "logs");
  const candidates = logCandidates(logsDir, stage);
  const files = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    files.push({
      file,
      name: path.basename(file),
      text: await readTail(file, maxBytes)
    });
  }
  return { ok: true, task_dir: taskDir, stage: stage || "", files };
}

function logCandidates(logsDir, stage) {
  const names = stage
    ? [`${stage}.jsonl`, `${stage}.stdout.log`, `${stage}.stderr.log`, `${stage}_stdout.log`, `${stage}_stderr.log`]
    : [];
  return [
    ...names.map((name) => path.join(logsDir, name)),
    path.join(logsDir, "stdout.log"),
    path.join(logsDir, "stderr.log"),
    path.join(logsDir, "task.stdout.log"),
    path.join(logsDir, "task.stderr.log")
  ];
}

// ---- 成品库 ----

async function listOutputs() {
  const reviews = await readJsonSafe(STUDIO_REVIEW_PATH) || { reviews: {} };
  const tasks = [];
  for (const taskDir of await collectTaskDirs()) {
    const manifest = await readJsonSafe(path.join(taskDir, "task_manifest.json"));
    if (!manifest) continue;
    const status = manifest.status || "queued";
    const finalVideoRel = manifest.active_artifacts?.final_subtitled || "hyperframes_subtitle_burn/final_subtitled.mp4";
    const finalVideo = path.join(taskDir, finalVideoRel);
    const hasVideo = existsSync(finalVideo);
    if (!hasVideo && !["succeeded", "completed", "needs_review"].includes(status)) continue;
    tasks.push({
      task_dir: taskDir,
      task_id: manifest.task_id || path.basename(taskDir),
      product_slug: manifest.product_slug || "",
      product_name: manifest.product_name || manifest.product_slug || "",
      label: manifest.label || "",
      status,
      qa_status: manifest.qa?.status || "pending",
      target_duration_s: manifest.target_duration_s || null,
      final_video: hasVideo ? finalVideo : null,
      review: reviews.reviews?.[taskDir] || null,
      updated_at: manifest.updated_at || manifest.created_at || ""
    });
  }
  tasks.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return tasks;
}

async function saveReview({ taskDir, decision, note }) {
  if (!taskDir || !existsSync(taskDir)) return { ok: false, error: "任务目录不存在" };
  const payload = (await readJsonSafe(STUDIO_REVIEW_PATH)) || { schema_version: "voah.studio_reviews.v1", reviews: {} };
  payload.reviews ||= {};
  payload.reviews[taskDir] = {
    task_dir: taskDir,
    decision,
    note: note || "",
    updated_at: new Date().toISOString()
  };
  await writeJson(STUDIO_REVIEW_PATH, payload);
  return { ok: true, review: payload.reviews[taskDir] };
}

async function collectTaskDirs() {
  const dirs = [];
  for (const product of await safeReaddir(TASKS_DIR)) {
    const productDir = path.join(TASKS_DIR, product);
    if (!(await isDir(productDir))) continue;
    for (const run of await safeReaddir(productDir)) {
      const taskDir = path.join(productDir, run);
      if (existsSync(path.join(taskDir, "task_manifest.json"))) dirs.push(taskDir);
    }
  }
  for (const product of await safeReaddir(BATCHES_DIR)) {
    const productDir = path.join(BATCHES_DIR, product);
    if (!(await isDir(productDir))) continue;
    for (const batch of await safeReaddir(productDir)) {
      const tasksRoot = path.join(productDir, batch, "tasks");
      for (const task of await safeReaddir(tasksRoot)) {
        const taskDir = path.join(tasksRoot, task);
        if (existsSync(path.join(taskDir, "task_manifest.json"))) dirs.push(taskDir);
      }
    }
  }
  return [...new Set(dirs)];
}

// ---- 任务中心 ----

async function listTaskCenter() {
  const [products, batches, outputs] = await Promise.all([listProducts(), listBatches(), listOutputs()]);
  const intakeTasks = [];
  for (const product of products) {
    const runs = await intakeRunsForSlug(product.slug);
    for (const run of runs) {
      if (!["running", "stalled", "failed"].includes(run.status)) continue;
      intakeTasks.push({
        id: `intake:${product.slug}:${run.name}`,
        kind: "intake",
        kind_label: "入库",
        product_slug: product.slug,
        product_name: product.name,
        title: product.name,
        status: run.status,
        stage_label: run.stage_label || intakeStatusLabel(run.status),
        progress: normalizeProgress(run.progress),
        elapsed_s: run.elapsed_s,
        updated_at: run.updated_at,
        target_path: run.run_dir,
        error: run.error?.message || ""
      });
    }
  }

  const running = [];
  const needsAttention = [];
  for (const task of intakeTasks) {
    if (["running", "stalled"].includes(task.status)) running.push(task);
    if (["failed", "stalled"].includes(task.status)) needsAttention.push(task);
  }

  for (const batch of batches) {
    for (const task of batch.tasks || []) {
      const item = {
        id: `task:${task.task_dir}`,
        kind: "video",
        kind_label: "出片",
        product_slug: batch.product_slug,
        product_name: batch.product_name,
        title: `${batch.product_name || batch.product_slug} #${task.index || ""}`.trim(),
        status: task.status,
        stage_label: taskStageLabel(task.current_stage || task.failed_stage),
        progress: batchProgress(batch, task),
        elapsed_s: null,
        updated_at: batch.updated_at || batch.created_at || "",
        target_path: task.task_dir,
        error: task.failed_stage ? taskStageLabel(task.failed_stage) : ""
      };
      if (task.status === "running" || task.status === "queued") running.push(item);
      if (task.status === "failed" || task.status === "needs_review") needsAttention.push(item);
    }
  }

  const summary = {
    target: 150,
    succeeded: outputs.filter((item) => ["succeeded", "completed"].includes(item.status)).length,
    needs_review: outputs.filter((item) => item.status === "needs_review" || item.qa_status === "manual_review").length,
    failed: needsAttention.filter((item) => item.status === "failed").length,
    running: running.length,
    total: outputs.length
  };

  return {
    ok: true,
    summary,
    running: sortTasks(running),
    needs_attention: sortTasks(needsAttention),
    recent_outputs: outputs.slice(0, 8).map((item) => ({
      id: `output:${item.task_dir}`,
      kind: "output",
      kind_label: "成片",
      product_slug: item.product_slug,
      product_name: item.product_name,
      title: item.label || item.product_name || item.product_slug,
      status: item.status,
      stage_label: item.qa_status === "ok" ? "完成" : "待审",
      updated_at: item.updated_at,
      target_path: item.final_video || item.task_dir,
      final_video: item.final_video
    }))
  };
}

function sortTasks(items) {
  return [...items].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

function normalizeProgress(progress = {}) {
  const total = Number(progress.total || 0);
  const processed = Number(progress.processed || 0);
  const percent = Number(progress.percent || (total > 0 ? Math.round((processed / total) * 100) : 0));
  return { total, processed, percent: Math.max(0, Math.min(100, percent || 0)) };
}

function batchProgress(batch, task) {
  if (task.status === "running") return { processed: batch.counts.succeeded, total: batch.total, percent: Math.round((batch.counts.succeeded / Math.max(1, batch.total)) * 100) };
  if (task.status === "queued") return { processed: batch.counts.succeeded, total: batch.total, percent: 0 };
  return { processed: 1, total: 1, percent: 100 };
}

function taskStageLabel(stage) {
  return {
    copy: "文案",
    tts: "配音",
    retrieve: "选素材",
    subtitle: "字幕",
    render: "渲染",
    qa: "质检"
  }[stage] || "处理中";
}

// ---- 设置 ----

async function getConfig() {
  const result = await runVoah(["config", "get", "--workspace", WORKSPACE]);
  const configured = parseJsonFromText(result.stdout) || {};
  const secretStatus = configured.secrets || configured;
  return {
    ok: result.ok,
    configured,
    modules: MODEL_MODULES.map((item) => ({
      ...item,
      configured: Boolean(secretStatus[item.config_key] || secretStatus[item.id])
    })),
    stderr: result.stderr
  };
}

function setConfig({ key, value }) {
  if (!key || !value) return { ok: false, error: "缺少 key 或 value" };
  return runVoah(["config", "set", key, "--workspace", WORKSPACE], { stdin: String(value) });
}

async function listTtsVoices() {
  const fallback = FALLBACK_TTS_VOICES.map(normalizeVoiceOption);
  try {
    const apiKey = await readSecret("minimax.api_key");
    if (!apiKey) {
      return {
        ok: true,
        source: "fallback",
        voices: fallback,
        warning: "MiniMax Key 未配置，使用内置音色表"
      };
    }
    const response = await fetch("https://api.minimax.io/v1/get_voice", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ voice_type: "system" })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.base_resp?.status_code) {
      return {
        ok: true,
        source: "fallback",
        voices: fallback,
        warning: payload?.base_resp?.status_msg || `MiniMax 音色接口返回 ${response.status}`
      };
    }
    const remote = Array.isArray(payload.system_voice) ? payload.system_voice.map(normalizeVoiceOption) : [];
    const merged = mergeVoices(fallback, remote);
    return { ok: true, source: "minimax", voices: merged };
  } catch (error) {
    return {
      ok: true,
      source: "fallback",
      voices: fallback,
      warning: String(error?.message || error)
    };
  }
}

async function listSubtitleFonts() {
  return {
    ok: true,
    fonts: FONT_OPTIONS.map((font) => {
      const installed_path = installedFontPath(font);
      return {
        ...font,
        installed: Boolean(installed_path),
        installed_path
      };
    })
  };
}

async function installSubtitleFont(fontId) {
  const font = FONT_OPTIONS.find((item) => item.id === fontId);
  if (!font) return { ok: false, error: "未知字体" };
  const existing = installedFontPath(font);
  if (existing) return { ok: true, installed_path: existing, already_installed: true };
  if (!font.install?.urls?.length) return { ok: false, error: "该字体没有可用安装源" };

  const fontsDir = path.join(os.homedir(), "Library", "Fonts");
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `voah-font-${font.id}-`));
  await fs.mkdir(fontsDir, { recursive: true });
  try {
    const downloaded = await downloadFirst(font.install.urls, tmpRoot, font.install.type === "zip" ? "font.zip" : font.install.file_name);
    let source = downloaded;
    if (font.install.type === "zip") {
      source = await extractFontFromZip(downloaded, tmpRoot, font.install.archive_match);
    }
    const output = path.join(fontsDir, font.install.file_name || path.basename(source));
    await fs.copyFile(source, output);
    return { ok: true, installed_path: output };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function getStudioSettings() {
  const settings = await readJsonSafe(STUDIO_SETTINGS_PATH);
  return mergeStudioSettings(settings);
}

async function saveStudioSettings(settings) {
  const payload = mergeStudioSettings(settings);
  payload.schema_version = "voah.studio_settings.v1";
  payload.updated_at = new Date().toISOString();
  await writeJson(STUDIO_SETTINGS_PATH, payload);
  return { ok: true, settings: payload };
}

function defaultStudioSettings() {
  return {
    schema_version: "voah.studio_settings.v1",
    copy: {
      platform: "抖音",
      style: "",
      audience: "",
      forbidden: "",
      cta: ""
    },
    tts: {
      provider: "minimax-official",
      model: "speech-2.8-hd",
      voice_id: "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
      voice_label: "当前默认音色",
      speed: 1.1,
      vol: 1,
      emotion: "happy",
      pitch: 0,
      modify_pitch: 20,
      intensity: 20,
      timbre: 0
    },
    subtitle: {
      preset: "songti_white_gold_lower",
      font: "",
      font_source: "/System/Library/Fonts/Supplemental/Songti.ttc",
      font_label: "系统宋体"
    }
  };
}

function mergeStudioSettings(settings) {
  const defaults = defaultStudioSettings();
  const source = settings || {};
  return {
    ...defaults,
    ...source,
    copy: {
      ...defaults.copy,
      ...(source.copy || {})
    },
    tts: {
      ...defaults.tts,
      ...(source.tts || {})
    },
    subtitle: {
      ...defaults.subtitle,
      ...(source.subtitle || {}),
      preset: source.subtitle?.preset === "方案1" ? "songti_white_gold_lower" : source.subtitle?.preset || defaults.subtitle.preset
    }
  };
}

// ---- 精修打样 ----

function createSampleTask({ product, productName, targetDuration, intakeRun, extraArgs = [] }) {
  const args = [
    "task",
    "create",
    "--workspace",
    WORKSPACE,
    "--product",
    product || "",
    "--target-duration",
    String(targetDuration || 45),
    "--label",
    "studio_sample"
  ];
  if (productName) args.push("--product-name", productName);
  if (intakeRun) args.push("--intake-run", intakeRun);
  args.push(...extraArgs);
  return runVoah(args);
}

function runCopyStage(taskDir) {
  return runVoah(["copy", "run", "--workspace", WORKSPACE, taskDir]);
}

function runTtsStage(taskDir) {
  return runVoah(["tts", "run", "--workspace", WORKSPACE, taskDir]);
}

function ttsPreview({ text, provider, model, voiceId, speed, vol, voiceSettingPitch, modifyPitch, emotion, intensity, timbre }) {
  const args = ["tts", "preview", "--workspace", WORKSPACE, "--text", text || ""];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (voiceId) args.push("--voice-id", voiceId);
  if (speed) args.push("--speed", String(speed));
  if (vol) args.push("--vol", String(vol));
  if (voiceSettingPitch !== undefined) args.push("--pitch", String(voiceSettingPitch));
  if (emotion) args.push("--emotion", emotion);
  if (modifyPitch !== undefined) args.push("--modify-pitch", String(modifyPitch));
  if (intensity !== undefined) args.push("--modify-intensity", String(intensity));
  if (timbre !== undefined) args.push("--modify-timbre", String(timbre));
  return runVoah(args).then(async (result) => {
    const audio = result.stdout.match(/preview_audio=(.*)/)?.[1]?.trim() || null;
    const playable = result.ok ? await audioPreviewUrl(audio) : "";
    return {
      ...result,
      audio,
      audio_url: playable,
      manifest: result.stdout.match(/manifest=(.*)/)?.[1]?.trim() || null
    };
  });
}

async function saveVoiceScript({ taskDir, voiceScript }) {
  if (!taskDir || !existsSync(taskDir)) return { ok: false, error: "任务目录不存在" };
  const normalized = normalizeVoiceScript(voiceScript || {});
  await writeJson(path.join(taskDir, "voice_script.json"), normalized);
  try {
    const manifestModule = await import(pathToFileURL(path.join(WORKSPACE, "cli", "src", "core", "manifest.js")).href);
    await manifestModule.markDownstreamStale(taskDir, "copy");
  } catch {
    const manifestPath = path.join(taskDir, "task_manifest.json");
    const manifest = await readJsonSafe(manifestPath);
    if (manifest) {
      for (const stage of STAGE_ORDER.slice(1)) {
        if (manifest.stages?.[stage]?.status === "succeeded") manifest.stages[stage].status = "stale";
      }
      manifest.status = "stale";
      manifest.updated_at = new Date().toISOString();
      await writeJson(manifestPath, manifest);
    }
  }
  return { ok: true, voice_script: normalized };
}

function normalizeVoiceScript(input) {
  const sections = Array.isArray(input.script_sections) ? input.script_sections : [];
  const normalizedSections = sections.map((section) => {
    const text = String(section.voice_text || section.tts_text || section.text || "").trim();
    return {
      ...section,
      voice_text: text,
      tts_text: text
    };
  });
  const full = normalizedSections.map((section) => section.voice_text).filter(Boolean).join("\n");
  return {
    ...input,
    script_sections: normalizedSections,
    full_voice_text: full || String(input.full_voice_text || "").trim(),
    pronounce_text: full || String(input.pronounce_text || input.full_voice_text || "").trim(),
    updated_at: new Date().toISOString()
  };
}

function normalizeTextList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item?.text || item?.claim || item?.name || item?.term || item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// ---- shell ----

async function revealPath(target) {
  if (target && existsSync(target)) {
    shell.showItemInFolder(target);
    return { ok: true };
  }
  return { ok: false, error: "路径不存在" };
}

async function openFile(target) {
  if (target && existsSync(target)) {
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  }
  return { ok: false, error: "文件不存在" };
}

// ---- 工具 ----

function normalizeVoiceOption(item) {
  const voiceId = item.voice_id || item.id || "";
  const description = Array.isArray(item.description) ? item.description.join("；") : item.description || "";
  const language = item.language || voiceLanguage(voiceId);
  return {
    voice_id: voiceId,
    voice_name: VOICE_NAME_ZH[voiceId] || item.voice_name || item.name || voiceId,
    raw_voice_name: item.voice_name || item.name || "",
    description,
    gender: item.gender || "",
    language,
    group: voiceGroup(language, voiceId)
  };
}

function mergeVoices(primary, remote) {
  const byId = new Map();
  for (const item of [...primary, ...remote]) {
    if (!item.voice_id || byId.has(item.voice_id)) continue;
    byId.set(item.voice_id, item);
  }
  return [...byId.values()];
}

async function readSecret(key) {
  const envKey = keyToEnvName(key);
  const secrets = await new SecretService().readSecrets();
  return secrets[envKey] || "";
}

function keyToEnvName(key) {
  return String(key || "").trim().replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

function toFileUrl(target) {
  if (!target) return "";
  return pathToFileURL(target).href;
}

async function audioPreviewUrl(target) {
  if (!target || !existsSync(target)) return "";
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.size) return "";
  const ext = path.extname(target).toLowerCase();
  const mime = ext === ".wav" ? "audio/wav" : "audio/mpeg";
  const buffer = await fs.readFile(target);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function expandHome(target) {
  const text = String(target || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function installedFontPath(font) {
  for (const item of font.candidate_paths || []) {
    const target = expandHome(item);
    if (target && existsSync(target)) return target;
  }
  return "";
}

async function downloadFirst(urls, dir, fileName) {
  let lastError = null;
  for (const url of urls) {
    const output = path.join(dir, fileName || path.basename(new URL(url).pathname));
    const result = await runCommand("curl", ["-L", "--fail", "--retry", "2", "--connect-timeout", "20", "--max-time", "240", "-o", output, url]);
    if (result.ok && existsSync(output)) {
      const stat = await fs.stat(output).catch(() => null);
      if (stat?.size) return output;
    }
    lastError = result.stderr || result.stdout || `下载失败：${url}`;
  }
  throw new Error(lastError || "下载失败");
}

async function extractFontFromZip(zipPath, dir, matchPattern) {
  const result = await runCommand("unzip", ["-q", zipPath, "-d", dir]);
  if (!result.ok) throw new Error(result.stderr || result.stdout || "字体压缩包解压失败");
  const regex = new RegExp(matchPattern || "\\.(otf|ttf)$", "i");
  const files = await collectFiles(dir);
  const found = files.find((file) => regex.test(path.basename(file)) || regex.test(file));
  if (!found) throw new Error("压缩包里没有找到目标字体文件");
  return found;
}

async function collectFiles(root) {
  const output = [];
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else output.push(full);
    }
  }
  await walk(root);
  return output;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd: WORKSPACE });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => resolve({ ok: false, error: String(err.message || err), stdout, stderr }));
    proc.on("close", (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function voiceLanguage(voiceId) {
  const id = String(voiceId || "");
  if (id.startsWith("Chinese (Mandarin)") || id.startsWith("moss_audio_")) return "Chinese (Mandarin)";
  if (id.startsWith("Cantonese")) return "Cantonese";
  if (id.startsWith("English")) return "English";
  if (id.startsWith("Japanese")) return "Japanese";
  if (id.startsWith("Korean")) return "Korean";
  if (id.startsWith("Spanish")) return "Spanish";
  if (id.startsWith("Portuguese")) return "Portuguese";
  return "";
}

function voiceGroup(language, voiceId) {
  if (VOICE_NAME_ZH[voiceId]) return "中文常用音色";
  if (language === "Chinese (Mandarin)") return "普通话系统音色";
  if (language === "Cantonese") return "粤语系统音色";
  if (language === "English") return "英语系统音色";
  return language ? `${language} 系统音色` : "其他音色";
}

function runVoah(args, { stdin = null } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: WORKSPACE,
      // ELECTRON_RUN_AS_NODE：让 Electron 二进制以纯 Node 模式跑 CLI,
      // 否则 process.execPath 会再启动一个 Electron app(dock 多图标、点不开)。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => resolve({ ok: false, error: String(err.message || err) }));
    proc.on("close", (code) => {
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    if (stdin !== null) {
      proc.stdin.end(stdin);
    }
  });
}

function runVoahDetached(args) {
  const proc = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: WORKSPACE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore"
  });
  proc.unref();
  return {
    ok: true,
    pid: proc.pid,
    started_at: new Date().toISOString(),
    args: args.map((arg) => (String(arg).startsWith("sk-") ? "[redacted]" : arg))
  };
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseJsonFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
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

async function readTail(file, maxBytes) {
  const stat = await fs.stat(file);
  const start = Math.max(0, stat.size - Number(maxBytes || 60000));
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
