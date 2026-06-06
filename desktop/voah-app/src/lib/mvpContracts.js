export const TASK_STATUSES = [
  "draft",
  "queued",
  "running",
  "awaiting_review",
  "qa_warning",
  "completed",
  "failed"
];

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "warning",
  "failed",
  "stale"
];

export const RECIPE_STAGES = [
  {
    id: "task_brief",
    label: "整理任务 brief",
    artifactKind: "task_brief",
    outputFile: "task_brief.json",
    description: "把平台、时长、卖点、活动和禁忌整理成任务输入。"
  },
  {
    id: "copy_brief",
    label: "生成销售逻辑",
    artifactKind: "copy_brief",
    outputFile: "copy_brief.json",
    description: "生成开头、卖点顺序、证明方式和 CTA。"
  },
  {
    id: "voice_script",
    label: "生成连续口播",
    artifactKind: "voice_script",
    outputFile: "voice_script.json",
    description: "生成可直接 TTS 的连续口播稿。"
  },
  {
    id: "tts_audio",
    label: "生成语音主轴",
    artifactKind: "tts_audio",
    outputFile: "tts_audio.json",
    description: "记录 TTS 参数和音频时长，MVP 使用 dry-run。"
  },
  {
    id: "audio_sections",
    label: "切分口播语义段",
    artifactKind: "audio_sections",
    outputFile: "audio_sections.json",
    description: "根据口播语义和时长生成素材匹配主轴。"
  },
  {
    id: "timeline_fill",
    label: "匹配视频素材",
    artifactKind: "timeline_fill",
    outputFile: "timeline_fill.json",
    description: "按每段口播语义生成素材填充计划。"
  },
  {
    id: "caption_plan",
    label: "生成字幕计划",
    artifactKind: "caption_plan",
    outputFile: "caption_plan.json",
    description: "字幕文本来自口播原文断句。"
  },
  {
    id: "qa_gate",
    label: "执行 QA Gate",
    artifactKind: "qa_gate_report",
    outputFile: "qa_gate_report.json",
    description: "产出 pass / manual_review / block。"
  },
  {
    id: "export_record",
    label: "登记成品",
    artifactKind: "export_record",
    outputFile: "export_record.json",
    description: "登记导出记录和最终来源链。"
  }
];

export const DEFAULT_PRODUCTS = [
  {
    id: "product_fangshai_qidian",
    name: "防晒气垫",
    slug: "fangshai-qidian",
    source_folder: "cache/voah_video_intake/fangshai-qidian",
    status: "ready",
    material_status: "可生产",
    claim_summary: "自然气色、防晒持妆、防水防汗、通勤补妆",
    latest_intake_run: "20260603_225800_merged5_scene_candidates_v1",
    updated_at: "2026-06-05T20:55:59+08:00"
  },
  {
    id: "product_lipstick",
    name: "口红",
    slug: "kouhong",
    source_folder: "口红/口红",
    status: "needs_intake",
    material_status: "需处理素材",
    claim_summary: "待整理",
    latest_intake_run: null,
    updated_at: "2026-06-01T10:00:00+08:00"
  }
];

export const DEFAULT_SETTINGS = {
  workspace_root: "/Users/noah/混剪",
  tts_voice_preset: "MiniMax 女声 happy / speed 1.1",
  subtitle_preset: "方案 1：底部白字关键词高亮",
  provider_status: "已配置本机私有 key，不在应用中显示明文"
};

export function createTaskTitle(product, brief) {
  const platform = brief.target_platform || "抖音";
  const duration = Number(brief.target_duration_s || 45);
  return `${product.name} ${duration} 秒${platform}投放版`;
}

export function createHumanError({ title, stageLabel, message }) {
  return {
    task: title,
    failed_step: stageLabel,
    reason: message,
    impact: "当前步骤没有完成，下游产物已暂停生成。",
    suggested_action: "重试失败步骤"
  };
}
