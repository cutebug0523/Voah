import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs, requireOption, optionalInt, optionalNumber } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { readJson, writeJson } from "../core/json.js";
import { createTaskManifest, writeTaskManifest } from "../core/manifest.js";
import { compactDateTime, compactId, ensureDir, resolvePath, resolveWorkspace, slugify } from "../core/paths.js";
import { runPipeline, writeTaskBrief } from "../core/taskPipeline.js";

export async function runBatchCommand({ argv }) {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "run") {
    throw new UserError("用法：voah batch run --product <slug> --intake-run <dir> --count N [--concurrency K]");
  }
  const options = parseArgs(rest, {
    boolean: ["skip-omni", "create-only", "no-subtitle-enable", "no-split-punctuation", "allow-inspect-warning"]
  });
  const workspace = resolveWorkspace(options.workspace);
  const productSlug = requireOption(options, "product");
  const productName = options["product-name"] || options.name || productSlug;
  const intakeRun = resolvePath(requireOption(options, "intake-run"), workspace);
  if (!existsSync(path.join(intakeRun, "shot_index.json"))) {
    throw new UserError(`intake-run 缺少 shot_index.json：${intakeRun}`);
  }
  const count = Math.max(1, optionalInt(options.count, 1));
  const concurrency = Math.max(1, optionalInt(options.concurrency, 2));
  const targetDurationS = optionalNumber(options["target-duration"] ?? options["target-duration-s"], 45);
  const batchSlug = `${compactDateTime()}_${slugify(options.label || `${targetDurationS}秒批量${count}条`)}`;
  const batchDir = resolvePath(options["batch-dir"] || path.join("cache", "voah_batches", productSlug, batchSlug), workspace);
  await ensureDir(path.join(batchDir, "logs"));
  const tasks = [];
  for (let index = 0; index < count; index += 1) {
    const taskId = compactId("task");
    const taskLabel = `${options.label || `${targetDurationS}秒投放版`} #${index + 1}`;
    const taskDir = path.join(batchDir, "tasks", `${String(index + 1).padStart(3, "0")}_${slugify(taskLabel)}_${taskId.slice(-6)}`);
    await ensureDir(path.join(taskDir, "logs"));
    const manifest = createTaskManifest({
      taskId,
      productSlug,
      productName,
      intakeRun,
      taskDir,
      targetDurationS,
      label: taskLabel
    });
    manifest.batch = {
      batch_dir: batchDir,
      index: index + 1,
      count
    };
    manifest.tts = {
      provider: options["tts-provider"] || "minimax-official",
      model: options["tts-model"] || "speech-2.8-hd",
      voice_id: options["voice-id"] || "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
      speed: optionalNumber(options.speed, 1.1),
      emotion: options.emotion || "happy",
      voice_modify: {
        pitch: 20,
        intensity: 20,
        timbre: 0
      }
    };
    await writeTaskManifest(taskDir, manifest);
    await writeTaskBrief({
      workspace,
      taskDir,
      manifest,
      brief: {
        platform: options.platform || "抖音",
        target_duration_s: targetDurationS,
        main_claim: options["main-claim"] || "",
        offer: options.offer || "",
        forbidden: options.forbidden || "",
        cta_policy: options.cta || "",
        style: options.style || "",
        audience: options.audience || ""
      }
    });
    tasks.push({ task_id: taskId, task_dir: taskDir, status: "queued", index: index + 1 });
  }
  await writeBatchFiles(batchDir, {
    schema_version: "voah.batch_manifest.v1",
    batch_id: compactId("batch"),
    product_slug: productSlug,
    product_name: productName,
    intake_run: intakeRun,
    status: options["create-only"] ? "queued" : "running",
    count,
    concurrency,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tasks
  });
  if (!options["create-only"]) {
    await runQueue({ workspace, batchDir, tasks, concurrency, options });
  }
  console.log(`batch_dir=${batchDir}`);
  console.log(`batch_manifest=${path.join(batchDir, "batch_manifest.json")}`);
}

