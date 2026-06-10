import path from "node:path";
import { parseArgs, requireOption, optionalInt, optionalNumber } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { readJson } from "../core/json.js";
import { compactId, resolvePath, resolveWorkspace } from "../core/paths.js";
import { ResourceService } from "../services/resourceService.js";
import { SecretService } from "../services/secretService.js";
import { WorkerRunner } from "../services/workerRunner.js";

export async function runIntakeCommand({ argv }) {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "run") {
    throw new UserError("用法：voah intake run --product <slug> --source-dir <dir> [--limit N] [--label label]");
  }
  const options = parseArgs(rest, { aliases: { product: "product", limit: "limit", label: "label" } });
  const workspace = resolveWorkspace(options.workspace);
  const productSlug = requireOption(options, "product");
  const productName = options["product-name"] || options.name || productSlug;
  const sourceDir = resolvePath(requireOption(options, "source-dir"), workspace);
  const label = options.label || "cli_intake_v1";
  const maxVideos = optionalInt(options.limit ?? options["max-videos"], 0);
  const secretService = new SecretService();
  const runner = new WorkerRunner({ workspace, secretService });
  const result = await runner.run({
    command: "python3",
    args: [
      path.join(workspace, "scripts", "voah_intake_desktop_wrapper.py"),
      "--job-id",
      compactId("intake"),
      "--workspace",
      workspace,
      "--product-slug",
      productSlug,
      "--product-name",
      productName,
      "--source-dir",
      sourceDir,
      "--max-videos",
      String(maxVideos),
      "--run-label",
      label,
      ...(options["scene-threshold"] ? ["--scene-threshold", String(optionalNumber(options["scene-threshold"], 0))] : []),
      ...(options["candidate-min-duration"] ? ["--candidate-min-duration", String(optionalNumber(options["candidate-min-duration"], 0))] : []),
      ...(options["min-physical-duration"] ? ["--min-physical-duration", String(optionalNumber(options["min-physical-duration"], 0))] : [])
    ],
    cwd: workspace,
    stage: "intake",
    moduleIds: ["material_understanding", "material_vectorization"]
  });
  const parsed = extractJson(result.stdout);
  const runDir = parsed.outputs?.run_dir || "";
  if (runDir) {
    const resourceService = new ResourceService({ workspace });
    await resourceService.importDashscopeUploadFile({
      runDir,
      uploadFile: path.join(runDir, "trim_upload_results_physical.json"),
      purpose: "embedding",
      consumers: ["qwen3-vl-embedding"]
    });
  }
  console.log(result.stdout.trim());
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
  }
  return {};
}
