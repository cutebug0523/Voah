import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs, requireOption, optionalInt, optionalNumber } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { readJson, writeJson } from "../core/json.js";
import { compactId, resolvePath, resolveWorkspace } from "../core/paths.js";
import { ResourceService } from "../services/resourceService.js";
import { SecretService } from "../services/secretService.js";
import { WorkerRunner } from "../services/workerRunner.js";

export async function runIntakeCommand({ argv }) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "merge") {
    await mergeIntake(rest);
    return;
  }
  if (!["run", "add"].includes(subcommand)) {
    throw new UserError("用法：voah intake run|add --product <slug> --source-dir <dir> [--limit N] [--label label]；voah intake merge --product <slug>");
  }
  const options = parseArgs(rest, {
    aliases: { product: "product", limit: "limit", label: "label" },
    boolean: ["no-refine-children", "skip-upload", "skip-vectorize", "force-reindex", "include-existing-failed"]
  });
  const workspace = resolveWorkspace(options.workspace);
  const productSlug = requireOption(options, "product");
  const productDir = path.join(workspace, "data", "products", productSlug);
  const product = existsSync(path.join(productDir, "product.json")) ? await readJson(path.join(productDir, "product.json")) : {};
  const productName = options["product-name"] || options.name || product.name || productSlug;
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
      "--mode",
      options.mode || (subcommand === "add" ? "add" : "add"),
      ...(options["scene-threshold"] ? ["--scene-threshold", String(optionalNumber(options["scene-threshold"], 0))] : []),
      ...(options["candidate-min-duration"] ? ["--candidate-min-duration", String(optionalNumber(options["candidate-min-duration"], 0))] : []),
      ...(options["min-physical-duration"] ? ["--min-physical-duration", String(optionalNumber(options["min-physical-duration"], 0))] : []),
      ...(options["force-reindex"] ? ["--force-reindex"] : []),
      ...(options["include-existing-failed"] ? ["--include-existing-failed"] : []),
      ...(options["no-refine-children"] ? ["--no-refine-children"] : []),
      ...(options["refine-workers"] ? ["--refine-workers", String(optionalInt(options["refine-workers"], 0))] : []),
      ...(options["refine-limit"] ? ["--refine-limit", String(optionalInt(options["refine-limit"], 0))] : []),
      ...(options["refine-timeout-s"] ? ["--refine-timeout-s", String(optionalInt(options["refine-timeout-s"], 0))] : []),
      ...(options["skip-upload"] ? ["--skip-upload"] : []),
      ...(options["skip-vectorize"] ? ["--skip-vectorize"] : [])
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
    await refineProductContextAfterIntake({ workspace, productSlug, productName, category: options.category || product.category || "", runDir });
  }
  console.log(result.stdout.trim());
}

async function refineProductContextAfterIntake({ workspace, productSlug, productName, category, runDir }) {
  const productDir = path.join(workspace, "data", "products", productSlug);
  const runner = new WorkerRunner({ workspace, secretService: new SecretService() });
  try {
    await runner.run({
      command: "python3",
      args: [
        path.join(workspace, "scripts", "voah_refine_product_context.py"),
        "--run-dir",
        runDir,
        "--product-dir",
        productDir,
        "--product-slug",
        productSlug,
        "--product-name",
        productName,
        "--category",
        category || "",
      ],
      cwd: workspace,
      stage: "product_context_refinement",
      moduleIds: ["product_context_refinement"],
      timeoutMs: 240000
    });
  } catch (error) {
    const statusPath = path.join(runDir, "product_context_refinement_status.json");
    await writeJson(statusPath, {
      schema_version: "voah.product_context_refinement_status.v1",
      status: "failed",
      updated_at: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 1200)
    });
  }
}

async function mergeIntake(argv) {
  const options = parseArgs(argv);
  const workspace = resolveWorkspace(options.workspace);
  const productSlug = requireOption(options, "product");
  const productName = options["product-name"] || options.name || productSlug;
  const productRoot = path.join(workspace, "cache", "voah_video_intake", productSlug);
  const runNames = await safeReaddir(productRoot);
  const records = [];
  const warnings = [];
  const sourceRunDirs = [];
  for (const name of runNames.sort()) {
    if (name.startsWith("_")) continue;
    const runDir = path.join(productRoot, name);
    const indexPath = path.join(runDir, "shot_index.json");
    const index = await readJsonIfExists(indexPath);
    if (!Array.isArray(index?.records)) continue;
    sourceRunDirs.push(runDir);
    for (const record of index.records) {
      records.push({
        ...record,
        merged_record_id: `${name}:${record.shot_id || records.length}`,
        source_run_dir: runDir,
        source_run_name: name
      });
    }
    if (Array.isArray(index.warnings)) warnings.push(...index.warnings);
  }
  const mergedDir = path.join(productRoot, "_merged");
  await writeJson(path.join(mergedDir, "shot_index.json"), {
    schema_version: "voah.shot_index.merged.v1",
    source: "product_merged_intake_runs",
    product_slug: productSlug,
    product_name: productName,
    updated_at: new Date().toISOString(),
    source_run_dirs: sourceRunDirs,
    total_runs: sourceRunDirs.length,
    total_shots: records.length,
    records,
    warnings
  });
  await writeJson(path.join(mergedDir, "run_manifest.json"), {
    schema_version: "voah.merged_intake_manifest.v1",
    status: "ready",
    updated_at: new Date().toISOString(),
    product: { name: productName, slug: productSlug },
    source_run_dirs: sourceRunDirs,
    outputs: { shot_index: "shot_index.json" },
    qa: { status: records.length ? "ok" : "manual_review", shot_index_record_count: records.length }
  });
  console.log(`merged_run_dir=${mergedDir}`);
  console.log(`total_runs=${sourceRunDirs.length}`);
  console.log(`total_shots=${records.length}`);
}

async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

async function safeReaddir(dir) {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(dir);
  } catch {
    return [];
  }
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
