import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createHumanError,
  createTaskTitle,
  mergeVoahSettings,
  RECIPE_STAGES
} from "../../src/lib/mvpContracts.js";

const PIPELINE_VERSION = "voah-desktop-real-recipe.v1";

function nowIso() {
  return new Date().toISOString();
}

function compactId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function parseStdoutKeyValue(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("="))
    .reduce((acc, line) => {
      const index = line.indexOf("=");
      acc[line.slice(0, index)] = line.slice(index + 1);
      return acc;
    }, {});
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
  }
  return {};
}

function slugify(input) {
  return String(input || "task")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function compactDateTime() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function safeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function uniqueStrings(values) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function qaStatusFromPayload(payload) {
  return payload?.qa?.status || payload?.status || "ok";
}

function statusFromQa(status) {
  if (status === "block" || status === "blocked") {
    return "failed";
  }
  return status === "ok" || status === "pass" ? "succeeded" : "warning";
}

function isChildVisualReviewWarning(warning) {
  return String(warning || "").includes("child physical shot 未明确命中目标视觉词");
}

function normalizeTargetRange(duration) {
  const target = safeNumber(duration, 45);
  return [Math.max(15, Math.round(target - 5)), Math.round(target + 5)];
}

function getIntakeRunDir(workspaceRoot, product) {
  if (!product.latest_intake_run) {
    return "";
  }
  return path.join(workspaceRoot, "cache", "voah_video_intake", product.slug, product.latest_intake_run);
}

function hyperframesCommandArgs(args) {
  const localBin = path.join(process.cwd(), "node_modules", ".bin", "hyperframes");
  if (existsSync(localBin)) {
    return { command: localBin, args };
  }
  return { command: "npx", args: ["hyperframes", ...args] };
}

function productMeta(product) {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand || "",
    slug: product.slug
  };
}

function splitClaims(product, brief) {
  return uniqueStrings([
    ...(String(product.claim_summary || "").split(/[、,，]/)),
    ...(String(brief.main_claim || "").split(/[、,，]/)),
    brief.offer
  ]);
}

function taskConfig(task) {
  return mergeVoahSettings(task.production_config || {});
}

function numberArg(value, fallback) {
  return String(safeNumber(value, fallback));
}

function intArg(value, fallback) {
  return String(Math.round(safeNumber(value, fallback)));
}

function optionalString(value) {
  return String(value || "").trim();
}

function dryStagePayload({ stage, task, product, brief, sourceArtifacts, qaStatus }) {
  const base = {
    schema_version: "1.0.0",
    stage: stage.id,
    created_at: nowIso(),
    product: productMeta(product),
    task: {
      id: task.id,
      title: task.title
    },
    inputs: {
      source_artifacts: sourceArtifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path
      })),
      brief
    },
    outputs: {},
    qa: {
      status: qaStatus,
      warnings: []
    },
    next_consumers: []
  };

  if (stage.id === "voice_script") {
    base.full_voice_text = "防晒气垫出门前一拍就有自然气色，SPF 防晒和持妆表现都在线，通勤补妆也不厚重，今天活动价很适合直接入。";
    base.subtitle_policy = "verbatim_voice_text_split";
  }

  if (stage.id === "qa_gate") {
    base.status = "manual_review";
    base.checks = [
      { id: "artifact", label: "产物完整", status: "pass" },
      { id: "voice_caption", label: "声音和字幕同源", status: "pass" },
      { id: "timeline", label: "素材覆盖音频主轴", status: "pass" },
      { id: "render", label: "渲染健康", status: "pass" },
      { id: "human_spot", label: "人工抽检", status: "manual_review" }
    ];
    base.summary = "MVP dry-run：关键产物完整，最终仍建议人工抽检。";
  }

  return base;
}

export class ProductionRecipe {
  constructor({ storeService, modelKeyService }) {
    this.storeService = storeService;
    this.modelKeyService = modelKeyService;
  }

  async createBatch({ productId, brief, count }) {
    const store = await this.storeService.read();
    const product = store.products.find((item) => item.id === productId);
    if (!product) {
      throw new Error("未找到产品");
    }
    if (product.status !== "ready") {
      throw new Error("产品素材还不可生产");
    }

    const safeCount = Math.max(1, Math.min(Number(count || 1), 50));
    const createdTasks = [];
    const settings = mergeVoahSettings(store.settings || {});
    const normalizedBrief = {
      ...brief,
      style: optionalString(brief.style) || settings.copy.default_style,
      audience: optionalString(brief.audience) || settings.copy.default_audience,
      offer: optionalString(brief.offer) || optionalString(product.default_offer) || settings.copy.default_offer,
      forbidden: optionalString(brief.forbidden) || optionalString(product.compliance_notes) || settings.copy.forbidden_terms,
      cta_policy: optionalString(brief.cta_policy) || optionalString(product.cta_notes) || settings.copy.cta_policy
    };
    const productionConfig = {
      schema_version: "voah-production-config.v1",
      copy: {
        ...settings.copy,
        task_overrides: {
          main_claim: optionalString(normalizedBrief.main_claim),
          offer: optionalString(normalizedBrief.offer),
          forbidden: optionalString(normalizedBrief.forbidden),
          style: optionalString(normalizedBrief.style),
          audience: optionalString(normalizedBrief.audience),
          cta_policy: optionalString(normalizedBrief.cta_policy)
        }
      },
      tts: settings.tts,
      subtitle: settings.subtitle
    };

    const batchId = compactId("batch");
    await this.storeService.mutate(async (draft) => {
      const batch = {
        id: batchId,
        product_id: product.id,
        title: `${product.name} 批量生产 ${safeCount} 条`,
        status: "queued",
        task_ids: [],
        target_count: safeCount,
        created_at: nowIso(),
        updated_at: nowIso()
      };
      for (let index = 0; index < safeCount; index += 1) {
        const taskId = compactId("task");
        const title = `${createTaskTitle(product, normalizedBrief)} #${index + 1}`;
        const taskDir = path.join(
          this.storeService.workspaceRoot,
          "cache",
          "voah_tasks",
          product.slug,
          `${compactDateTime()}_${slugify(title)}_${taskId.slice(-6)}`
        );
        const task = {
          id: taskId,
          product_id: product.id,
          title,
          status: "queued",
          target_platform: brief.target_platform || "抖音",
          target_duration_s: safeNumber(brief.target_duration_s, 45),
          current_stage: "queued",
          task_dir: taskDir,
          source_intake_run: product.latest_intake_run,
          batch_id: batchId,
          brief: normalizedBrief,
          production_config: productionConfig,
          pipeline_mode: "real",
          created_at: nowIso(),
          updated_at: nowIso()
        };
        draft.tasks.push(task);
        batch.task_ids.push(task.id);
        createdTasks.push(task);
      }
      draft.batches = [batch, ...(draft.batches || [])];
      return draft;
    });

    return createdTasks;
  }

