import { useEffect, useState } from "react";
import { useStore } from "../hooks/useStore.js";
import { StageBar } from "../components/StageBar.jsx";
import { StatusTag } from "../components/StatusTag.jsx";
import { STAGE_LABELS, STAGE_ORDER } from "../lib/status.js";

const QA_META = {
  pass: { label: "通过", color: "text-ok", bg: "bg-ok/5 border-ok/20" },
  ok: { label: "通过", color: "text-ok", bg: "bg-ok/5 border-ok/20" },
  needs_review: { label: "待复核", color: "text-warn", bg: "bg-warn/5 border-warn/20" },
  warning: { label: "待复核", color: "text-warn", bg: "bg-warn/5 border-warn/20" },
  block: { label: "已拦截", color: "text-err", bg: "bg-err/5 border-err/20" },
  pending: { label: "未执行", color: "text-ink-400", bg: "bg-slate-50 border-slate-200" }
};

// 任务详情抽屉：成品一键播放 + QA 复核原因 + 分阶段重跑。
export function TaskDetailDrawer({ taskDir, onClose }) {
  const retryTask = useStore((s) => s.retryTask);
  const continueTask = useStore((s) => s.continueTask);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logStage, setLogStage] = useState("copy");
  const [logs, setLogs] = useState(null);

  useEffect(() => {
    if (!taskDir) {
      setDetail(null);
      return;
    }
    let alive = true;
    setLoading(true);
    window.voah?.taskDetail(taskDir).then((d) => {
      if (alive) {
        setDetail(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [taskDir]);

  const open = Boolean(taskDir);
  const qa = detail?.qa || {};
  const qaMeta = QA_META[qa.status] || QA_META.pending;

  async function handleRetry(fromStage) {
    setBusy(true);
    try {
      await retryTask(taskDir, fromStage);
      const d = await window.voah.taskDetail(taskDir);
      setDetail(d);
    } finally {
      setBusy(false);
    }
  }

  async function handleContinue(run) {
    setBusy(true);
    try {
      await continueTask(taskDir, run?.run_id, run?.failed_stage || run?.current_stage || detail?.failed_stage || "copy");
      const d = await window.voah.taskDetail(taskDir);
      setDetail(d);
    } finally {
      setBusy(false);
    }
  }

  async function loadLogs(stage = logStage, runId = "") {
    const res = await window.voah.readTaskLog({ taskDir, stage, runId });
    setLogs(res);
  }

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />}
      <div
        className={`fixed inset-y-0 right-0 w-[460px] bg-white shadow-2xl border-l border-slate-200 z-50 flex flex-col transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="h-14 px-5 flex items-center justify-between border-b border-slate-100">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-[15px]">任务详情</h2>
            {detail && <StatusTag status={detail.status} />}
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <i className="fa fa-times" />
          </button>
        </div>

        {loading && <div className="p-6 text-ink-400 text-sm">加载中…</div>}

        {detail && !loading && (
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            <div className="text-xs text-ink-400">
              {detail.product_name}
              {detail.target_duration_s ? ` · ${detail.target_duration_s}秒` : ""} · {detail.task_id}
            </div>

            {/* 成品 */}
            <div>
              <div className="text-xs font-medium text-ink-700 mb-2">成品</div>
              {detail.final_video ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => window.voah.openFile(detail.final_video)}
                    className="flex-1 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-medium shadow-sm"
                  >
                    <i className="fa fa-play mr-1.5" /> 播放成品
                  </button>
                  <button
                    onClick={() => window.voah.reveal(detail.final_video)}
                    className="px-3 py-2.5 rounded-lg border border-slate-200 text-ink-700 hover:bg-slate-50"
                  >
                    <i className="fa fa-folder-open-o" />
                  </button>
                </div>
              ) : (
                <div className="text-xs text-ink-400 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  成品尚未生成
                  {detail.preview_no_subtitles && (
                    <button
                      onClick={() => window.voah.openFile(detail.preview_no_subtitles)}
                      className="ml-2 text-brand-600 hover:underline"
                    >
                      看无字幕预览
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 阶段进度 */}
            <div>
              <div className="text-xs font-medium text-ink-700 mb-2">阶段</div>
              <StageBar segments={detail.segments} />
              <div className="grid grid-cols-6 gap-1.5 max-w-md mt-1.5">
                {STAGE_ORDER.map((s) => (
                  <span key={s} className="text-[10px] text-ink-400 text-center">
                    {STAGE_LABELS[s]}
                  </span>
                ))}
              </div>
            </div>

            {/* QA 复核 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-ink-700">QA 复核</span>
                <span className={`text-xs font-medium ${qaMeta.color}`}>{qaMeta.label}</span>
              </div>
              {qa.warnings.length === 0 ? (
                <div className={`text-xs rounded-lg p-3 border ${qaMeta.bg} text-ink-500`}>无待办项。</div>
              ) : (
                <ul className={`text-xs rounded-lg p-3 border space-y-1.5 ${qaMeta.bg}`}>
                  {qa.warnings.map((w, i) => (
                    <li key={i} className="flex gap-1.5 text-ink-700">
                      <i className={`fa fa-exclamation-triangle ${qaMeta.color} mt-0.5`} />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 运行记录 */}
            <div>
              <div className="text-xs font-medium text-ink-700 mb-2">运行记录</div>
              {detail.runs?.length ? (
                <div className="space-y-2">
                  {detail.runs.slice(0, 6).map((run) => (
                    <RunRow
                      key={run.run_id}
                      run={run}
                      busy={busy}
                      onLog={() => {
                        setLogStage(run.failed_stage || run.current_stage || run.from_stage || "copy");
                        loadLogs(run.failed_stage || run.current_stage || run.from_stage || "copy", run.run_id);
                      }}
                      onContinue={() => handleContinue(run)}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-xs text-ink-400 bg-slate-50 border border-slate-200 rounded-lg p-3">暂无运行记录。</div>
              )}
            </div>

            {/* 日志 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-ink-700">日志</span>
                <div className="flex gap-2">
                  <select
                    value={logStage}
                    onChange={(e) => {
                      setLogStage(e.target.value);
                      setLogs(null);
                    }}
                    className="px-2 py-1 rounded-md border border-slate-200 bg-white text-xs outline-none"
                  >
                    {STAGE_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {STAGE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => loadLogs()}
                    className="px-2.5 py-1 rounded-md text-xs border border-slate-200 text-ink-700 hover:bg-slate-50"
                  >
                    读取
                  </button>
                </div>
              </div>
              {logs?.files?.length ? (
                <div className="space-y-2">
                  {logs.files.map((file) => (
                    <details key={file.file} className="rounded-lg border border-slate-200 overflow-hidden">
                      <summary className="px-3 py-2 text-xs bg-slate-50 cursor-pointer">{file.name}</summary>
                      <pre className="max-h-56 overflow-auto p-3 text-[11px] leading-5 text-ink-700 whitespace-pre-wrap bg-white">
                        {file.text || "空日志"}
                      </pre>
                    </details>
                  ))}
                </div>
              ) : logs ? (
                <div className="text-xs text-ink-400 bg-slate-50 border border-slate-200 rounded-lg p-3">没有找到该阶段日志。</div>
              ) : (
                <div className="text-xs text-ink-400 bg-slate-50 border border-slate-200 rounded-lg p-3">选择阶段后读取日志。</div>
              )}
            </div>
          </div>
        )}

        {detail && !loading && (
          <div className="p-5 border-t border-slate-100 flex gap-2">
            <RetrySelect onPick={handleRetry} busy={busy} />
            <button
              onClick={() => handleRetry(detail.failed_stage || "qa")}
              disabled={busy}
              className="flex-1 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-ink-300 text-white font-medium"
            >
              {busy ? "处理中…" : detail.failed_stage ? `从「${STAGE_LABELS[detail.failed_stage]}」重跑` : "重跑 QA"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function RunRow({ run, busy, onLog, onContinue }) {
  const meta = runStatusMeta(run.status);
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
            <span className="text-xs text-ink-700">{run.stage_label || "任务"}</span>
          </div>
          <div className="mt-1 text-[11px] text-ink-400 truncate">{run.run_id}</div>
          {run.error_summary && <div className="mt-1 text-[11px] text-err line-clamp-2">{run.error_summary}</div>}
        </div>
        <div className="shrink-0 flex gap-2 text-xs">
          <button onClick={onLog} className="text-brand-600 hover:underline">日志</button>
          {run.can_continue && (
            <button onClick={onContinue} disabled={busy} className="text-brand-600 hover:underline disabled:opacity-50">
              继续
            </button>
          )}
          <button onClick={() => window.voah?.reveal(run.run_dir)} className="text-brand-600 hover:underline">目录</button>
        </div>
      </div>
    </div>
  );
}

function runStatusMeta(status) {
  return (
    {
      running: { label: "运行中", cls: "text-run bg-run/5 border-run/20" },
      failed: { label: "失败", cls: "text-err bg-err/5 border-err/20" },
      superseded: { label: "已取代", cls: "text-ink-500 bg-slate-50 border-slate-200" },
      promoted: { label: "已合入", cls: "text-ok bg-ok/5 border-ok/20" },
      succeeded: { label: "完成", cls: "text-ok bg-ok/5 border-ok/20" }
    }[status] || { label: "记录", cls: "text-ink-500 bg-slate-50 border-slate-200" }
  );
}

function RetrySelect({ onPick, busy }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="py-2.5 px-3 rounded-lg border border-slate-200 text-ink-700 hover:bg-slate-50 disabled:opacity-50"
      >
        从阶段重跑 <i className="fa fa-caret-down ml-1" />
      </button>
      {open && (
        <div className="absolute bottom-12 left-0 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-32 z-10">
          {STAGE_ORDER.map((s) => (
            <button
              key={s}
              onClick={() => {
                setOpen(false);
                onPick(s);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-ink-700 hover:bg-slate-50"
            >
              {STAGE_LABELS[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
