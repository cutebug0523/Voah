// 阶段与状态的展示元数据，渲染层共用。

export const STAGE_ORDER = ["copy", "tts", "retrieve", "subtitle", "render", "qa"];

export const STAGE_LABELS = {
  copy: "文案",
  tts: "配音",
  retrieve: "召回",
  subtitle: "字幕",
  render: "渲染",
  qa: "QA"
};

// 阶段条颜色
export const SEG_COLOR = {
  succeeded: "bg-ok",
  running: "bg-run animate-pulse",
  failed: "bg-err",
  needs_review: "bg-warn",
  stale: "bg-slate-300",
  pending: "bg-slate-200",
  skipped: "bg-slate-200"
};

// 任务级状态展示
export const TASK_STATUS = {
  succeeded: { label: "完成", color: "text-ok", icon: "fa-check-circle" },
  running: { label: "运行中", color: "text-run", icon: "fa-spinner fa-spin" },
  needs_review: { label: "待审", color: "text-warn", icon: "fa-exclamation-circle" },
  failed: { label: "失败", color: "text-err", icon: "fa-times-circle" },
  queued: { label: "排队", color: "text-ink-400", icon: "fa-clock-o" },
  stale: { label: "待重跑", color: "text-ink-400", icon: "fa-refresh" }
};

export function taskStatusMeta(status) {
  return TASK_STATUS[status] || TASK_STATUS.queued;
}

export const DURATION_PRESETS = [15, 45];
