import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { optionalInt, optionalNumber } from "./args.js";
import { UserError } from "./errors.js";
import { readJson, writeJson } from "./json.js";
import { markDownstreamStale, markStage, refreshActiveArtifacts, recordStageOutputHashes, detectUpstreamChange, STAGE_ORDER, writeTaskManifest, loadTaskManifest } from "./manifest.js";
import { compactId } from "./paths.js";
import { createTaskRun, isRunSupersededError, markRunStage, promoteStageOutputs, updateTaskRun } from "./taskRun.js";
import { SecretService } from "../services/secretService.js";
import { WorkerRunner } from "../services/workerRunner.js";
import { ResourceService } from "../services/resourceService.js";
import {
  DEFAULT_HYPERFRAMES_RENDER_TIMEOUT_MS,
  collectHyperframesDiagnostics,
  hyperframesBaseRenderArgs,
  hyperframesRenderEnv,
  renderAttemptFailure,
  resolveHyperframesCommand,
  withHyperframesArgs
} from "../services/hyperframesService.js";

const DEFAULT_VOICE_ID = "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d";
const DEFAULT_COPY_REQUEST_TIMEOUT_S = 240;

// 各阶段默认超时（毫秒）。worker 挂死时由 WorkerRunner SIGTERM 中断，退出码 124。
// 可被 options[`${stage}-timeout-ms`] 覆盖。
const STAGE_TIMEOUTS_MS = {
  copy: 1200000,
  tts: 600000,
  retrieve: 300000,
  subtitle: 180000,
  render: DEFAULT_HYPERFRAMES_RENDER_TIMEOUT_MS,
  qa: 600000
};

function stageTimeout(stage, options = {}) {
  return optionalInt(options[`${stage}-timeout-ms`], STAGE_TIMEOUTS_MS[stage] ?? 0);
}

export async function runPipeline({ workspace, taskDir, from = "copy", options = {} }) {
  const runContext = options.runContext || await createTaskRun({ taskDir, from, scope: "pipeline" });
  const startIndex = STAGE_ORDER.indexOf(from);
  if (startIndex < 0) {
    throw new UserError(`未知起始阶段：${from}`);
  }
  // 自动 stale 检测：若上游产物 hash 相对基线变了，从最早变化的阶段起把下游全部标 stale。
  const changedStage = await detectUpstreamChange(taskDir, from);
  if (changedStage) {
    const changedIndex = STAGE_ORDER.indexOf(changedStage);
    if (changedIndex < startIndex) {
      console.warn(`上游阶段 ${changedStage} 的产物已变更，已将其下游标记为 stale。`);
      console.warn(`建议从该阶段重跑：voah task run ${taskDir} --from ${changedStage}`);
      await markDownstreamStale(taskDir, changedStage);
    }
  }
  await markDownstreamStale(taskDir, from);
  try {
    for (const stage of STAGE_ORDER.slice(startIndex)) {
      await runStageByName(stage, { workspace, taskDir, options: { ...options, runContext } });
    }
    await updateTaskRun(runContext, { status: "succeeded", finished_at: new Date().toISOString() });
  } catch (error) {
    if (isRunSupersededError(error)) {
      await updateTaskRun(runContext, { status: "superseded", finished_at: new Date().toISOString() });
      return;
    }
    await updateTaskRun(runContext, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error: { message: error.message || String(error) }
    });
    throw error;
  }
  const manifest = await loadTaskManifest(taskDir);
  if (manifest) {
    manifest.status = manifest.qa?.status === "ok" || manifest.qa?.status === "pass" ? "succeeded" : "needs_review";
    manifest.updated_at = new Date().toISOString();
    await writeTaskManifest(taskDir, manifest);
  }
}

export async function runStageByName(stage, context) {
  let runContext = context.options?.runContext;
  let ownRun = false;
  if (!runContext) {
    runContext = await createTaskRun({ taskDir: context.taskDir, stage, scope: "stage" });
    ownRun = true;
  }
  const handlers = {
    copy: runCopyStage,
    tts: runTtsStage,
    retrieve: runRetrieveStage,
    subtitle: runSubtitleStage,
    render: runRenderStage,
    qa: runQaStage
  };
  const handler = handlers[stage];
  if (!handler) throw new UserError(`未知阶段：${stage}`);
  try {
    const result = await handler({ ...context, runContext });
    // 阶段成功后记录产物 hash，作为下游 stale 判断基线。
    await recordStageOutputHashes(context.taskDir, stage);
    if (ownRun) {
      await updateTaskRun(runContext, { status: "succeeded", finished_at: new Date().toISOString() });
    }
    return result;
  } catch (error) {
    if (isRunSupersededError(error)) {
      if (ownRun) {
        await updateTaskRun(runContext, { status: "superseded", finished_at: new Date().toISOString() });
      }
      throw error;
    }
    await markRunStage(runContext, stage, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: error.message || String(error)
    });
    if (ownRun) {
      await updateTaskRun(runContext, {
        status: "failed",
        finished_at: new Date().toISOString(),
        error: { message: error.message || String(error) }
      });
    }
    throw error;
  }
}

