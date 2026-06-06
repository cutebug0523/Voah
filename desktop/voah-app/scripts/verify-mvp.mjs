import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { StoreService } from "../electron/services/storeService.js";
import { ProductionRecipe } from "../electron/services/productionRecipe.js";
import { RECIPE_STAGES } from "../src/lib/mvpContracts.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "voah-mvp-"));
const workspaceRoot = path.join(tempRoot, "workspace");
const appDataDir = path.join(tempRoot, "appdata");

try {
  const store = new StoreService({ appDataDir, workspaceRoot });
  const recipe = new ProductionRecipe({ storeService: store });
  const initial = await store.read();

  assert.equal(initial.products.length >= 1, true, "should seed products");
  const readyProduct = initial.products.find((product) => product.status === "ready");
  assert.ok(readyProduct, "should have a ready product");

  const tasks = await recipe.createBatch({
    productId: readyProduct.id,
    count: 2,
    brief: {
      target_platform: "抖音",
      target_duration_s: 45,
      main_claim: "自然气色、防晒持妆",
      offer: "今日活动价",
      forbidden: "不夸大功效"
    }
  });

  assert.equal(tasks.length, 2, "should create requested tasks");
  await recipe.runTask(tasks[0].id);

  let current = await store.read();
  const finishedTask = current.tasks.find((task) => task.id === tasks[0].id);
  assert.equal(finishedTask.status, "qa_warning", "dry-run should finish with QA warning");

  const taskArtifacts = current.artifacts.filter((artifact) => artifact.task_id === tasks[0].id);
  assert.equal(taskArtifacts.length, RECIPE_STAGES.length, "should create one artifact per recipe stage");
  assert.ok(taskArtifacts.every((artifact) => artifact.path && artifact.job_id), "artifacts should have path and producer job");

  const qa = current.qa_reports.find((report) => report.task_id === tasks[0].id);
  assert.equal(qa.status, "manual_review", "qa gate should require human spot review in dry-run");
  assert.equal(qa.checks.length >= 5, true, "qa report should include gate checks");

  const voiceScript = taskArtifacts.find((artifact) => artifact.kind === "voice_script");
  const voicePayload = JSON.parse(await readFile(voiceScript.path, "utf8"));
  assert.equal(voicePayload.subtitle_policy, "verbatim_voice_text_split");

  const failedTasks = await recipe.createBatch({
    productId: readyProduct.id,
    count: 1,
    brief: {
      target_platform: "抖音",
      target_duration_s: 45,
      main_claim: "失败重试验证"
    }
  });
  await recipe.runTask(failedTasks[0].id, { failStage: "tts_audio" });
  current = await store.read();
  const failedTask = current.tasks.find((task) => task.id === failedTasks[0].id);
  assert.equal(failedTask.status, "failed", "should record simulated failure");
  assert.equal(failedTask.human_error.suggested_action, "重试失败步骤");

  await recipe.retryFailedTask(failedTask.id);
  current = await store.read();
  const retriedTask = current.tasks.find((task) => task.id === failedTask.id);
  assert.equal(retriedTask.status, "qa_warning", "retry should complete task");
  const retryJob = current.jobs.find((job) => job.retry_of_job_id);
  assert.ok(retryJob, "retry job should record retry_of_job_id");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        products: initial.products.length,
        tasks: current.tasks.length,
        artifacts: current.artifacts.length,
        qa_reports: current.qa_reports.length,
        recipe_stages: RECIPE_STAGES.length
      },
      null,
      2
    )
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
