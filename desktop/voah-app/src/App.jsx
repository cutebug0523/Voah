import { useEffect, useMemo, useState } from "react";
import "./App.css";

const navItems = [
  { id: "dashboard", label: "工作台", icon: "⌂" },
  { id: "products", label: "产品", icon: "□" },
  { id: "tasks", label: "任务", icon: "◫" },
  { id: "outputs", label: "成品", icon: "▷" },
  { id: "settings", label: "设置", icon: "⚙" }
];

const defaultBrief = {
  target_platform: "抖音",
  target_duration_s: 45,
  count: 3,
  main_claim: "自然气色、防晒持妆",
  offer: "今日活动价",
  forbidden: "不夸大功效，不承诺医疗效果"
};

function formatTime(value) {
  if (!value) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function statusText(status) {
  const map = {
    ready: "可生产",
    needs_intake: "需处理",
    queued: "排队中",
    running: "处理中",
    awaiting_review: "待确认",
    qa_warning: "QA 提醒",
    completed: "已完成",
    failed: "失败",
    draft: "草稿"
  };
  return map[status] || status;
}

function statusTone(status) {
  if (["ready", "completed", "succeeded", "pass"].includes(status)) return "good";
  if (["qa_warning", "warning", "manual_review", "needs_intake"].includes(status)) return "warn";
  if (["failed", "block"].includes(status)) return "bad";
  return "info";
}

function useVoahState() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      if (window.voah) {
        const next = await window.voah.getState();
        setState(next);
      } else {
        setState(createBrowserPreviewState());
      }
      setError("");
    } catch (err) {
      setError(err.message || "读取状态失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let ignore = false;
    async function loadInitialState() {
      try {
        const next = window.voah ? await window.voah.getState() : createBrowserPreviewState();
        if (!ignore) {
          setState(next);
          setError("");
        }
      } catch (err) {
        if (!ignore) {
          setError(err.message || "读取状态失败");
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }
    loadInitialState();
    return () => {
      ignore = true;
    };
  }, []);

  return { state, loading, error, refresh };
}

function createBrowserPreviewState() {
  return {
    products: [
      {
        id: "product_fangshai_qidian",
        name: "防晒气垫",
        status: "ready",
        material_status: "可生产",
        claim_summary: "自然气色、防晒持妆、防水防汗、通勤补妆",
        latest_intake_run: "20260603_225800_merged5_scene_candidates_v1",
        updated_at: new Date().toISOString()
      }
    ],
    tasks: [],
    jobs: [],
    artifacts: [],
    qa_reports: [],
    settings: {
      workspace_root: "/Users/noah/混剪",
      tts_voice_preset: "MiniMax 女声 happy / speed 1.1",
      subtitle_preset: "方案 1：底部白字关键词高亮",
      provider_status: "Electron 中可读取真实本地配置"
    },
    paths: {
      store_path: "浏览器预览模式不写入本地 store"
    }
  };
}

function App() {
  const { state, loading, error, refresh } = useVoahState();
  const [active, setActive] = useState("dashboard");
  const [selectedProductId, setSelectedProductId] = useState("product_fangshai_qidian");
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [brief, setBrief] = useState(defaultBrief);
  const [busy, setBusy] = useState(false);

  const selectedProduct = useMemo(
    () => state?.products?.find((product) => product.id === selectedProductId) || state?.products?.[0],
    [state, selectedProductId]
  );
  const selectedTask = useMemo(
    () => state?.tasks?.find((task) => task.id === selectedTaskId) || state?.tasks?.[0],
    [state, selectedTaskId]
  );

  async function createBatch() {
    if (!selectedProduct || !window.voah) return;
    setBusy(true);
    try {
      const result = await window.voah.createBatch({
        productId: selectedProduct.id,
        brief,
        count: Number(brief.count || 1)
      });
      const tasks = result.tasks || [];
      for (const task of tasks) {
        await window.voah.runTask({ task_id: task.id });
      }
      if (tasks[0]) {
        setSelectedTaskId(tasks[0].id);
        setActive("tasks");
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createFailedDemo() {
    if (!selectedProduct || !window.voah) return;
    setBusy(true);
    try {
      const result = await window.voah.createBatch({
        productId: selectedProduct.id,
        brief: { ...brief, count: 1 },
        count: 1
      });
      const task = result.tasks?.[0];
      if (task) {
        await window.voah.runTask({ task_id: task.id, fail_stage: "tts_audio" });
        setSelectedTaskId(task.id);
        setActive("tasks");
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function retryTask(taskId) {
    if (!window.voah) return;
    setBusy(true);
    try {
      await window.voah.retryTask({ task_id: taskId });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (loading || !state) {
    return <div className="boot">正在打开 Voah 生产工作台...</div>;
  }

  const counts = {
    running: state.tasks.filter((task) => task.status === "running").length,
    failed: state.tasks.filter((task) => task.status === "failed").length,
    review: state.tasks.filter((task) => task.status === "qa_warning" || task.status === "awaiting_review").length,
    readyProducts: state.products.filter((product) => product.status === "ready").length
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">V</span>
          <div>
            <strong>Voah</strong>
            <small>生产工作台</small>
          </div>
        </div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={active === item.id ? "active" : ""}
              onClick={() => setActive(item.id)}
              type="button"
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p>今日生产</p>
            <h1>{pageTitle(active)}</h1>
          </div>
          <div className="top-actions">
            {error ? <span className="error">{error}</span> : null}
            <button type="button" onClick={refresh} disabled={busy}>
              刷新
            </button>
          </div>
        </header>

        {active === "dashboard" ? (
          <Dashboard
            state={state}
            counts={counts}
            setActive={setActive}
            setSelectedProductId={setSelectedProductId}
            setSelectedTaskId={setSelectedTaskId}
          />
        ) : null}
        {active === "products" ? (
          <Products
            products={state.products}
            selectedProduct={selectedProduct}
            brief={brief}
            setBrief={setBrief}
            setSelectedProductId={setSelectedProductId}
            createBatch={createBatch}
            createFailedDemo={createFailedDemo}
            busy={busy}
          />
        ) : null}
        {active === "tasks" ? (
          <Tasks
            state={state}
            selectedTask={selectedTask}
            setSelectedTaskId={setSelectedTaskId}
            retryTask={retryTask}
            busy={busy}
          />
        ) : null}
        {active === "outputs" ? <Outputs state={state} /> : null}
        {active === "settings" ? <Settings state={state} /> : null}
      </main>
    </div>
  );
}

function pageTitle(active) {
  return {
    dashboard: "工作台",
    products: "产品与批量生成",
    tasks: "任务详情",
    outputs: "成品库",
    settings: "设置"
  }[active];
}

function Dashboard({ state, counts, setActive, setSelectedProductId, setSelectedTaskId }) {
  const recentTasks = [...state.tasks].reverse().slice(0, 5);
  const failedTasks = state.tasks.filter((task) => task.status === "failed");

  return (
    <section className="page">
      <div className="metric-grid">
        <Metric label="正在处理" value={counts.running} tone="info" />
        <Metric label="失败待处理" value={counts.failed} tone={counts.failed ? "bad" : "good"} />
        <Metric label="待确认" value={counts.review} tone={counts.review ? "warn" : "good"} />
        <Metric label="可生产产品" value={counts.readyProducts} tone="good" />
      </div>

      <div className="layout two">
        <section className="panel">
          <div className="panel-head">
            <h2>可生产产品</h2>
            <button type="button" onClick={() => setActive("products")}>查看产品</button>
          </div>
          <div className="product-list">
            {state.products.map((product) => (
              <button
                key={product.id}
                className="product-row"
                type="button"
                onClick={() => {
                  setSelectedProductId(product.id);
                  setActive("products");
                }}
              >
                <span>
                  <strong>{product.name}</strong>
                  <small>{product.claim_summary}</small>
                </span>
                <Badge status={product.status}>{product.material_status}</Badge>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>待处理队列</h2>
            <button type="button" onClick={() => setActive("tasks")}>查看任务</button>
          </div>
          {failedTasks.length === 0 ? (
            <EmptyState title="暂无失败任务" text="系统会把失败步骤集中放在这里。" />
          ) : (
            <div className="task-list">
              {failedTasks.map((task) => (
                <button
                  key={task.id}
                  className="task-row"
                  type="button"
                  onClick={() => {
                    setSelectedTaskId(task.id);
                    setActive("tasks");
                  }}
                >
                  <strong>{task.title}</strong>
                  <small>{task.human_error?.failed_step || "等待处理"}</small>
                  <Badge status="failed">失败</Badge>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>最近任务</h2>
        </div>
        {recentTasks.length ? (
          <div className="task-table">
            {recentTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className="table-row"
                onClick={() => {
                  setSelectedTaskId(task.id);
                  setActive("tasks");
                }}
              >
                <span>{task.title}</span>
                <span>{statusText(task.status)}</span>
                <span>{task.current_stage}</span>
                <span>{formatTime(task.updated_at)}</span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState title="还没有生产任务" text="从产品页选择可生产产品，创建一批任务。" />
        )}
      </section>
    </section>
  );
}

function Products({ products, selectedProduct, brief, setBrief, setSelectedProductId, createBatch, createFailedDemo, busy }) {
  return (
    <section className="page">
      <div className="layout products">
        <section className="panel">
          <div className="panel-head">
            <h2>产品</h2>
          </div>
          <div className="product-list">
            {products.map((product) => (
              <button
                key={product.id}
                type="button"
                className={`product-row ${selectedProduct?.id === product.id ? "selected" : ""}`}
                onClick={() => setSelectedProductId(product.id)}
              >
                <span>
                  <strong>{product.name}</strong>
                  <small>{product.latest_intake_run || "素材未入库"}</small>
                </span>
                <Badge status={product.status}>{product.material_status}</Badge>
              </button>
            ))}
          </div>
        </section>

        <section className="panel product-detail">
          <div className="panel-head">
            <div>
              <h2>{selectedProduct?.name}</h2>
              <p>{selectedProduct?.claim_summary}</p>
            </div>
            <Badge status={selectedProduct?.status}>{selectedProduct?.material_status}</Badge>
          </div>
          <div className="detail-grid">
            <Info label="素材文件夹" value={selectedProduct?.source_folder} />
            <Info label="最近入库" value={selectedProduct?.latest_intake_run || "无"} />
            <Info label="更新时间" value={formatTime(selectedProduct?.updated_at)} />
          </div>

          <h3>创建批量任务</h3>
          <div className="form-grid">
            <Field label="平台" value={brief.target_platform} onChange={(value) => setBrief({ ...brief, target_platform: value })} />
            <Field label="目标时长" type="number" value={brief.target_duration_s} onChange={(value) => setBrief({ ...brief, target_duration_s: Number(value) })} />
            <Field label="生成数量" type="number" value={brief.count} onChange={(value) => setBrief({ ...brief, count: Number(value) })} />
            <Field label="主卖点" value={brief.main_claim} onChange={(value) => setBrief({ ...brief, main_claim: value })} />
            <Field label="活动优惠" value={brief.offer} onChange={(value) => setBrief({ ...brief, offer: value })} />
            <Field label="禁忌" value={brief.forbidden} onChange={(value) => setBrief({ ...brief, forbidden: value })} />
          </div>
          <div className="action-row">
            <button
              type="button"
              className="primary"
              disabled={busy || selectedProduct?.status !== "ready"}
              onClick={createBatch}
            >
              创建并运行
            </button>
            <button
              type="button"
              disabled={busy || selectedProduct?.status !== "ready"}
              onClick={createFailedDemo}
            >
              生成失败示例
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}

function Tasks({ state, selectedTask, setSelectedTaskId, retryTask, busy }) {
  const taskJobs = state.jobs.filter((job) => job.task_id === selectedTask?.id);
  const taskArtifacts = state.artifacts.filter((artifact) => artifact.task_id === selectedTask?.id);
  const qa = state.qa_reports.find((report) => report.task_id === selectedTask?.id);

  return (
    <section className="page">
      <div className="layout tasks">
        <section className="panel">
          <div className="panel-head">
            <h2>任务列表</h2>
          </div>
          <div className="task-list">
            {state.tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className={`task-row ${selectedTask?.id === task.id ? "selected" : ""}`}
                onClick={() => setSelectedTaskId(task.id)}
              >
                <strong>{task.title}</strong>
                <small>{task.current_stage}</small>
                <Badge status={task.status}>{statusText(task.status)}</Badge>
              </button>
            ))}
          </div>
        </section>

        <section className="panel task-detail">
          {selectedTask ? (
            <>
              <div className="panel-head">
                <div>
                  <h2>{selectedTask.title}</h2>
                  <p>当前阶段：{selectedTask.current_stage}</p>
                </div>
                <Badge status={selectedTask.status}>{statusText(selectedTask.status)}</Badge>
              </div>

              {selectedTask.human_error ? (
                <div className="human-error">
                  <strong>{selectedTask.human_error.failed_step}</strong>
                  <p>原因：{selectedTask.human_error.reason}</p>
                  <p>影响：{selectedTask.human_error.impact}</p>
                  <button type="button" className="primary" disabled={busy} onClick={() => retryTask(selectedTask.id)}>
                    {selectedTask.human_error.suggested_action}
                  </button>
                </div>
              ) : null}

              <h3>步骤</h3>
              <div className="job-list">
                {taskJobs.map((job) => (
                  <div key={job.id} className="job-row">
                    <span>{job.stage_label || job.stage}</span>
                    <Badge status={job.status}>{statusText(job.status)}</Badge>
                    <small>{formatTime(job.finished_at)}</small>
                  </div>
                ))}
              </div>

              <h3>产物来源链</h3>
              <div className="artifact-list">
                {taskArtifacts.map((artifact) => (
                  <div key={artifact.id} className="artifact-row">
                    <div>
                      <strong>{artifact.kind}</strong>
                      <small>{artifact.path}</small>
                    </div>
                    <span>输入：{artifact.source_artifact_ids.length || "任务 brief"}</span>
                    <Badge status={artifact.qa_status}>{artifact.qa_status}</Badge>
                  </div>
                ))}
              </div>

              {qa ? (
                <>
                  <h3>QA Gate</h3>
                  <div className="qa-box">
                    <Badge status={qa.status}>{qa.status}</Badge>
                    <p>{qa.summary}</p>
                    <div className="check-grid">
                      {qa.checks.map((check) => (
                        <div key={check.id} className="check-item">
                          <span>{check.label}</span>
                          <Badge status={check.status}>{check.status}</Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <EmptyState title="还没有任务" text="从产品页创建批量任务。" />
          )}
        </section>
      </div>
    </section>
  );
}

function Outputs({ state }) {
  const outputTasks = state.tasks.filter((task) => ["completed", "qa_warning"].includes(task.status));
  return (
    <section className="page">
      <section className="panel">
        <div className="panel-head">
          <h2>成品库</h2>
          <p>block 任务不会进入这里。</p>
        </div>
        {outputTasks.length ? (
          <div className="output-grid">
            {outputTasks.map((task) => {
              const qa = state.qa_reports.find((report) => report.task_id === task.id);
              return (
                <article key={task.id} className="output-card">
                  <div className="output-thumb">45s</div>
                  <h3>{task.title}</h3>
                  <p>{qa?.summary || "等待 QA"}</p>
                  <Badge status={qa?.status || task.status}>{qa?.status || statusText(task.status)}</Badge>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState title="暂无可导出成品" text="通过 QA gate 的任务会出现在这里。" />
        )}
      </section>
    </section>
  );
}

function Settings({ state }) {
  return (
    <section className="page">
      <section className="panel">
        <div className="panel-head">
          <h2>设置</h2>
          <p>低频配置入口，日常生产不需要进入这里。</p>
        </div>
        <div className="detail-grid">
          <Info label="Workspace" value={state.settings.workspace_root} />
          <Info label="Store" value={state.paths?.store_path} />
          <Info label="TTS 声音" value={state.settings.tts_voice_preset} />
          <Info label="字幕样式" value={state.settings.subtitle_preset} />
          <Info label="Provider" value={state.settings.provider_status} />
        </div>
      </section>
    </section>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Badge({ status, children }) {
  return <span className={`badge ${statusTone(status)}`}>{children}</span>;
}

function Info({ label, value }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong>{value || "未设置"}</strong>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function EmptyState({ title, text }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

export default App;