export async function runCopyStage({ workspace, taskDir, runContext, options = {} }) {
  const manifest = await requireTaskManifest(taskDir);
  const taskBrief = path.join(taskDir, "task_brief.json");
  const shotIndex = path.join(resolveIntakeRun(workspace, manifest), "shot_index.json");
  const outputDir = runContext?.outputDir || taskDir;
  requireFile(taskBrief, "task_brief.json");
  requireFile(shotIndex, "shot_index.json");
  const runner = createRunner(workspace);
  await runner.run({
    command: "python3",
    args: [
      path.join(workspace, "scripts", "voah_generate_copy_with_m3.py"),
      "--task-brief",
      taskBrief,
      "--task-dir",
      outputDir,
      "--shot-index",
      shotIndex,
      "--target-duration-s",
      String(optionalNumber(options["target-duration"] ?? options["target-duration-s"], manifest.target_duration_s || 45)),
      "--timeout-s",
      String(optionalInt(options["copy-request-timeout-s"], DEFAULT_COPY_REQUEST_TIMEOUT_S)),
      "--variant",
      manifest.task_id || "cli"
    ],
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "copy",
    cwd: workspace,
    moduleIds: ["copy_generation"],
    timeoutMs: stageTimeout("copy", options)
  });
  requireStageOutputs(outputDir, "copy");
  if (runContext) await promoteStageOutputs({ taskDir, runContext, stage: "copy" });
  await refreshActiveArtifacts(taskDir, "copy");
  return path.join(taskDir, "voice_script.json");
}

export async function runTtsStage({ workspace, taskDir, runContext, options = {} }) {
  const manifest = await requireTaskManifest(taskDir);
  const voiceScript = path.join(taskDir, "voice_script.json");
  const outputDir = runContext?.outputDir || taskDir;
  requireFile(voiceScript, "voice_script.json");
  const provider = options.provider || manifest.tts?.provider || (await readTtsProvider()) || "minimax-official";
  if (provider === "gpt-sovits") {
    await runGptSovitsTts({ workspace, taskDir, outputDir, runContext, manifest, options });
  } else {
    const runner = createRunner(workspace);
    const voiceModify = manifest.tts?.voice_modify || {};
    const args = [
      path.join(workspace, "scripts", "voah_run_oneshot_minimax_tts.py"),
      "--voice-script",
      voiceScript,
      "--task-dir",
      outputDir,
      "--provider",
      provider,
      "--model",
      options.model || manifest.tts?.model || "speech-2.8-hd",
      "--voice-id",
      options["voice-id"] || manifest.tts?.voice_id || DEFAULT_VOICE_ID,
      "--speed",
      String(optionalNumber(options.speed, manifest.tts?.speed ?? 1.1)),
      "--vol",
      String(optionalNumber(options.vol, manifest.tts?.vol ?? 1)),
      "--voice-setting-pitch",
      String(optionalInt(options.pitch ?? options["voice-setting-pitch"], manifest.tts?.pitch ?? 0)),
      "--emotion",
      options.emotion || manifest.tts?.emotion || "happy",
      "--modify-pitch",
      String(optionalInt(options["modify-pitch"], manifest.tts?.modify_pitch ?? voiceModify.pitch ?? 20)),
      "--modify-intensity",
      String(optionalInt(options["modify-intensity"], manifest.tts?.intensity ?? voiceModify.intensity ?? 20)),
      "--modify-timbre",
      String(optionalInt(options["modify-timbre"], manifest.tts?.timbre ?? voiceModify.timbre ?? 0)),
      "--subtitle-type",
      options["subtitle-type"] || "sentence",
      "--output-format",
      options["output-format"] || "url"
    ];
    args.push(options["no-subtitle-enable"] ? "--no-subtitle-enable" : "--subtitle-enable");
    await runner.run({
      command: "python3",
      args,
      taskDir,
      logsDir: runContext?.logsDir,
      runContext,
      stage: "tts",
      cwd: workspace,
      moduleIds: provider === "vectorengine-minimax" ? ["tts_fallback"] : ["tts_primary"],
      timeoutMs: stageTimeout("tts", options)
    });
  }
  requireStageOutputs(outputDir, "tts");
  if (runContext) await promoteStageOutputs({ taskDir, runContext, stage: "tts" });
  await refreshActiveArtifacts(taskDir, "tts");
  return path.join(taskDir, "audio_sections.json");
}

