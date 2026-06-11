import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { elapsedSeconds } from "./intakeStatus.js";

export const VIDEO_STAGE_ORDER = ["copy", "tts", "retrieve", "subtitle", "render", "qa"];

export async function listTaskRuns(taskDir, { limit = 8, stageLabel = defaultStageLabel } = {}) {
  const runsDir = path.join(taskDir, ".runs");
  if (!existsSync(runsDir)) return [];
  const runs = [];
  for (const name of await safeReaddir(runsDir)) {
    const runDir = path.join(runsDir, name);
    if (!(await isDir(runDir))) continue;
    const manifest = await readJsonSafe(path.join(runDir, "run_manifest.json"));
    if (!manifest) continue;
    const status = manifest.status || inferRunStatus(manifest);
    const currentStage = currentStageFromRun(manifest);
    const failedStageName = failedStageFromRun(manifest);
    const errorSummary = manifest.error?.message || stageErrorFromRun(manifest) || "";
    runs.push({
      run_id: manifest.run_id || name,
      run_dir: runDir,
      status,
      from_stage: manifest.from_stage || "",
      stage: manifest.stage || "",
      current_stage: currentStage,
      failed_stage: failedStageName,
      stage_label: stageLabel(currentStage || failedStageName || manifest.from_stage || manifest.stage),
      started_at: manifest.started_at || "",
      updated_at: manifest.updated_at || manifest.finished_at || manifest.started_at || "",
      finished_at: manifest.finished_at || "",
      elapsed_s: elapsedSeconds(manifest.started_at, manifest.finished_at || manifest.updated_at),
      pid: manifest.pid || null,
      error_summary: errorSummary,
      log_dir: manifest.logs_dir || path.join(runDir, "logs"),
      can_continue: ["failed", "superseded"].includes(status),
      can_retry: ["failed", "superseded", "promoted", "succeeded"].includes(status),
      promotion: manifest.promotion || {}
    });
  }
  runs.sort((a, b) => String(b.updated_at || b.started_at).localeCompare(String(a.updated_at || a.started_at)));
  return runs.slice(0, limit);
}

export function inferRunStatus(manifest) {
  const stages = Object.values(manifest.stages || {});
  if (stages.some((stage) => stage.status === "running")) return "running";
  if (stages.some((stage) => stage.status === "failed")) return "failed";
  if (stages.some((stage) => stage.status === "promoted")) return "promoted";
  return manifest.status || "unknown";
}

export function currentStageFromRun(manifest) {
  const entries = Object.entries(manifest.stages || {});
  const running = entries.find(([, stage]) => stage.status === "running");
  if (running) return running[0];
  const latest = entries.sort((a, b) => String(b[1]?.updated_at || "").localeCompare(String(a[1]?.updated_at || "")))[0];
  return latest?.[0] || manifest.stage || manifest.from_stage || "";
}

export function failedStageFromRun(manifest) {
  return Object.entries(manifest.stages || {}).find(([, stage]) => stage.status === "failed")?.[0] || "";
}

export function stageErrorFromRun(manifest) {
  const failed = Object.values(manifest.stages || {}).find((stage) => stage.status === "failed");
  return failed?.error_message || "";
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function isDir(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function defaultStageLabel(stage) {
  return {
    copy: "文案",
    tts: "配音",
    retrieve: "选素材",
    subtitle: "字幕",
    render: "渲染",
    qa: "质检"
  }[stage] || "处理中";
}
