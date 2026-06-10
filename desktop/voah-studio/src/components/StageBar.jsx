import { STAGE_ORDER, STAGE_LABELS, SEG_COLOR } from "../lib/status.js";

// 5 段阶段条：文案/配音/召回/字幕/渲染/QA 的进度可视化。
export function StageBar({ segments }) {
  const byStage = Object.fromEntries((segments || []).map((s) => [s.stage, s.status]));
  return (
    <div className="flex-1 grid grid-cols-6 gap-1.5 max-w-md">
      {STAGE_ORDER.map((stage) => {
        const status = byStage[stage] || "pending";
        return (
          <div
            key={stage}
            className={`seg ${SEG_COLOR[status] || SEG_COLOR.pending}`}
            title={`${STAGE_LABELS[stage]} · ${status}`}
          />
        );
      })}
    </div>
  );
}
