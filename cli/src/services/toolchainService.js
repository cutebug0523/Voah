import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  const localHyperframes = path.join(workspace, "desktop", "voah-app", "node_modules", ".bin", "hyperframes");
  const hyperframesCommand = existsSync(localHyperframes) ? localHyperframes : "npx";
  const hyperframesArgs = existsSync(localHyperframes) ? ["--version"] : ["--yes", "hyperframes", "--version"];
  const dashscopeCommand = resolveDashscopeCommand();
  const checks = await Promise.all([
    commandVersion("ffmpeg", ["-version"]),
    commandVersion("ffprobe", ["-version"]),
    commandVersion("python3", ["--version"]),
    commandVersion("node", ["--version"]),
    commandVersion(hyperframesCommand, hyperframesArgs),
    commandVersion(dashscopeCommand, ["--help"])
  ]);
  return checks.map((item) => ({
    ...item,
    required:
      ["ffmpeg", "ffprobe", "python3", "node"].includes(item.command) ||
      item.command === hyperframesCommand ||
      item.command === dashscopeCommand,
    tool: item.command === hyperframesCommand ? "hyperframes" : item.command === dashscopeCommand ? "dashscope" : item.command
  }));
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find(Boolean) || "";
}

export function resolveDashscopeCommand() {
  const candidates = [
    process.env.DASHSCOPE_CLI,
    path.join(os.homedir(), "Library", "Python", "3.9", "bin", "dashscope"),
    "dashscope"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "dashscope" || existsSync(candidate)) {
      return candidate;
    }
  }
  return "dashscope";
}
