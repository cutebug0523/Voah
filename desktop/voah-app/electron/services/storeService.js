import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PRODUCTS, DEFAULT_SETTINGS } from "../../src/lib/mvpContracts.js";

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
    jobs: [],
    artifacts: [],
    qa_reports: [],
    settings: DEFAULT_SETTINGS
  };
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
      return parsed;
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
