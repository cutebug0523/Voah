import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHyperframesCommand, withHyperframesArgs } from "./hyperframesService.js";

export async function commandVersion(command, args = ["--version"]) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", (error) => {
      resolve({ command, ok: false, error: error.message });
    });
    proc.on("close", (code) => {
      const version = firstLine(stdout || stderr);
      resolve({
        command,
        ok: code === 0 || Boolean(version),
        code,
        version
      });
    });
  });
}

export async function toolStatus(workspace) {
  const hyperframes = resolveHyperframesCommand(workspace);
  const hyperframesVersion = withHyperframesArgs(hyperframes, ["--version"]);
  const dashscopeCommand = resolveDashscopeCommand();
  const pythonCommand = resolvePythonCommand();
  const checks = await Promise.all([
    commandVersion("ffmpeg", ["-version"]),
    commandVersion("ffprobe", ["-version"]),
    commandVersion(pythonCommand, ["--version"]),
    commandVersion("node", ["--version"]),
    commandVersion(hyperframesVersion.command, hyperframesVersion.args),
    commandVersion(dashscopeCommand, ["--help"])
  ]);
  return checks.map((item) => ({
    ...item,
    required:
      ["ffmpeg", "ffprobe", "node"].includes(item.command) ||
      item.command === pythonCommand ||
      item.command === hyperframesVersion.command ||
      item.command === dashscopeCommand,
    tool: item.command === hyperframesVersion.command ? "hyperframes" : item.command === dashscopeCommand ? "dashscope" : item.command === pythonCommand ? "python" : item.command
  }));
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find(Boolean) || "";
}

export function resolveDashscopeCommand() {
  const candidates = [
    process.env.DASHSCOPE_CLI,
    ...(process.platform === "win32"
      ? [
          path.join(process.env.APPDATA || "", "Python", "Python312", "Scripts", "dashscope.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "Scripts", "dashscope.exe"),
          "dashscope.exe"
        ]
      : [path.join(os.homedir(), "Library", "Python", "3.9", "bin", "dashscope")]),
    "dashscope"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "dashscope" || existsSync(candidate)) {
      return candidate;
    }
  }
  return "dashscope";
}

export function resolvePythonCommand() {
  if (process.env.VOAH_PYTHON) return process.env.VOAH_PYTHON;
  return process.platform === "win32" ? "python" : "python3";
}
