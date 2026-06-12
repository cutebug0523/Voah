import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import { SecretService } from "../../../cli/src/services/secretService.js";
import { MODEL_MODULES } from "../../../cli/src/services/modelModules.js";
import { FALLBACK_TTS_VOICES, FONT_OPTIONS, VOICE_NAME_ZH } from "../src/lib/studioOptions.js";
import { dedupeIntakeRuns, elapsedSeconds, intakeStatusLabel, normalizeIntakeStatus, summarizeIntakeRuns } from "./intakeStatus.js";
import { isTaskAcknowledged, withTaskAcknowledgement } from "./taskAcknowledgements.js";
import { failedStageFromRun, listTaskRuns } from "./taskRuns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { dialog, shell } = electron;

// 仓库根：voah-studio 在 desktop/voah-studio，根目录上溯两层。
// 生产环境可由 VOAH_WORKSPACE 覆盖。
const WORKSPACE = process.env.VOAH_WORKSPACE || path.resolve(__dirname, "..", "..", "..");
const CLI_ENTRY = path.join(WORKSPACE, "cli", "src", "bin", "voah.js");
const PRODUCTS_DIR = path.join(WORKSPACE, "data", "products");
const BATCHES_DIR = path.join(WORKSPACE, "cache", "voah_batches");
const TASKS_DIR = path.join(WORKSPACE, "cache", "voah_tasks");
const INTAKE_DIR = path.join(WORKSPACE, "cache", "voah_video_intake");
const STUDIO_DIR = path.join(os.homedir(), ".voah");
const STUDIO_FONTS_DIR = path.join(STUDIO_DIR, "fonts");
const STUDIO_SETTINGS_PATH = path.join(STUDIO_DIR, "studio_settings.json");
const STUDIO_REVIEW_PATH = path.join(STUDIO_DIR, "studio_reviews.json");
const STUDIO_TASK_ACK_PATH = path.join(STUDIO_DIR, "studio_task_acknowledgements.json");

