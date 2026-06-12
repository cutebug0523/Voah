import { parseArgs, requireOption } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { resolvePath, resolveWorkspace } from "../core/paths.js";
import { ResourceService } from "../services/resourceService.js";
import { SecretService } from "../services/secretService.js";

export async function runResourceCommand({ argv }) {
  const [subcommand, ...rest] = argv;
  const options = parseArgs(rest, { boolean: ["expired-only"] });
  const workspace = resolveWorkspace(options.workspace);
  const service = new ResourceService({ workspace });
  if (subcommand === "upload") {
    const file = resolvePath(requireOption(options, "file"), workspace);
    const purpose = requireOption(options, "purpose");
    const runDir = resolvePath(options.run || options["run-dir"] || options.outputDir || process.cwd(), workspace);
    const secretService = new SecretService({ workspace });
    const resource = await service.upload({
      runDir,
      file,
      purpose,
      model: options.model || "qwen3.5-omni-plus",
      env: await secretService.envForModules(["material_understanding"]),
      consumers: options.consumer ? [options.consumer] : []
    });
    console.log(JSON.stringify(publicResource(resource), null, 2));
    return;
  }
  if (subcommand === "cleanup") {
    const runDir = resolvePath(requireOption(options, "run"), workspace);
    const cleanup = await service.cleanup({ runDir, expiredOnly: Boolean(options["expired-only"]) });
    console.log(JSON.stringify(cleanup, null, 2));
    return;
  }
  throw new UserError("用法：voah resource upload|cleanup");
}

function publicResource(resource) {
  const { remote_url: _remoteUrl, ...rest } = resource;
  return rest;
}
