import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs, requireOption } from "../core/args.js";
import { UserError } from "../core/errors.js";
import { resolvePath, resolveWorkspace } from "../core/paths.js";
import { SecretService } from "../services/secretService.js";
import { WorkerRunner } from "../services/workerRunner.js";

// voah tts preview：包装 scripts/voah_tts_desktop_preview.py。
// 仅做配音试听，不产 audio_sections.json，不进入任务主线。
export async function runTtsPreview({ argv }) {
  const options = parseArgs(argv, {
    boolean: ["dry-run"]
  });
  const workspace = resolveWorkspace(options.workspace);
  const text = options.text;
  const textFile = options["text-file"] ? resolvePath(options["text-file"], workspace) : null;
  if (!text && !textFile) {
    throw new UserError("用法：voah tts preview --text <文本> | --text-file <文件> [--provider ...] [--voice-id ...]");
  }
  if (textFile && !existsSync(textFile)) {
    throw new UserError(`找不到文本文件：${textFile}`);
  }

  const provider = options.provider || (await readTtsProvider());
  const outputRoot = options["output-root"]
    ? resolvePath(options["output-root"], workspace)
    : path.join(workspace, "cache", "voah_tts", "desktop_preview");

  const args = [
    path.join(workspace, "scripts", "voah_tts_desktop_preview.py"),
    ...(textFile ? ["--text-file", textFile] : ["--text", String(text)]),
    "--output-root",
    outputRoot,
    "--audio-format",
    options["audio-format"] || "mp3",
    "--minimax-output-format",
    options["minimax-output-format"] || "url"
  ];
  if (provider) args.push("--provider", provider);
  for (const [flag, key] of [
    ["--model", "model"],
    ["--voice-id", "voice-id"],
    ["--speed", "speed"],
    ["--vol", "vol"],
    ["--pitch", "pitch"],
    ["--emotion", "emotion"],
    ["--voice-modify", "voice-modify"],
    ["--modify-pitch", "modify-pitch"],
    ["--modify-intensity", "modify-intensity"],
    ["--modify-timbre", "modify-timbre"],
    ["--timestamp", "timestamp"],
    ["--timeout-s", "timeout-s"]
  ]) {
    if (options[key] !== undefined) args.push(flag, String(options[key]));
  }
  if (options["dry-run"]) args.push("--dry-run");

  const moduleId = provider === "vectorengine-minimax" ? "tts_fallback" : "tts_primary";
  const runner = new WorkerRunner({ workspace, secretService: new SecretService() });
  const result = await runner.run({
    command: "python3",
    args,
    cwd: workspace,
    stage: "tts_preview",
    moduleIds: [moduleId],
    timeoutMs: 300000
  });
  if (result.stdout) {
    process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  }
}

async function readTtsProvider() {
  try {
    const config = await new SecretService().readConfig();
    return config["tts.provider"] || "";
  } catch {
    return "";
  }
}
