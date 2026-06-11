import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./hash.js";
import { readJson, writeJson } from "./json.js";
import { compactId } from "./paths.js";

export const STAGE_ORDER = ["copy", "tts", "retrieve", "subtitle", "render", "qa"];

export const STAGE_OUTPUTS = {
  task_brief: ["task_brief.json"],
  copy: ["copy_brief.json", "voice_script.json"],
  tts: ["tts_audio.json", "voice.wav", "audio_sections.json"],
  retrieve: ["candidate_sections.json", "timeline_selection.json", "timeline_fill.json", "preview_no_subtitles.mp4"],
  subtitle: ["caption_plan.json", "hyperframes_subtitle_burn"],
  render: ["hyperframes_subtitle_burn/final_subtitled.mp4", "hyperframes_subtitle_burn/hyperframes_subtitle_burn_manifest.json"],
  qa: ["qa_omni_alignment_final", "qa_gate_report.json", "full_pipeline_manifest.json", "desktop_quality_report.json", "desktop_quality_report.md"]
};

export function manifestPath(taskDir) {
  return path.join(taskDir, "task_manifest.json");
}

export async function loadTaskManifest(taskDir) {
  if (!existsSync(manifestPath(taskDir))) {
    return null;
  }
  return readJson(manifestPath(taskDir));
}

export async function writeTaskManifest(taskDir, manifest) {
  await writeJson(manifestPath(taskDir), manifest);
}

