import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs, requireOption } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { readJson, writeJson } from "../core/json.js";
import { ensureDir, resolvePath, resolveWorkspace, slugify } from "../core/paths.js";
import { SecretService } from "../services/secretService.js";
import { WorkerRunner } from "../services/workerRunner.js";

export async function runProductCommand({ argv }) {
  const [subcommand, ...rest] = argv;
  const options = parseArgs(rest);
  const workspace = resolveWorkspace(options.workspace);
  if (subcommand === "create") {
    const slug = requireOption(options, "slug");
    const name = options.name || "";
    const productDir = productPath(workspace, slug);
    await ensureDir(productDir);
    const payload = {
      schema_version: "voah.product.v1",
      slug,
      name,
      brand: options.brand || "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await writeJson(path.join(productDir, "product.json"), payload);
    await writeJson(path.join(productDir, "claims.json"), { schema_version: "voah.product_claims.v1", claims: [] });
    await writeJson(path.join(productDir, "campaigns.json"), { schema_version: "voah.product_campaigns.v1", campaigns: [] });
    await writeJson(path.join(productDir, "blocked_terms.json"), { schema_version: "voah.blocked_terms.v1", terms: [] });
    console.log(`product=${path.join(productDir, "product.json")}`);
    return;
  }
  if (subcommand === "list") {
    const root = path.join(workspace, "data", "products");
    const { readdir } = await import("node:fs/promises");
    const rows = existsSync(root) ? await readdir(root, { withFileTypes: true }) : [];
    const products = [];
    for (const row of rows.filter((item) => item.isDirectory())) {
      const file = path.join(root, row.name, "product.json");
      if (existsSync(file)) products.push(await readJson(file));
    }
    console.log(JSON.stringify({ schema_version: "voah.product_list.v1", products }, null, 2));
    return;
  }
  if (subcommand === "inspect") {
    const slug = options._[0] || options.slug;
    if (!slug) throw new UserError("用法：voah product inspect <slug>");
    const productDir = productPath(workspace, slugify(slug));
    const payload = {
      product: existsSync(path.join(productDir, "product.json")) ? await readJson(path.join(productDir, "product.json")) : null,
      claims: existsSync(path.join(productDir, "claims.json")) ? await readJson(path.join(productDir, "claims.json")) : null,
      campaigns: existsSync(path.join(productDir, "campaigns.json")) ? await readJson(path.join(productDir, "campaigns.json")) : null,
      blocked_terms: existsSync(path.join(productDir, "blocked_terms.json")) ? await readJson(path.join(productDir, "blocked_terms.json")) : null
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (subcommand === "refine") {
    await refineProductContext(workspace, options);
    return;
  }
  throw new UserError("用法：voah product create|list|inspect|refine");
}

function productPath(workspace, slug) {
  return resolvePath(path.join("data", "products", slug), workspace);
}

async function refineProductContext(workspace, options) {
  const slug = requireOption(options, "product");
  const runDir = resolvePath(requireOption(options, "run-dir"), workspace);
  const productDir = productPath(workspace, slugify(slug));
  await ensureDir(productDir);
  const product = existsSync(path.join(productDir, "product.json")) ? await readJson(path.join(productDir, "product.json")) : {};
  const runner = new WorkerRunner({ workspace, secretService: new SecretService() });
  const result = await runner.run({
    command: "python3",
    args: [
      path.join(workspace, "scripts", "voah_refine_product_context.py"),
      "--run-dir",
      runDir,
      "--product-dir",
      productDir,
      "--product-slug",
      slug,
      "--product-name",
      options["product-name"] || options.name || product.name || "",
      "--brand",
      options.brand || product.brand || "",
      ...(options["no-fallback"] ? ["--no-allow-fallback"] : []),
    ],
    cwd: workspace,
    stage: "product_context_refinement",
    moduleIds: ["product_context_refinement"],
    timeoutMs: 240000
  });
  console.log(result.stdout.trim());
}
