import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactText } from "../core/redact.js";

export const DEFAULT_HYPERFRAMES_BROWSER_TIMEOUT_MS = 180000;
export const DEFAULT_HYPERFRAMES_PROTOCOL_TIMEOUT_MS = 600000;
export const DEFAULT_HYPERFRAMES_PLAYER_READY_TIMEOUT_MS = 120000;
export const DEFAULT_HYPERFRAMES_RENDER_TIMEOUT_MS = 600000;
export const DEFAULT_HYPERFRAMES_RENDER_PLATFORM_POLICY = {
  darwin: { workers: "1", browserGpu: false },
  win32: { workers: "auto", browserGpu: true },
  linux: { workers: "auto", browserGpu: true },
  default: { workers: "1", browserGpu: false }
};

export function resolveHyperframesCommand(workspace, { cwd = process.cwd() } = {}) {
  const binName = process.platform === "win32" ? "hyperframes.cmd" : "hyperframes";
  const candidates = [
    ["desktop/voah-app", path.join(workspace, "desktop", "voah-app", "node_modules", ".bin", binName)],
    ["desktop/voah-studio", path.join(workspace, "desktop", "voah-studio", "node_modules", ".bin", binName)],
    ["workspace", path.join(workspace, "node_modules", ".bin", binName)],
    ["cwd", path.join(cwd, "node_modules", ".bin", binName)]
  ];
  for (const [source, bin] of candidates) {
    if (existsSync(bin)) {
      return {
        command: bin,
        args: [],
        source,
        isLocal: true
      };
    }
  }
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", "hyperframes"],
    source: "npx-fallback",
    isLocal: false
  };
}

export function withHyperframesArgs(tool, args = []) {
  return {
    command: tool.command,
    args: [...(tool.args || []), ...args]
  };
}

export function hyperframesRenderEnv({ lowMemoryMode = false } = {}) {
  return {
    PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS: String(DEFAULT_HYPERFRAMES_PROTOCOL_TIMEOUT_MS),
    PRODUCER_PLAYER_READY_TIMEOUT_MS: String(DEFAULT_HYPERFRAMES_PLAYER_READY_TIMEOUT_MS),
    PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS: String(DEFAULT_HYPERFRAMES_BROWSER_TIMEOUT_MS),
    PRODUCER_LOW_MEMORY_MODE: lowMemoryMode ? "true" : "false"
  };
}

export function resolveHyperframesRenderOptions(options = {}) {
  const platform = options.platform || process.platform;
  const policy = DEFAULT_HYPERFRAMES_RENDER_PLATFORM_POLICY[platform] || DEFAULT_HYPERFRAMES_RENDER_PLATFORM_POLICY.default;
  const workers = normalizeWorkers(options.workers ?? options["hyperframes-workers"] ?? process.env.VOAH_HYPERFRAMES_WORKERS, policy.workers);
  const browserGpu = normalizeBrowserGpu(
    options["no-gpu"] || options["no-browser-gpu"]
      ? false
      : options.browserGpu ?? options["browser-gpu"] ?? options.gpu ?? options["hyperframes-gpu"] ?? process.env.VOAH_HYPERFRAMES_GPU,
    policy.browserGpu
  );
  return {
    platform,
    workers,
    browser_gpu: browserGpu,
    source: {
      workers: optionWasSet(options.workers ?? options["hyperframes-workers"] ?? process.env.VOAH_HYPERFRAMES_WORKERS) ? "configured" : "platform_default",
      browser_gpu: optionWasSet(
        options["no-gpu"] || options["no-browser-gpu"]
          ? false
          : options.browserGpu ?? options["browser-gpu"] ?? options.gpu ?? options["hyperframes-gpu"] ?? process.env.VOAH_HYPERFRAMES_GPU
      )
        ? "configured"
        : "platform_default"
    }
  };
}