async function runQueue({ workspace, batchDir, tasks, concurrency, options }) {
  let cursor = 0;
  const workerCount = Math.min(concurrency, tasks.length);
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      task.status = "running";
      await updateBatch(batchDir, tasks, "running");
      try {
        const result = await runSingleTask({ workspace, task, options });
        task.status = result.status;
        task.final_video = result.final_video || "";
        task.qa_status = result.qa_status || "";
      } catch (error) {
        task.status = "failed";
        task.error_message = error.message || String(error);
      }
      await updateBatch(batchDir, tasks, "running");
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  await updateBatch(batchDir, tasks, finalBatchStatus(tasks));
  await writeBatchResultLists(batchDir, tasks);
}

async function runSingleTask({ workspace, task, options }) {
  const maxRetries = Math.max(0, optionalInt(options.retries, 0));
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await runPipeline({ workspace, taskDir: task.task_dir, from: options.from || "copy", options });
      const manifest = await readJson(path.join(task.task_dir, "task_manifest.json"));
      const finalVideo = manifest.active_artifacts?.final_subtitled
        ? path.join(task.task_dir, "hyperframes_subtitle_burn", "final_subtitled.mp4")
        : "";
      return {
        task_dir: task.task_dir,
        status: manifest.status || "completed",
        qa_status: manifest.qa?.status || "",
        final_video: finalVideo
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function writeBatchFiles(batchDir, manifest) {
  await writeJson(path.join(batchDir, "batch_manifest.json"), manifest);
  await writeJson(path.join(batchDir, "tasks.json"), {
    schema_version: "voah.batch_tasks.v1",
    tasks: manifest.tasks
  });
}

async function updateBatch(batchDir, tasks, status) {
  const manifestPath = path.join(batchDir, "batch_manifest.json");
  const manifest = await readJson(manifestPath);
  manifest.status = status;
  manifest.tasks = tasks;
  manifest.summary = {
    queued: tasks.filter((item) => item.status === "queued").length,
    running: tasks.filter((item) => item.status === "running").length,
    succeeded: tasks.filter((item) => ["succeeded", "completed"].includes(item.status)).length,
    needs_review: tasks.filter((item) => item.status === "needs_review").length,
    failed: tasks.filter((item) => item.status === "failed").length
  };
  manifest.updated_at = new Date().toISOString();
  await writeBatchFiles(batchDir, manifest);
}

function finalBatchStatus(tasks) {
  const failed = tasks.some((item) => item.status === "failed");
  const review = tasks.some((item) => item.status === "needs_review" || item.qa_status === "needs_review");
  if (failed && review) return "partial_failed_needs_review";
  if (failed) return "partial_failed";
  if (review) return "needs_review";
  return "completed";
}

async function writeBatchResultLists(batchDir, tasks) {
  const passed = tasks.filter((item) => {
    if (!["succeeded", "completed"].includes(item.status)) return false;
    if (!["ok", "pass", "succeeded"].includes(item.qa_status || "")) return false;
    return item.final_video && existsSync(item.final_video);
  });
  await writeJson(path.join(batchDir, "passed_videos.json"), {
    schema_version: "voah.batch_passed_videos.v1",
    created_at: new Date().toISOString(),
    passed_count: passed.length,
    videos: passed.map((item) => ({
      task_dir: item.task_dir,
      final_video: item.final_video || path.join(item.task_dir, "hyperframes_subtitle_burn", "final_subtitled.mp4"),
      qa_status: item.qa_status || ""
    }))
  });
  const review = tasks.filter((item) => item.status === "needs_review" || !["ok", "pass", "succeeded"].includes(item.qa_status || ""));
  await writeJson(path.join(batchDir, "needs_review_videos.json"), {
    schema_version: "voah.batch_needs_review_videos.v1",
    created_at: new Date().toISOString(),
    needs_review_count: review.length,
    videos: review.map((item) => ({
      task_dir: item.task_dir,
      final_video: item.final_video || "",
      status: item.status,
      qa_status: item.qa_status || "",
      error_message: item.error_message || ""
    }))
  });
}
