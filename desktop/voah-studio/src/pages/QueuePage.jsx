import { useStore } from "../hooks/useStore.js";
import { StageBar } from "../components/StageBar.jsx";
import { StatusTag } from "../components/StatusTag.jsx";

export function QueuePage({ onOpenTask }) {
  const batches = useStore((s) => s.batches);
  const loading = useStore((s) => s.loading);
  const lastError = useStore((s) => s.lastError);

  if (lastError) {
    return <EmptyHint icon="fa-exclamation-triangle" title="读取失败" sub={lastError} />;
  }
  if (loading && batches.length === 0) {
    return <EmptyHint icon="fa-spinner fa-spin" title="加载中…" />;
  }
  if (batches.length === 0) {
    return <EmptyHint icon="fa-inbox" title="今天还没有批次" sub="点右上角“新建批量”开始出片。" />;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {batches.map((b) => (
        <BatchCard key={b.batch_dir} batch={b} onOpenTask={onOpenTask} />
      ))}
    </div>
  );
}

function BatchCard({ batch, onOpenTask }) {
  const retryTask = useStore((s) => s.retryTask);
  const done = batch.counts.succeeded;
  const pct = batch.total ? Math.round((done / batch.total) * 100) : 0;
  const allDone = batch.total > 0 && done === batch.total;

  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
      <div className="px-4 py-3 flex items-center justify-between border-b border-slate-100">
        <div className="flex items-center gap-3">
          <span className="font-semibold">{batch.product_name}</span>
          <span className="text-ink-400">·</span>
          <span className="text-ink-500">
            {batch.target_duration_s ? `${batch.target_duration_s}秒` : ""} {batch.label}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {allDone ? (
            <span className="text-xs text-ok font-medium">
              <i className="fa fa-check" /> 全部完成 {done}/{batch.total}
            </span>
          ) : (
            <>
              <span className="text-xs text-ink-500">
                <b className="text-ink-900">{done}</b>/{batch.total}
              </span>
              <div className="w-28 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full bg-brand-500" style={{ width: `${pct}%` }} />
              </div>
            </>
          )}
          <button
            onClick={() => window.voah?.reveal(batch.batch_dir)}
            className="px-2.5 py-1 rounded-md text-xs text-ink-700 hover:bg-slate-100 border border-slate-200"
          >
            <i className="fa fa-folder-open-o" /> 目录
          </button>
        </div>
      </div>

      <div className="divide-y divide-slate-50">
        {batch.tasks.map((t) => (
          <TaskRow
            key={t.task_dir || t.task_id}
            task={t}
            onRetry={() => retryTask(t.task_dir, t.failed_stage)}
            onOpen={() => onOpenTask?.(t.task_dir)}
          />
        ))}
      </div>
    </section>
  );
}

function TaskRow({ task, onRetry, onOpen }) {
  const idx = task.index != null ? String(task.index).padStart(2, "0") : task.task_id?.slice(-2);
  return (
    <div className="row-hover px-4 py-2.5 flex items-center gap-4 cursor-pointer" onClick={onOpen}>
      <span className="w-10 text-ink-400 text-xs font-mono">#{idx}</span>
      <StageBar segments={task.segments} />
      <span className="w-20 text-right">
        <StatusTag status={task.status} />
      </span>
      {task.status === "failed" ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className="w-16 text-xs px-2 py-1 rounded-md bg-err/10 text-err hover:bg-err/20 font-medium"
        >
          重试
        </button>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen?.();
          }}
          className="w-16 text-xs text-brand-600 hover:underline"
        >
          详情
        </button>
      )}
    </div>
  );
}

function EmptyHint({ icon, title, sub }) {
  return (
    <div className="flex-1 grid place-items-center text-center p-10">
      <div>
        <i className={`fa ${icon} text-4xl text-ink-300 mb-4`} />
        <div className="font-medium text-ink-700">{title}</div>
        {sub && <div className="text-xs text-ink-400 mt-1 max-w-xs">{sub}</div>}
      </div>
    </div>
  );
}
