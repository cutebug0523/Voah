import { runBatchCommand } from "./commands/batch.js";
import { runConfigCommand } from "./commands/config.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runIntakeCommand } from "./commands/intake.js";
import { runProductCommand } from "./commands/product.js";
import { runResourceCommand } from "./commands/resource.js";
import { runStageCommand } from "./commands/stage.js";
import { runTaskCommand } from "./commands/task.js";
import { runTtsPreview } from "./commands/ttsPreview.js";
import { UserError } from "./core/errors.js";

const COMMANDS = new Map([
  ["doctor", runDoctorCommand],
  ["config", runConfigCommand],
  ["product", runProductCommand],
  ["intake", runIntakeCommand],
  ["task", runTaskCommand],
  ["copy", (ctx) => runStageCommand("copy", ctx)],
  ["tts", runTtsCommand],
  ["retrieve", (ctx) => runStageCommand("retrieve", ctx)],
  ["subtitle", (ctx) => runStageCommand("subtitle", ctx)],
  ["render", (ctx) => runStageCommand("render", ctx)],
  ["qa", (ctx) => runStageCommand("qa", ctx)],
  ["batch", runBatchCommand],
  ["resource", runResourceCommand]
]);

// tts 有两个子命令：run（任务主线阶段）和 preview（独立试听，不进主线）。
function runTtsCommand(ctx) {
  if (ctx.argv[0] === "preview") {
    return runTtsPreview({ ...ctx, argv: ctx.argv.slice(1) });
  }
  return runStageCommand("tts", ctx);
}

export async function main(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log("voah-cli 0.1.0");
    return;
  }
  const handler = COMMANDS.get(command);
  if (!handler) {
    throw new UserError(`未知命令：${command}`);
  }
  try {
    await handler({ argv: args, command });
  } catch (error) {
    if (error instanceof UserError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

function printHelp() {
  console.log(`Voah CLI

用法:
  voah doctor [--workspace <dir>]
  voah config get|set <key> [value]
  voah product create|list|inspect
  voah intake run --product <slug> --source-dir <dir> [--limit N] [--label label]
  voah task create --product <slug> --intake-run <dir> [--target-duration N] [--label label]
  voah task run <task_dir> [--from stage]
  voah copy|tts|retrieve|subtitle|render|qa run <task_dir>
  voah tts preview --text <文本> | --text-file <文件> [--provider ...] [--voice-id ...] [--dry-run]
  voah batch run --product <slug> --intake-run <dir> --count N [--concurrency K]
  voah resource upload --file <path> --purpose <purpose>
  voah resource cleanup --run <dir> [--expired-only]
`);
}