  async previewTts(payload = {}) {
    const settings = mergeVoahSettings(payload.settings || {});
    const tts = {
      ...settings.tts,
      ...(payload.tts || {}),
      voice_modify: {
        ...(settings.tts?.voice_modify || {}),
        ...(payload.tts?.voice_modify || {})
      }
    };
    const voiceModify = tts.voice_modify || {};
    const text = optionalString(payload.text) || "今天这款气垫，上脸是自然气色，通勤补妆也很轻薄。";
    const task = {
      id: compactId("tts_preview"),
      title: "TTS 参数试听",
      task_dir: path.join(this.storeService.workspaceRoot, "cache", "voah_tts", "desktop_preview", `${compactDateTime()}_desktop`)
    };
    await mkdir(path.join(task.task_dir, "logs"), { recursive: true });
    const jobId = compactId("job");
    const env = await this.buildModelEnv(["tts_primary"]);
    const result = await this.runCommand({
      task,
      jobId,
      command: "python3",
      args: [
        path.join(this.storeService.workspaceRoot, "scripts", "voah_tts_desktop_preview.py"),
        "--text",
        text,
        "--provider",
        optionalString(tts.provider) || "minimax-official",
        "--model",
        optionalString(tts.model) || "speech-2.8-hd",
        "--voice-id",
        optionalString(tts.voice_id) || "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
        "--speed",
        numberArg(tts.speed, 1.1),
        "--vol",
        numberArg(tts.vol, 1),
        "--pitch",
        intArg(tts.pitch, 0),
        "--emotion",
        optionalString(tts.emotion) || "happy",
        "--modify-pitch",
        intArg(voiceModify.pitch, 20),
        "--modify-intensity",
        intArg(voiceModify.intensity, 20),
        "--modify-timbre",
        intArg(voiceModify.timbre, 0),
        "--audio-format",
        optionalString(payload.audio_format) || "mp3",
        "--output-root",
        path.join(this.storeService.workspaceRoot, "cache", "voah_tts", "desktop_preview"),
        "--timestamp",
        path.basename(task.task_dir)
      ],
      env
    });
    const parsed = parseStdoutKeyValue(result.stdout);
    const manifestPath = parsed.manifest || path.join(task.task_dir, "manifest.json");
    const manifest = existsSync(manifestPath) ? await readJson(manifestPath) : {};
    const record = {
      id: compactId("tts_preview"),
      text,
      provider: optionalString(tts.provider) || "minimax-official",
      model: optionalString(tts.model) || "speech-2.8-hd",
      voice_id: optionalString(tts.voice_id),
      voice_label: optionalString(tts.voice_label),
      speed: safeNumber(tts.speed, 1.1),
      emotion: optionalString(tts.emotion) || "happy",
      voice_modify: {
        pitch: Math.round(safeNumber(voiceModify.pitch, 20)),
        intensity: Math.round(safeNumber(voiceModify.intensity, 20)),
        timbre: Math.round(safeNumber(voiceModify.timbre, 0))
      },
      audio_path: manifest.outputs?.preview_audio || parsed.preview_audio || "",
      manifest_path: manifestPath,
      duration_s: manifest.timing?.actual_audio_duration_s || null,
      qa_status: manifest.qa?.status || "ok",
      created_at: nowIso()
    };
    await this.storeService.mutate(async (draft) => {
      draft.tts_previews = [record, ...((draft.tts_previews || []).filter((item) => item.id !== record.id))].slice(0, 20);
      return draft;
    });
    return { schema_version: "voah-tts-preview-response.v1", preview: record, manifest };
  }

  async startIntakeJob(payload = {}) {
    const store = await this.storeService.read();
    const product = store.products.find((item) => item.id === payload.product_id);
    if (!product) {
      throw new Error("未找到产品");
    }
    const jobId = compactId("intake");
    const sourceDir = optionalString(payload.source_dir) || product.source_folder;
    const productSlug = optionalString(product.slug) || slugify(product.name);
    const intakeJob = {
      id: jobId,
      product_id: product.id,
      stage: "material_intake",
      status: "running",
      source_dir: sourceDir,
      run_label: optionalString(payload.run_label) || "desktop_intake_v1",
      max_videos: Math.max(0, Math.round(safeNumber(payload.max_videos, 3))),
      started_at: nowIso(),
      finished_at: null,
      result_path: null,
      run_dir: null,
      error_message: null
    };
    await this.storeService.mutate(async (draft) => {
      draft.intake_jobs = [intakeJob, ...(draft.intake_jobs || [])];
      const current = draft.products.find((item) => item.id === product.id);
      current.status = "running";
      current.material_status = "入库中";
      current.updated_at = nowIso();
      return draft;
    });
    const task = {
      id: jobId,
      title: `${product.name} 素材入库`,
      task_dir: path.join(this.storeService.workspaceRoot, "cache", "voah_video_intake", productSlug, "_desktop_jobs", jobId)
    };
    await mkdir(path.join(task.task_dir, "logs"), { recursive: true });
    const env = await this.buildModelEnv(["material_understanding", "material_vectorization"]);
    try {
      const result = await this.runCommand({
        task,
        jobId,
        command: "python3",
        args: [
          path.join(this.storeService.workspaceRoot, "scripts", "voah_intake_desktop_wrapper.py"),
          "--job-id",
          jobId,
          "--workspace",
          this.storeService.workspaceRoot,
          "--product-slug",
          productSlug,
          "--product-name",
          product.name,
          "--source-dir",
          sourceDir,
          "--max-videos",
          String(intakeJob.max_videos),
          "--run-label",
          intakeJob.run_label
        ],
        env
      });
      const workerResult = extractJsonObject(result.stdout);
      const runDir = workerResult.outputs?.run_dir || "";
      const runName = runDir ? path.basename(runDir) : "";
      await this.storeService.mutate(async (draft) => {
        const currentJob = draft.intake_jobs.find((item) => item.id === jobId);
        currentJob.status = workerResult.qa?.status === "ok" ? "succeeded" : "warning";
        currentJob.finished_at = nowIso();
        currentJob.result_path = workerResult.outputs?.desktop_result || "";
        currentJob.run_dir = runDir;
        currentJob.qa = workerResult.qa || {};
        const currentProduct = draft.products.find((item) => item.id === product.id);
        currentProduct.latest_intake_run = runName || currentProduct.latest_intake_run;
        currentProduct.source_folder = sourceDir;
        currentProduct.status = runName ? "ready" : "awaiting_review";
        currentProduct.material_status = runName ? "可生产" : "待确认";
        currentProduct.updated_at = nowIso();
        return draft;
      });
      return {
        schema_version: "voah-start-intake-response.v1",
        job_id: jobId,
        status: "succeeded",
        result: workerResult
      };
    } catch (error) {
      await this.storeService.mutate(async (draft) => {
        const currentJob = draft.intake_jobs.find((item) => item.id === jobId);
        currentJob.status = "failed";
        currentJob.finished_at = nowIso();
        currentJob.error_message = error.message || String(error);
        const currentProduct = draft.products.find((item) => item.id === product.id);
        currentProduct.status = "failed";
        currentProduct.material_status = "入库失败";
        currentProduct.updated_at = nowIso();
        return draft;
      });
      throw error;
    }
  }

