import { runStageByName } from "../core/taskPipeline.js";
import { detectUpstreamChange, markDownstreamStale } from "../core/manifest.js";
import { parseArgs } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { resolvePath, resolveWorkspace } from "../core/paths.js";

const STAGES = new Set(["copy", "tts", "retrieve", "subtitle", "render", "qa"]);

export async function runStageCommand(stage, { argv }) {
  if (!STAGES.has(stage)) throw new UserError(`未知阶段：${stage}`);
  const [subcommand, ...rest] = argv;
  if (subcommand !== "run") {
    throw new UserError(`用法：voah ${stage} run <task_dir>`);
  }
  const options = parseArgs(rest, {
    boolean: [
      "skip-omni",
      "run-omni",
      "no-subtitle-enable",
      "no-split-punctuation",
      "allow-inspect-warning",
      "gpu",
      "no-gpu",
      "no-browser-gpu"
    ]
  });
  const workspace = resolveWorkspace(options.workspace);
  const taskArg = options._[0] || options.task;
  if (!taskArg) throw new UserError(`用法：voah ${stage} run <task_dir>`);
  const taskDir = resolvePath(taskArg, workspace);
  // 单阶段复跑也做上游 stale 检测：上游产物变了先提示并标下游 stale。
  const changedStage = await detectUpstreamChange(taskDir, stage);
  if (changedStage) {
    console.warn(`上游阶段 ${changedStage} 的产物已变更，已将其下游标记为 stale。`);
    console.warn(`建议从该阶段重跑：voah task run ${taskDir} --from ${changedStage}`);
    await markDownstreamStale(taskDir, changedStage);
  }
  await runStageByName(stage, { workspace, taskDir, options });
}
