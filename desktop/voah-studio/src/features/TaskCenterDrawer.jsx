import { useStore } from "../hooks/useStore.js";

export function TaskCenterDrawer({ open, onClose }) {
  const taskCenter = useStore((s) => s.taskCenter);
  const refresh = useStore((s) => s.refresh);
  const acknowledgeTask = useStore((s) => s.acknowledgeTask);
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
          <TaskSection title="正在运行" empty="暂无运行任务" items={running} />
          <TaskSection title="需要处理" empty="暂无待处理任务" items={needsAttention} onAcknowledge={acknowledgeTask} />
          <TaskSection title="最近完成" empty="暂无成片" items={recentOutputs} compact />
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

function TaskSection({ title, empty, items, compact = false, onAcknowledge = null }) {
  return (
    <section>
      <div className="text-xs font-semibold text-ink-700 mb-2">{title}</div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-ink-400">{empty}</div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <TaskRow key={item.id} item={item} compact={compact} onAcknowledge={onAcknowledge} />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskRow({ item, compact, onAcknowledge }) {
  const meta = statusMeta(item.status);
  const percent = Number(item.progress?.percent || 0);
  const canAcknowledge = Boolean(onAcknowledge && ["failed", "stalled"].includes(item.status));
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
            {item.elapsed_s ? ` · ${formatElapsed(item.elapsed_s)}` : ""}
          </div>
        </div>
        <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
      </div>

      {!compact && item.status !== "failed" && (
        <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div className="h-full bg-brand-500" style={{ width: `${Math.max(4, Math.min(100, percent || 12))}%` }} />
        </div>
      )}

      {item.error && <div className="mt-2 text-[11px] text-err line-clamp-2">{item.error}</div>}

      <div className="mt-2 flex justify-end gap-3 text-xs">
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