export async function runRetrieveStage({ workspace, taskDir, runContext, options = {} }) {
  const manifest = await requireTaskManifest(taskDir);
  const audioSections = path.join(taskDir, "audio_sections.json");
  const voiceWav = path.join(taskDir, "voice.wav");
  const shotIndex = path.join(resolveIntakeRun(workspace, manifest), "shot_index.json");
  const outputDir = runContext?.outputDir || taskDir;
  requireFile(audioSections, "audio_sections.json");
  requireFile(voiceWav, "voice.wav");
  requireFile(shotIndex, "shot_index.json");
  const runner = createRunner(workspace);
  await runner.run({
    command: "python3",
    args: [
      path.join(workspace, "scripts", "voah_retrieve_fill_from_audio_sections.py"),
      "--audio-sections",
      audioSections,
      "--index",
      shotIndex,
      "--voice-wav",
      voiceWav,
      "--task-dir",
      outputDir,
      "--product",
      manifest.product_name || manifest.product_slug,
      "--top-k",
      String(optionalInt(options["top-k"], 14)),
      "--pool-k",
      String(optionalInt(options["pool-k"], 36)),
      "--max-clips-per-section",
      String(optionalInt(options["max-clips-per-section"], 6)),
      "--selection-planner",
      options["selection-planner"] || "auto",
      "--width",
      String(optionalInt(options.width, 720)),
      "--height",
      String(optionalInt(options.height, 1280)),
      "--fps",
      String(optionalInt(options.fps, 30)),
      "--preset",
      options.preset || "veryfast"
    ],
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "retrieve",
    cwd: workspace,
    moduleIds: ["material_retrieval", "selection_planner"],
    timeoutMs: stageTimeout("retrieve", options)
  });
  requireStageOutputs(outputDir, "retrieve");
  if (runContext) await promoteStageOutputs({ taskDir, runContext, stage: "retrieve" });
  await refreshActiveArtifacts(taskDir, "retrieve");
  return path.join(taskDir, "timeline_fill.json");
}

export async function runSubtitleStage({ workspace, taskDir, runContext, options = {} }) {
  const manifest = await requireTaskManifest(taskDir);
  const audioSections = path.join(taskDir, "audio_sections.json");
  const preview = path.join(taskDir, "preview_no_subtitles.mp4");
  const voiceWav = path.join(taskDir, "voice.wav");
  const outputDir = runContext?.outputDir || taskDir;
  requireFile(audioSections, "audio_sections.json");
  requireFile(preview, "preview_no_subtitles.mp4");
  requireFile(voiceWav, "voice.wav");
  const runner = createRunner(workspace);
  await runner.run({
    command: "python3",
    args: [
      path.join(workspace, "scripts", "voah_build_caption_plan.py"),
      "--audio-sections",
      audioSections,
      "--task-dir",
      outputDir,
      "--preset",
      options["subtitle-preset"] || options.preset || manifest.subtitle?.preset || "songti_white_gold_lower",
      ...(options["font-source"] || manifest.subtitle?.font_source ? ["--font-source", options["font-source"] || manifest.subtitle?.font_source] : []),
      options["no-split-punctuation"] ? "--no-split-punctuation" : "--split-punctuation"
    ],
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "subtitle",
    cwd: workspace,
    timeoutMs: stageTimeout("subtitle", options)
  });
  await runner.run({
    command: "python3",
    args: [
      path.join(workspace, "scripts", "voah_create_hyperframes_subtitle_project.py"),
      "--caption-plan",
      path.join(outputDir, "caption_plan.json"),
      "--base-video",
      preview,
      "--voice-wav",
      voiceWav,
      "--project-dir",
      path.join(outputDir, "hyperframes_subtitle_burn")
    ],
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "subtitle",
    cwd: workspace,
    timeoutMs: stageTimeout("subtitle", options)
  });
  requireStageOutputs(outputDir, "subtitle");
  if (runContext) await promoteStageOutputs({ taskDir, runContext, stage: "subtitle" });
  await refreshActiveArtifacts(taskDir, "subtitle");
  return path.join(taskDir, "caption_plan.json");
}

