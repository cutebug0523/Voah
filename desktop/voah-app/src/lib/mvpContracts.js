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
    description: "调用 MiniMax TTS，生成 voice.wav、tts_audio 和音频语义段。"
  },
  {
    id: "audio_sections",
    label: "切分口播语义段",
    artifactKind: "audio_sections",
    outputFile: "audio_sections.json",
    description: "根据口播语义和时长生成素材匹配主轴。"
  },
  {
    id: "timeline_selection",
    label: "生成选片计划",
    artifactKind: "timeline_selection",
    outputFile: "timeline_selection.json",
    description: "从候选素材里确定每段口播最终使用的片段。"
  },
  {
    id: "timeline_fill",
    label: "填充视频时间线",
    artifactKind: "timeline_fill",
    outputFile: "timeline_fill.json",
    description: "按选片计划裁切或拼接素材生成无字幕预览。"
  },
  {
    id: "caption_plan",
    label: "生成字幕计划",
    artifactKind: "caption_plan",
    outputFile: "caption_plan.json",
    description: "字幕文本来自口播原文断句。"
  },
  {
    id: "subtitle_burn",
    label: "烧录字幕成片",
    artifactKind: "subtitle_burn",
    outputFile: "hyperframes_subtitle_burn/hyperframes_subtitle_burn_manifest.json",
    description: "创建 HyperFrames 字幕工程并渲染 final_subtitled.mp4。"
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
    id: "product_huaxizi_qidian",
    name: "花西子气垫",
    brand: "花西子",
    slug: "huaxizi-qidian",
    source_folder: "cache/voah_video_intake/huaxizi-qidian",
    status: "ready",
    material_status: "可生产",
    claim_summary: "轻薄服帖、自然柔焦、遇水稳定、礼盒陈列",
    selling_points: "轻薄服帖、自然柔焦、遇水稳定、礼盒陈列、通勤快速补妆",
    compliance_notes: "不承诺医学防晒或绝对不脱妆，不夸大遮瑕效果",
    cta_notes: "礼盒、活动价、限时福利放在卖点和证明之后",
    latest_intake_run: "20260607_013444_selected6_scene_candidates_v1",
    updated_at: "2026-06-07T03:12:00+08:00"
  },
  {
    id: "product_fangshai_qidian",
    name: "防晒气垫",
    slug: "fangshai-qidian",
    source_folder: "cache/voah_video_intake/fangshai-qidian",
    status: "ready",
    material_status: "可生产",
    claim_summary: "自然气色、防晒持妆、防水防汗、通勤补妆",
    selling_points: "自然气色、防晒持妆、防水防汗、通勤补妆、一盒少带东西",
    compliance_notes: "不写百分百防水、防汗一整天、不承诺医疗或绝对化功效",
    cta_notes: "活动价、补妆场景、防晒气垫一盒搞定放在后段",
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
    selling_points: "待整理",
    compliance_notes: "待整理",
    cta_notes: "待整理",
    latest_intake_run: null,
    updated_at: "2026-06-01T10:00:00+08:00"
  }
];

export const TTS_VOICE_OPTIONS = [
  {
    id: "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
    label: "带货女声基线",
    provider: "minimax-official"
  },
  {
    id: "Chinese (Mandarin)_Warm_Bestie",
    label: "Warm Bestie",
    provider: "minimax-official"
  },
  {
    id: "Chinese (Mandarin)_Warm_Girl",
    label: "Warm Girl",
    provider: "minimax-official"
  },
  {
    id: "Chinese (Mandarin)_Sweet_Lady",
    label: "Sweet Lady",
    provider: "minimax-official"
  },
  {
    id: "Chinese (Mandarin)_Crisp_Girl",
    label: "Crisp Girl",
    provider: "minimax-official"
  }
];

export const SUBTITLE_PRESETS = [
  {
    id: "songti_white_gold_lower",
    label: "宋体白金下方"
  },
  {
    id: "live_bar_lower",
    label: "直播条下方"
  }
];

export const DEFAULT_SETTINGS = {
  workspace_root: "/Users/noah/混剪",
  copy: {
    default_style: "轻快、口语、种草感，但不过度承诺",
    default_audience: "夏天出门需要补妆、补防晒、想少带东西的人",
    default_offer: "今日活动价",
    forbidden_terms: "不夸大功效，不承诺医疗效果",
    cta_policy: "先完成产品介绍、卖点和证明，再给活动与购买动作"
  },
  tts: {
    provider: "minimax-official",
    model: "speech-2.8-hd",
    voice_id: "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
    voice_label: "带货女声基线",
    speed: 1.1,
    vol: 1,
    pitch: 0,
    emotion: "happy",
    voice_modify: {
      pitch: 20,
      intensity: 20,
      timbre: 0
    },
    subtitle_enable: true,
    subtitle_type: "sentence",
    output_format: "url"
  },
  subtitle: {
    preset: "songti_white_gold_lower",
    preset_label: "宋体白金下方",
    font_source: "/System/Library/Fonts/Supplemental/Songti.ttc",
    split_punctuation: true
  },
  tts_voice_preset: "MiniMax 女声 happy / speed 1.1",
  subtitle_preset: "方案 1：底部白字关键词高亮",
  provider_status: "已配置本机私有 key，不在应用中显示明文"
};

export function mergeVoahSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    copy: {
      ...DEFAULT_SETTINGS.copy,
      ...(settings.copy || {})
    },
    tts: {
      ...DEFAULT_SETTINGS.tts,
      ...(settings.tts || {}),
      voice_modify: {
        ...DEFAULT_SETTINGS.tts.voice_modify,
        ...(settings.tts?.voice_modify || {})
      }
    },
    subtitle: {
      ...DEFAULT_SETTINGS.subtitle,
      ...(settings.subtitle || {})
    }
  };
}

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
