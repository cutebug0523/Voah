import { spawn } from "node:child_process";
import { StageLogger } from "../core/logger.js";
import { markStage } from "../core/manifest.js";
import { compactId } from "../core/paths.js";
import { redactText } from "../core/redact.js";

export class WorkerRunner {
  constructor({ workspace, secretService }) {
    this.workspace = workspace;
    this.secretService = secretService;
  }

  async run({
    command,
    args = [],
    cwd = this.workspace,
    env = {},
    taskDir = null,
    stage,
    timeoutMs = 0,
    allowFailure = false,
    moduleIds = []
  }) {
    const runId = compactId(stage || "run");
    const logsDir = taskDir ? `${taskDir}/logs` : `${this.workspace}/cache/voah_system/logs`;
    const logger = new StageLogger({ logsDir, stage: stage || "command", runId });
    await logger.event("info", "process_start", { command, args, cwd });
    if (taskDir && stage) {
      await markStage(taskDir, stage, {
        status: "running",
        attempt: ((await safeStageAttempt(taskDir, stage)) || 0) + 1,
        started_at: new Date().toISOString(),
        log: `logs/${stage}.jsonl`,
        stdout_log: `logs/${stage}.stdout.log`,
        stderr_log: `logs/${stage}.stderr.log`
      });
    }
    const modelEnv = moduleIds.length ? await this.secretService.envForModules(moduleIds) : {};
    const mergedEnv = { ...process.env, ...modelEnv, ...env };
    let result;
    try {
      result = await spawnCapture(command, args, { cwd, env: mergedEnv, timeoutMs, logger });
    } catch (error) {
      const message = summarizeError(error.message || String(error));
      await logger.event("error", "process_spawn_failed", { error: message });
      if (taskDir && stage) {
        await markStage(taskDir, stage, {
          status: "failed",
          finished_at: new Date().toISOString(),
          exit_code: -1,
          error_message: message
        });
      }
      if (allowFailure) {
        return { code: -1, signal: null, stdout: "", stderr: message };
      }
      throw error;
    }
    await logger.event(result.code === 0 ? "info" : "error", "process_exit", {
      code: result.code,
      signal: result.signal
    });
    if (taskDir && stage) {
      await markStage(taskDir, stage, {
        status: result.code === 0 ? "succeeded" : "failed",
        finished_at: new Date().toISOString(),
        exit_code: result.code,
        error_message: result.code === 0 ? "" : summarizeError(result.stderr || result.stdout)
      });
    }
    if (result.code !== 0 && !allowFailure) {
      const timeoutNote = result.timedOut ? ` timed out after ${result.timeoutMs}ms` : "";
      const error = new Error(`${command} ${args.join(" ")} failed with code ${result.code}${timeoutNote}: ${summarizeError(result.stderr || result.stdout)}`);
      error.result = result;
      throw error;
    }
    return result;
  }
}

async function safeStageAttempt(taskDir, stage) {
  try {
    const { loadTaskManifest } = await import("../core/manifest.js");
    const manifest = await loadTaskManifest(taskDir);
    return manifest?.stages?.[stage]?.attempt || 0;
  } catch {
    return 0;
  }
}

function spawnCapture(command, args, { cwd, env, timeoutMs, logger }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, timeoutMs)
      : null;
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      logger.stdout(text);
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logger.stderr(text);
    });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code,
        signal,
        timedOut,
        timeoutMs: timedOut ? timeoutMs : 0,
        elapsedMs: Date.now() - startedAt,
        stdout: redactText(stdout),
        stderr: redactText(stderr)
      });
    });
  });
}

function summarizeError(text) {
  return redactText(String(text || "").trim().split(/\r?\n/).slice(-8).join("\n")).slice(0, 1200);
}