export async function runRenderStage({ workspace, taskDir, runContext, options = {} }) {
  const outputDir = runContext?.outputDir || taskDir;
  const projectDir = path.join(outputDir, "hyperframes_subtitle_burn");
  const finalVideo = path.join(projectDir, "final_subtitled.mp4");
  const stableProjectDir = path.join(taskDir, "hyperframes_subtitle_burn");
  requireFile(path.join(stableProjectDir, "index.html"), "hyperframes_subtitle_burn/index.html");
  if (runContext) {
    await rm(projectDir, { recursive: true, force: true });
    await mkdir(path.dirname(projectDir), { recursive: true });
    await cp(stableProjectDir, projectDir, { recursive: true, force: true });
  }
  const runner = createRunner(workspace);
  await reencodeHyperframesBaseVideo({ runner, taskDir, projectDir, logsDir: runContext?.logsDir, runContext });
  const hyperframes = resolveHyperframesCommand(workspace, { cwd: projectDir });
  const diagnostics = await collectHyperframesDiagnostics(workspace, hyperframes, { cwd: projectDir });
  const renderEnv = hyperframesRenderEnv();
  await runner.run({
    ...withHyperframesArgs(hyperframes, ["lint", "."]),
    cwd: projectDir,
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "render",
    timeoutMs: stageTimeout("render", options)
  });
  await runner.run({
    ...withHyperframesArgs(hyperframes, ["inspect", ".", "--samples", "12", "--json"]),
    cwd: projectDir,
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "render",
    env: renderEnv,
    allowFailure: Boolean(options["allow-inspect-warning"]),
    timeoutMs: stageTimeout("render", options)
  });
  let fallbackUsed = false;
  let fallbackReason = "";
  let lowMemoryMode = false;
  const renderAttempts = [];
  const renderStartedAt = Date.now();
  const renderTimeoutMs = optionalInt(options["render-timeout-ms"], stageTimeout("render", options) || DEFAULT_HYPERFRAMES_RENDER_TIMEOUT_MS);
  const baseRenderArgs = hyperframesBaseRenderArgs({ output: finalVideo, quality: "standard", fps: 30 });
  try {
    const result = await runner.run({
      ...withHyperframesArgs(hyperframes, [...baseRenderArgs, "--no-low-memory-mode"]),
      cwd: projectDir,
      taskDir,
      logsDir: runContext?.logsDir,
      runContext,
      stage: "render",
      env: renderEnv,
      timeoutMs: renderTimeoutMs
    });
    renderAttempts.push({ mode: "normal", status: "succeeded", elapsed_ms: result.elapsedMs ?? null });
  } catch (error) {
    renderAttempts.push(renderAttemptFailure("normal", error));
    try {
      const result = await runner.run({
        ...withHyperframesArgs(hyperframes, [...baseRenderArgs, "--low-memory-mode"]),
        cwd: projectDir,
        taskDir,
        logsDir: runContext?.logsDir,
        runContext,
        stage: "render",
        env: hyperframesRenderEnv({ lowMemoryMode: true }),
        timeoutMs: renderTimeoutMs
      });
      lowMemoryMode = true;
      renderAttempts.push({ mode: "low-memory", status: "succeeded", elapsed_ms: result.elapsedMs ?? null });
    } catch (retryError) {
      renderAttempts.push(renderAttemptFailure("low-memory", retryError));
      fallbackUsed = true;
      fallbackReason = retryError.message || error.message || String(retryError);
      await burnOverlayFallback({
        runner,
        workspace,
        taskDir,
        projectDir,
        outputDir,
        runContext,
        finalVideo,
        reason: fallbackReason,
        options
      });
    }
  }
  const manifestPath = path.join(projectDir, "hyperframes_subtitle_burn_manifest.json");
  const payload = existsSync(manifestPath) ? await readJson(manifestPath) : {};
  payload.render = {
    renderer: fallbackUsed ? "ffmpeg-png-overlay" : "hyperframes",
    fallback_used: fallbackUsed,
    fallback_reason: fallbackReason,
    output: finalVideo,
    elapsed_ms: Date.now() - renderStartedAt,
    render_timeout_ms: renderTimeoutMs,
    low_memory_mode: lowMemoryMode,
    attempts: renderAttempts,
    hyperframes: diagnostics
  };
  payload.outputs ||= {};
  payload.outputs.final_subtitled = finalVideo;
  payload.qa = {
    status: existsSync(finalVideo) ? "ok" : "warning",
    warnings: existsSync(finalVideo) ? [] : ["final_subtitled.mp4 missing after render"]
  };
  await writeJson(manifestPath, payload);
  requireStageOutputs(outputDir, "render");
  if (runContext) {
    await promoteStageOutputs({
      taskDir,
      runContext,
      stage: "render",
      paths: ["hyperframes_subtitle_burn/final_subtitled.mp4", "hyperframes_subtitle_burn/hyperframes_subtitle_burn_manifest.json"]
    });
  }
  await refreshActiveArtifacts(taskDir, "render");
  return finalVideo;
}