export function hyperframesBaseRenderArgs({ output, quality = "standard", fps = 30, renderOptions = {} } = {}) {
  const resolved = resolveHyperframesRenderOptions(renderOptions);
  return [
    "render",
    ".",
    "--output",
    output,
    "--quality",
    quality,
    "--fps",
    String(fps),
    "--workers",
    resolved.workers,
    resolved.browser_gpu ? "--gpu" : "--no-browser-gpu",
    "--browser-timeout",
    String(Math.round(DEFAULT_HYPERFRAMES_BROWSER_TIMEOUT_MS / 1000)),
    "--protocol-timeout",
    String(DEFAULT_HYPERFRAMES_PROTOCOL_TIMEOUT_MS),
    "--player-ready-timeout",
    String(DEFAULT_HYPERFRAMES_PLAYER_READY_TIMEOUT_MS)
  ];
}

export async function collectHyperframesDiagnostics(workspace, tool, { cwd = workspace } = {}) {
  const version = await runHyperframesProbe(tool, ["--version"], { cwd, timeoutMs: 30000 });
  const doctor = await runHyperframesProbe(tool, ["doctor"], { cwd, timeoutMs: 60000 });
  return {
    command: tool.command,
    args_prefix: tool.args || [],
    command_source: tool.source,
    local_binary: Boolean(tool.isLocal),
    version: firstLine(version.stdout || version.stderr),
    version_probe: probeSummary(version),
    doctor: {
      ...probeSummary(doctor),
      summary: tailLines(doctor.stdout || doctor.stderr, 40)
    },
    chrome_path: detectChromePath(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    memory: {
      total_mb: Math.round(os.totalmem() / 1024 / 1024),
      free_mb: Math.round(os.freemem() / 1024 / 1024)
    }
  };
}

export function hyperframesRenderSettingsForManifest(renderOptions = {}) {
  const resolved = resolveHyperframesRenderOptions(renderOptions);
  return {
    platform: resolved.platform,
    workers: resolved.workers,
    browser_gpu: resolved.browser_gpu,
    source: resolved.source
  };
}

export function renderAttemptFailure(mode, error) {
  const result = error?.result || {};
  return {
    mode,
    status: "failed",
    code: result.code ?? null,
    signal: result.signal ?? null,
    timed_out: Boolean(result.timedOut),
    timeout_ms: result.timeoutMs ?? null,
    elapsed_ms: result.elapsedMs ?? null,
    message: redactText(error?.message || String(error || "")).slice(0, 1600)
  };
}

function runHyperframesProbe(tool, args, { cwd, timeoutMs }) {
  const command = tool.command;
  const finalArgs = [...(tool.args || []), ...args];
  const started = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(command, finalArgs, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.();
    }, timeoutMs);
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        signal: null,
        timedOut,
        elapsedMs: Date.now() - started,
        stdout: "",
        stderr: redactText(error.message || String(error))
      });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code,
        signal,
        timedOut,
        elapsedMs: Date.now() - started,
        stdout: redactText(stdout),
        stderr: redactText(stderr)
      });
    });
  });
}

function probeSummary(probe) {
  return {
    ok: probe.code === 0,
    code: probe.code,
    signal: probe.signal,
    timed_out: Boolean(probe.timedOut),
    elapsed_ms: probe.elapsedMs
  };
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find(Boolean) || "";
}

function tailLines(text, count) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-count).join("\n");
}

function detectChromePath() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.CHROME_PATH,
          path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
        ]
      : [
          process.env.CHROME_PATH,
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
        ];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function normalizeWorkers(value, fallback) {
  const raw = String(value ?? fallback ?? "1").trim().toLowerCase();
  if (raw === "auto") return "auto";
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 1) return String(fallback || "1");
  return String(Math.min(8, Math.round(number)));
}

function normalizeBrowserGpu(value, fallback) {
  if (!optionWasSet(value)) return Boolean(fallback);
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on", "gpu"].includes(String(value).trim().toLowerCase());
}

function optionWasSet(value) {
  return value !== undefined && value !== null && value !== "";
}
