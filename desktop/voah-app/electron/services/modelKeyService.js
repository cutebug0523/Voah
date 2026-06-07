import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MODEL_MODULES,
  getModelModule,
  publicModelModules,
  runtimeEnvForModuleIds
} from "../../src/lib/modelRegistry.js";

const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

function maskKey(value) {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

function keyIdForModule(moduleId) {
  return getModelModule(moduleId)?.envKey || "";
}

function assertKnownModules(moduleIds) {
  const unknownIds = moduleIds.filter((moduleId) => !getModelModule(moduleId));
  if (unknownIds.length) {
    throw new Error(`未知模型模块：${unknownIds.join(", ")}`);
  }
}

async function readEnvFile(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const [key, ...rest] = line.split("=");
          return [key.trim(), rest.join("=").trim().replace(/^['"]|['"]$/g, "")];
        })
        .filter(([key, value]) => key && value)
    );
  } catch {
    return {};
  }
}

export class ModelKeyService {
  constructor({ appDataDir, envPaths = [] }) {
    this.storeDir = path.join(appDataDir, "voah-mvp");
    this.keysPath = path.join(this.storeDir, "model-keys.local.json");
    this.envPaths = envPaths;
  }

  async ensureDir() {
    await mkdir(this.storeDir, { recursive: true, mode: SECRET_DIR_MODE });
    try {
      await chmod(this.storeDir, SECRET_DIR_MODE);
    } catch {
      // Directory permissions are best effort on non-POSIX filesystems.
    }
  }

  async readSecrets() {
    await this.ensureDir();
    try {
      return JSON.parse(await readFile(this.keysPath, "utf8"));
    } catch {
      return {};
    }
  }

  async readEnvSecrets() {
    const merged = {};
    for (const envPath of this.envPaths) {
      Object.assign(merged, await readEnvFile(envPath));
    }
    return merged;
  }

  async readAvailableSecrets() {
    return {
      ...(await this.readEnvSecrets()),
      ...(await this.readSecrets())
    };
  }

  getPaths() {
    return {
      key_store_dir: this.storeDir,
      key_store_path: this.keysPath
    };
  }

  async writeSecrets(secrets) {
    await this.ensureDir();
    await writeFile(this.keysPath, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: SECRET_FILE_MODE });
    try {
      await chmod(this.keysPath, SECRET_FILE_MODE);
    } catch {
      // File permissions are best effort on non-POSIX filesystems.
    }
  }

  async getPublicConfig() {
    const secrets = await this.readAvailableSecrets();
    return {
      modules: publicModelModules().map((item) => {
        const envKey = keyIdForModule(item.id);
        const value = secrets[envKey] || "";
        return {
          ...item,
          has_key: Boolean(value),
          masked_key: maskKey(value)
        };
      })
    };
  }

  async saveModuleKey(moduleId, key) {
    const envKey = keyIdForModule(moduleId);
    if (!envKey) {
      throw new Error("未知模型模块");
    }
    const value = String(key || "").trim();
    if (!value) {
      throw new Error("Key 不能为空");
    }
    const secrets = await this.readSecrets();
    secrets[envKey] = value;
    await this.writeSecrets(secrets);
    return this.getPublicConfig();
  }

  async deleteModuleKey(moduleId) {
    const envKey = keyIdForModule(moduleId);
    if (!envKey) {
      throw new Error("未知模型模块");
    }
    const secrets = await this.readSecrets();
    delete secrets[envKey];
    await this.writeSecrets(secrets);
    return this.getPublicConfig();
  }

  async clearAll() {
    await rm(this.keysPath, { force: true });
    return this.getPublicConfig();
  }

  moduleIdsOrAll(moduleIds = []) {
    if (!moduleIds.length) {
      return MODEL_MODULES.map((item) => item.id);
    }
    assertKnownModules(moduleIds);
    return moduleIds;
  }

  async getEnvForModule(moduleId) {
    return this.buildPipelineEnv([moduleId]);
  }

  async buildEnv(moduleIds = []) {
    return this.buildPipelineEnv(moduleIds);
  }

  async buildPipelineEnv(moduleIds = []) {
    const resolvedModuleIds = this.moduleIdsOrAll(moduleIds);
    const secrets = await this.readAvailableSecrets();
    const requested = new Set(MODEL_MODULES.filter((item) => resolvedModuleIds.includes(item.id)).map((item) => item.envKey));
    const env = runtimeEnvForModuleIds(resolvedModuleIds);
    for (const envKey of requested) {
      if (secrets[envKey]) {
        env[envKey] = secrets[envKey];
      }
    }
    return env;
  }

  async missingModules(moduleIds = []) {
    const result = await this.validateRequiredKeys(moduleIds);
    return result.missing;
  }

  async validateRequiredKeys(moduleIds = []) {
    const resolvedModuleIds = this.moduleIdsOrAll(moduleIds);
    const secrets = await this.readAvailableSecrets();
    const modules = MODEL_MODULES.filter((item) => resolvedModuleIds.includes(item.id));
    const seenEnvKeys = new Set();
    const missing = [];
    for (const item of modules) {
      if (secrets[item.envKey] || seenEnvKeys.has(item.envKey)) {
        continue;
      }
      seenEnvKeys.add(item.envKey);
      missing.push({ id: item.id, module: item.module, model: item.model });
    }
    return {
      ok: missing.length === 0,
      missing
    };
  }
}
