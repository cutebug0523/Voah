import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createHumanError,
  createTaskTitle,
  RECIPE_STAGES
} from "../../src/lib/mvpContracts.js";

const PIPELINE_VERSION = "voah-desktop-real-recipe.v1";

function nowIso() {
  return new Date().toISOString();
}

function compactId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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
  return status === "ok" || status === "pass" ? "succeeded" : "warning";
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

function productMeta(product) {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand || "花西子",
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

function buildDefaultScriptSections(brief) {
  const offer = brief.offer || "直播间福利";
  return [
    {
      section_id: "opening_pain",
      role: "opening",
      rough_duration_s: 5,
      intention_copy: "夏天出门底妆和防晒都要补，补妆不能越补越厚。",
      required_meaning: "建立痛点：晒、补妆、补防晒、底妆厚重。",
      required_visual: "户外、脸部妆效、补妆动作或产品开场，画面要有吸引力。",
      avoid: ["不要一上来讲活动优惠", "不要用和产品无关的纯促销画面"],
      keywords: ["夏天", "补妆", "防晒", "底妆"]
    },
    {
      section_id: "product_positioning",
      role: "product",
      rough_duration_s: 6,
      intention_copy: "花西子防晒气垫作为随身底妆，开盖蘸粉轻拍上脸。",
      required_meaning: "明确产品身份和使用动作。",
      required_visual: "产品盒、开盖、蘸粉、粉扑按压脸颊、手背试色。",
      avoid: ["不要只出现人物口播不见产品", "不要混入其他单品"],
      keywords: ["花西子", "防晒气垫", "开盖", "轻拍"]
    },
    {
      section_id: "finish_effect",
      role: "product",
      rough_duration_s: 6,
      intention_copy: "泛红暗沉被压下去，妆效是自然柔焦的干净感。",
      required_meaning: "呈现即时妆效和自然感。",
      required_visual: "上妆前后、泛红遮盖、面部特写、柔焦肤质。",
      avoid: ["不要写磨皮级绝对效果", "不要把局部修饰当成主卖点"],
      keywords: ["泛红", "暗沉", "柔焦", "干净"]
    },
    {
      section_id: "multi_function",
      role: "product",
      rough_duration_s: 6,
      intention_copy: "一盒覆盖底妆、定妆、补妆和防晒，减少包里东西。",
      required_meaning: "四效合一，随身轻负担。",
      required_visual: "产品堆叠、包内携带、补妆动作、四效合一提示画面。",
      avoid: ["不要把四效合一说成替代所有护肤防晒", "不要提前 CTA"],
      keywords: ["四效合一", "底妆", "定妆", "补妆", "防晒"]
    },
    {
      section_id: "spf_proof",
      role: "proof",
      rough_duration_s: 7,
      intention_copy: "SPF50+ PA+++，用紫外线测试卡做可视化证明。",
      required_meaning: "防晒力要有画面证据，而不是只口头说参数。",
      required_visual: "SPF/PA 标签、紫外线感应卡、测试卡变色。",
      avoid: ["不要夸大成晒不黑", "不要没有测试画面却讲测试"],
      keywords: ["SPF50+", "PA+++", "紫外线", "测试卡"]
    },
    {
      section_id: "waterproof_scene",
      role: "proof",
      rough_duration_s: 8,
      intention_copy: "出汗、遇水、海边场景下，妆面仍然挂得住。",
      required_meaning: "证明持妆、防水防汗和户外场景适配。",
      required_visual: "泼水、纸巾轻按、海边湿发、户外运动后妆面。",
      avoid: ["不要说绝对不脱", "不要只用室内静态产品图"],
      keywords: ["防水", "防汗", "海边", "持妆"]
    },
    {
      section_id: "daily_scenarios",
      role: "proof",
      rough_duration_s: 6,
      intention_copy: "赶时间上班、出去玩、车里临时补一下，都能快速拉回气色。",
      required_meaning: "把产品落到真实使用场景。",
      required_visual: "通勤、车内补妆、户外阳光、快速上妆对比。",
      avoid: ["不要重复前面测试卡画面", "不要进入礼盒促销"],
      keywords: ["上班", "出去玩", "车里", "气色"]
    },
    {
      section_id: "cta_bundle",
      role: "cta",
      rough_duration_s: 7,
      intention_copy: `${offer} 入手看礼盒和赠品，进直播间看福利。`,
      required_meaning: "收束到购买理由和行动，不生硬打断前面的证明链。",
      required_visual: "礼盒、赠品、明星周边、买赠图标、直播福利画面。",
      avoid: ["不要虚构价格", "不要说库存和赠品必然有，除非素材明确"],
      keywords: uniqueStrings(["618", "礼盒", "赠品", "直播间", offer])
    }
  ];
}

function pronounceText(text) {
  return String(text || "")
    .replaceAll("SPF50+", "SPF五十加")
    .replaceAll("PA+++", "PA三个加")
    .replaceAll("618", "六一八");
}

function buildVoiceScriptFromSections(copyBrief) {
  const lineBySection = {
    opening_pain: "夏天出门最麻烦的，不是只补妆，是补完妆还要记得补防晒，越拍越厚还容易斑驳。",
    product_positioning: "这盒花西子防晒气垫，我会当随身底妆用。开盖蘸粉，粉扑轻轻拍开，早上出门和外面临时补都方便。",
    finish_effect: "上脸不是闷白厚粉感，泛红暗沉会先被压下去，妆面是柔焦的干净感，近看也不会显得很重。",
    multi_function: "它把底妆、定妆、补妆和防晒放在一盒里，包里不用再塞好几样，通勤和出去玩都省事。",
    spf_proof: "防晒别只听参数，SPF50+、PA+++ 是基础，配合紫外线测试卡看，画面里能看到变化。",
    waterproof_scene: "夏天出汗、遇水、去海边，最怕妆一下就花。泼水和纸巾轻按之后，妆面还能挂住。",
    daily_scenarios: "上班前、下午脸色暗了，或者车里临时补一下，它都能比较快把气色拉回来，也不容易打掉防晒感。",
    cta_bundle: "618 想入的话，建议看礼盒和赠品。想少带几样，又想妆面干净有防晒感，进直播间看这波福利。"
  };
  const scriptSections = (copyBrief.script_sections || []).map((section) => {
    const voiceText = lineBySection[section.section_id] || section.intention_copy;
    return {
      ...section,
      voice_text: voiceText,
      tts_text: pronounceText(voiceText)
    };
  });
  const fullVoiceText = scriptSections.map((section) => section.voice_text).join("");
  const fullTtsText = scriptSections.map((section) => section.tts_text).join("");
  return {
    scriptSections,
    fullVoiceText,
    fullTtsText
  };
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

    await this.storeService.mutate(async (draft) => {
      for (let index = 0; index < safeCount; index += 1) {
        const taskId = compactId("task");
        const title = `${createTaskTitle(product, brief)} #${index + 1}`;
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
          brief,
          pipeline_mode: "real",
          created_at: nowIso(),
          updated_at: nowIso()
        };
        draft.tasks.push(task);
        createdTasks.push(task);
      }
      return draft;
    });

    return createdTasks;
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

    store = await this.storeService.mutate(async (draft) => {
      const current = draft.tasks.find((item) => item.id === taskId);
      current.status = "qa_warning";
      current.current_stage = "qa_gate";
      current.updated_at = nowIso();
      return draft;
    });

    return {
      status: "qa_warning",
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

    store = await this.storeService.mutate(async (draft) => {
      const current = draft.tasks.find((item) => item.id === taskId);
      current.status = "qa_warning";
      current.current_stage = "qa_gate";
      current.updated_at = nowIso();
      return draft;
    });

    return {
      status: "qa_warning",
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
      copy_brief: () => this.writeCopyBrief({ task, product }),
      voice_script: () => this.writeVoiceScript({ task, product }),
      tts_audio: () => this.runTts({ task, product, jobId }),
      audio_sections: () => this.registerExistingJson({ task, stage, fileName: "audio_sections.json" }),
      timeline_selection: () => this.runRetrievalAndSelection({ task, product, jobId }),
      timeline_fill: () => this.runRetrievalAndFill({ task, stage }),
      caption_plan: () => this.runCaptionPlan({ task, jobId }),
      subtitle_burn: () => this.runSubtitleBurn({ task, jobId }),
      qa_gate: () => this.writeQaGate({ task }),
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
        style: task.brief.style || "轻快、口语、种草感，但不过度承诺",
        audience: task.brief.audience || "夏天出门需要补妆、补防晒、想少带东西的人",
        objective: "桌面端真实生产：先销售逻辑和连续口播，再 TTS，再按音频语义召回素材、烧字幕。"
      },
      inputs: {
        intake_run: intakeRun,
        shot_index: shotIndex,
        user_brief: task.brief
      },
      product_claims: splitClaims(product, task.brief),
      constraints: uniqueStrings([
        task.brief.forbidden,
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

  async writeCopyBrief({ task, product }) {
    const taskBriefPath = path.join(task.task_dir, "task_brief.json");
    const copyBriefPath = path.join(task.task_dir, "copy_brief.json");
    const taskBrief = await readJson(taskBriefPath);
    const sections = buildDefaultScriptSections(task.brief);
    const payload = {
      schema_version: "1.0.0",
      stage: "voah_copy_brief",
      pipeline_version: PIPELINE_VERSION,
      created_at: nowIso(),
      product: productMeta(product),
      target_platform: task.target_platform,
      target_duration_range_s: normalizeTargetRange(task.target_duration_s),
      inputs: {
        task_brief: taskBriefPath,
        intake_run: taskBrief.inputs.intake_run
      },
      sales_logic: {
        hook: "先抓夏天补妆和补防晒分离的痛点，不从促销开始。",
        positioning: "把防晒气垫定位成随身底妆，而不是普通粉底或单纯防晒。",
        proof_order: [
          "上脸妆效和轻拍便利性",
          "四效合一减少随身负担",
          "SPF50+ PA+++ 与紫外线卡可视化证明",
          "出汗遇水和海边场景下的持妆表现",
          `${task.brief.offer || "活动"} 与直播间 CTA`
        ],
        cta: "福利放在卖点和证明之后，强调礼盒/赠品比单买更值得看。"
      },
      product_claims: taskBrief.product_claims,
      script_sections: sections,
      outputs: {
        copy_brief: copyBriefPath,
        next_artifact: path.join(task.task_dir, "voice_script.json")
      },
      qa: {
        status: "ok",
        warnings: []
      },
      next_consumers: ["voah-copy-final"]
    };
    await writeJson(copyBriefPath, payload);
    return { path: copyBriefPath, payload };
  }

  async writeVoiceScript({ task, product }) {
    const copyBriefPath = path.join(task.task_dir, "copy_brief.json");
    const voiceScriptPath = path.join(task.task_dir, "voice_script.json");
    const copyBrief = await readJson(copyBriefPath);
    const { scriptSections, fullVoiceText, fullTtsText } = buildVoiceScriptFromSections(copyBrief);
    const payload = {
      schema_version: "1.0.0",
      stage: "voah_copy_final",
      pipeline_version: PIPELINE_VERSION,
      created_at: nowIso(),
      product: productMeta(product),
      target_duration_range_s: normalizeTargetRange(task.target_duration_s),
      inputs: {
        copy_brief: copyBriefPath
      },
      full_voice_text: fullVoiceText,
      pronounce_text: fullTtsText,
      subtitle_policy: "verbatim_voice_text_split",
      script_sections: scriptSections,
      script_stats: {
        voice_text_characters: fullVoiceText.length,
        pronounce_text_characters: fullTtsText.length,
        section_count: scriptSections.length
      },
      outputs: {
        voice_script: voiceScriptPath,
        next_artifact: path.join(task.task_dir, "voice.wav")
      },
      qa: {
        status: "ok",
        warnings: []
      },
      next_consumers: ["voah-tts"]
    };
    await writeJson(voiceScriptPath, payload);
    return { path: voiceScriptPath, payload };
  }

  async runTts({ task, product, jobId }) {
    const voiceScriptPath = path.join(task.task_dir, "voice_script.json");
    const env = await this.buildModelEnv(["tts_primary"]);
    await this.runCommand({
      task,
      jobId,
      command: "python3",
      args: [
        path.join(this.storeService.workspaceRoot, "scripts", "voah_run_oneshot_minimax_tts.py"),
        "--voice-script",
        voiceScriptPath,
        "--task-dir",
        task.task_dir,
        "--provider",
        "minimax-official",
        "--model",
        "speech-2.8-hd",
        "--voice-id",
        "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
        "--speed",
        "1.1",
        "--emotion",
        "happy",
        "--modify-pitch",
        "20",
        "--modify-intensity",
        "20",
        "--modify-timbre",
        "0",
        "--subtitle-enable",
        "--subtitle-type",
        "sentence"
      ],
      env
    });
    const ttsAudioPath = path.join(task.task_dir, "tts_audio.json");
    const payload = await readJson(ttsAudioPath);
    payload.product = payload.product?.name ? payload.product : productMeta(product);
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
        "3",
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
    await this.runCommand({
      task,
      jobId,
      command: "python3",
      args: [
        path.join(this.storeService.workspaceRoot, "scripts", "voah_build_caption_plan.py"),
        "--audio-sections",
        path.join(task.task_dir, "audio_sections.json"),
        "--task-dir",
        task.task_dir,
        "--preset",
        "songti_white_gold_lower",
        "--split-punctuation"
      ]
    });
    const captionPlanPath = path.join(task.task_dir, "caption_plan.json");
    const payload = await readJson(captionPlanPath);
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
      command: "npx",
      args: ["hyperframes", "lint", "."],
      cwd: projectDir
    });
    await this.runCommand({
      task,
      jobId,
      command: "npx",
      args: ["hyperframes", "inspect", ".", "--samples", "12", "--json", "--browser-timeout", "180"],
      cwd: projectDir,
      env: hyperframesTimeoutEnv
    });
    await this.renderHyperframesWithRetry({ task, jobId, projectDir });
    const manifestPath = path.join(projectDir, "hyperframes_subtitle_burn_manifest.json");
    const payload = await readJson(manifestPath);
    payload.outputs.final_subtitled = path.join(projectDir, "final_subtitled.mp4");
    payload.qa = {
      status: existsSync(payload.outputs.final_subtitled) ? "ok" : "warning",
      warnings: existsSync(payload.outputs.final_subtitled) ? [] : ["final_subtitled.mp4 missing after render"]
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
    const baseArgs = [
      "hyperframes",
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
        command: "npx",
        args: baseArgs,
        cwd: projectDir,
        env
      });
    } catch (error) {
      await writeFile(
        path.join(task.task_dir, "logs", `${jobId}.log`),
        `\n--- render retry ---\n${error.message}\n`,
        { flag: "a" }
      );
      await this.runCommand({
        task,
        jobId,
        command: "npx",
        args: [...baseArgs, "--no-browser-gpu", "--no-low-memory-mode"],
        cwd: projectDir,
        env: {
          ...env,
          PRODUCER_LOW_MEMORY_MODE: "false"
        }
      });
    }
  }

  async writeQaGate({ task }) {
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
        status: warnings.length ? "manual_review" : "pass",
        detail: warnings.length ? warnings.slice(0, 3).join("；") : "时间线已生成无字幕预览"
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
        task_dir: task.task_dir
      },
      outputs: {
        qa_gate_report: outputPath,
        next_artifact: path.join(task.task_dir, "export_record.json")
      },
      qa: {
        status: status === "block" ? "block" : "warning",
        warnings
      },
      next_consumers: ["voah-export-record"]
    };
    await writeJson(outputPath, payload);
    return { path: outputPath, payload };
  }

  async writeExportRecord({ task, product, jobId }) {
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
    const payload = {
      schema_version: "1.0.0",
      stage: "voah_export_record",
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
        final_exists: existsSync(finalPath),
        final_duration_s: manifest.summaries?.final_duration_s || null
      },
      qa: {
        status: existsSync(finalPath) ? "warning" : "block",
        warnings: existsSync(finalPath) ? ["等待人工抽检确认"] : ["最终成片不存在"]
      },
      next_consumers: ["operator-review", "export-library"]
    };
    await writeJson(exportPath, payload);
    return { path: exportPath, payload };
  }

  async runCommand({ task, jobId, command, args, cwd, env }) {
    const logPath = path.join(task.task_dir, "logs", `${jobId}.log`);
    const started = `$ ${command} ${args.join(" ")}\n\n`;
    await writeFile(logPath, started, { flag: "a" });
    return new Promise((resolve, reject) => {
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
      child.on("error", reject);
      child.on("close", async (code) => {
        const output = [
          stdout ? `--- stdout ---\n${stdout}` : "",
          stderr ? `--- stderr ---\n${stderr}` : "",
          `\nexit_code=${code}\n`
        ]
          .filter(Boolean)
          .join("\n");
        await writeFile(logPath, output, { flag: "a" });
        if (code === 0) {
          resolve({ stdout, stderr });
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
    const missing = await this.modelKeyService.missingModules(["material_retrieval", "selection_planner", "tts_primary"]);
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
