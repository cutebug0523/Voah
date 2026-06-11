import { parseArgs } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { SecretService } from "../services/secretService.js";

export async function runConfigCommand({ argv }) {
  const [subcommand, ...rest] = argv;
  const service = new SecretService();
  if (!subcommand || subcommand === "get") {
    const config = await service.publicConfig();
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (subcommand === "set") {
    const options = parseArgs(rest, { aliases: { v: "value" } });
    const key = options._[0];
    if (!key) {
      throw new UserError("用法：voah config set <key> [value]");
    }
    const value = options.value ?? options._[1] ?? (await readStdinIfAvailable());
    if (!value) {
      throw new UserError("缺少配置值。可用管道传入，或 voah config set <key> <value>");
    }
    await service.set(key, String(value).trim());
    console.log(`${key}=configured`);
    return;
  }
  throw new UserError(`未知 config 子命令：${subcommand}`);
}

async function readStdinIfAvailable() {
  if (process.stdin.isTTY) {
    return "";
  }
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value;
}