const STAGE_ORDER = ["copy", "tts", "retrieve", "subtitle", "render", "qa"];
export function registerVoahHandlers(ipcMain) {
  ipcMain.handle("voah:listProducts", () => listProducts());
  ipcMain.handle("voah:listTaskCenter", () => listTaskCenter());
  ipcMain.handle("voah:acknowledgeTask", (_e, task) => acknowledgeTask(task));
  ipcMain.handle("voah:continueIntakeTask", (_e, task) => continueIntakeTask(task));
  ipcMain.handle("voah:inspectProduct", (_e, slug) => inspectProduct(slug));
  ipcMain.handle("voah:createProduct", (_e, params) => createProduct(params));
  ipcMain.handle("voah:saveProductDetail", (_e, params) => saveProductDetail(params));
  ipcMain.handle("voah:refineProductContext", (_e, params) => refineProductContext(params));
  ipcMain.handle("voah:listIntakeRuns", (_e, slug) => listIntakeRuns(slug));
  ipcMain.handle("voah:startIntake", (_e, params) => startIntake(params));
  ipcMain.handle("voah:chooseDirectory", () => chooseDirectory());

  ipcMain.handle("voah:listBatches", () => listBatches());
  ipcMain.handle("voah:taskDetail", (_e, taskDir) => taskDetail(taskDir));
  ipcMain.handle("voah:createBatch", (_e, params) => createBatch(params));
  ipcMain.handle("voah:retryTask", (_e, params) => retryTask(params));
  ipcMain.handle("voah:continueTask", (_e, params) => continueTask(params));
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
      category: product.category || "",
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
      category: "",
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

async function createProduct({ slug, name, brand, category }) {
  const args = ["product", "create", "--workspace", WORKSPACE, "--slug", slug || ""];
  if (name) args.push("--name", name);
  if (brand) args.push("--brand", brand);
  if (category) args.push("--category", category);
  return runVoah(args);
}

async function saveProductDetail({ slug, product, claims, campaigns, blockedTerms }) {
  if (!slug) return { ok: false, error: "缺少产品 slug" };
  const productDir = path.join(PRODUCTS_DIR, slug);
  await fs.mkdir(productDir, { recursive: true });
  const currentProduct = (await readJsonSafe(path.join(productDir, "product.json"))) || {};
  await writeJson(path.join(productDir, "product.json"), buildProductPayloadForSave({ slug, product, currentProduct }));
  await writeJson(path.join(productDir, "claims.json"), {
    schema_version: "voah.product_claims.v2",
    claims: normalizeClaimsForSave(claims),
    updated_at: new Date().toISOString()
  });
  await writeJson(path.join(productDir, "campaigns.json"), {
    schema_version: "voah.product_campaigns.v2",
    campaigns: normalizeTextList(campaigns).map((text, index) => ({ text, rank: index + 1 })),
    updated_at: new Date().toISOString()
  });
  await writeJson(path.join(productDir, "blocked_terms.json"), {
    schema_version: "voah.blocked_terms.v1",
    terms: normalizeTextList(blockedTerms).map((text) => ({ text })),
    updated_at: new Date().toISOString()
  });
  return { ok: true };
}

export function buildProductPayloadForSave({ slug, product = {}, currentProduct = {} }) {
  return {
    schema_version: "voah.product.v1",
    slug,
    name: product?.name || "",
    brand: product?.brand || "",
    category: product?.category || "",
    cta: product?.cta || "",
    created_at: product?.created_at || currentProduct.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

async function refineProductContext({ slug, runDir }) {
  if (!slug) return { ok: false, error: "缺少产品 slug" };
  const productDir = path.join(PRODUCTS_DIR, slug);
  const product = await readJsonSafe(path.join(productDir, "product.json")) || {};
  const intakeRuns = await intakeRunsForSlug(slug);
  const selectedRunDir = runDir || intakeRuns.find((run) => run.name === "_merged" && run.ready)?.run_dir || intakeRuns.find((run) => run.ready)?.run_dir || "";
  if (!selectedRunDir) return { ok: false, error: "没有可提炼的入库记录" };
  return runVoah([
    "product",
    "refine",
    "--workspace",
    WORKSPACE,
    "--product",
    slug,
    "--run-dir",
    selectedRunDir,
    ...(product.name ? ["--product-name", product.name] : []),
    ...(product.brand ? ["--brand", product.brand] : []),
    ...(product.category ? ["--category", product.category] : [])
  ]);
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
      source: "run",
      job_id: statusPayload?.job_id || result?.job_id || manifest?.job_id || "",
      ready,
      system: name.startsWith("_"),
      status,
      current_stage: statusPayload?.current_stage || "",
      stage_label: statusPayload?.stage_label || intakeStatusLabel(status),
      progress: statusPayload?.progress || {},
      started_at: statusPayload?.started_at || result?.created_at || manifest.created_at || manifest.started_at || "",
      inputs: result?.inputs || statusPayload?.inputs || {},
      incremental: result?.incremental || statusPayload?.incremental || {},
      error: result?.error || statusPayload?.error || manifest.error || null,
      logs: statusPayload?.logs || result?.logs || manifest.logs || {},
      shot_count: Array.isArray(shotIndex?.shots) ? shotIndex.shots.length : Array.isArray(shotIndex?.records) ? shotIndex.records.length : null,
      created_at: statusPayload?.started_at || result?.created_at || manifest.created_at || manifest.started_at || "",
      updated_at: updatedAt,
      elapsed_s: elapsedSeconds(statusPayload?.started_at || manifest.created_at || "", updatedAt)
    });
  }
  const deduped = dedupeIntakeRuns(runs);
  deduped.sort((a, b) => String(b.updated_at || b.name).localeCompare(String(a.updated_at || a.name)));
  return deduped;
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
    const jobKey = statusPayload?.job_id || result?.job_id || jobId;
    jobs.push({
      run_dir: runDir || jobDir,
      name: jobId,
      source: "job",
      job_id: jobKey,
      job_dir: jobDir,
      ready: false,
      system: true,
      status,
      current_stage: statusPayload?.current_stage || "",
      stage_label: statusPayload?.stage_label || intakeStatusLabel(status),
      progress: statusPayload?.progress || {},
      started_at: statusPayload?.started_at || result?.created_at || "",
      inputs: result?.inputs || statusPayload?.inputs || {},
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
    const runs = taskDir ? await listTaskRuns(taskDir, { limit: 5, stageLabel: taskStageLabel }) : [];
    tasks.push(summarizeTask(t, taskManifest, taskDir, runs));
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

function summarizeTask(taskEntry, manifest, taskDir, runs = []) {
  const stages = (manifest && manifest.stages) || {};
  const segments = STAGE_ORDER.map((stage) => ({
    stage,
    status: stages[stage]?.status || "pending"
  }));
  const latestRun = runs[0] || null;
  const effectiveStatus = runAwareTaskStatus(manifest?.status || taskEntry.status || "queued", latestRun);
  const current = latestRun?.current_stage || currentStage(segments);
  const failed = latestRun?.failed_stage || failedStage(segments);
  return {
    task_dir: taskDir,
    task_id: manifest?.task_id || taskEntry.task_id || path.basename(taskDir || ""),
    index: taskEntry.index ?? null,
    status: effectiveStatus,
    qa_status: manifest?.qa?.status || "pending",
    current_stage: current,
    failed_stage: failed,
    stage_label: taskStageLabel(current || failed),
    segments,
    latest_run: latestRun,
    failed_runs: runs.filter((run) => run.status === "failed")
  };
}

function runAwareTaskStatus(status, latestRun) {
  if (latestRun?.status === "running") return "running";
  if (latestRun?.status === "failed") return "failed";
  return status;
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
  const runs = await listTaskRuns(taskDir, { limit: 12, stageLabel: taskStageLabel });

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
    latest_run: runs[0] || null,
    runs,
    failed_runs: runs.filter((run) => run.status === "failed"),
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

function createBatch({ product, count, targetDuration, intakeRun, concurrency = 1, resolution = "720p", extraArgs = [] }) {
  return runVoah(buildCreateBatchArgs({ product, count, targetDuration, intakeRun, concurrency, resolution, extraArgs }));
}

export function buildCreateBatchArgs({ product, count, targetDuration, intakeRun, concurrency = 1, resolution = "720p", extraArgs = [] }) {
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
    String(concurrency),
    "--resolution",
    resolution || "720p"
  ];
  if (intakeRun) args.push("--intake-run", intakeRun);
  args.push(...extraArgs);
  return args;
}

function retryTask({ taskDir, fromStage }) {
  const args = ["task", "run", "--workspace", WORKSPACE, taskDir];
  if (fromStage) args.push("--from", fromStage);
  return runVoah(args);
}

async function continueTask({ taskDir, runId, fromStage }) {
  const args = ["task", "run", "--workspace", WORKSPACE, taskDir];
  const stage = fromStage || await inferContinueStageFromRunId(taskDir, runId) || "copy";
  args.push("--from", stage);
  return runVoah(args);
}

async function inferContinueStageFromRunId(taskDir, runId) {
  const runDir = runId ? path.join(taskDir, ".runs", runId) : "";
  const manifest = runDir ? await readJsonSafe(path.join(runDir, "run_manifest.json")) : null;
  return manifest ? failedStageFromRun(manifest) || manifest.from_stage || manifest.stage || "" : "";
}

function pauseBatch(batchDir) {
  return runVoah(["batch", "pause", "--workspace", WORKSPACE, batchDir]);
}

function resumeBatch(batchDir) {
  return runVoah(["batch", "resume", "--workspace", WORKSPACE, batchDir]);
}

async function readTaskLog({ taskDir, stage, runId, maxBytes = 60000 }) {
  if (!taskDir || !existsSync(taskDir)) return { ok: false, error: "任务目录不存在" };
  const logsDirs = [];
  if (runId) logsDirs.push(path.join(taskDir, ".runs", runId, "logs"));
  const latestRun = !runId ? (await listTaskRuns(taskDir, { limit: 1, stageLabel: taskStageLabel }))[0] : null;
  if (latestRun?.run_id) logsDirs.push(path.join(taskDir, ".runs", latestRun.run_id, "logs"));
  logsDirs.push(path.join(taskDir, "logs"));
  const candidates = logsDirs.flatMap((logsDir) => logCandidates(logsDir, stage));
  const files = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    files.push({
      file,
      name: path.basename(file),
      text: await readTail(file, maxBytes)
    });
  }
  return { ok: true, task_dir: taskDir, stage: stage || "", run_id: runId || latestRun?.run_id || "", files };
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
  const [products, batches, outputs, acknowledgements] = await Promise.all([
    listProducts(),
    listBatches(),
    listOutputs(),
    readJsonSafe(STUDIO_TASK_ACK_PATH)
  ]);
  const intakeTasks = [];
  for (const product of products) {
    const runs = await intakeRunsForSlug(product.slug);
    for (const run of runs) {
      if (!["running", "stalled", "failed"].includes(run.status)) continue;
      const ackKey = intakeAckKey(product.slug, run);
      intakeTasks.push({
        id: ackKey,
        ack_key: ackKey,
        ack_keys: intakeAckKeys(product.slug, run),
        kind: "intake",
        kind_label: "入库",
        product_slug: product.slug,
        product_name: product.name,
        title: product.name,
        status: run.status,
        current_stage: run.current_stage || "",
        stage_label: run.stage_label || intakeStatusLabel(run.status),
        progress: normalizeProgress(run.progress),
        started_at: run.started_at || run.created_at || "",
        elapsed_s: run.elapsed_s,
        updated_at: run.updated_at,
        target_path: run.run_dir,
        run_dir: run.run_dir,
        job_dir: run.job_dir || "",
        job_id: run.job_id || "",
        source_dir: run.inputs?.source_dir || "",
        max_videos: run.inputs?.max_videos ?? 0,
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
      const ackKey = videoTaskAckKey(batch, task);
      const item = {
        id: ackKey,
        ack_key: ackKey,
        kind: "video",
        kind_label: "出片",
        product_slug: batch.product_slug,
        product_name: batch.product_name,
        title: `${batch.product_name || batch.product_slug} #${task.index || ""}`.trim(),
        status: task.status,
        stage_label: taskStageLabel(task.current_stage || task.failed_stage),
        current_stage: task.current_stage || "",
        failed_stage: task.failed_stage || "",
        progress: batchProgress(batch, task),
        elapsed_s: null,
        updated_at: batch.updated_at || batch.created_at || "",
        target_path: task.task_dir,
        latest_run: task.latest_run || null,
        run_id: task.latest_run?.run_id || "",
        can_continue: ["failed", "needs_review"].includes(task.status),
        error: task.latest_run?.error_summary || (task.failed_stage ? taskStageLabel(task.failed_stage) : "")
      };
      if (task.status === "running" || task.status === "queued") running.push(item);
      if (task.status === "failed" || task.status === "needs_review") needsAttention.push(item);
    }
  }

  const summary = {
    target: 150,
    succeeded: outputs.filter((item) => ["succeeded", "completed"].includes(item.status)).length,
    needs_review: outputs.filter((item) => item.status === "needs_review" || item.qa_status === "manual_review").length,
    failed: needsAttention.filter((item) => item.status === "failed" && !isTaskAcknowledged(item, acknowledgements)).length,
    running: running.length,
    total: outputs.length
  };

  return {
    ok: true,
    summary,
    running: sortTasks(running),
    needs_attention: sortTasks(needsAttention.filter((item) => !isTaskAcknowledged(item, acknowledgements))),
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

async function acknowledgeTask(task) {
  const current = await readJsonSafe(STUDIO_TASK_ACK_PATH);
  const updated = withTaskAcknowledgement(current, task || {});
  await writeJson(STUDIO_TASK_ACK_PATH, updated);
  return { ok: true, acknowledged_at: updated.updated_at };
}

async function continueIntakeTask(task) {
  if (!task || task.kind !== "intake") return { ok: false, error: "只能继续入库任务" };
  const context = await resolveIntakeRetryContext(task);
  if (!context.ok) return context;
  return startIntake({
    product: context.product_slug,
    productName: context.product_name,
    sourceDir: context.source_dir,
    limit: context.max_videos,
    label: context.label,
    extraArgs: ["--include-existing-failed"]
  });
}

async function resolveIntakeRetryContext(task) {
  const productSlug = String(task.product_slug || "").trim();
  const productName = String(task.product_name || productSlug).trim();
  if (!productSlug) return { ok: false, error: "缺少产品信息" };

  const payloads = [];
  for (const base of [task.job_dir, task.run_dir, task.target_path]) {
    if (!base) continue;
    payloads.push(await readJsonSafe(path.join(base, "desktop_intake_status.json")));
    payloads.push(await readJsonSafe(path.join(base, "desktop_intake_result.json")));
    payloads.push(await readJsonSafe(path.join(base, "logs", task.job_id || "", "job_input.json")));
  }
  const sourceDir = firstNonEmpty([
    task.source_dir,
    ...payloads.map((item) => item?.inputs?.source_dir),
    ...payloads.map((item) => item?.inputs?.selected_source_dir)
  ]);
  if (!sourceDir) return { ok: false, error: "找不到原素材目录" };
  if (!existsSync(sourceDir)) return { ok: false, error: `原素材目录不存在：${sourceDir}` };

  const maxVideos = firstNumber([
    task.max_videos,
    ...payloads.map((item) => item?.inputs?.max_videos),
    ...payloads.map((item) => item?.options?.max_videos)
  ]);
  const label = `studio_intake_${Date.now()}_resume`;
  return {
    ok: true,
    product_slug: productSlug,
    product_name: productName || productSlug,
    source_dir: sourceDir,
    max_videos: maxVideos,
    label
  };
}

function intakeAckKey(productSlug, run) {
  const jobId = String(run?.job_id || "").trim();
  const stamp = taskOccurrenceStamp(run);
  if (jobId) return `intake:${productSlug}:job:${jobId}:${stamp}`;
  const runDir = String(run?.run_dir || "").trim();
  if (runDir) return `intake:${productSlug}:run:${runDir}:${stamp}`;
  return `intake:${productSlug}:name:${run?.name || ""}:${stamp}`;
}

function intakeAckKeys(productSlug, run) {
  const stamp = taskOccurrenceStamp(run);
  const keys = [intakeAckKey(productSlug, run)];
  if (run?.job_id) keys.push(`intake:${productSlug}:job:${run.job_id}:${stamp}`);
  if (run?.run_dir) keys.push(`intake:${productSlug}:run:${run.run_dir}:${stamp}`);
  if (run?.name) keys.push(`intake:${productSlug}:name:${run.name}:${stamp}`);
  return [...new Set(keys)];
}

function videoTaskAckKey(batch, task) {
  return `task:${task.task_dir}:${taskOccurrenceStamp({
    status: task.status,
    updated_at: batch.updated_at || batch.created_at || "",
    current_stage: task.current_stage,
    failed_stage: task.failed_stage
  })}`;
}

function taskOccurrenceStamp(item) {
  return [
    item?.status || "unknown",
    item?.updated_at || item?.created_at || "",
    item?.current_stage || item?.failed_stage || ""
  ].map((part) => String(part || "").replace(/\s+/g, "_")).join(":");
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

function firstNonEmpty(values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function firstNumber(values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

// ---- 设置 ----

async function getConfig() {
  const result = await runVoah(["config", "get", "--workspace", WORKSPACE]);
  const configured = parseJsonFromText(result.stdout) || {};
  const secretStatus = configured.secrets || configured;
  return {
    ok: result.ok,
    configured,
    providers: configured.providers || providerRowsFromModules(MODEL_MODULES, secretStatus),
    modules: configured.modules || MODEL_MODULES.map((item) => ({
      id: item.id,
      module: item.module,
      model: item.model,
      provider_id: item.providerId,
      provider_name: item.providerName,
      config_key: item.configKey,
      configured: Boolean(secretStatus[item.configKey] || secretStatus[item.id])
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
  await ensureBundledFonts();
  const fonts = await Promise.all(
    FONT_OPTIONS.map(async (font) => {
      const installed_path = installedFontPath(font);
      return {
        ...font,
        installed: Boolean(installed_path),
        installed_path,
        font_source: installed_path,
        font_url: await fontPreviewUrl(installed_path, font)
      };
    })
  );
  return {
    ok: true,
    fonts
  };
}

async function installSubtitleFont(fontId) {
  const font = FONT_OPTIONS.find((item) => item.id === fontId);
  if (!font) return { ok: false, error: "未知字体" };
  await ensureBundledFont(font);
  const installed_path = installedFontPath(font);
  return installed_path
    ? { ok: true, installed_path, font_url: toFileUrl(installed_path), bundled: Boolean(font.bundled_file) }
    : { ok: false, error: "字体文件不可用" };
}

async function getStudioSettings() {
  await ensureBundledFonts();
  const settings = await readJsonSafe(STUDIO_SETTINGS_PATH);
  return mergeStudioSettings(settings);
}

async function saveStudioSettings(settings) {
  await ensureBundledFonts();
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
      font: "smiley-sans",
      font_source: path.join(STUDIO_FONTS_DIR, "SmileySans-Oblique.otf"),
      font_label: "得意黑"
    },
    render: {
      hyperframes_workers: "auto",
      gpu: "auto"
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
      ...resolveSubtitleFontSettings(source.subtitle),
      preset: source.subtitle?.preset === "方案1" ? "songti_white_gold_lower" : source.subtitle?.preset || defaults.subtitle.preset
    },
    render: {
      ...defaults.render,
      ...(source.render || {})
    }
  };
}

function resolveSubtitleFontSettings(subtitle = {}) {
  const requested = FONT_OPTIONS.find((font) => font.id === subtitle.font);
  const sourcePath = expandHome(subtitle.font_source || "");
  if (requested && installedFontPath(requested)) {
    return {
      font: requested.id,
      font_label: requested.label,
      font_source: installedFontPath(requested)
    };
  }
  if (sourcePath && existsSync(sourcePath)) {
    const byPath = FONT_OPTIONS.find((font) => installedFontPath(font) === sourcePath);
    return {
      font: byPath?.id || subtitle.font || "",
      font_label: byPath?.label || subtitle.font_label || "自定义字体",
      font_source: sourcePath
    };
  }
  const fallback = FONT_OPTIONS.find((font) => installedFontPath(font)) || FONT_OPTIONS[0];
  return {
    font: fallback?.id || "",
    font_label: fallback?.label || "",
    font_source: fallback ? installedFontPath(fallback) : ""
  };
}

// ---- 精修打样 ----

function createSampleTask({ product, productName, targetDuration, intakeRun, resolution = "720p", extraArgs = [] }) {
  return runVoah(buildCreateSampleTaskArgs({ product, productName, targetDuration, intakeRun, resolution, extraArgs }));
}

export function buildCreateSampleTaskArgs({ product, productName, targetDuration, intakeRun, resolution = "720p", extraArgs = [] }) {
  const args = [
    "task",
    "create",
    "--workspace",
    WORKSPACE,
    "--product",
    product || "",
    "--target-duration",
    String(targetDuration || 45),
    "--resolution",
    resolution || "720p",
    "--label",
    "studio_sample"
  ];
  if (productName) args.push("--product-name", productName);
  if (intakeRun) args.push("--intake-run", intakeRun);
  args.push(...extraArgs);
  return args;
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

export function normalizeClaimsForSave(value) {
  if (Array.isArray(value)) {
    return value
      .map((item, index) => ({
        text: String(item?.text || item?.claim || item?.name || item?.term || item || "").trim(),
        tier: item?.tier === "core" ? "core" : "support",
        rank: Number(item?.rank || index + 1)
      }))
      .filter((item) => item.text);
  }
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    const core = line.startsWith("核心：") || line.startsWith("[核心]") || index < 2;
    return {
      text: line.replace(/^核心[:：]\s*/, "").replace(/^\[核心\]\s*/, ""),
      tier: core ? "core" : "support",
      rank: index + 1
    };
  });
}

export function providerRowsFromModules(modules, secretStatus) {
  const byProvider = new Map();
  for (const item of modules || []) {
    if (!item.providerId || item.providerId === "vectorengine") continue;
    if (!byProvider.has(item.providerId)) {
      byProvider.set(item.providerId, {
        id: item.providerId,
        name: item.providerName,
        config_key: item.configKey,
        env_key: item.envKey,
        configured: Boolean(secretStatus[item.configKey] || secretStatus[item.envKey])
      });
    }
  }
  return [...byProvider.values()];
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
  const secrets = await new SecretService({ workspace: WORKSPACE }).readSecrets();
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

async function fontPreviewUrl(target, font) {
  if (!target || !existsSync(target)) return "";
  if (!font?.bundled_file) return toFileUrl(target);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.size || stat.size > 12 * 1024 * 1024) return toFileUrl(target);
  const ext = path.extname(target).toLowerCase();
  const mime = ext === ".otf" ? "font/otf" : ext === ".woff2" ? "font/woff2" : "font/ttf";
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

async function ensureBundledFonts() {
  await fs.mkdir(STUDIO_FONTS_DIR, { recursive: true });
  await Promise.all(FONT_OPTIONS.map((font) => ensureBundledFont(font)));
}

async function ensureBundledFont(font) {
  if (!font?.bundled_file) return;
  const source = bundledFontPath(font.bundled_file);
  if (!source) return;
  const output = path.join(STUDIO_FONTS_DIR, font.bundled_file);
  const [sourceStat, outputStat] = await Promise.all([
    fs.stat(source).catch(() => null),
    fs.stat(output).catch(() => null)
  ]);
  if (!sourceStat?.size) return;
  if (outputStat?.size === sourceStat.size) return;
  await fs.mkdir(STUDIO_FONTS_DIR, { recursive: true });
  await fs.copyFile(source, output);
}

function bundledFontPath(fileName) {
  const candidates = [
    path.join(__dirname, "..", "resources", "fonts", fileName),
    path.join(process.resourcesPath || "", "fonts", fileName),
    path.join(process.resourcesPath || "", "resources", "fonts", fileName)
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
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