export async function runQaStage({ workspace, taskDir, options = {} }) {
  const runContext = options.runContext;
  const outputDir = runContext?.outputDir || taskDir;
  const finalVideo = path.join(taskDir, "hyperframes_subtitle_burn", "final_subtitled.mp4");
  const audioSections = path.join(taskDir, "audio_sections.json");
  const timelineFill = path.join(taskDir, "timeline_fill.json");
  requireFile(finalVideo, "hyperframes_subtitle_burn/final_subtitled.mp4");
  requireFile(audioSections, "audio_sections.json");
  requireFile(timelineFill, "timeline_fill.json");
  if (runContext) {
    await prepareQaWorkspace(taskDir, outputDir);
  }
  const runner = createRunner(workspace);
  if (!options["skip-omni"]) {
    await runner.run({
      command: "python3",
      args: [
        path.join(workspace, "scripts", "voah_omni_alignment_qa.py"),
        "--task-dir",
        taskDir,
        "--video",
        finalVideo,
        "--audio-sections",
        audioSections,
        "--timeline-fill",
        timelineFill,
        "--output-dir",
        path.join(outputDir, "qa_omni_alignment_final"),
        ...(options["max-sections"] ? ["--max-sections", String(optionalInt(options["max-sections"], 0))] : [])
      ],
      taskDir,
      logsDir: runContext?.logsDir,
      runContext,
      stage: "qa",
      cwd: workspace,
      moduleIds: ["material_understanding"],
      allowFailure: true,
      timeoutMs: stageTimeout("qa", options)
    });
  }
  await runner.run({
    command: "python3",
    args: [path.join(workspace, "scripts", "voah_write_full_pipeline_manifest.py"), "--task-dir", outputDir],
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "qa",
    cwd: workspace,
    timeoutMs: stageTimeout("qa", options)
  });
  await runner.run({
    command: "python3",
    args: [path.join(workspace, "scripts", "voah_build_desktop_quality_report.py"), "--task-dir", outputDir],
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "qa",
    cwd: workspace,
    allowFailure: true,
    timeoutMs: stageTimeout("qa", options)
  });
  requireStageOutputs(outputDir, "qa");
  if (runContext) await promoteStageOutputs({ taskDir, runContext, stage: "qa" });
  await updateQaFromManifest(taskDir);
  await refreshActiveArtifacts(taskDir, "qa");
  await importQaResources({ workspace, taskDir });
  return path.join(taskDir, "full_pipeline_manifest.json");
}

async function prepareQaWorkspace(taskDir, outputDir) {
  const relPaths = [
    "copy_brief.json",
    "voice_script.json",
    "tts_audio.json",
    "voice.wav",
    "audio_sections.json",
    "candidate_sections.json",
    "timeline_selection.json",
    "timeline_fill.json",
    "caption_plan.json",
    "preview_no_subtitles.mp4",
    "hyperframes_subtitle_burn"
  ];
  for (const relPath of relPaths) {
    const source = path.join(taskDir, relPath);
    if (!existsSync(source)) continue;
    const target = path.join(outputDir, relPath);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }
}

