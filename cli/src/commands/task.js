import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs, requireOption, optionalInt, optionalNumber } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { readJson, writeJson } from "../core/json.js";
import { canvasFromOptions, createTaskManifest, writeTaskManifest } from "../core/manifest.js";
import { compactDateTime, compactId, ensureDir, resolvePath, resolveWorkspace, slugify } from "../core/paths.js";
import { runPipeline, writeTaskBrief } from "../core/taskPipeline.js";

export async function runTaskCommand({ argv }) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "create") {
    await createTask(rest);
    return;
  }
  if (subcommand === "run") {
    await runTask(rest);
    return;
  }
  if (subcommand === "resume") {
    await runTask(rest);
    return;
  }
  if (subcommand === "inspect") {
    await inspectTask(rest);
    return;
  }
  throw new UserError("用法：voah task create|run|resume|inspect");
}

async function createTask(argv) {
  const options = parseArgs(argv, {
    boolean: ["gpu", "no-gpu", "no-browser-gpu"]
  });
  const workspace = resolveWorkspace(options.workspace);
  const productSlug = requireOption(options, "product");
  const productName = options["product-name"] || options.name || productSlug;
  const intakeRun = resolvePath(requireOption(options, "intake-run"), workspace);
  if (!existsSync(path.join(intakeRun, "shot_index.json"))) {
    throw new UserError(`intake-run 缺少 shot_index.json：${intakeRun}`);
  }
  const targetDurationS = optionalNumber(options["target-duration"] ?? options["target-duration-s"], 45);
  const canvas = canvasFromOptions(options);
  const label = options.label || `${targetDurationS}秒${options.platform || "抖音"}投放版`;
  const taskId = compactId("task");
  const taskSlug = `${compactDateTime()}_${slugify(label)}_${taskId.slice(-6)}`;
  const taskDir = resolvePath(options["task-dir"] || path.join("cache", "voah_tasks", productSlug, taskSlug), workspace);
  await ensureDir(path.join(taskDir, "logs"));
  const manifest = createTaskManifest({
    taskId,
    productSlug,
    productName,
    intakeRun,
    taskDir,
    targetDurationS,
    label,
    canvas
  });
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
  manifest.render = renderManifestFromOptions(options);
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
  console.log(`task_dir=${taskDir}`);
  console.log(`task_manifest=${path.join(taskDir, "task_manifest.json")}`);
}

async function runTask(argv) {
  const options = parseArgs(argv, {
    boolean: ["skip-omni", "run-omni", "no-subtitle-enable", "no-split-punctuation", "allow-inspect-warning", "gpu", "no-gpu", "no-browser-gpu"]
  });
  const workspace = resolveWorkspace(options.workspace);
  const taskArg = options._[0] || options.task;
  if (!taskArg) {
    throw new UserError("用法：voah task run <task_dir> [--from stage]");
  }
  const taskDir = resolvePath(taskArg, workspace);
  if (!existsSync(taskDir)) {
    throw new UserError(`任务目录不存在：${taskDir}`);
  }
  await runPipeline({ workspace, taskDir, from: options.from || "copy", options });
  console.log(`task_dir=${taskDir}`);
  console.log(`task_manifest=${path.join(taskDir, "task_manifest.json")}`);
}

function renderManifestFromOptions(options = {}) {
  const hyperframes = {};
  if (options["hyperframes-workers"] !== undefined || options.workers !== undefined) {
    hyperframes.workers = options["hyperframes-workers"] ?? options.workers;
  }
  if (options.gpu) {
    hyperframes.browser_gpu = true;
  } else if (options["no-gpu"] || options["no-browser-gpu"]) {
    hyperframes.browser_gpu = false;
  }
  return Object.keys(hyperframes).length ? { hyperframes } : {};
}

async function inspectTask(argv) {
  const options = parseArgs(argv);
  const workspace = resolveWorkspace(options.workspace);
  const taskArg = options._[0] || options.task;
  if (!taskArg) throw new UserError("用法：voah task inspect <task_dir>");
  const taskDir = resolvePath(taskArg, workspace);
  const manifestPath = path.join(taskDir, "task_manifest.json");
  if (!existsSync(manifestPath)) {
    throw new UserError(`缺少 task_manifest.json：${manifestPath}`);
  }
  console.log(JSON.stringify(await readJson(manifestPath), null, 2));
}
