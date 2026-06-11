import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "./json.js";
import { STAGE_OUTPUTS, hashPath, loadTaskManifest, writeTaskManifest } from "./manifest.js";
import { compactId } from "./paths.js";
import { withTaskRunLock } from "./taskLock.js";

const RUNS_DIR = ".runs";
const RUN_MANIFEST = "run_manifest.json";

export class RunSupersededError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunSupersededError";
  }
}

export function isRunSupersededError(error) {
  return error?.name === "RunSupersededError";
}

export async function createTaskRun({ taskDir, from = "", stage = "", scope = "pipeline" }) {
  const stableManifest = (await loadTaskManifest(taskDir)) || {};
  const runId = compactId("run");
  const runDir = path.join(taskDir, RUNS_DIR, runId);
  const outputDir = path.join(runDir, "outputs");
  const logsDir = path.join(runDir, "logs");
  const workDir = path.join(runDir, "work");
  const inputsDir = path.join(runDir, "inputs");
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(logsDir, { recursive: true }), mkdir(workDir, { recursive: true }), mkdir(inputsDir, { recursive: true })]);
  const manifest = {
    schema_version: "voah.task_run_manifest.v1",
    run_id: runId,
    task_dir: taskDir,
    run_dir: runDir,
    output_dir: outputDir,
    logs_dir: logsDir,
    work_dir: workDir,
    from_stage: from || stage || "",
    stage: stage || "",
    from_stage_label: from || stage || "",
    scope,
    status: "running",
    pid: process.pid,
    started_at: new Date().toISOString(),
    stages: {},
    inputs: {
      stable_artifacts: stableManifest.active_artifacts || {},
      artifact_status: stableManifest.artifact_status || {}
    },
    outputs: {},
    promotion: {}
  };
  await writeRunManifest(runDir, manifest);
  return {
    runId,
    runDir,
    outputDir,
    logsDir,
    workDir,
    manifestPath: path.join(runDir, RUN_MANIFEST),
    startedAt: manifest.started_at,
    fromStage: manifest.from_stage,
    stage: manifest.stage
  };
}

export async function updateTaskRun(runContext, patch) {
  if (!runContext?.runDir) return null;
  const current = await readRunManifest(runContext.runDir);
  const updated = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString()
  };
  await writeRunManifest(runContext.runDir, updated);
  return updated;
}

export async function markRunStage(runContext, stage, patch) {
  if (!runContext?.runDir) return null;
  const current = await readRunManifest(runContext.runDir);
  current.stages ||= {};
  current.stages[stage] = {
    ...(current.stages[stage] || {}),
    ...patch,
    updated_at: new Date().toISOString()
  };
  current.updated_at = new Date().toISOString();
  await writeRunManifest(runContext.runDir, current);
  return current;
}

export async function promoteStageOutputs({ taskDir, runContext, stage, paths = null }) {
  if (!runContext?.outputDir) return [];
  const promotePaths = paths || STAGE_OUTPUTS[stage] || [];
  const promoted = [];
  let superseded = false;
  await withTaskRunLock(taskDir, { stage, scope: "promote", run_id: runContext.runId }, async () => {
    const manifest = (await loadTaskManifest(taskDir)) || {};
    if (isRunSuperseded(manifest, stage, runContext.startedAt)) {
      superseded = true;
      await markRunStage(runContext, stage, { status: "superseded", superseded_reason: "newer stage already promoted" });
      await updateTaskRun(runContext, { status: "superseded", finished_at: new Date().toISOString() });
      return;
    }
    const previousActiveArtifacts = { ...(manifest.active_artifacts || {}) };
    for (const relPath of promotePaths) {
      const source = path.join(runContext.outputDir, relPath);
      if (!existsSync(source)) continue;
      const target = path.join(taskDir, relPath);
      await promotePath(source, target);
      promoted.push({
        path: relPath,
        hash: await hashPath(target)
      });
    }
    manifest.stages ||= {};
    manifest.stages[stage] ||= {};
    manifest.stages[stage].status = "succeeded";
    manifest.stages[stage].finished_at = new Date().toISOString();
    manifest.stages[stage].error_message = "";
    manifest.stages[stage].promoted_run_id = runContext.runId;
    manifest.stages[stage].promoted_at = manifest.stages[stage].finished_at;
    manifest.runs ||= {};
    manifest.runs.latest = runContext.runId;
    manifest.runs[runContext.runId] = {
      run_id: runContext.runId,
      run_dir: runContext.runDir,
      from_stage: runContext.fromStage || "",
      stage,
      status: "promoted",
      promoted_at: manifest.stages[stage].promoted_at,
      promoted_paths: promoted.map((item) => item.path),
      previous_active_artifacts: previousActiveArtifacts
    };
    manifest.updated_at = new Date().toISOString();
    await writeTaskManifest(taskDir, manifest);
    await markRunStage(runContext, stage, { status: "promoted", promoted });
  });
  if (superseded) {
    throw new RunSupersededError(`run ${runContext.runId} 已被更新的 ${stage} 合入取代`);
  }
  const runManifest = await readRunManifest(runContext.runDir);
  runManifest.outputs ||= {};
  runManifest.outputs[stage] = promoted;
  runManifest.promotion ||= {};
  runManifest.promotion[stage] = {
    status: promoted.length ? "promoted" : "no_outputs",
    promoted_at: new Date().toISOString(),
    paths: promoted
  };
  runManifest.updated_at = new Date().toISOString();
  await writeRunManifest(runContext.runDir, runManifest);
  return promoted;
}

export async function listTaskRuns(taskDir, limit = 8) {
  const runsDir = path.join(taskDir, RUNS_DIR);
  if (!existsSync(runsDir)) return [];
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsDir, entry.name);
    const manifest = await readRunManifest(runDir).catch(() => null);
    if (!manifest) continue;
    runs.push({
      run_id: manifest.run_id || entry.name,
      run_dir: runDir,
      status: manifest.status || inferRunStatus(manifest),
      from_stage: manifest.from_stage || "",
      stage: manifest.stage || "",
      started_at: manifest.started_at || "",
      finished_at: manifest.finished_at || "",
      updated_at: manifest.updated_at || manifest.finished_at || manifest.started_at || "",
      error: manifest.error?.message || manifest.error || "",
      stages: manifest.stages || {}
    });
  }
  runs.sort((a, b) => String(b.updated_at || b.started_at).localeCompare(String(a.updated_at || a.started_at)));
  return runs.slice(0, limit);
}

async function promotePath(source, target) {
  const info = await lstat(source);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${compactId("promote")}.tmp`);
  await rm(tmp, { recursive: true, force: true });
  if (info.isDirectory()) {
    await cp(source, tmp, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rename(tmp, target);
    return;
  }
  await cp(source, tmp, { force: true });
  await rename(tmp, target);
}

function isRunSuperseded(manifest, stage, startedAt) {
  const promotedAt = manifest?.stages?.[stage]?.promoted_at;
  if (!promotedAt || !startedAt) return false;
  return Date.parse(promotedAt) > Date.parse(startedAt);
}

function inferRunStatus(manifest) {
  const stages = Object.values(manifest.stages || {});
  if (stages.some((stage) => stage.status === "failed")) return "failed";
  if (stages.some((stage) => stage.status === "running")) return "running";
  if (stages.some((stage) => stage.status === "promoted")) return "promoted";
  return manifest.status || "unknown";
}

async function readRunManifest(runDir) {
  return readJson(path.join(runDir, RUN_MANIFEST));
}

async function writeRunManifest(runDir, payload) {
  await writeJson(path.join(runDir, RUN_MANIFEST), payload);
}