async function runGptSovitsTts({ workspace, taskDir, outputDir, runContext, manifest, options }) {
  const gptRoot = options["gpt-sovits-root"] || process.env.GPT_SOVITS_ROOT || path.join(workspace, "GPT-SoVITS");
  const scriptPath = path.join(gptRoot, "scripts", "gpt_sovits_tts.py");
  const pythonPath = options["gpt-sovits-python"] || process.env.GPT_SOVITS_PYTHON || path.join(gptRoot, ".venv", "bin", "python");
  if (!existsSync(scriptPath)) {
    throw new UserError(`gpt-sovits provider requested but script not found: ${scriptPath}`);
  }
  if (!existsSync(pythonPath)) {
    throw new UserError(`gpt-sovits provider requested but python not found: ${pythonPath}`);
  }
  const voiceScriptPath = path.join(taskDir, "voice_script.json");
  const voiceScript = await readJson(voiceScriptPath);
  const text = voiceScript.pronounce_text || voiceScript.full_voice_text || "";
  if (!text.trim()) {
    throw new UserError("voice_script 缺少 pronounce_text/full_voice_text，无法生成 GPT-SoVITS TTS");
  }
  const ref = options.ref || process.env.GPT_SOVITS_REF || path.join(gptRoot, "samples", "user_refs", "fangshai_qidian_pshot4_p00_loop2.wav");
  const promptText =
    options["prompt-text"] ||
    process.env.GPT_SOVITS_PROMPT_TEXT ||
    "出门别人都以为你本来就长这个样子。出门别人都以为你本来就长这个样子。";
  const out = path.join(outputDir, "voice.wav");
  const runner = createRunner(workspace);
  await runner.run({
    command: pythonPath,
    args: [
      scriptPath,
      "--ref",
      ref,
      "--prompt-text",
      promptText,
      "--text",
      text,
      "--out",
      out,
      "--prompt-lang",
      options["prompt-lang"] || "zh",
      "--text-lang",
      options["text-lang"] || "zh",
      "--seed",
      String(optionalInt(options.seed, 2026)),
      "--speed",
      String(optionalNumber(options.speed, manifest.tts?.speed ?? 1.0))
    ],
    cwd: gptRoot,
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "tts",
    timeoutMs: stageTimeout("tts", options)
  });
  const duration = await probeDuration(out);
  await writeFile(path.join(outputDir, "pronounce_text.txt"), `${text}\n`, "utf8");
  const sections = buildAudioSectionsFromVoiceScript(voiceScript, duration);
  const ttsAudio = {
    schema_version: "1.0.0",
    stage: "voah_tts",
    created_at: new Date().toISOString(),
    provider: {
      name: "gpt-sovits",
      model: "local-gpt-sovits",
      key_configured: false
    },
    inputs: {
      voice_script: voiceScriptPath,
      ref_audio: ref
    },
    outputs: {
      voice_wav: out,
      audio_sections: path.join(outputDir, "audio_sections.json"),
      next_artifact: path.join(outputDir, "candidate_sections.json")
    },
    timing: {
      actual_audio_duration_s: duration
    },
    qa: {
      status: duration > 0 ? "ok" : "warning",
      warnings: duration > 0 ? [] : ["cannot probe GPT-SoVITS voice duration"]
    },
    next_consumers: ["voah-shot-retrieval"]
  };
  await writeJson(path.join(outputDir, "tts_audio.json"), ttsAudio);
  await writeJson(path.join(outputDir, "audio_sections.json"), {
    schema_version: "1.0.0",
    stage: "voah_audio_sections",
    created_at: new Date().toISOString(),
    product: voiceScript.product || {},
    inputs: {
      voice_script: voiceScriptPath,
      voice_wav: out
    },
    sections,
    summary: {
      section_count: sections.length,
      voice_duration_s: duration
    },
    qa: ttsAudio.qa,
    next_consumers: ["voah-shot-retrieval"]
  });
}

function buildAudioSectionsFromVoiceScript(voiceScript, duration) {
  const rawSections = Array.isArray(voiceScript.script_sections) && voiceScript.script_sections.length
    ? voiceScript.script_sections
    : [{ role: "body", voice_text: voiceScript.full_voice_text || voiceScript.pronounce_text || "" }];
  const lengths = rawSections.map((section) => Math.max(1, String(section.tts_text || section.voice_text || "").length));
  const total = lengths.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = 0;
  return rawSections.map((section, index) => {
    const isLast = index === rawSections.length - 1;
    const start = round3(cursor);
    const sectionDuration = isLast ? Math.max(0, duration - cursor) : (duration * lengths[index]) / total;
    const end = round3(isLast ? duration : cursor + sectionDuration);
    cursor = end;
    const voiceText = String(section.voice_text || section.tts_text || "");
    return {
      section_id: section.section_id || `section_${String(index + 1).padStart(3, "0")}`,
      timeline_order: index + 1,
      role: section.role || "body",
      voice_text: voiceText,
      tts_text: String(section.tts_text || voiceText),
      subtitle_text: voiceText,
      intention_copy: section.intention_copy || "",
      required_meaning: section.required_meaning || "",
      required_visual: section.required_visual || "",
      avoid: section.avoid || "",
      audio_start_s: start,
      audio_end_s: end,
      timeline_start_s: start,
      timeline_end_s: end,
      audio_duration_s: round3(Math.max(0, end - start))
    };
  });
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file
    ]);
    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.on("error", () => resolve(0));
    proc.on("close", () => {
      const number = Number(stdout.trim());
      resolve(Number.isFinite(number) ? round3(number) : 0);
    });
  });
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

async function reencodeHyperframesBaseVideo({ runner, taskDir, projectDir, logsDir, runContext }) {
  const baseVideo = path.join(projectDir, "media", "base_video.mp4");
  const sourcePreview = path.join(taskDir, "preview_no_subtitles.mp4");
  const encodedVideo = path.join(projectDir, "media", `base_video_gop30.${process.pid}.${Date.now()}.tmp.mp4`);
  await mkdir(path.dirname(baseVideo), { recursive: true });
  if (existsSync(sourcePreview)) {
    await copyFile(sourcePreview, baseVideo);
  }
  if (!existsSync(baseVideo)) return;
  const result = await runner.run({
    command: "ffmpeg",
    args: [
      "-y",
      "-i",
      baseVideo,
      "-c:v",
      "libx264",
      "-r",
      "30",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-c:a",
      "copy",
      encodedVideo
    ],
    cwd: projectDir,
    taskDir,
    logsDir,
    runContext,
    stage: "render",
    allowFailure: true
  });
  if (result.code === 0 && existsSync(encodedVideo)) {
    await rename(encodedVideo, baseVideo);
  }
  await rm(encodedVideo, { force: true });
}

