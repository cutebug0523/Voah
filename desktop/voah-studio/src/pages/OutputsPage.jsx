import { useState } from "react";
import { EmptyHint } from "../components/EmptyHint.jsx";
import { StatusTag } from "../components/StatusTag.jsx";
import { useStore } from "../hooks/useStore.js";

const REVIEW = {
  pass: { label: "通过", cls: "bg-brand-600 hover:bg-brand-700 text-white" },
  recheck: { label: "复查", cls: "bg-warn/10 hover:bg-warn/20 text-warn" },
  reject: { label: "退回", cls: "bg-err/10 hover:bg-err/20 text-err" }
};

export function OutputsPage() {
  const outputs = useStore((s) => s.outputs);
  const loading = useStore((s) => s.loading);
  const saveReview = useStore((s) => s.saveReview);
  const [noteByTask, setNoteByTask] = useState({});

  if (loading && outputs.length === 0) return <EmptyHint icon="fa-spinner fa-spin" title="加载中…" />;
  if (outputs.length === 0) return <EmptyHint icon="fa-film" title="还没有成品" sub="批量任务跑完后，这里会展示可复核的成片。" />;

  async function review(taskDir, decision) {
    await saveReview({ taskDir, decision, note: noteByTask[taskDir] || "" });
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="grid grid-cols-3 gap-4">
        {outputs.map((item) => (
          <article key={item.task_dir} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="aspect-video bg-slate-100 grid place-items-center">
              {item.final_video ? (
                <button onClick={() => window.voah?.openFile(item.final_video)} className="text-brand-600 hover:text-brand-700">
                  <i className="fa fa-play-circle text-4xl" />
                </button>
              ) : (
                <i className="fa fa-film text-3xl text-ink-300" />
              )}
            </div>
            <div className="p-3 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{item.product_name}</div>
                  <div className="text-xs text-ink-400 truncate">{item.label || item.task_id}</div>
                </div>
                <StatusTag status={item.status} />
              </div>
              <div className="flex items-center justify-between text-xs text-ink-500">
                <span>QA {item.qa_status}</span>
                {item.target_duration_s && <span>{item.target_duration_s}秒</span>}
              </div>
              <textarea
                value={noteByTask[item.task_dir] ?? item.review?.note ?? ""}
                onChange={(e) => setNoteByTask((prev) => ({ ...prev, [item.task_dir]: e.target.value }))}
                className="input h-16 resize-none text-xs"
                placeholder="复核备注"
              />
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(REVIEW).map(([decision, meta]) => (
                  <button
                    key={decision}
                    onClick={() => review(item.task_dir, decision)}
                    className={`py-1.5 rounded-md text-xs font-medium ${meta.cls}`}
                  >
                    {meta.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => item.final_video && window.voah?.reveal(item.final_video)}
                  className="flex-1 py-1.5 rounded-md border border-slate-200 text-xs text-ink-700 hover:bg-slate-50"
                >
                  目录
                </button>
                <button
                  onClick={() => item.final_video && window.voah?.openFile(item.final_video)}
                  className="flex-1 py-1.5 rounded-md border border-slate-200 text-xs text-ink-700 hover:bg-slate-50"
                >
                  播放
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

