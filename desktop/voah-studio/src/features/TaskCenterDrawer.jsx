import { useState } from "react";
import { useStore } from "../hooks/useStore.js";

export function TaskCenterDrawer({ open, onClose }) {
  const taskCenter = useStore((s) => s.taskCenter);
  const nowMs = useStore((s) => s.nowMs);
  const refresh = useStore((s) => s.refresh);
  const acknowledgeTask = useStore((s) => s.acknowledgeTask);
  const continueIntakeTask = useStore((s) => s.continueIntakeTask);
  const continueTask = useStore((s) => s.continueTask);
  const summary = taskCenter?.summary || {};
  const running = taskCenter?.running || [];
  const needsAttention = taskCenter?.needs_attention || [];
  const recentOutputs = taskCenter?.recent_outputs || [];

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />}
      <div
        className={`fixed inset-y-0 right-0 w-[460px] max-w-[92vw] bg-white shadow-2xl border-l border-slate-200 z-50 flex flex-col transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="h-14 px-5 flex items-center justify-between border-b border-slate-100">
          <h2 className="font-semibold text-[15px]">任务中心</h2>
          <div className="flex items-center gap-3">
            <button onClick={refresh} className="text-ink-400 hover:text-ink-700" title="刷新">
              <i className="fa fa-refresh" />
            </button>
            <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
              <i className="fa fa-times" />
            </button>
          </div>
        </div>

        <div className="p-5 border-b border-slate-100">
          <div className="grid grid-cols-4 gap-2">
            <Metric value={`${summary.succeeded || 0}/${summary.target || 150}`} label="今日" />
            <Metric value={summary.running || 0} label="运行" color="text-run" />
            <Metric value={summary.needs_review || 0} label="待审" color="text-warn" />
            <Metric value={summary.failed || 0} label="失败" color="text-err" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <TaskSection title="正在运行" empty="暂无运行任务" items={running} nowMs={nowMs} />
          <TaskSection
            title="需要处理"
            empty="暂无待处理任务"
            items={needsAttention}
            nowMs={nowMs}
            onAcknowledge={acknowledgeTask}
            onContinueIntake={continueIntakeTask}
            onContinueTask={continueTask}
          />
          <TaskSection title="最近完成" empty="暂无成片" items={recentOutputs} compact nowMs={nowMs} />
        </div>
      </div>
    </>
  );
}

function Metric({ value, label, color = "text-ink-900" }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <div className={`font-bold text-lg leading-none ${color}`}>{value}</div>
      <div className="text-[11px] text-ink-400 mt-1">{label}</div>
    </div>
  );
}

function TaskSection({ title, empty, items, compact = false, nowMs, onAcknowledge = null, onContinueIntake = null, onContinueTask = null }) {
  return (
    <section>
      <div className="text-xs font-semibold text-ink-700 mb-2">{title}</div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-ink-400">{empty}</div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <TaskRow
              key={item.id}
              item={item}
              compact={compact}
              nowMs={nowMs}
              onAcknowledge={onAcknowledge}
              onContinueIntake={onContinueIntake}
              onContinueTask={onContinueTask}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskRow({ item, compact, nowMs, onAcknowledge, onContinueIntake, onContinueTask }) {
  const meta = statusMeta(item.status);
  const elapsed = displayElapsed(item, nowMs);
  const [busy, setBusy] = useState("");
  const canAcknowledge = Boolean(onAcknowledge && ["failed", "stalled"].includes(item.status));
  const canContinue = Boolean(onContinueIntake && item.kind === "intake" && ["failed", "stalled"].includes(item.status));
  const canContinueVideo = Boolean(onContinueTask && item.kind === "video" && item.can_continue);
  async function runContinue() {
    if (!onContinueIntake || busy) return;
    setBusy("continue");
    try {
      await onContinueIntake(item);
    } finally {
      setBusy("");
    }
  }
  async function runContinueVideo() {
    if (!onContinueTask || busy) return;
    setBusy("continue");
    try {
      await onContinueTask(item.target_path, item.run_id, item.failed_stage || item.current_stage);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-ink-400 shrink-0">{item.kind_label}</span>
            <span className="font-medium truncate">{item.title || item.product_name || "任务"}</span>
          </div>
          <div className="mt-1 text-[11px] text-ink-400 truncate">
            {item.stage_label || meta.label}
            {elapsed ? ` · ${formatElapsed(elapsed)}` : ""}
          </div>
        </div>
        <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
      </div>

      {!compact && item.status !== "failed" && (
        <SegmentedProgress item={item} />
      )}

      {item.error && <div className="mt-2 text-[11px] text-err line-clamp-2">{item.error}</div>}

      <div className="mt-2 flex justify-end gap-3 text-xs">
        {canContinue && (
          <button onClick={runContinue} disabled={Boolean(busy)} className="text-brand-600 hover:underline disabled:opacity-50">
            {busy === "continue" ? "启动中" : "继续"}
          </button>
        )}
        {canContinueVideo && (
          <button onClick={runContinueVideo} disabled={Boolean(busy)} className="text-brand-600 hover:underline disabled:opacity-50">
            {busy === "continue" ? "启动中" : "继续"}
          </button>
        )}
        {canAcknowledge && (
          <button onClick={() => onAcknowledge(item)} className="text-ink-500 hover:text-ink-800 hover:underline">
            已读
          </button>
        )}
        {item.final_video && (
          <button onClick={() => window.voah?.openFile(item.final_video)} className="text-brand-600 hover:underline">
            播放
          </button>
        )}
        {item.target_path && (
          <button onClick={() => window.voah?.reveal(item.target_path)} className="text-brand-600 hover:underline">
            目录
          </button>
        )}
      </div>
    </div>
  );
}

const INTAKE_STAGES = [
  { id: "queued", label: "排队" },
  { id: "scan", label: "扫描" },
  { id: "run_intake", label: "理解" },
  { id: "trim_upload", label: "裁切" },
  { id: "refine_child_vlm", label: "校准" },
  { id: "vectorize", label: "向量" },
  { id: "build_shot_index", label: "索引" },
  { id: "merge_index", label: "合并" },
  { id: "done", label: "完成" }
];

function SegmentedProgress({ item }) {
  const stages = item.kind === "intake" ? INTAKE_STAGES : null;
  if (!stages) return <PlainProgress percent={item.progress?.percent} />;
  const current = item.current_stage || (item.status === "succeeded" ? "done" : "queued");
  const foundIndex = stages.findIndex((stage) => stage.id === current);
  const currentIndex = foundIndex >= 0 ? foundIndex : 0;
  const stagePercent = current === "done" ? 100 : Math.max(0, Math.min(100, Number(item.progress?.percent || 0)));

  return (
    <div className="mt-3">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-100">
        {stages.map((stage, index) => {
          const fill = index < currentIndex ? 100 : index === currentIndex ? Math.max(10, stagePercent || 18) : 0;
          return (
            <div key={stage.id} className="h-full flex-1 bg-slate-100 border-r border-white last:border-r-0">
              <div className="h-full bg-brand-500" style={{ width: `${fill}%` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlainProgress({ percent }) {
  const value = Math.max(4, Math.min(100, Number(percent || 12)));
  return (
    <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
      <div className="h-full bg-brand-500" style={{ width: `${value}%` }} />
    </div>
  );
}

function statusMeta(status) {
  return (
    {
      ready: { label: "完成", cls: "text-ok bg-ok/5 border-ok/20" },
      succeeded: { label: "完成", cls: "text-ok bg-ok/5 border-ok/20" },
      completed: { label: "完成", cls: "text-ok bg-ok/5 border-ok/20" },
      running: { label: "运行中", cls: "text-run bg-run/5 border-run/20" },
      queued: { label: "排队", cls: "text-ink-500 bg-slate-50 border-slate-200" },
      needs_review: { label: "待审", cls: "text-warn bg-warn/5 border-warn/20" },
      stalled: { label: "需查看", cls: "text-warn bg-warn/5 border-warn/20" },
      failed: { label: "失败", cls: "text-err bg-err/5 border-err/20" }
    }[status] || { label: "处理中", cls: "text-run bg-run/5 border-run/20" }
  );
}

function formatElapsed(seconds) {
  const value = Number(seconds || 0);
  if (value < 60) return `${value}秒`;
  const min = Math.floor(value / 60);
  const sec = value % 60;
  if (min < 60) return sec ? `${min}分${sec}秒` : `${min}分`;
  const hour = Math.floor(min / 60);
  return `${hour}小时${min % 60}分`;
}

function displayElapsed(item, nowMs) {
  const base = Number(item.elapsed_s || 0);
  if (!["running", "stalled"].includes(item.status) || !item.started_at) return base;
  const startMs = Date.parse(normalizeDate(item.started_at));
  if (!Number.isFinite(startMs)) return base;
  return Math.max(base, Math.round(((nowMs || Date.now()) - startMs) / 1000));
}

function normalizeDate(value) {
  const text = String(value || "");
  if (/[+-]\d{4}$/.test(text)) return `${text.slice(0, -5)}${text.slice(-5, -2)}:${text.slice(-2)}`;
  return text;
}
