import { existsSync } from "node:fs";
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
  subtitle: ["caption_plan.json", "hyperframes_subtitle_burn/hyperframes_subtitle_burn_manifest.json"],
  render: ["hyperframes_subtitle_burn/final_subtitled.mp4"],
  qa: ["qa_gate_report.json", "full_pipeline_manifest.json", "desktop_quality_report.json"]
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

export function createTaskManifest({ taskId, productSlug, productName, intakeRun, taskDir, targetDurationS, label }) {
  return {
    schema_version: "voah.task_manifest.v1",
    task_id: taskId || compactId("task"),
    product_slug: productSlug,
    product_name: productName || productSlug,
    intake_run: intakeRun,
    task_dir: taskDir,
    label: label || "",
    target_duration_s: targetDurationS,
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

export async function markStage(taskDir, stage, patch) {
  const manifest = (await loadTaskManifest(taskDir)) || createTaskManifest({ taskDir });
  manifest.stages ||= {};
  const previous = manifest.stages[stage] || {};
  const next = {
    ...previous,
    ...patch,
    updated_at: new Date().toISOString()
  };
  if (["running", "succeeded"].includes(patch.status)) {
    delete next.stale_reason;
    delete next.stale_at;
  }
  manifest.stages[stage] = {
    ...next
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