async function burnOverlayFallback({ runner, workspace, taskDir, projectDir, outputDir, runContext, finalVideo, reason, options = {} }) {
  await runner.run({
    command: "python3",
    args: [
      path.join(workspace, "scripts", "voah_burn_subtitles_overlay.py"),
      "--caption-plan",
      path.join(outputDir || taskDir, "caption_plan.json"),
      "--base-video",
      path.join(projectDir, "media", "base_video.mp4"),
      "--voice-wav",
      path.join(projectDir, "media", "voice.wav"),
      "--output",
      finalVideo,
      "--work-dir",
      projectDir,
      "--manifest",
      path.join(projectDir, "overlay_subtitle_burn_manifest.json"),
      "--reason",
      reason
    ],
    cwd: workspace,
    taskDir,
    logsDir: runContext?.logsDir,
    runContext,
    stage: "render",
    timeoutMs: stageTimeout("render", options)
  });
}

function createRunner(workspace) {
  return new WorkerRunner({ workspace, secretService: new SecretService() });
}

async function requireTaskManifest(taskDir) {
  const manifest = await loadTaskManifest(taskDir);
  if (!manifest) {
    throw new UserError(`缺少 task_manifest.json：${taskDir}`);
  }
  return manifest;
}

function resolveIntakeRun(workspace, manifest) {
  if (!manifest.intake_run) {
    throw new UserError("task_manifest 缺少 intake_run");
  }
  return path.isAbsolute(manifest.intake_run) ? manifest.intake_run : path.join(workspace, manifest.intake_run);
}

function requireFile(file, label) {
  if (!existsSync(file)) {
    throw new UserError(`缺少生产必需文件：${label} (${file})`);
  }
}

function requireStageOutputs(taskDir, stage) {
  const outputs = {
    copy: ["copy_brief.json", "voice_script.json"],
    tts: ["tts_audio.json", "voice.wav", "audio_sections.json"],
    retrieve: ["candidate_sections.json", "timeline_selection.json", "timeline_fill.json", "preview_no_subtitles.mp4"],
    subtitle: ["caption_plan.json", "hyperframes_subtitle_burn/index.html", "hyperframes_subtitle_burn/hyperframes_subtitle_burn_manifest.json"],
    render: ["hyperframes_subtitle_burn/final_subtitled.mp4", "hyperframes_subtitle_burn/hyperframes_subtitle_burn_manifest.json"],
    qa: ["full_pipeline_manifest.json"]
  }[stage] || [];
  for (const output of outputs) {
    requireFile(path.join(taskDir, output), output);
  }
}

async function readTtsProvider() {
  try {
    const service = new SecretService();
    const config = await service.readConfig();
    return config["tts.provider"] || "";
  } catch {
    return "";
  }
}

async function updateQaFromManifest(taskDir) {
  const manifest = await loadTaskManifest(taskDir);
  if (!manifest) return;
  const full = path.join(taskDir, "full_pipeline_manifest.json");
  const fullPayload = existsSync(full) ? await readJson(full) : {};
  manifest.qa = fullPayload.qa || fullPayload.export_gate || manifest.qa || {};
  manifest.status = manifest.qa?.status === "ok" || manifest.qa?.status === "pass" ? "succeeded" : "needs_review";
  manifest.updated_at = new Date().toISOString();
  await writeTaskManifest(taskDir, manifest);
}

async function importQaResources({ workspace, taskDir }) {
  const resourceService = new ResourceService({ workspace });
  const inputs = path.join(taskDir, "qa_omni_alignment_final", "alignment_inputs.json");
  if (!existsSync(inputs)) return;
  const rows = await readJson(inputs);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.clip_path) {
      if (row.video_url) {
        await resourceService.registerRemote({
          runDir: taskDir,
          file: row.clip_path,
          purpose: "omni_qa",
          remoteUrl: row.video_url,
          provider: row.resource_provider || "dashscope_managed_oss",
          consumers: ["qwen3.5-omni-plus"]
        });
      } else {
        await resourceService.registerLocal({
          runDir: taskDir,
          file: row.clip_path,
          purpose: "omni_qa",
          provider: row.resource_provider || "local",
          consumers: ["qwen3.5-omni-plus"]
        });
      }
    }
  }
}