  async runTask(taskId, options = {}) {
    if (options.dryRun || options.failStage) {
      return this.runDryTask(taskId, options);
    }
    return this.runRealTask(taskId, options);
  }

  async runDryTask(taskId, options = {}) {
    let store = await this.storeService.read();
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error("未找到任务");
    }
    const product = store.products.find((item) => item.id === task.product_id);
    if (!product) {
      throw new Error("未找到产品");
    }

    const failStage = options.failStage || null;
    await mkdir(task.task_dir, { recursive: true });
    await this.markTaskRunning(taskId, "starting");

    let sourceArtifacts = [];
    for (const stage of RECIPE_STAGES) {
      const jobId = await this.startJob(task, stage, options.retryOfJobId || null);
      if (failStage === stage.id) {
        await this.failJobAndTask({
          jobId,
          taskId,
          task,
          stage,
          errorCode: "dry_run_failure",
          errorMessage: "MVP 验证用模拟失败"
        });
        return { status: "failed", failed_stage: stage.id };
      }

      const outputPath = path.join(task.task_dir, stage.outputFile);
      const qaStatus = stage.id === "qa_gate" ? "warning" : "ok";
      const payload = dryStagePayload({
        stage,
        task,
        product,
        brief: task.brief,
        sourceArtifacts,
        qaStatus
      });
      payload.outputs[stage.artifactKind] = outputPath;
      const nextStage = RECIPE_STAGES[RECIPE_STAGES.findIndex((item) => item.id === stage.id) + 1];
      payload.next_consumers = nextStage ? [nextStage.id] : [];
      await writeJson(outputPath, payload);

      const artifact = await this.succeedJobWithArtifact({
        task,
        jobId,
        stage,
        path: outputPath,
        payload,
        sourceArtifacts
      });
      sourceArtifacts = [artifact];
    }

    const exportRecordPath = path.join(task.task_dir, "export_record.json");
    const exportRecord = existsSync(exportRecordPath) ? await readJson(exportRecordPath) : {};
    const finalStatus = exportRecord.qa?.status === "block" || exportRecord.status === "blocked" ? "failed" : "qa_warning";
    store = await this.storeService.mutate(async (draft) => {
      const current = draft.tasks.find((item) => item.id === taskId);
      current.status = finalStatus;
      current.current_stage = finalStatus === "failed" ? "export_record" : "qa_gate";
      if (finalStatus === "failed") {
        current.human_error = createHumanError({
          title: task.title,
          stageLabel: "QA",
          message: "QA gate 阻断导出，详见 export_record.json"
        });
      }
      current.updated_at = nowIso();
      return draft;
    });

