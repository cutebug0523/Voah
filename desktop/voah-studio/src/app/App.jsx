import { useEffect, useMemo, useState } from "react";
import { useStore, startPolling, computeSummary } from "../hooks/useStore.js";
import { QueuePage } from "../pages/QueuePage.jsx";
import { ProductsPage } from "../pages/ProductsPage.jsx";
import { OutputsPage } from "../pages/OutputsPage.jsx";
import { SettingsPage } from "../pages/SettingsPage.jsx";
import { NewBatchDrawer } from "../features/NewBatchDrawer.jsx";
import { SampleDrawer } from "../features/SampleDrawer.jsx";
import { TaskDetailDrawer } from "../features/TaskDetailDrawer.jsx";
import { TaskCenterDrawer } from "../features/TaskCenterDrawer.jsx";

const DAILY_TARGET = 150;

const NAV = [
  { id: "queue", label: "队列", icon: "fa-list-ul" },
  { id: "products", label: "产品", icon: "fa-cube" },
  { id: "outputs", label: "成品库", icon: "fa-film" },
  { id: "settings", label: "设置", icon: "fa-cog" }
];

export default function App() {
  const [nav, setNav] = useState("queue");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [openTaskDir, setOpenTaskDir] = useState(null);
  const [sampleTaskDir, setSampleTaskDir] = useState(null);
  const refresh = useStore((s) => s.refresh);
  const batches = useStore((s) => s.batches);
  const taskCenter = useStore((s) => s.taskCenter);
  const summary = useMemo(() => computeSummary(batches, taskCenter), [batches, taskCenter]);

  useEffect(() => {
    refresh();
    return startPolling();
  }, [refresh]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar nav={nav} setNav={setNav} summary={summary} onOpenTaskCenter={() => setTaskCenterOpen(true)} />

      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 shrink-0 bg-white border-b border-slate-200 px-6 flex items-center justify-between">
          <h1 className="font-semibold text-[15px]">{NAV.find((n) => n.id === nav)?.label}</h1>
          {nav === "queue" && (
            <button
              onClick={() => setDrawerOpen(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-medium shadow-sm"
            >
              <i className="fa fa-plus text-xs" /> 新建批量
            </button>
          )}
        </header>

        {nav === "queue" && <OverviewBar summary={summary} />}

        {nav === "queue" && <QueuePage onOpenTask={setOpenTaskDir} />}
        {nav === "products" && <ProductsPage />}
        {nav === "outputs" && <OutputsPage />}
        {nav === "settings" && <SettingsPage />}
      </main>

      <NewBatchDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onOpenSample={setSampleTaskDir} />
      <SampleDrawer taskDir={sampleTaskDir} onClose={() => setSampleTaskDir(null)} />
      <TaskDetailDrawer taskDir={openTaskDir} onClose={() => setOpenTaskDir(null)} />
      <TaskCenterDrawer open={taskCenterOpen} onClose={() => setTaskCenterOpen(false)} />
    </div>
  );
}

function Sidebar({ nav, setNav, summary, onOpenTaskCenter }) {
  const pct = Math.min(100, Math.round((summary.succeeded / DAILY_TARGET) * 100));
  return (
    <aside className="w-52 shrink-0 bg-white border-r border-slate-200 flex flex-col">
      <div className="px-4 h-14 flex items-center gap-2 border-b border-slate-100">
        <div className="w-7 h-7 rounded-lg bg-brand-600 text-white grid place-items-center font-bold">V</div>
        <span className="font-semibold text-[15px]">Voah</span>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => setNav(item.id)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg font-medium ${
              nav === item.id ? "bg-brand-50 text-brand-700" : "text-ink-700 hover:bg-slate-50"
            }`}
          >
            <i className={`fa ${item.icon} w-4 text-center`} />
            {item.label}
          </button>
        ))}
      </nav>

      <button
        onClick={onOpenTaskCenter}
        className="m-2 p-3 rounded-xl bg-slate-50 border border-slate-200 text-left hover:bg-white hover:border-brand-200 transition-colors"
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-ink-500 font-medium">任务中心</span>
          <i className="fa fa-angle-right text-ink-300" />
        </div>
        <div className="flex items-end gap-1 mb-2">
          <span className="text-2xl font-bold leading-none">{summary.succeeded}</span>
          <span className="text-ink-400 text-xs mb-0.5">/ {DAILY_TARGET}</span>
        </div>
        <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden mb-3">
          <div className="h-full bg-brand-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="grid grid-cols-3 gap-1 text-center">
          <Stat n={summary.running} label="运行" color="text-run" />
          <Stat n={summary.needs_review} label="待审" color="text-warn" />
          <Stat n={summary.failed} label="失败" color="text-err" />
        </div>
      </button>
    </aside>
  );
}

function Stat({ n, label, color }) {
  return (
    <div>
      <div className={`font-bold ${color}`}>{n}</div>
      <div className="text-[10px] text-ink-400">{label}</div>
    </div>
  );
}

function OverviewBar({ summary }) {
  return (
    <div className="px-6 py-3 bg-white border-b border-slate-100 flex gap-6 text-xs">
      <Item label="今日" value={`${summary.succeeded}/${DAILY_TARGET}`} color="text-ink-900" />
      <Item label="运行" value={summary.running} color="text-run" />
      <Item label="待审" value={summary.needs_review} color="text-warn" />
      <Item label="失败" value={summary.failed} color="text-err" />
      <Item label="完成" value={summary.succeeded} color="text-ok" />
    </div>
  );
}

function Item({ label, value, color }) {
  return (
    <span className="text-ink-500">
      {label} <b className={`${color} text-sm`}>{value}</b>
    </span>
  );
}
