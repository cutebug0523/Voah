import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireOption, optionalInt, optionalNumber } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { readJson, writeJson } from "../core/json.js";
import { canvasFromOptions, createTaskManifest, writeTaskManifest } from "../core/manifest.js";
import { compactDateTime, compactId, ensureDir, resolvePath, resolveWorkspace, slugify } from "../core/paths.js";
import { runPipeline, writeTaskBrief } from "../core/taskPipeline.js";

export async function runBatchCommand({ argv }) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "pause") {
    await pauseBatch(rest);
    return;
  }
  if (subcommand === "resume") {
    await resumeBatch(rest);
    return;
  }
  if (subcommand !== "run") {
    throw new UserError("用法：voah batch run|pause|resume");
  }
  const options = parseArgs(rest, {
    boolean: ["skip-omni", "run-omni", "create-only", "no-subtitle-enable", "no-split-punctuation", "allow-inspect-warning"]
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
  const canvas = canvasFromOptions(options);
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
      label: taskLabel,
      canvas
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
      vol: optionalNumber(options.vol, 1),
      pitch: optionalInt(options.pitch ?? options["voice-setting-pitch"], 0),
      emotion: options.emotion || "happy",
      modify_pitch: optionalInt(options["modify-pitch"], 20),
      intensity: optionalInt(options["modify-intensity"], 20),
      timbre: optionalInt(options["modify-timbre"], 0),
      voice_modify: {
        pitch: optionalInt(options["modify-pitch"], 20),
        intensity: optionalInt(options["modify-intensity"], 20),
        timbre: optionalInt(options["modify-timbre"], 0)
      }
    };
    manifest.subtitle = {
      preset: options["subtitle-preset"] || "songti_white_gold_lower",
      font_source: options["font-source"] || ""
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
    resolution: canvas.preset,
    canvas,
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
  function nextTask() {
    if (cursor >= tasks.length) return null;
    const task = tasks[cursor];
    cursor += 1;
    return task || null;
  }
  async function worker() {
    while (true) {
      const task = nextTask();
      if (!task) return;
      if (await shouldStopForPause(batchDir, tasks)) {
        return;
      }
      if (task.status !== "queued") {
        continue;
      }
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
  if (existsSync(batchPauseControlPath(batchDir))) {
    await updateBatch(batchDir, tasks, "paused", { paused: true });
    return;
  }
  await updateBatch(batchDir, tasks, finalBatchStatus(tasks), { paused: false });
  await writeBatchResultLists(batchDir, tasks);
}

async function pauseBatch(argv) {
  const options = parseArgs(argv);
  const workspace = resolveWorkspace(options.workspace);
  const batchArg = options._[0] || options.batch || options["batch-dir"];
  if (!batchArg) {
    throw new UserError("用法：voah batch pause <batch_dir>");
  }
  const batchDir = resolvePath(batchArg, workspace);
  const manifestPath = path.join(batchDir, "batch_manifest.json");
  if (!existsSync(manifestPath)) {
    throw new UserError(`缺少 batch_manifest.json：${manifestPath}`);
  }
  await writeJson(batchPauseControlPath(batchDir), {
    schema_version: "voah.batch_control.v1",
    paused: true,
    updated_at: new Date().toISOString()
  });
  const manifest = await readJson(manifestPath);
  manifest.status = "paused";
  manifest.control = {
    ...(manifest.control || {}),
    paused: true,
    paused_at: new Date().toISOString()
  };
  await writeBatchFiles(batchDir, manifest);
  console.log(`batch_dir=${batchDir}`);
  console.log("paused=true");
}

async function resumeBatch(argv) {
  const options = parseArgs(argv, {
    boolean: ["skip-omni", "run-omni", "no-subtitle-enable", "no-split-punctuation", "allow-inspect-warning"]
  });
  const workspace = resolveWorkspace(options.workspace);
  const batchArg = options._[0] || options.batch || options["batch-dir"];
  if (!batchArg) {
    throw new UserError("用法：voah batch resume <batch_dir> [--concurrency K]");
  }
  const batchDir = resolvePath(batchArg, workspace);
  const manifestPath = path.join(batchDir, "batch_manifest.json");
  if (!existsSync(manifestPath)) {
    throw new UserError(`缺少 batch_manifest.json：${manifestPath}`);
  }
  if (existsSync(batchPauseControlPath(batchDir))) {
    await rm(batchPauseControlPath(batchDir), { force: true });
  }
  const manifest = await readJson(manifestPath);
  const tasks = await refreshTasksFromDisk((manifest.tasks || []).map((task) => ({ ...task })));
  const concurrency = Math.max(1, optionalInt(options.concurrency ?? manifest.concurrency, 2));
  options.resolution ??= manifest.resolution || manifest.canvas?.preset;
  options.width ??= manifest.canvas?.width;
  options.height ??= manifest.canvas?.height;
  options.fps ??= manifest.canvas?.fps;
  const runnable = tasks.filter((task) => isRunnableOnResume(task));
  const running = tasks.filter((task) => task.status === "running");
  for (const task of runnable) {
    task.status = "queued";
    if (!options.from) {
      task.resume_from = task.failed_stage || task.current_stage || task.resume_from || "";
    }
  }
  manifest.control = {
    ...(manifest.control || {}),
    paused: false,
    resumed_at: new Date().toISOString()
  };
  manifest.status = runnable.length ? "running" : finalBatchStatus(tasks);
  manifest.tasks = tasks;
  manifest.concurrency = concurrency;
  await writeBatchFiles(batchDir, manifest);
  if (running.length) {
    await updateBatch(batchDir, tasks, "running", { paused: false });
  } else if (runnable.length) {
    await runQueue({ workspace, batchDir, tasks, concurrency, options });
  } else {
    await updateBatch(batchDir, tasks, manifest.status, { paused: false });
    await writeBatchResultLists(batchDir, tasks);
  }
  console.log(`batch_dir=${batchDir}`);
  console.log("paused=false");
  console.log(`queued=${runnable.length}`);
  console.log(`running=${running.length}`);
}

function isRunnableOnResume(task) {
  if (!task) return false;
  if (["running", "succeeded", "completed"].includes(task.status)) return false;
  return ["queued", "failed", "needs_review", "stale"].includes(task.status);
}

function batchPauseControlPath(batchDir) {
  return path.join(batchDir, "batch_control.json");
}

async function shouldStopForPause(batchDir, tasks) {
  if (!existsSync(batchPauseControlPath(batchDir))) {
    return false;
  }
  await updateBatch(batchDir, tasks, "paused", { paused: true });
  return true;
}

async function runSingleTask({ workspace, task, options }) {
  const maxRetries = Math.max(0, optionalInt(options.retries, 0));
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await runPipeline({ workspace, taskDir: task.task_dir, from: options.from || task.resume_from || task.failed_stage || "copy", options });
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
      task.failed_stage = await inferFailedStage(task.task_dir);
      task.error_message = error.message || String(error);
    }
  }
  throw lastError;
}

async function inferFailedStage(taskDir) {
  try {
    const manifest = await readJson(path.join(taskDir, "task_manifest.json"));
    const failed = Object.entries(manifest.stages || {}).find(([, info]) => info?.status === "failed");
    return failed?.[0] || "";
  } catch {
    return "";
  }
}

async function writeBatchFiles(batchDir, manifest) {
  await writeJson(path.join(batchDir, "batch_manifest.json"), manifest);
  await writeJson(path.join(batchDir, "tasks.json"), {
    schema_version: "voah.batch_tasks.v1",
    tasks: manifest.tasks
  });
}

async function updateBatch(batchDir, tasks, status, controlPatch = null) {
  const manifestPath = path.join(batchDir, "batch_manifest.json");
  const manifest = await readJson(manifestPath);
  const refreshedTasks = await refreshTasksFromDisk(tasks);
  const effectiveStatus = status === "running" || status === "paused" ? status : finalBatchStatus(refreshedTasks);
  manifest.status = effectiveStatus;
  manifest.tasks = refreshedTasks;
  if (controlPatch) {
    manifest.control = {
      ...(manifest.control || {}),
      ...controlPatch
    };
  }
  manifest.summary = {
    queued: refreshedTasks.filter((item) => item.status === "queued").length,
    running: refreshedTasks.filter((item) => item.status === "running").length,
    succeeded: refreshedTasks.filter((item) => ["succeeded", "completed"].includes(item.status)).length,
    needs_review: refreshedTasks.filter((item) => item.status === "needs_review").length,
    failed: refreshedTasks.filter((item) => item.status === "failed").length
  };
  manifest.updated_at = new Date().toISOString();
  await writeBatchFiles(batchDir, manifest);
  tasks.splice(0, tasks.length, ...refreshedTasks);
}

function finalBatchStatus(tasks) {
  const failed = tasks.some((item) => item.status === "failed");
  const review = tasks.some((item) => item.status === "needs_review" || isReviewQaStatus(item.qa_status));
  if (failed && review) return "partial_failed_needs_review";
  if (failed) return "partial_failed";
  if (review) return "needs_review";
  return "completed";
}

function isPassingQaStatus(status) {
  return ["ok", "pass", "succeeded", "warning"].includes(String(status || ""));
}

function isReviewQaStatus(status) {
  return ["needs_review", "manual_review"].includes(String(status || ""));
}

async function writeBatchResultLists(batchDir, tasks) {
  const refreshedTasks = await refreshTasksFromDisk(tasks);
  const passed = refreshedTasks.filter((item) => {
    if (!["succeeded", "completed"].includes(item.status)) return false;
    if (!isPassingQaStatus(item.qa_status)) return false;
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
  const review = refreshedTasks.filter((item) => item.status === "needs_review" || !isPassingQaStatus(item.qa_status));
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

async function refreshTasksFromDisk(tasks) {
  const refreshed = [];
  for (const task of tasks) {
    refreshed.push(await refreshTaskFromDisk(task));
  }
  return refreshed;
}

async function refreshTaskFromDisk(task) {
  if (!task?.task_dir) return task;
  const manifestPath = path.join(task.task_dir, "task_manifest.json");
  if (!existsSync(manifestPath)) return task;
  try {
    const manifest = await readJson(manifestPath);
    const manifestStatus = String(manifest.status || "");
    let status = manifest.status || task.status;
    if (["succeeded", "completed"].includes(manifestStatus)) {
      status = manifest.status;
    } else if (task.status === "running" && ["queued", "stale", ""].includes(manifestStatus)) {
      status = "running";
    }
    const qaStatus = manifest.qa?.status || task.qa_status || "";
    const finalVideo = manifest.active_artifacts?.final_subtitled
      ? path.join(task.task_dir, manifest.active_artifacts.final_subtitled)
      : task.final_video || "";
    const nextTask = {
      ...task,
      status,
      qa_status: qaStatus,
      final_video: finalVideo
    };
    if (["succeeded", "completed"].includes(status)) {
      delete nextTask.failed_stage;
      delete nextTask.error_message;
      delete nextTask.resume_from;
    } else {
      nextTask.failed_stage = task.failed_stage || (await inferFailedStage(task.task_dir));
    }
    return nextTask;
  } catch {
    return task;
  }
}
