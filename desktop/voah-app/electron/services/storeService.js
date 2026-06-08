import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PRODUCTS, mergeVoahSettings } from "../../src/lib/mvpContracts.js";

const STORE_VERSION = "voah-desktop-store.v1";

function nowIso() {
  return new Date().toISOString();
}

function createInitialStore(workspaceRoot) {
  return {
    schema_version: STORE_VERSION,
    workspace_root: workspaceRoot,
    created_at: nowIso(),
    updated_at: nowIso(),
    products: DEFAULT_PRODUCTS,
    tasks: [],
    batches: [],
    jobs: [],
    intake_jobs: [],
    artifacts: [],
    qa_reports: [],
    quality_reports: [],
    output_reviews: [],
    tts_previews: [],
    settings: mergeVoahSettings()
  };
}

function mergeDefaultProducts(products = []) {
  const byId = new Map(products.map((product) => [product.id, product]));
  for (const product of DEFAULT_PRODUCTS) {
    byId.set(product.id, {
      ...product,
      ...(byId.get(product.id) || {})
    });
  }
  return [...byId.values()];
}

export class StoreService {
  constructor({ appDataDir, workspaceRoot }) {
    this.appDataDir = appDataDir;
    this.workspaceRoot = workspaceRoot;
    this.storeDir = path.join(appDataDir, "voah-mvp");
    this.storePath = path.join(this.storeDir, "store.json");
  }

  async ensureStore() {
    await mkdir(this.storeDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8"));
      const merged = {
        ...parsed,
        products: mergeDefaultProducts(parsed.products),
        batches: parsed.batches || [],
        jobs: parsed.jobs || [],
        intake_jobs: parsed.intake_jobs || [],
        artifacts: parsed.artifacts || [],
        qa_reports: parsed.qa_reports || [],
        quality_reports: parsed.quality_reports || [],
        output_reviews: parsed.output_reviews || [],
        tts_previews: parsed.tts_previews || [],
        settings: mergeVoahSettings(parsed.settings || {})
      };
      if (
        JSON.stringify(merged.products) !== JSON.stringify(parsed.products || []) ||
        JSON.stringify(merged.settings) !== JSON.stringify(parsed.settings || {})
      ) {
        await this.save(merged);
      }
      return merged;
    } catch {
      const initial = createInitialStore(this.workspaceRoot);
      await this.save(initial);
      return initial;
    }
  }

  async read() {
    return this.ensureStore();
  }

  async save(store) {
    const next = {
      ...store,
      schema_version: STORE_VERSION,
      updated_at: nowIso()
    };
    await mkdir(this.storeDir, { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  async mutate(mutator) {
    const store = await this.read();
    const next = await mutator(structuredClone(store));
    return this.save(next);
  }

  getPaths() {
    return {
      store_dir: this.storeDir,
      store_path: this.storePath
    };
  }
}