export function createTaskManifest({ taskId, productSlug, productName, intakeRun, taskDir, targetDurationS, label, canvas }) {
  const normalizedCanvas = normalizeCanvas(canvas);
  return {
    schema_version: "voah.task_manifest.v1",
    task_id: taskId || compactId("task"),
    product_slug: productSlug,
    product_name: productName || productSlug,
    intake_run: intakeRun,
    task_dir: taskDir,
    label: label || "",
    target_duration_s: targetDurationS,
    canvas: normalizedCanvas,
    resolution: normalizedCanvas.preset,
    status: "queued",
    active_artifacts: {},
    stages: {},
    qa: {
      status: "pending"
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

export function canvasFromOptions(options = {}, fallback = {}) {
  if (options.resolution) {
    return canvasFromResolution(options.resolution);
  }
  const width = Number(options.width ?? fallback.width ?? 720);
  const height = Number(options.height ?? fallback.height ?? 1280);
  return normalizeCanvas({
    width,
    height,
    fps: options.fps ?? fallback.fps ?? 30,
    preset: presetForCanvas(width, height)
  });
}

export function canvasFromResolution(resolution = "720p") {
  const value = String(resolution || "720p").trim().toLowerCase();
  if (value === "1080p" || value === "1080" || value === "fhd") {
    return { preset: "1080p", width: 1080, height: 1920, fps: 30 };
  }
  if (value === "720p" || value === "720" || value === "hd") {
    return { preset: "720p", width: 720, height: 1280, fps: 30 };
  }
  throw new Error(`未知分辨率档位：${resolution}`);
}

export function normalizeCanvas(canvas = {}) {
  const width = Math.max(1, Math.round(Number(canvas.width || 720)));
  const height = Math.max(1, Math.round(Number(canvas.height || 1280)));
  return {
    preset: canvas.preset || presetForCanvas(width, height),
    width,
    height,
    fps: Math.max(1, Math.round(Number(canvas.fps || 30)))
  };
}

function presetForCanvas(width, height) {
  if (Number(width) === 1080 && Number(height) === 1920) return "1080p";
  if (Number(width) === 720 && Number(height) === 1280) return "720p";
  return "custom";
}

export async function markStage(taskDir, stage, patch) {
  const manifest = (await loadTaskManifest(taskDir)) || createTaskManifest({ taskDir });
  manifest.stages ||= {};
  const previous = manifest.stages[stage] || {};
  manifest.stages[stage] = {
    ...previous,
    ...patch,
    updated_at: new Date().toISOString()
  };
  manifest.updated_at = new Date().toISOString();
  if (patch.status === "running") {
    manifest.status = "running";
  } else if (patch.status === "failed") {
    manifest.status = "failed";
  }
  await writeTaskManifest(taskDir, manifest);
  return manifest;
}

export async function refreshActiveArtifacts(taskDir, stage = null) {
  const manifest = (await loadTaskManifest(taskDir)) || createTaskManifest({ taskDir });
  manifest.active_artifacts ||= {};
  manifest.artifact_status ||= {};
  const stages = stage ? [stage] : Object.keys(STAGE_OUTPUTS);
  for (const item of stages) {
    for (const output of STAGE_OUTPUTS[item] || []) {
      const file = path.join(taskDir, output);
      if (existsSync(file)) {
        const key = artifactKey(output);
        manifest.active_artifacts[key] = output;
        manifest.artifact_status[key] = {
          path: output,
          produced_by_stage: item,
          stage_attempt: manifest.stages?.[item]?.attempt || 0,
          valid: manifest.stages?.[item]?.status !== "stale" && manifest.stages?.[item]?.status !== "failed",
          updated_at: new Date().toISOString()
        };
      }
    }
  }
  manifest.updated_at = new Date().toISOString();
  await writeTaskManifest(taskDir, manifest);
  return manifest;
}

function artifactKey(output) {
  return output
    .replace(/^hyperframes_subtitle_burn\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function stageInputHashes(files) {
  const hashes = {};
  for (const file of files) {
    if (existsSync(file)) {
      hashes[file] = await hashFile(file);
    }
  }
  return hashes;
}

// 记录某阶段产物文件的 hash，作为下游 stale 判断的基线。
export async function recordStageOutputHashes(taskDir, stage) {
  const manifest = await loadTaskManifest(taskDir);
  if (!manifest) return null;
  manifest.stages ||= {};
  manifest.stages[stage] ||= {};
  const hashes = {};
  for (const output of STAGE_OUTPUTS[stage] || []) {
    const file = path.join(taskDir, output);
    if (existsSync(file)) {
      hashes[output] = await hashPath(file);
    }
  }
  manifest.stages[stage].output_hashes = hashes;
  manifest.updated_at = new Date().toISOString();
  await writeTaskManifest(taskDir, manifest);
  return manifest;
}

export async function hashPath(target) {
  const info = await lstat(target);
  if (info.isFile()) return hashFile(target);
  if (!info.isDirectory()) return null;
  const entries = await listFiles(target);
  const parts = [];
  for (const file of entries) {
    const rel = path.relative(target, file);
    parts.push(`${rel}:${await hashFile(file)}`);
  }
  return parts.join("|");
}

async function listFiles(dir) {
  const output = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) output.push(full);
    }
  }
  await walk(dir);
  output.sort();
  return output;
}

// 检测上游产物 hash 是否相对基线发生变化。
// 返回最早发生变化的阶段名（用于把其下游全部标 stale），无变化返回 null。
export async function detectUpstreamChange(taskDir, beforeStage) {
  const manifest = await loadTaskManifest(taskDir);
  if (!manifest?.stages) return null;
  const index = STAGE_ORDER.indexOf(beforeStage);
  if (index <= 0) return null;
  for (const stage of STAGE_ORDER.slice(0, index)) {
    const recorded = manifest.stages?.[stage]?.output_hashes;
    if (!recorded) continue;
    for (const [output, baseline] of Object.entries(recorded)) {
      const file = path.join(taskDir, output);
      if (!existsSync(file)) continue;
      const current = await hashPath(file);
      if (current !== baseline) {
        return stage;
      }
    }
  }
  return null;
}

export async function markDownstreamStale(taskDir, fromStage) {
  const manifest = await loadTaskManifest(taskDir);
  if (!manifest) return null;
  const index = STAGE_ORDER.indexOf(fromStage);
  if (index < 0) return manifest;
  manifest.active_artifacts ||= {};
  manifest.artifact_status ||= {};
  manifest.stale_artifacts ||= {};
  for (const stage of STAGE_ORDER.slice(index + 1)) {
    if (manifest.stages?.[stage]?.status === "succeeded") {
      manifest.stages[stage].status = "stale";
      manifest.stages[stage].stale_reason = `${fromStage} rerun`;
    }
    for (const output of STAGE_OUTPUTS[stage] || []) {
      const key = artifactKey(output);
      if (manifest.active_artifacts[key]) {
        manifest.stale_artifacts[key] = {
          path: manifest.active_artifacts[key],
          produced_by_stage: stage,
          stale_reason: `${fromStage} rerun`,
          stale_at: new Date().toISOString()
        };
        delete manifest.active_artifacts[key];
      }
      if (manifest.artifact_status[key]) {
        manifest.artifact_status[key] = {
          ...manifest.artifact_status[key],
          valid: false,
          stale_reason: `${fromStage} rerun`,
          stale_at: new Date().toISOString()
        };
      }
    }
  }
  manifest.status = "stale";
  manifest.updated_at = new Date().toISOString();
  await writeTaskManifest(taskDir, manifest);
  return manifest;
}
