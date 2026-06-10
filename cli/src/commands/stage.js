import { runCopyStage, runQaStage, runRenderStage, runRetrieveStage, runSubtitleStage, runTtsStage } from "../core/taskPipeline.js";
import { parseArgs } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { resolvePath, resolveWorkspace } from "../core/paths.js";

const HANDLERS = {
  copy: runCopyStage,
  tts: runTtsStage,
  retrieve: runRetrieveStage,
  subtitle: runSubtitleStage,
  render: runRenderStage,
  qa: runQaStage
};

export async function runStageCommand(stage, { argv }) {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "run") {
    throw new UserError(`用法：voah ${stage} run <task_dir>`);
  }
  const options = parseArgs(rest, {
    boolean: ["skip-omni", "no-subtitle-enable", "no-split-punctuation", "allow-inspect-warning"]
  });
  const workspace = resolveWorkspace(options.workspace);
  const taskArg = options._[0] || options.task;
  if (!taskArg) throw new UserError(`用法：voah ${stage} run <task_dir>`);
  const taskDir = resolvePath(taskArg, workspace);
  await HANDLERS[stage]({ workspace, taskDir, options });
}
