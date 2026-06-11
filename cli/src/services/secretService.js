import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MODEL_MODULES, envKeysForModuleIds, runtimeEnvForModuleIds, visibleModelProviders } from "./modelModules.js";

const CONFIG_DIR = process.env.VOAH_CONFIG_DIR || path.join(os.homedir(), ".voah");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const SECRETS_PATH = path.join(CONFIG_DIR, "secrets.env");

const SECRET_KEYS = {
  "minimax.api_key": "MINIMAX_API_KEY",
  "dashscope.api_key": "DASHSCOPE_API_KEY",
  "deepseek.api_key": "DEEPSEEK_API_KEY",
  "vectorengine.api_key": "VECTORENGINE_API_KEY"
};

const CONFIG_KEYS = new Set(["tts.provider"]);

export class SecretService {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.configDir = configDir;
    this.configPath = path.join(configDir, "config.json");
    this.secretsPath = path.join(configDir, "secrets.env");
  }

  async ensureDir() {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    try {
      await chmod(this.configDir, 0o700);
    } catch {
      // best effort
    }
  }

  async readConfig() {
    await this.ensureDir();
    try {
      return JSON.parse(await readFile(this.configPath, "utf8"));
    } catch {
      return {};
    }
  }

  async writeConfig(config) {
    await this.ensureDir();
    await writeFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async readSecretsFile() {
    await this.ensureDir();
    try {
      return parseEnv(await readFile(this.secretsPath, "utf8"));
    } catch {
      return {};
    }
  }

  async writeSecretsFile(secrets) {
    await this.ensureDir();
    const text = Object.entries(secrets)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join("\n");
    await writeFile(this.secretsPath, `${text}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(this.secretsPath, 0o600);
    } catch {
      // best effort
    }
  }

  async set(key, value) {
    if (SECRET_KEYS[key]) {
      const secrets = await this.readSecretsFile();
      secrets[SECRET_KEYS[key]] = String(value || "").trim();
      await this.writeSecretsFile(secrets);
      return;
    }
    if (CONFIG_KEYS.has(key)) {
      const config = await this.readConfig();
      config[key] = String(value || "").trim();
      await this.writeConfig(config);
      return;
    }
    throw new Error(`未知配置项：${key}`);
  }

  async publicConfig() {
    const config = await this.readConfig();
    const secrets = await this.readSecrets();
    return {
      config_path: this.configPath,
      secrets_path: this.secretsPath,
      settings: {
        "tts.provider": config["tts.provider"] || "minimax-official"
      },
      secrets: Object.fromEntries(Object.entries(SECRET_KEYS).map(([key, envKey]) => [key, Boolean(secrets[envKey])])),
      providers: visibleModelProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        config_key: provider.configKey,
        env_key: provider.envKey,
        configured: Boolean(secrets[provider.envKey])
      })),
      modules: MODEL_MODULES.map((item) => ({
        id: item.id,
        module: item.module,
        model: item.model,
        provider_id: item.providerId,
        provider_name: item.providerName,
        env_key: item.envKey,
        config_key: item.configKey,
        configured: Boolean(secrets[item.envKey])
      }))
    };
  }

  async readSecrets() {
    return {
      ...process.env,
      ...(await readWorkspaceEnv()),
      ...(await this.readSecretsFile())
    };
  }

  async envForModules(moduleIds = []) {
    const ids = moduleIds.length ? moduleIds : MODEL_MODULES.map((item) => item.id);
    const secrets = await this.readSecrets();
    const env = runtimeEnvForModuleIds(ids);
    for (const envKey of envKeysForModuleIds(ids)) {
      if (secrets[envKey]) {
        env[envKey] = secrets[envKey];
      }
    }
    return env;
  }

  async keyStatus(moduleIds = []) {
    const ids = moduleIds.length ? moduleIds : MODEL_MODULES.map((item) => item.id);
    const secrets = await this.readSecrets();
    const modules = MODEL_MODULES.filter((item) => ids.includes(item.id));
    return modules.map((item) => ({
      id: item.id,
      module: item.module,
      model: item.model,
      env_key: item.envKey,
      configured: Boolean(secrets[item.envKey])
    }));
  }
}

async function readWorkspaceEnv() {
  const paths = [
    path.join("/Users/noah/混剪", ".env"),
    path.join(os.homedir(), ".voah", "video_intake", ".env")
  ];
  const merged = {};
  for (const file of paths) {
    try {
      Object.assign(merged, parseEnv(await readFile(file, "utf8")));
    } catch {
      // ignore
    }
  }
  return merged;
}

function parseEnv(text) {
  const result = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    const value = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    if (key.trim()) result[key.trim()] = value;
  }
  return result;
}

function shellQuote(value) {
  return JSON.stringify(String(value || ""));
}

export { CONFIG_PATH, SECRETS_PATH };
