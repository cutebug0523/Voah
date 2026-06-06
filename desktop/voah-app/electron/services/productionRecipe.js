import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createHumanError,
  createTaskTitle,
  RECIPE_STAGES
} from "../../src/lib/mvpContracts.js";

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

function buildStagePayload({ stage, task, product, brief, sourceArtifacts, qaStatus }) {
  const base = {
    schema_version: "1.0.0",
    stage: stage.id,
    created_at: nowIso(),
    product: {
      id: product.id,
      name: product.name,
      slug: product.slug
    },
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
    base.full_voice_text = `防晒气垫出门前一拍就有自然气色，SPF 防晒和持妆表现都在线，通勤补妆也不厚重，今天活动价很适合直接入。`;
    base.subtitle_policy = "verbatim_voice_text_split";
  }

  if (stage.id === "audio_sections") {
    base.sections = [
      {
        section_id: "hook",
        voice_text: "防晒气垫出门前一拍就有自然气色，",
        start_s: 0,
        end_s: 8,
        required_visual: "上脸自然气色"
      },
      {
        section_id: "proof",
        voice_text: "SPF 防晒和持妆表现都在线，",
        start_s: 8,
        end_s: 22,
        required_visual: "防晒指数或持妆证明"
      },
      {
        section_id: "cta",
        voice_text: "通勤补妆也不厚重，今天活动价很适合直接入。",
        start_s: 22,
        end_s: 45,
        required_visual: "通勤补妆和 CTA"
      }
    ];
  }

  if (stage.id === "qa_gate") {
    base.status = qaStatus === "ok" ? "pass" : "manual_review";
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
  constructor({ storeService }) {
    this.storeService = storeService;
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
          `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_${slugify(title)}_${taskId.slice(-6)}`
        );
        const task = {
          id: taskId,
          product_id: product.id,
          title,
          status: "queued",
          target_platform: brief.target_platform || "抖音",
          target_duration_s: Number(brief.target_duration_s || 45),
          current_stage: "queued",
          task_dir: taskDir,
          source_intake_run: product.latest_intake_run,
          brief,
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

    await this.storeService.mutate(async (draft) => {
      const current = draft.tasks.find((item) => item.id === taskId);
      current.status = "running";
      current.current_stage = "starting";
      current.updated_at = nowIso();
      return draft;
    });

    let sourceArtifacts = [];
    for (const stage of RECIPE_STAGES) {
      const jobId = compactId("job");
      const job = {
        id: jobId,
        task_id: task.id,
        stage: stage.id,
        stage_label: stage.label,
        status: "running",
        started_at: nowIso(),
        finished_at: null,
        retry_of_job_id: options.retryOfJobId || null,
        error_code: null,
        error_message: null,
        result_manifest_path: null
      };

      await this.storeService.mutate(async (draft) => {
        draft.jobs.push(job);
        const current = draft.tasks.find((item) => item.id === taskId);
        current.status = "running";
        current.current_stage = stage.id;
        current.updated_at = nowIso();
        return draft;
      });

      if (failStage === stage.id) {
        const humanError = createHumanError({
          title: task.title,
          stageLabel: stage.label,
          message: "MVP 验证用模拟失败"
        });
        await this.storeService.mutate(async (draft) => {
          const failedJob = draft.jobs.find((item) => item.id === jobId);
          failedJob.status = "failed";
          failedJob.finished_at = nowIso();
          failedJob.error_code = "dry_run_failure";
          failedJob.error_message = humanError.reason;
          const current = draft.tasks.find((item) => item.id === taskId);
          current.status = "failed";
          current.current_stage = stage.id;
          current.human_error = humanError;
          current.updated_at = nowIso();
          return draft;
        });
        return { status: "failed", failed_stage: stage.id };
      }

      const outputPath = path.join(task.task_dir, stage.outputFile);
      const qaStatus = stage.id === "qa_gate" ? "warning" : "ok";
      const payload = buildStagePayload({
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

      await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

      const artifact = {
        id: compactId("art"),
        task_id: task.id,
        job_id: jobId,
        kind: stage.artifactKind,
        path: outputPath,
        source_artifact_ids: sourceArtifacts.map((item) => item.id),
        qa_status: payload.qa.status,
        created_at: nowIso()
      };

      await this.storeService.mutate(async (draft) => {
        const storedJob = draft.jobs.find((item) => item.id === jobId);
        storedJob.status = qaStatus === "warning" ? "warning" : "succeeded";
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
    return this.runTask(taskId, { retryOfJobId: failedJob?.id || null });
  }
}