    return {
      status: finalStatus,
      task: store.tasks.find((item) => item.id === taskId)
    };
  }

  async runRealTask(taskId, options = {}) {
    let store = await this.storeService.read();
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error("未找到任务");
    }
    const product = store.products.find((item) => item.id === task.product_id);
    if (!product) {
      throw new Error("未找到产品");
    }

    await mkdir(task.task_dir, { recursive: true });
    await mkdir(path.join(task.task_dir, "logs"), { recursive: true });
    try {
      await this.assertRequiredModelKeys({ task });
    } catch {
      return { status: "failed", failed_stage: "settings" };
    }
    await this.markTaskRunning(taskId, "starting");

    let sourceArtifacts = [];
    for (const stage of RECIPE_STAGES) {
      const jobId = await this.startJob(task, stage, options.retryOfJobId || null);
      try {
        const result = await this.runRealStage({ stage, task, product, sourceArtifacts, jobId });
        const artifact = await this.succeedJobWithArtifact({
          task,
          jobId,
          stage,
          path: result.path,
          payload: result.payload,
          sourceArtifacts
        });
        sourceArtifacts = [artifact];
      } catch (error) {
        await this.failJobAndTask({
          jobId,
          taskId,
          task,
          stage,
          errorCode: "real_stage_failure",
          errorMessage: error.message || String(error)
        });
        return { status: "failed", failed_stage: stage.id };
      }
    }

    const exportRecordPath = path.join(task.task_dir, "export_record.json");
    const exportRecord = existsSync(exportRecordPath) ? await readJson(exportRecordPath) : {};
    const finalStatus = exportRecord.qa?.status === "block" || exportRecord.status === "blocked" ? "failed" : "qa_warning";
    store = await this.storeService.mutate(async (draft) => {
      const current = draft.tasks.find((item) => item.id === taskId);
      current.status = finalStatus;
      current.current_stage = finalStatus === "failed" ? "export_record" : "qa_gate";
      if (finalStatus === "failed") {
        current.human_error = createHumanError({
          title: task.title,
          stageLabel: "QA",
          message: "QA gate 阻断导出，详见 export_record.json"
        });
      }
      current.updated_at = nowIso();
      return draft;
    });

    return {
      status: finalStatus,
      task: store.tasks.find((item) => item.id === taskId)
    };
  }

  async markTaskRunning(taskId, stageId) {
    await this.storeService.mutate(async (draft) => {
      const current = draft.tasks.find((item) => item.id === taskId);
      current.status = "running";
      current.current_stage = stageId;
      current.updated_at = nowIso();
      return draft;
    });
  }

  async startJob(task, stage, retryOfJobId) {
    const jobId = compactId("job");
    const job = {
      id: jobId,
      task_id: task.id,
      stage: stage.id,
      stage_label: stage.label,
      status: "running",
      started_at: nowIso(),
      finished_at: null,
      retry_of_job_id: retryOfJobId || null,
      error_code: null,
      error_message: null,
      result_manifest_path: null,
      log_path: path.join(task.task_dir, "logs", `${jobId}.log`)
    };

    await this.storeService.mutate(async (draft) => {
      draft.jobs.push(job);
      const current = draft.tasks.find((item) => item.id === task.id);
      current.status = "running";
      current.current_stage = stage.id;
      current.updated_at = nowIso();
      return draft;
    });
    return jobId;
  }

  async succeedJobWithArtifact({ task, jobId, stage, path: outputPath, payload, sourceArtifacts }) {
    const qaStatus = qaStatusFromPayload(payload);
    const artifact = {
      id: compactId("art"),
      task_id: task.id,
      job_id: jobId,
      kind: stage.artifactKind,
      path: outputPath,
      source_artifact_ids: sourceArtifacts.map((item) => item.id),
      qa_status: qaStatus,
      created_at: nowIso()
    };

    await this.storeService.mutate(async (draft) => {
      const storedJob = draft.jobs.find((item) => item.id === jobId);
      storedJob.status = statusFromQa(qaStatus);
      storedJob.finished_at = nowIso();
      storedJob.result_manifest_path = outputPath;
      draft.artifacts.push(artifact);
      if (stage.id === "qa_gate") {
        draft.qa_reports.push({
          id: compactId("qa"),
          task_id: task.id,
          artifact_id: artifact.id,
          status: payload.status,
          checks: payload.checks,
          summary: payload.summary,
          created_at: nowIso()
        });
      }
      return draft;
    });

    return artifact;
  }

  async failJobAndTask({ jobId, taskId, task, stage, errorCode, errorMessage }) {
    const humanError = createHumanError({
      title: task.title,
      stageLabel: stage.label,
      message: errorMessage
    });
    await this.storeService.mutate(async (draft) => {
      const failedJob = draft.jobs.find((item) => item.id === jobId);
      failedJob.status = "failed";
      failedJob.finished_at = nowIso();
      failedJob.error_code = errorCode;
      failedJob.error_message = humanError.reason;
      const current = draft.tasks.find((item) => item.id === taskId);
      current.status = "failed";
      current.current_stage = stage.id;
      current.human_error = humanError;
      current.updated_at = nowIso();
      return draft;
    });
  }

  async runRealStage({ stage, task, product, jobId }) {
    const handlers = {
      task_brief: () => this.writeTaskBrief({ task, product }),
      copy_brief: () => this.writeCopyBrief({ task, product, jobId }),
      voice_script: () => this.writeVoiceScript({ task }),
      tts_audio: () => this.runTts({ task, product, jobId }),
      audio_sections: () => this.registerExistingJson({ task, stage, fileName: "audio_sections.json" }),
      timeline_selection: () => this.runRetrievalAndSelection({ task, product, jobId }),
      timeline_fill: () => this.runRetrievalAndFill({ task, stage }),
      caption_plan: () => this.runCaptionPlan({ task, jobId }),
      subtitle_burn: () => this.runSubtitleBurn({ task, jobId }),
      qa_gate: () => this.writeQaGate({ task, jobId }),
      export_record: () => this.writeExportRecord({ task, product, jobId })
    };
    const handler = handlers[stage.id];
    if (!handler) {
      throw new Error(`未实现阶段：${stage.id}`);
    }
    return handler();
  }

  async writeTaskBrief({ task, product }) {
    const taskBriefPath = path.join(task.task_dir, "task_brief.json");
    const intakeRun = getIntakeRunDir(this.storeService.workspaceRoot, product);
    const shotIndex = path.join(intakeRun, "shot_index.json");
    const config = taskConfig(task);
    const copyConfig = config.copy || {};
    if (!existsSync(shotIndex)) {
      throw new Error(`素材索引不存在：${shotIndex}`);
    }
    const payload = {
      schema_version: "1.0.0",
      stage: "voah_task_brief",
      pipeline_version: PIPELINE_VERSION,
      created_at: nowIso(),
      product: productMeta(product),
      task: {
        id: task.id,
        title: task.title,
        target_platform: task.target_platform,
        target_duration_range_s: normalizeTargetRange(task.target_duration_s),
        style: task.brief.style || copyConfig.default_style,
        audience: task.brief.audience || copyConfig.default_audience,
        objective: "桌面端真实生产：先销售逻辑和连续口播，再 TTS，再按音频语义召回素材、烧字幕。"
      },
      inputs: {
        intake_run: intakeRun,
        shot_index: shotIndex,
        user_brief: task.brief,
        production_config: task.production_config || config
      },
      product_claims: uniqueStrings([
        ...splitClaims(product, task.brief),
        ...(String(product.selling_points || "").split(/[、,，]/))
      ]),
      product_library: {
        name: product.name,
        brand: product.brand || "",
        selling_points: product.selling_points || product.claim_summary || "",
        compliance_notes: product.compliance_notes || "",
        cta_notes: product.cta_notes || "",
        material_summary: product.claim_summary || "",
        latest_intake_run: product.latest_intake_run || ""
      },
      copy_parameters: {
        main_claim: task.brief.main_claim || "",
        offer: task.brief.offer || copyConfig.default_offer || "",
        forbidden_terms: task.brief.forbidden || copyConfig.forbidden_terms || "",
        cta_policy: task.brief.cta_policy || copyConfig.cta_policy || "",
        style: task.brief.style || copyConfig.default_style || "",
        audience: task.brief.audience || copyConfig.default_audience || ""
      },
      constraints: uniqueStrings([
        task.brief.forbidden,
        copyConfig.forbidden_terms,
        product.compliance_notes,
        "不写医疗或绝对化功效",
        "不说百分百防水、不脱妆一整天等过强承诺",
        "不把原素材 ASR/OCR 逐字搬运成文案",
        "字幕文本来自最终口播原文，不使用 MiniMax 字幕文本或 ASR 改写"
      ]),
      outputs: {
        task_brief: taskBriefPath,
        next_artifact: path.join(task.task_dir, "copy_brief.json")
      },
      qa: {
        status: "ok",
        warnings: []
      },
      next_consumers: ["voah-copy-brief"]
    };
    await writeJson(taskBriefPath, payload);
    return { path: taskBriefPath, payload };
  }

  async writeCopyBrief({ task, product, jobId }) {
    const taskBriefPath = path.join(task.task_dir, "task_brief.json");
    const copyBriefPath = path.join(task.task_dir, "copy_brief.json");
    const intakeRun = getIntakeRunDir(this.storeService.workspaceRoot, product);
    const shotIndex = path.join(intakeRun, "shot_index.json");
    const env = await this.buildModelEnv(["copy_generation"]);
    await this.runCommand({
      task,
      jobId,
      command: "python3",
      args: [
        path.join(this.storeService.workspaceRoot, "scripts", "voah_generate_copy_with_m3.py"),
        "--task-brief",
        taskBriefPath,
        "--task-dir",
        task.task_dir,
        "--shot-index",
        shotIndex,
        "--target-duration-s",
        String(task.target_duration_s || 45),
        "--variant",
        task.id || "desktop"
      ],
      env
    });
    const payload = await readJson(copyBriefPath);
    payload.pipeline_version = payload.pipeline_version || PIPELINE_VERSION;
    payload.product = payload.product?.name ? payload.product : productMeta(product);
    await writeJson(copyBriefPath, payload);
    return { path: copyBriefPath, payload };
  }

  async writeVoiceScript({ task }) {
    const voiceScriptPath = path.join(task.task_dir, "voice_script.json");
    if (!existsSync(voiceScriptPath)) {
      throw new Error(`文案阶段未生成 voice_script.json：${voiceScriptPath}`);
    }
    const payload = await readJson(voiceScriptPath);
    return { path: voiceScriptPath, payload };
  }

  async runTts({ task, product, jobId }) {
    const voiceScriptPath = path.join(task.task_dir, "voice_script.json");
    const env = await this.buildModelEnv(["tts_primary"]);
    const config = taskConfig(task);
    const tts = config.tts || {};
    const voiceModify = tts.voice_modify || {};
    const args = [
      path.join(this.storeService.workspaceRoot, "scripts", "voah_run_oneshot_minimax_tts.py"),
      "--voice-script",
      voiceScriptPath,
      "--task-dir",
      task.task_dir,
      "--provider",
      optionalString(tts.provider) || "minimax-official",
      "--model",
      optionalString(tts.model) || "speech-2.8-hd",
      "--voice-id",
      optionalString(tts.voice_id) || "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
      "--speed",
      numberArg(tts.speed, 1.1),
      "--vol",
      numberArg(tts.vol, 1),
      "--voice-setting-pitch",
      intArg(tts.pitch, 0),
      "--emotion",
      optionalString(tts.emotion) || "happy",
      "--modify-pitch",
      intArg(voiceModify.pitch, 20),
      "--modify-intensity",
      intArg(voiceModify.intensity, 20),
      "--modify-timbre",
      intArg(voiceModify.timbre, 0),
      "--subtitle-type",
      optionalString(tts.subtitle_type) || "sentence",
      "--output-format",
      optionalString(tts.output_format) || "url"
    ];
    args.push(tts.subtitle_enable === false ? "--no-subtitle-enable" : "--subtitle-enable");
    await this.runCommand({
      task,
      jobId,
      command: "python3",
      args,
      env
    });
    const ttsAudioPath = path.join(task.task_dir, "tts_audio.json");
    const payload = await readJson(ttsAudioPath);
    payload.product = payload.product?.name ? payload.product : productMeta(product);
    payload.desktop_config = {
      provider: optionalString(tts.provider) || "minimax-official",
      model: optionalString(tts.model) || "speech-2.8-hd",
      voice_id: optionalString(tts.voice_id) || "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
      voice_label: optionalString(tts.voice_label),
      speed: safeNumber(tts.speed, 1.1),
      vol: safeNumber(tts.vol, 1),
      pitch: Math.round(safeNumber(tts.pitch, 0)),
      emotion: optionalString(tts.emotion) || "happy",
      voice_modify: {
        pitch: Math.round(safeNumber(voiceModify.pitch, 20)),
        intensity: Math.round(safeNumber(voiceModify.intensity, 20)),
        timbre: Math.round(safeNumber(voiceModify.timbre, 0))
      },
      subtitle_enable: tts.subtitle_enable !== false,
      subtitle_type: optionalString(tts.subtitle_type) || "sentence"
    };
    await writeJson(ttsAudioPath, payload);
    return { path: ttsAudioPath, payload };
  }

  async registerExistingJson({ task, stage, fileName }) {
    const outputPath = path.join(task.task_dir, fileName);
    if (!existsSync(outputPath)) {
      throw new Error(`缺少阶段产物：${outputPath}`);
    }
    const payload = await readJson(outputPath);
    return { path: outputPath, payload: { ...payload, desktop_stage: stage.id } };
  }

  async runRetrievalAndSelection({ task, product, jobId }) {
    const intakeRun = getIntakeRunDir(this.storeService.workspaceRoot, product);
    const shotIndex = path.join(intakeRun, "shot_index.json");
    const env = await this.buildModelEnv(["material_retrieval", "selection_planner"]);
    await this.runCommand({
      task,
      jobId,
      command: "python3",
      args: [
        path.join(this.storeService.workspaceRoot, "scripts", "voah_retrieve_fill_from_audio_sections.py"),
        "--audio-sections",
        path.join(task.task_dir, "audio_sections.json"),
        "--index",
        shotIndex,
        "--voice-wav",
        path.join(task.task_dir, "voice.wav"),
        "--task-dir",
        task.task_dir,
        "--product",
        product.name,
        "--top-k",
        "14",
        "--pool-k",
        "36",
        "--max-clips-per-section",
        "6",
        "--selection-planner",
        "auto",
        "--width",
        "720",
        "--height",
        "1280",
        "--fps",
        "30",
        "--preset",
        "veryfast"
      ],
      env
    });
    const selectionPath = path.join(task.task_dir, "timeline_selection.json");
    const payload = await readJson(selectionPath);
    return { path: selectionPath, payload };
  }

  async runRetrievalAndFill({ task, stage }) {
    return this.registerExistingJson({ task, stage, fileName: "timeline_fill.json" });
  }

  async runCaptionPlan({ task, jobId }) {
    const config = taskConfig(task);
    const subtitle = config.subtitle || {};
    const args = [
      path.join(this.storeService.workspaceRoot, "scripts", "voah_build_caption_plan.py"),
      "--audio-sections",
      path.join(task.task_dir, "audio_sections.json"),
      "--task-dir",
      task.task_dir,
      "--preset",
      optionalString(subtitle.preset) || "songti_white_gold_lower"
    ];
    const fontSource = optionalString(subtitle.font_source);
    if (fontSource) {
      args.push("--font-source", fontSource);
    }
    args.push(subtitle.split_punctuation === false ? "--no-split-punctuation" : "--split-punctuation");
    await this.runCommand({
      task,
      jobId,
      command: "python3",
      args
    });
    const captionPlanPath = path.join(task.task_dir, "caption_plan.json");
    const payload = await readJson(captionPlanPath);
    payload.desktop_config = {
      subtitle: {
        preset: optionalString(subtitle.preset) || "songti_white_gold_lower",
        preset_label: optionalString(subtitle.preset_label),
        font_source: fontSource || payload.style?.font_source || "",
        split_punctuation: subtitle.split_punctuation !== false
      }
    };
    await writeJson(captionPlanPath, payload);
    return { path: captionPlanPath, payload };
  }

  async runSubtitleBurn({ task, jobId }) {
    const projectDir = path.join(task.task_dir, "hyperframes_subtitle_burn");
    await this.runCommand({
      task,
      jobId,
      command: "python3",
      args: [
        path.join(this.storeService.workspaceRoot, "scripts", "voah_create_hyperframes_subtitle_project.py"),
        "--caption-plan",
        path.join(task.task_dir, "caption_plan.json"),
        "--base-video",
        path.join(task.task_dir, "preview_no_subtitles.mp4"),
        "--voice-wav",
        path.join(task.task_dir, "voice.wav"),
        "--project-dir",
        projectDir
      ]
    });
    await this.prepareHyperframesBaseVideo({ task, jobId, projectDir });
    const hyperframesTimeoutEnv = {
      PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS: "300000",
      PRODUCER_PLAYER_READY_TIMEOUT_MS: "120000",
      PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS: "180000",
      PRODUCER_LOW_MEMORY_MODE: "false"
    };
    await this.runCommand({
      task,
      jobId,
      ...hyperframesCommandArgs(["lint", "."]),
      cwd: projectDir
    });
    await this.runCommand({
      task,
      jobId,
      ...hyperframesCommandArgs(["inspect", ".", "--samples", "12", "--json"]),
      cwd: projectDir,
      env: hyperframesTimeoutEnv
    });
    const renderResult = await this.renderHyperframesWithRetry({ task, jobId, projectDir });
    const manifestPath = path.join(projectDir, "hyperframes_subtitle_burn_manifest.json");
    const payload = await readJson(manifestPath);
    payload.outputs.final_subtitled = path.join(projectDir, "final_subtitled.mp4");
    payload.outputs.overlay_fallback_manifest = path.join(projectDir, "overlay_subtitle_burn_manifest.json");
    payload.render = renderResult;
    payload.qa = {
      status: existsSync(payload.outputs.final_subtitled) ? "ok" : "warning",
      warnings: [
        ...(existsSync(payload.outputs.final_subtitled) ? [] : ["final_subtitled.mp4 missing after render"]),
        ...(renderResult.fallback_used ? [`HyperFrames render fallback used: ${renderResult.fallback_reason}`] : [])
      ]
    };
    await writeJson(manifestPath, payload);
    return { path: manifestPath, payload };
  }

  async prepareHyperframesBaseVideo({ task, jobId, projectDir }) {
    const baseVideo = path.join(projectDir, "media", "base_video.mp4");
    const encodedVideo = path.join(projectDir, "media", "base_video_gop30.mp4");
    await this.runCommand({
      task,
      jobId,
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
      cwd: projectDir
    });
    await rename(encodedVideo, baseVideo);
  }

  async renderHyperframesWithRetry({ task, jobId, projectDir }) {
    const output = path.join(projectDir, "final_subtitled.mp4");
    const timeoutMs = Math.max(60000, Math.round(safeNumber(process.env.VOAH_HYPERFRAMES_RENDER_TIMEOUT_MS, 90000)));
    const baseArgs = [
      "render",
      ".",
      "--output",
      output,
      "--quality",
      "standard",
      "--fps",
      "30",
      "--workers",
      "1",
      "--no-browser-gpu",
      "--browser-timeout",
      "180",
      "--protocol-timeout",
      "300000",
      "--player-ready-timeout",
      "120000",
      "--no-low-memory-mode"
    ];
    const env = {
      PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS: "300000",
      PRODUCER_PLAYER_READY_TIMEOUT_MS: "120000",
      PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS: "180000",
      PRODUCER_LOW_MEMORY_MODE: "false"
    };
    try {
      await this.runCommand({
        task,
        jobId,
        ...hyperframesCommandArgs(baseArgs),
        cwd: projectDir,
        env,
        timeoutMs
      });
      return {
        renderer: "hyperframes",
        fallback_used: false,
        output
      };
    } catch (error) {
      await writeFile(
        path.join(task.task_dir, "logs", `${jobId}.log`),
        `\n--- render retry ---\n${error.message}\n`,
        { flag: "a" }
      );
      try {
        await this.runCommand({
          task,
          jobId,
          ...hyperframesCommandArgs(baseArgs.filter((item) => item !== "--no-low-memory-mode").concat("--low-memory-mode")),
          cwd: projectDir,
          env: {
            ...env,
            PRODUCER_LOW_MEMORY_MODE: "true"
          },
          timeoutMs
        });
        return {
          renderer: "hyperframes-low-memory",
          fallback_used: false,
          output
        };
      } catch (retryError) {
        await writeFile(
          path.join(task.task_dir, "logs", `${jobId}.log`),
          `\n--- overlay fallback ---\n${retryError.message}\n`,
          { flag: "a" }
        );
        await this.burnSubtitlesWithOverlay({
          task,
          jobId,
          projectDir,
          output,
          reason: retryError.message || error.message || "hyperframes render failed"
        });
        return {
          renderer: "ffmpeg-png-overlay",
          fallback_used: true,
          fallback_reason: retryError.message || error.message || "hyperframes render failed",
          output
        };
      }
    }
  }

  async burnSubtitlesWithOverlay({ task, jobId, projectDir, output, reason }) {
    await this.runCommand({
      task,
      jobId,
      command: "python3",
      args: [
        path.join(this.storeService.workspaceRoot, "scripts", "voah_burn_subtitles_overlay.py"),
        "--caption-plan",
        path.join(task.task_dir, "caption_plan.json"),
        "--base-video",
        path.join(projectDir, "media", "base_video.mp4"),
        "--voice-wav",
        path.join(projectDir, "media", "voice.wav"),
        "--output",
        output,
        "--work-dir",
        projectDir,
        "--manifest",
        path.join(projectDir, "overlay_subtitle_burn_manifest.json"),
        "--reason",
        reason
      ]
    });
  }

  async writeQaGate({ task, jobId }) {
    const outputPath = path.join(task.task_dir, "qa_gate_report.json");
    const required = [
      "task_brief.json",
      "copy_brief.json",
      "voice_script.json",
      "tts_audio.json",
      "voice.wav",
      "audio_sections.json",
      "candidate_sections.json",
      "timeline_selection.json",
      "timeline_fill.json",
      "preview_no_subtitles.mp4",
      "caption_plan.json",
      "hyperframes_subtitle_burn/final_subtitled.mp4"
    ];
    const missing = required.filter((item) => !existsSync(path.join(task.task_dir, item)));
    const omniResultsPath = path.join(task.task_dir, "qa_omni_alignment_final", "omni_alignment_results.json");
    let omniResults = {};
    let omniWorkerError = "";
    if (!missing.length) {
      const env = await this.buildModelEnv(["material_understanding"]);
      try {
        await this.runCommand({
          task,
          jobId,
          command: "python3",
          args: [
            path.join(this.storeService.workspaceRoot, "scripts", "voah_omni_alignment_qa.py"),
            "--task-dir",
            task.task_dir,
            "--video",
            path.join(task.task_dir, "hyperframes_subtitle_burn", "final_subtitled.mp4"),
            "--audio-sections",
            path.join(task.task_dir, "audio_sections.json"),
            "--timeline-fill",
            path.join(task.task_dir, "timeline_fill.json"),
            "--output-dir",
            path.join(task.task_dir, "qa_omni_alignment_final")
          ],
          env
        });
      } catch (error) {
        omniWorkerError = error.message || String(error);
        if (!existsSync(omniResultsPath)) {
          await writeJson(path.join(task.task_dir, "qa_omni_alignment_final", "omni_alignment_results.json"), {
            schema_version: "1.0.0",
            stage: "voah_omni_alignment_qa",
            created_at: nowIso(),
            inputs: {
              task_dir: task.task_dir,
              video: path.join(task.task_dir, "hyperframes_subtitle_burn", "final_subtitled.mp4")
            },
            outputs: {
              results: omniResultsPath
            },
            results: [],
            summary: {
              section_count: 0,
              pass_count: 0,
              minor_review_count: 0,
              major_review_count: 0,
              fail_count: 0
            },
            qa: {
              status: "block",
              warnings: [`Omni QA 执行失败：${omniWorkerError}`]
            },
            next_consumers: ["voah-qa-gate"]
          });
        }
      }
      omniResults = existsSync(omniResultsPath) ? await readJson(omniResultsPath) : {};
    }
    const timeline = existsSync(path.join(task.task_dir, "timeline_fill.json"))
      ? await readJson(path.join(task.task_dir, "timeline_fill.json"))
      : {};
    const captionPlan = existsSync(path.join(task.task_dir, "caption_plan.json"))
      ? await readJson(path.join(task.task_dir, "caption_plan.json"))
      : {};
    const warnings = [
      ...((timeline.qa || {}).warnings || []).map((warning) => `timeline: ${warning}`),
      ...((captionPlan.qa || {}).warnings || []).map((warning) => `caption: ${warning}`)
    ];
    const voiceDuration = safeNumber(timeline.summary?.voice_duration_s, 0);
    const targetDuration = safeNumber(task.target_duration_s, 0);
    const durationStatus =
      voiceDuration && targetDuration && Math.abs(voiceDuration - targetDuration) > 8 ? "manual_review" : "pass";
    if (durationStatus === "manual_review") {
      warnings.push(`成片时长 ${voiceDuration}s 与目标 ${targetDuration}s 偏差较大`);
    }
    const omniQaStatus = omniResults.qa?.status || (missing.length ? "skipped" : "missing");
    const omniSummary = omniResults.summary || {};
    if (omniWorkerError) {
      warnings.push(`Omni QA 执行异常：${omniWorkerError}`);
    }
    for (const warning of omniResults.qa?.warnings || []) {
      warnings.push(`omni: ${warning}`);
    }
    const resolvedWarnings = [];
    const activeWarnings =
      omniQaStatus === "ok"
        ? warnings.filter((warning) => {
            if (isChildVisualReviewWarning(warning)) {
              resolvedWarnings.push(warning);
              return false;
            }
            return true;
          })
        : warnings;
    const omniCheckStatus =
      omniQaStatus === "ok"
        ? "pass"
        : omniQaStatus === "manual_review"
          ? "manual_review"
          : missing.length
            ? "block"
            : "block";
    const checks = [
      {
        id: "artifact",
        label: "关键产物完整",
        status: missing.length ? "block" : "pass",
        detail: missing.length ? `缺少：${missing.join(", ")}` : "关键产物均已落盘"
      },
      {
        id: "voice_caption",
        label: "声音和字幕同源",
        status: "pass",
        detail: "caption_plan 文本来自 voice_script/audio_sections，不使用 ASR 改写"
      },
      {
        id: "timeline",
        label: "素材覆盖音频主轴",
        status: activeWarnings.length ? "manual_review" : "pass",
        detail: activeWarnings.length ? activeWarnings.slice(0, 3).join("；") : "时间线已生成无字幕预览"
      },
      {
        id: "duration",
        label: "目标时长匹配",
        status: durationStatus,
        detail: voiceDuration ? `当前 ${voiceDuration}s，目标 ${targetDuration}s` : "未读取到音频时长"
      },
      {
        id: "render",
        label: "字幕烧录成片",
        status: existsSync(path.join(task.task_dir, "hyperframes_subtitle_burn", "final_subtitled.mp4")) ? "pass" : "block",
        detail: "HyperFrames lint / inspect / render 已执行"
      },
      {
        id: "omni_alignment",
        label: "Omni 音画字幕对齐",
        status: omniCheckStatus,
        detail:
          omniQaStatus === "ok"
            ? `最终成片 ${omniSummary.pass_count || 0}/${omniSummary.section_count || 0} 段通过`
            : missing.length
              ? "关键产物缺失，未执行 Omni QA"
              : `Omni QA 状态：${omniQaStatus}`
      },
      {
        id: "human_spot",
        label: "人工抽检",
        status: "manual_review",
        detail: "批量生产前仍需人工看首尾和字幕遮挡"
      }
    ];
    const status = checks.some((check) => check.status === "block") ? "block" : "manual_review";
    const payload = {
      schema_version: "1.0.0",
      stage: "voah_qa_gate",
      pipeline_version: PIPELINE_VERSION,
      created_at: nowIso(),
      task_dir: task.task_dir,
      status,
      checks,
      summary: status === "block" ? "存在阻塞问题，不能进入成品库。" : "真实生产闭环已跑完，建议人工抽检后发布。",
      inputs: {
        task_dir: task.task_dir,
        omni_alignment_results: omniResultsPath
      },
      outputs: {
        qa_gate_report: outputPath,
        next_artifact: path.join(task.task_dir, "export_record.json")
      },
      qa: {
        status: status === "block" ? "block" : "warning",
        warnings: activeWarnings,
        resolved_warnings: resolvedWarnings,
        omni_alignment_final: {
          status: omniQaStatus,
          results: omniResultsPath,
          summary: omniSummary
        }
      },
      next_consumers: ["voah-export-record"]
    };
    await writeJson(outputPath, payload);
    return { path: outputPath, payload };
  }

  async writeDesktopQualityReport({ task, jobId, qaGatePayload }) {
    const outputPath = path.join(task.task_dir, "desktop_quality_report.json");
    const markdownPath = path.join(task.task_dir, "desktop_quality_report.md");
    try {
      await this.runCommand({
        task,
        jobId,
        command: "python3",
        args: [
          path.join(this.storeService.workspaceRoot, "scripts", "voah_build_desktop_quality_report.py"),
          "--task-dir",
          task.task_dir,
          "--output",
          outputPath,
          "--markdown-output",
          markdownPath
        ]
      });
      const report = existsSync(outputPath) ? await readJson(outputPath) : {};
      await this.storeService.mutate(async (draft) => {
        draft.quality_reports = [
          {
            id: compactId("quality"),
            task_id: task.id,
            status: report.qa?.status || "warning",
            summary: report.summary || {},
            checks: report.checks || [],
            report_path: outputPath,
            markdown_path: markdownPath,
            final_video: report.outputs?.final_video || path.join(task.task_dir, "hyperframes_subtitle_burn", "final_subtitled.mp4"),
            created_at: nowIso()
          },
          ...((draft.quality_reports || []).filter((item) => item.task_id !== task.id))
        ];
        return draft;
      });
      return report;
    } catch (error) {
      qaGatePayload.qa = qaGatePayload.qa || {};
      qaGatePayload.qa.warnings = [
        ...(qaGatePayload.qa.warnings || []),
        `desktop quality report failed: ${error.message || String(error)}`
      ];
      await writeJson(outputPath, {
        schema_version: "1.0.0",
        stage: "voah_desktop_quality_report",
        created_at: nowIso(),
        task_dir: task.task_dir,
        status: "failed",
        error: error.message || String(error),
        qa: {
          status: "warning",
          warnings: [`desktop quality report failed: ${error.message || String(error)}`]
        }
      });
      return null;
    }
  }

  async writeExportRecord({ task, product, jobId }) {
    const qaGatePath = path.join(task.task_dir, "qa_gate_report.json");
    const qaGate = existsSync(qaGatePath) ? await readJson(qaGatePath) : {};
    const qaBlocked = qaGate.status === "block" || qaGate.qa?.status === "block";
    await this.runCommand({
      task,
      jobId,
      command: "python3",
      args: [
        path.join(this.storeService.workspaceRoot, "scripts", "voah_write_full_pipeline_manifest.py"),
        "--task-dir",
        task.task_dir
      ]
    });
    const manifestPath = path.join(task.task_dir, "full_pipeline_manifest.json");
    const exportPath = path.join(task.task_dir, "export_record.json");
    const manifest = await readJson(manifestPath);
    const finalPath = path.join(task.task_dir, "hyperframes_subtitle_burn", "final_subtitled.mp4");
    const finalExists = existsSync(finalPath);
    const manifestBlocked = manifest.qa?.status === "block";
    const exportBlocked = qaBlocked || manifestBlocked || !finalExists;
    const payload = {
      schema_version: "1.0.0",
      stage: "voah_export_record",
      status: exportBlocked ? "blocked" : "ready_for_review",
      pipeline_version: PIPELINE_VERSION,
      created_at: nowIso(),
      product: productMeta(product),
      task: {
        id: task.id,
        title: task.title
      },
      inputs: {
        full_pipeline_manifest: manifestPath,
        qa_gate_report: path.join(task.task_dir, "qa_gate_report.json")
      },
      outputs: {
        final_subtitled: finalPath,
        preview_no_subtitles: path.join(task.task_dir, "preview_no_subtitles.mp4"),
        voice_wav: path.join(task.task_dir, "voice.wav"),
        full_pipeline_manifest: manifestPath,
        export_record: exportPath
      },
      summary: {
        final_exists: finalExists,
        final_duration_s: manifest.summaries?.final_duration_s || null
      },
      qa: {
        status: exportBlocked ? "block" : "warning",
        warnings: exportBlocked
          ? [
              ...(qaBlocked ? ["QA gate 阻断导出", ...(qaGate.qa?.warnings || [])] : []),
              ...(manifestBlocked ? ["full_pipeline_manifest 阻断导出", ...(manifest.qa?.warnings || [])] : []),
              ...(!finalExists ? ["最终成片不存在"] : [])
            ]
          : ["等待人工抽检确认"]
      },
      next_consumers: ["operator-review", "export-library"]
    };
    await writeJson(exportPath, payload);
    const qualityReport = await this.writeDesktopQualityReport({ task, jobId, qaGatePayload: payload });
    if (qualityReport) {
      payload.outputs.desktop_quality_report = path.join(task.task_dir, "desktop_quality_report.json");
      payload.outputs.desktop_quality_report_md = path.join(task.task_dir, "desktop_quality_report.md");
      await writeJson(exportPath, payload);
    }
    return { path: exportPath, payload };
  }

  async runCommand({ task, jobId, command, args, cwd, env, timeoutMs = 0 }) {
    const logPath = path.join(task.task_dir, "logs", `${jobId}.log`);
    const started = `$ ${command} ${args.join(" ")}\n\n`;
    await writeFile(logPath, started, { flag: "a" });
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let timeout = null;
      let forceKillTimeout = null;
      const child = spawn(command, args, {
        cwd: cwd || this.storeService.workspaceRoot,
        env: {
          ...process.env,
          ...(env || {})
        }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      if (timeoutMs) {
        timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 5000);
        }, timeoutMs);
      }
      child.on("error", async (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
        await writeFile(logPath, `\nprocess_error=${error.message || String(error)}\n`, { flag: "a" });
        reject(error);
      });
      child.on("close", async (code) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
        const output = [
          stdout ? `--- stdout ---\n${stdout}` : "",
          stderr ? `--- stderr ---\n${stderr}` : "",
          timedOut ? `\ntimeout_ms=${timeoutMs}\n` : "",
          `\nexit_code=${code}\n`
        ]
          .filter(Boolean)
          .join("\n");
        await writeFile(logPath, output, { flag: "a" });
        if (code === 0 && !timedOut) {
          resolve({ stdout, stderr });
        } else if (timedOut) {
          const tail = (stderr || stdout || "").split("\n").slice(-16).join("\n").trim();
          reject(new Error(`${command} 超时 ${Math.round(timeoutMs / 1000)}s${tail ? `：${tail}` : ""}`));
        } else {
          const tail = (stderr || stdout || "").split("\n").slice(-16).join("\n").trim();
          reject(new Error(`${command} 退出码 ${code}${tail ? `：${tail}` : ""}`));
        }
      });
    });
  }

  async buildModelEnv(moduleIds) {
    if (!this.modelKeyService) {
      return {};
    }
    return this.modelKeyService.buildEnv(moduleIds);
  }

  async assertRequiredModelKeys({ task }) {
    if (!this.modelKeyService) {
      return;
    }
    const missing = await this.modelKeyService.missingModules([
      "material_understanding",
      "copy_generation",
      "material_retrieval",
      "selection_planner",
      "tts_primary"
    ]);
    if (!missing.length) {
      return;
    }
    const names = missing.map((item) => `${item.module} / ${item.model}`).join("、");
    await this.storeService.mutate(async (draft) => {
      const current = draft.tasks.find((item) => item.id === task.id);
      current.status = "failed";
      current.current_stage = "settings";
      current.human_error = createHumanError({
        title: task.title,
        stageLabel: "设置",
        message: `模型 Key 未配置：${names}`
      });
      current.updated_at = nowIso();
      return draft;
    });
    throw new Error(`模型 Key 未配置：${names}`);
  }

  async retryFailedTask(taskId) {
    const store = await this.storeService.read();
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task || task.status !== "failed") {
      throw new Error("只有失败任务可以重试");
    }
    const failedJob = [...store.jobs].reverse().find((job) => job.task_id === taskId && job.status === "failed");
    await this.storeService.mutate(async (draft) => {
      const current = draft.tasks.find((item) => item.id === taskId);
      current.status = "queued";
      current.human_error = null;
      current.updated_at = nowIso();
      return draft;
    });
    return this.runTask(taskId, {
      retryOfJobId: failedJob?.id || null,
      dryRun: failedJob?.error_code === "dry_run_failure"
    });
  }
}