export async function writeTaskBrief({ workspace, taskDir, manifest, brief = {} }) {
  const intakeRun = resolveIntakeRun(workspace, manifest);
  const shotIndex = path.join(intakeRun, "shot_index.json");
  requireFile(shotIndex, "shot_index.json");
  const productContext = await readProductContext(workspace, manifest.product_slug);
  const targetDuration = manifest.target_duration_s || Number(brief.target_duration_s) || 45;
  const productLibrary = productContext.product_library || {};
  const campaignText = linesFromItems(productContext.campaigns || []);
  const blockedText = linesFromItems(productContext.blocked_terms || []);
  const payload = {
    schema_version: "1.0.0",
    stage: "voah_task_brief",
    pipeline_version: "voah-cli-v1",
    created_at: new Date().toISOString(),
    product: {
      slug: manifest.product_slug,
      name: validProductName(manifest.product_name, manifest.product_slug) || validProductName(productLibrary.name, manifest.product_slug),
      brand: String(productLibrary.brand || "").trim(),
      generic_name: genericProductName(manifest.product_slug)
    },
    task: {
      id: manifest.task_id,
      title: manifest.label || manifest.task_id,
      target_platform: brief.platform || brief.target_platform || "抖音",
      target_duration_range_s: [Math.max(15, Math.round(targetDuration - 5)), Math.round(targetDuration + 5)],
      style: brief.style || "",
      audience: brief.audience || "",
      objective: "CLI 真实生产：先销售逻辑和连续口播，再 TTS，再按音频语义召回素材、烧字幕。"
    },
    inputs: {
      intake_run: intakeRun,
      shot_index: shotIndex,
      user_brief: brief
    },
    product_claims: productContext.claims || [],
    product_campaigns: productContext.campaigns || [],
    product_blocked_terms: productContext.blocked_terms || [],
    product_library: productLibrary,
    copy_parameters: {
      main_claim: brief.main_claim || "",
      offer: brief.offer || campaignText,
      forbidden_terms: brief.forbidden || blockedText,
      cta_policy: brief.cta_policy || productLibrary.cta || "",
      style: brief.style || "",
      audience: brief.audience || ""
    },
    constraints: [
      "不写医疗或绝对化功效",
      "不把原素材 ASR/OCR 逐字搬运成文案",
      "字幕文本来自最终口播原文，不使用 MiniMax 字幕文本或 ASR 改写",
      "产品 slug 只是内部文件标识，不能当品牌名或产品名写入口播；品牌和产品名为空时只能用泛称"
    ],
    outputs: {
      task_brief: path.join(taskDir, "task_brief.json"),
      next_artifact: path.join(taskDir, "copy_brief.json")
    },
    qa: {
      status: "ok",
      warnings: []
    },
    next_consumers: ["voah-copy-brief"]
  };
  await writeJson(path.join(taskDir, "task_brief.json"), payload);
  await markStage(taskDir, "task_brief", {
    status: "succeeded",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    log: ""
  });
  await refreshActiveArtifacts(taskDir, "task_brief");
  return payload;
}

async function readProductContext(workspace, slug) {
  const productDir = path.join(workspace, "data", "products", slug);
  const product = existsSync(path.join(productDir, "product.json")) ? await readJson(path.join(productDir, "product.json")) : {};
  const claimsPayload = existsSync(path.join(productDir, "claims.json")) ? await readJson(path.join(productDir, "claims.json")) : {};
  const campaignsPayload = existsSync(path.join(productDir, "campaigns.json")) ? await readJson(path.join(productDir, "campaigns.json")) : {};
  const blockedTermsPayload = existsSync(path.join(productDir, "blocked_terms.json")) ? await readJson(path.join(productDir, "blocked_terms.json")) : {};
  return {
    claims: claimsPayload.claims || [],
    campaigns: campaignsPayload.campaigns || [],
    blocked_terms: blockedTermsPayload.terms || [],
    product_library: product
  };
}

function linesFromItems(items) {
  return (items || []).map((item) => item.text || item.claim || item.name || item.term || item).filter(Boolean).join("\n");
}

function validProductName(name, slug) {
  const value = String(name || "").trim();
  if (!value) return "";
  if (slug && value === slug) return "";
  if (/^[a-z0-9][a-z0-9_-]{2,}$/i.test(value)) return "";
  return value;
}

function genericProductName(slug) {
  const value = String(slug || "");
  if (/qidian|cushion/i.test(value)) return "这盒气垫";
  if (/kouhong|lip/i.test(value)) return "这支口红";
  return "这款产品";
}
