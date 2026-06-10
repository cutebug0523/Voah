import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { readJson, writeJson } from "../core/json.js";
import { compactId } from "../core/paths.js";
import { redactObject } from "../core/redact.js";
import { resolveDashscopeCommand } from "./toolchainService.js";

export class ResourceService {
  constructor({ workspace }) {
    this.workspace = workspace;
  }

  manifestPath(runDir) {
    return path.join(runDir, "resource_manifest.json");
  }

  async read(runDir) {
    if (!existsSync(this.manifestPath(runDir))) {
      return {
        schema_version: "voah.resource_manifest.v1",
        run_dir: runDir,
        resources: []
      };
    }
    return readJson(this.manifestPath(runDir));
  }

  async write(runDir, manifest) {
    await writeJson(this.manifestPath(runDir), redactObject(manifest));
  }

  async registerLocal({ runDir, file, purpose, provider = "local", consumers = [] }) {
    const manifest = await this.read(runDir);
    const resource = {
      schema_version: "voah.resource.v1",
      resource_id: compactId("res"),
      local_path: path.isAbsolute(file) ? file : path.relative(runDir, path.resolve(runDir, file)),
      purpose,
      provider,
      remote_url_present: false,
      headers_required: {},
      consumers,
      status: existsSync(file) ? "ready" : "missing",
      created_at: new Date().toISOString(),
      expires_at: null
    };
    manifest.resources.push(resource);
    await this.write(runDir, manifest);
    return resource;
  }

  async registerRemote({ runDir, file, purpose, remoteUrl, provider = "dashscope_managed_oss", consumers = [] }) {
    const manifest = await this.read(runDir);
    const resource = {
      schema_version: "voah.resource.v1",
      resource_id: compactId("res"),
      local_path: path.isAbsolute(file) ? file : path.relative(runDir, path.resolve(runDir, file)),
      purpose,
      provider,
      remote_url_present: Boolean(remoteUrl),
      remote_url: remoteUrl || "",
      headers_required: provider.includes("dashscope") ? { "X-DashScope-OssResourceResolve": "enable" } : {},
      consumers,
      status: remoteUrl ? "ready" : "upload_failed",
      created_at: new Date().toISOString(),
      expires_at: null
    };
    manifest.resources.push(resource);
    await this.write(runDir, manifest);
    return resource;
  }

  async upload({ runDir, file, purpose, model = "qwen3.5-omni-plus", env = {}, consumers = [] }) {
    if (!existsSync(file)) {
      const resource = await this.registerRemote({
        runDir,
        file,
        purpose,
        remoteUrl: "",
        provider: "dashscope_managed_oss",
        consumers
      });
      resource.status = "upload_failed";
      resource.error = "local file does not exist";
      const manifest = await this.read(runDir);
      const index = manifest.resources.findIndex((item) => item.resource_id === resource.resource_id);
      if (index >= 0) {
        manifest.resources[index] = resource;
        await this.write(runDir, manifest);
      }
      return resource;
    }
    try {
      const remoteUrl = await dashscopeUpload(file, model, env);
      return this.registerRemote({
        runDir,
        file,
        purpose,
        remoteUrl,
        provider: "dashscope_managed_oss",
        consumers
      });
    } catch (error) {
      const resource = await this.registerRemote({
        runDir,
        file,
        purpose,
        remoteUrl: "",
        provider: "dashscope_managed_oss",
        consumers
      });
      resource.status = classifyUploadError(error);
      resource.error = String(error.message || error).slice(0, 1200);
      const manifest = await this.read(runDir);
      const index = manifest.resources.findIndex((item) => item.resource_id === resource.resource_id);
      if (index >= 0) {
        manifest.resources[index] = resource;
        await this.write(runDir, manifest);
      }
      return resource;
    }
  }

  async importDashscopeUploadFile({ runDir, uploadFile, purpose, consumers = [] }) {
    if (!existsSync(uploadFile)) {
      return [];
    }
    const data = await readJson(uploadFile);
    const rows = Array.isArray(data) ? data : data.results || data.uploads || [];
    const resources = [];
    for (const row of rows) {
      const file = row.local_path || row.file || row.path || row.clip_path || "";
      const remoteUrl = row.oss_url || row.url || row.remote_url || "";
      resources.push(await this.registerRemote({ runDir, file, purpose, remoteUrl, consumers }));
    }
    return resources;
  }

  async cleanup({ runDir, expiredOnly = false }) {
    const manifest = await this.read(runDir);
    const now = new Date();
    const affected = [];
    manifest.resources = (manifest.resources || []).map((resource) => {
      const expiresAt = resource.expires_at ? new Date(resource.expires_at) : null;
      const isExpired = resource.status === "expired" || (expiresAt && expiresAt <= now);
      if (expiredOnly && !isExpired) {
        return resource;
      }
      const next = {
        ...resource,
        cleanup_attempted_at: now.toISOString(),
        cleanup_status: resource.provider === "dashscope_managed_oss" ? "ttl_managed_not_deleted" : "local_manifest_marked",
        cleanup_reason: resource.provider === "dashscope_managed_oss"
          ? "DashScope managed OSS is provider-owned; CLI records lifecycle state and relies on provider TTL."
          : "CLI cleanup records local manifest lifecycle state; it does not delete source media.",
        status: isExpired || !expiredOnly ? "expired" : resource.status
      };
      affected.push(next.resource_id);
      return next;
    });
    manifest.cleanup = {
      requested_at: new Date().toISOString(),
      expired_only: Boolean(expiredOnly),
      status: "manifest_marked",
      provider_delete_supported: false,
      affected_count: affected.length,
      affected_resources: affected
    };
    await this.write(runDir, manifest);
    return manifest.cleanup;
  }
}

function dashscopeUpload(file, model, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveDashscopeCommand(), ["oss", "upload", "-f", file, "-m", model], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `dashscope upload exited ${code}`).trim()));
        return;
      }
      const url = extractOssUrl(stdout, stderr);
      if (!url) {
        reject(new Error("cannot extract oss url from dashscope upload output"));
        return;
      }
      resolve(url);
    });
  });
}

function extractOssUrl(stdout, stderr) {
  for (const text of [stdout, stderr]) {
    try {
      const parsed = JSON.parse(String(text || "").trim());
      const candidate = parsed.oss_url || parsed.url || parsed.data?.oss_url;
      if (typeof candidate === "string" && candidate.startsWith("oss://")) {
        return candidate;
      }
    } catch {
      // fall through
    }
    const match = String(text || "").match(/oss:\/\/\S+/);
    if (match) return match[0];
  }
  return "";
}

function classifyUploadError(error) {
  const text = String(error.message || error).toLowerCase();
  if (text.includes("accessdenied") || text.includes("access denied")) return "access_denied";
  if (text.includes("expired")) return "expired";
  if (text.includes("resolve")) return "resolve_failed";
  if (text.includes("provider") || text.includes("dashscope")) return "provider_error";
  return "upload_failed";
}
