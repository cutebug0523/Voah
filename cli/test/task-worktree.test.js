import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createTaskRun, promoteStageOutputs } from "../src/core/taskRun.js";
import { createTaskManifest, loadTaskManifest, refreshActiveArtifacts, writeTaskManifest } from "../src/core/manifest.js";

test("task run workspace promotes outputs without writing secrets or losing manifest history", async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "voah-worktree-promote-"));
  await writeTaskManifest(taskDir, createTaskManifest({
    taskId: "task_demo",
    productSlug: "demo",
    productName: "Demo",
    intakeRun: "/tmp/intake",
    taskDir,
    targetDurationS: 45
  }));

  const runContext = await createTaskRun({ taskDir, from: "copy", scope: "pipeline" });
  await writeFile(path.join(runContext.outputDir, "copy_brief.json"), JSON.stringify({ ok: true }));
  await writeFile(path.join(runContext.outputDir, "voice_script.json"), JSON.stringify({ full_voice_text: "v1" }));
  await promoteStageOutputs({ taskDir, runContext, stage: "copy" });
  await refreshActiveArtifacts(taskDir, "copy");

  assert.equal(existsSync(path.join(taskDir, "voice_script.json")), true);
  assert.equal(existsSync(path.join(runContext.runDir, "run_manifest.json")), true);
  const taskManifest = await loadTaskManifest(taskDir);
  assert.equal(taskManifest.runs.latest, runContext.runId);
  assert.equal(taskManifest.stages.copy.promoted_run_id, runContext.runId);
  assert.equal(taskManifest.active_artifacts.voice_script, "voice_script.json");
  const runManifestText = await readFile(path.join(runContext.runDir, "run_manifest.json"), "utf8");
  assert.doesNotMatch(runManifestText, /sk-[A-Za-z0-9_-]{12,}/);
});

test("failed run outputs stay isolated until promotion", async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "voah-worktree-failed-"));
  await writeFile(path.join(taskDir, "voice_script.json"), JSON.stringify({ full_voice_text: "stable" }));
  await writeTaskManifest(taskDir, createTaskManifest({
    taskId: "task_demo",
    productSlug: "demo",
    intakeRun: "/tmp/intake",
    taskDir,
    targetDurationS: 45
  }));

  const runContext = await createTaskRun({ taskDir, stage: "copy", scope: "stage" });
  await writeFile(path.join(runContext.outputDir, "voice_script.json"), JSON.stringify({ full_voice_text: "draft" }));

  const stable = JSON.parse(await readFile(path.join(taskDir, "voice_script.json"), "utf8"));
  const draft = JSON.parse(await readFile(path.join(runContext.outputDir, "voice_script.json"), "utf8"));
  assert.equal(stable.full_voice_text, "stable");
  assert.equal(draft.full_voice_text, "draft");
});

test("slower run is superseded after newer promotion wins", async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "voah-worktree-supersede-"));
  await writeTaskManifest(taskDir, createTaskManifest({
    taskId: "task_demo",
    productSlug: "demo",
    intakeRun: "/tmp/intake",
    taskDir,
    targetDurationS: 45
  }));

  const slow = await createTaskRun({ taskDir, stage: "copy", scope: "stage" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fast = await createTaskRun({ taskDir, stage: "copy", scope: "stage" });
  await mkdir(path.join(slow.outputDir), { recursive: true });
  await mkdir(path.join(fast.outputDir), { recursive: true });
  await writeFile(path.join(slow.outputDir, "copy_brief.json"), "{}");
  await writeFile(path.join(slow.outputDir, "voice_script.json"), JSON.stringify({ full_voice_text: "slow" }));
  await writeFile(path.join(fast.outputDir, "copy_brief.json"), "{}");
  await writeFile(path.join(fast.outputDir, "voice_script.json"), JSON.stringify({ full_voice_text: "fast" }));

  await promoteStageOutputs({ taskDir, runContext: fast, stage: "copy" });
  await assert.rejects(
    () => promoteStageOutputs({ taskDir, runContext: slow, stage: "copy" }),
    /已被更新的 copy 合入取代/
  );
  const promoted = JSON.parse(await readFile(path.join(taskDir, "voice_script.json"), "utf8"));
  assert.equal(promoted.full_voice_text, "fast");
});
