import { useEffect, useMemo, useState } from "react";
import { SUBTITLE_PRESETS, TTS_VOICE_OPTIONS } from "./lib/mvpContracts.js";
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
  forbidden: "不夸大功效，不承诺医疗效果",
  style: "",
  audience: "",
  cta_policy: ""
};

const browserPreviewModelModules = [
  { id: "material_understanding", module: "素材理解", model: "qwen3.5-omni-plus" },
  { id: "material_vectorization", module: "素材向量化", model: "qwen3-vl-embedding" },
  { id: "material_retrieval", module: "素材召回", model: "qwen3-vl-embedding" },
  { id: "copy_generation", module: "文案生成", model: "MiniMax-M3" },
  { id: "selection_planner", module: "选片计划", model: "MiniMax-M3" },
  { id: "tts_primary", module: "TTS", model: "speech-2.8-hd" },
  { id: "tts_fallback", module: "TTS备用", model: "speech-2.8-hd" }
];

async function bridgeRequest(path, payload) {
  const response = await fetch(`/api/voah/${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `请求失败：${response.status}`);
  }
  return data;
}

function createVoahClient() {
  if (window.voah) {
    return window.voah;
  }
  return {
    getState: () => bridgeRequest("state"),
    createBatch: (payload) => bridgeRequest("createBatch", payload),
    saveProduct: (payload) => bridgeRequest("saveProduct", payload),
    startIntakeJob: (payload) => bridgeRequest("startIntakeJob", payload),
    runTask: (payload) => bridgeRequest("runTask", payload),
    retryTask: (payload) => bridgeRequest("retryTask", payload),
    previewTts: (payload) => bridgeRequest("previewTts", payload),
    reviewOutput: (payload) => bridgeRequest("reviewOutput", payload),
    revealPath: (targetPath) => bridgeRequest("revealPath", { path: targetPath }),
    saveSettings: (payload) => bridgeRequest("saveSettings", payload),
    saveModelKey: (payload) => bridgeRequest("saveModelKey", payload),
    deleteModelKey: (payload) => bridgeRequest("deleteModelKey", payload),
    validateModelKeys: (payload) => bridgeRequest("validateModelKeys", payload)
  };
}

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
    draft: "草稿",
    succeeded: "成功",
    warning: "警告",
    manual_review: "需复核",
    block: "阻断"
  };
  return map[status] || status;
}

function statusTone(status) {
  if (["ready", "completed", "succeeded", "pass"].includes(status)) return "good";
  if (["qa_warning", "warning", "manual_review", "needs_intake"].includes(status)) return "warn";
  if (["failed", "block"].includes(status)) return "bad";
  return "info";
}

function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function compactPath(value) {
  const text = String(value || "");
  if (text.length <= 80) return text;
  return `...${text.slice(-77)}`;
}

function slugify(value) {
  return String(value || "product")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "product";
}

function mediaSrc(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.startsWith("file://") || text.startsWith("http://") || text.startsWith("https://")) return text;
  if (text.startsWith("/")) return `file://${text}`;
  return text;
}

function productDraftFrom(product) {
  return {
    id: product?.id || `product_${Date.now()}`,
    name: product?.name || "",
    brand: product?.brand || "",
    slug: product?.slug || "",
    source_folder: product?.source_folder || "",
    status: product?.status || "needs_intake",
    material_status: product?.material_status || "需处理素材",
    claim_summary: product?.claim_summary || "",
    selling_points: product?.selling_points || "",
    compliance_notes: product?.compliance_notes || "",
    cta_notes: product?.cta_notes || "",
    default_offer: product?.default_offer || "",
    latest_intake_run: product?.latest_intake_run || ""
  };
}

function batchSummary(batch, tasks) {
  const ids = new Set(batch.task_ids || []);
  const batchTasks = tasks.filter((task) => ids.has(task.id) || task.batch_id === batch.id);
  return {
    total: batchTasks.length || batch.target_count || 0,
    running: batchTasks.filter((task) => task.status === "running").length,
    failed: batchTasks.filter((task) => task.status === "failed").length,
    review: batchTasks.filter((task) => ["qa_warning", "awaiting_review"].includes(task.status)).length,
    done: batchTasks.filter((task) => task.status === "completed").length,
    taskIds: batchTasks.map((task) => task.id),
    failedTaskIds: batchTasks.filter((task) => task.status === "failed").map((task) => task.id)
  };
}

function useVoahState() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const next = await createVoahClient().getState();
      setState(next);
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
        const next = await createVoahClient().getState();
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

function App() {
  const { state, loading, error, refresh } = useVoahState();
  const [active, setActive] = useState("dashboard");
  const [selectedProductId, setSelectedProductId] = useState("product_fangshai_qidian");
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [brief, setBrief] = useState(defaultBrief);
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const selectedProduct = useMemo(
    () => state?.products?.find((product) => product.id === selectedProductId) || state?.products?.[0],
    [state, selectedProductId]
  );
  const selectedTask = useMemo(
    () => state?.tasks?.find((task) => task.id === selectedTaskId) || state?.tasks?.[0],
    [state, selectedTaskId]
  );

  async function createBatch() {
    if (!selectedProduct) return;
    setBusy(true);
    try {
      const voah = createVoahClient();
      const result = await voah.createBatch({
        productId: selectedProduct.id,
        brief,
        count: Number(brief.count || 1)
      });
      const tasks = result.tasks || [];
      for (const task of tasks) {
        await voah.runTask({ task_id: task.id }).catch(() => null);
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
    if (!selectedProduct) return;
    setBusy(true);
    try {
      const voah = createVoahClient();
      const result = await voah.createBatch({
        productId: selectedProduct.id,
        brief: { ...brief, count: 1 },
        count: 1
      });
      const task = result.tasks?.[0];
      if (task) {
        await voah.runTask({ task_id: task.id, fail_stage: "tts_audio" });
        setSelectedTaskId(task.id);
        setActive("tasks");
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function retryTask(taskId) {
    setBusy(true);
    try {
      await createVoahClient().retryTask({ task_id: taskId });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function retryFailedTasks(taskIds) {
    setBusy(true);
    try {
      const voah = createVoahClient();
      for (const taskId of taskIds) {
        await voah.retryTask({ task_id: taskId }).catch(() => null);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveProduct(product) {
    setBusy(true);
    try {
      await createVoahClient().saveProduct({ product });
      await refresh();
      setSelectedProductId(product.id);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || "保存失败" };
    } finally {
      setBusy(false);
    }
  }

  async function startIntakeJob(payload) {
    setBusy(true);
    try {
      await createVoahClient().startIntakeJob(payload);
      await refresh();
      return { ok: true };
    } catch (err) {
      await refresh();
      return { ok: false, message: err.message || "入库失败" };
    } finally {
      setBusy(false);
    }
  }

  async function previewTts(payload) {
    setSettingsBusy(true);
    try {
      const result = await createVoahClient().previewTts(payload);
      await refresh();
      return { ok: true, preview: result.preview };
    } catch (err) {
      return { ok: false, message: err.message || "试听失败" };
    } finally {
      setSettingsBusy(false);
    }
  }

  async function reviewOutput(payload) {
    setBusy(true);
    try {
      await createVoahClient().reviewOutput(payload);
      await refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || "审核失败" };
    } finally {
      setBusy(false);
    }
  }

  async function revealPath(targetPath) {
    if (!targetPath) return;
    await createVoahClient().revealPath(targetPath);
  }

  async function saveModelKey(moduleId, key) {
    setSettingsBusy(true);
    try {
      await createVoahClient().saveModelKey({ module_id: moduleId, key });
      await refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || "保存失败" };
    } finally {
      setSettingsBusy(false);
    }
  }

  async function deleteModelKey(moduleId) {
    setSettingsBusy(true);
    try {
      await createVoahClient().deleteModelKey({ module_id: moduleId });
      await refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || "删除失败" };
    } finally {
      setSettingsBusy(false);
    }
  }

  async function saveSettings(settings) {
    setSettingsBusy(true);
    try {
      await createVoahClient().saveSettings({ settings });
      await refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || "保存失败" };
    } finally {
      setSettingsBusy(false);
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
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
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
            key={selectedProduct?.id || "new-product"}
            products={state.products}
            selectedProduct={selectedProduct}
            brief={brief}
            setBrief={setBrief}
            setSelectedProductId={setSelectedProductId}
            createBatch={createBatch}
            createFailedDemo={createFailedDemo}
            saveProduct={saveProduct}
            startIntakeJob={startIntakeJob}
            intakeJobs={state.intake_jobs || []}
            busy={busy}
          />
        ) : null}
        {active === "tasks" ? (
          <Tasks
            state={state}
            selectedTask={selectedTask}
            setSelectedTaskId={setSelectedTaskId}
            retryTask={retryTask}
            retryFailedTasks={retryFailedTasks}
            revealPath={revealPath}
            busy={busy}
          />
        ) : null}
        {active === "outputs" ? <Outputs state={state} revealPath={revealPath} reviewOutput={reviewOutput} busy={busy} /> : null}
        {active === "settings" ? (
          <Settings
            key={JSON.stringify(state.settings || {})}
            state={state}
            saveModelKey={saveModelKey}
            deleteModelKey={deleteModelKey}
            saveSettings={saveSettings}
            previewTts={previewTts}
            revealPath={revealPath}
            busy={settingsBusy}
          />
        ) : null}
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
  const failedTasks = state.tasks.filter((task) => task.status === "failed").slice(0, 4);
  const readyProducts = state.products.filter((product) => product.status === "ready").slice(0, 4);

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
            {readyProducts.map((product) => (
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
                  <span>
                    <strong>{task.title}</strong>
                    <small>{task.human_error?.failed_step || "等待处理"}</small>
                  </span>
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
                <span title={task.title}>{task.title}</span>
                <span>{statusText(task.status)}</span>
                <span title={task.current_stage}>{task.current_stage}</span>
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

function Products({
  products,
  selectedProduct,
  brief,
  setBrief,
  setSelectedProductId,
  createBatch,
  createFailedDemo,
  saveProduct,
  startIntakeJob,
  intakeJobs,
  busy
}) {
  const [productDraft, setProductDraft] = useState(productDraftFrom(selectedProduct));
  const [message, setMessage] = useState("");
  const [intakeMaxVideos, setIntakeMaxVideos] = useState(3);
  const productIntakeJobs = (intakeJobs || []).filter((job) => job.product_id === productDraft.id).slice(0, 4);

  function updateProduct(field, value) {
    setProductDraft((current) => ({
      ...current,
      [field]: value
    }));
  }

  async function handleSaveProduct() {
    const result = await saveProduct({
      ...productDraft,
      slug: productDraft.slug || slugify(productDraft.name),
      status: productDraft.latest_intake_run ? "ready" : productDraft.status
    });
    setMessage(result?.ok ? "产品库已保存" : result?.message || "保存失败");
  }

  async function handleStartIntake() {
    const result = await startIntakeJob({
      product_id: productDraft.id,
      source_dir: productDraft.source_folder,
      max_videos: intakeMaxVideos,
      run_label: "desktop_intake_v1"
    });
    setMessage(result?.ok ? "入库任务已完成" : result?.message || "入库失败");
  }

  function createNewProduct() {
    const next = productDraftFrom({
      id: `product_${Date.now()}`,
      status: "needs_intake",
      material_status: "需处理素材"
    });
    setProductDraft(next);
    setMessage("正在新增产品，保存后会进入产品列表。");
  }

  return (
    <section className="page">
      <div className="layout products">
        <section className="panel">
          <div className="panel-head">
            <h2>产品</h2>
            <button type="button" onClick={createNewProduct}>新增</button>
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
                    <small title={product.latest_intake_run || ""}>{product.latest_intake_run || "素材未入库"}</small>
                  </span>
                  <Badge status={product.status}>{product.material_status}</Badge>
                </button>
            ))}
          </div>
        </section>

        <section className="panel product-detail">
          <div className="panel-head">
            <div>
              <h2>{productDraft.name || "新产品"}</h2>
              <p>{productDraft.claim_summary || "先维护产品卖点，再创建任务。"}</p>
            </div>
            <Badge status={productDraft.status}>{productDraft.material_status}</Badge>
          </div>
          <div className="form-grid">
            <Field label="产品名" value={productDraft.name} onChange={(value) => updateProduct("name", value)} />
            <Field label="品牌" value={productDraft.brand} onChange={(value) => updateProduct("brand", value)} />
            <Field label="Slug" value={productDraft.slug} onChange={(value) => updateProduct("slug", value)} />
            <Field label="素材目录" value={productDraft.source_folder} onChange={(value) => updateProduct("source_folder", value)} />
            <Field label="最近入库" value={productDraft.latest_intake_run} onChange={(value) => updateProduct("latest_intake_run", value)} />
            <Field
              label="状态"
              value={productDraft.status}
              onChange={(value) => updateProduct("status", value)}
              options={[
                { value: "needs_intake", label: "需入库" },
                { value: "ready", label: "可生产" },
                { value: "failed", label: "入库失败" },
                { value: "awaiting_review", label: "待确认" }
              ]}
            />
            <Field label="摘要卖点" value={productDraft.claim_summary} onChange={(value) => updateProduct("claim_summary", value)} />
            <Field label="全量卖点" value={productDraft.selling_points} onChange={(value) => updateProduct("selling_points", value)} multiline />
            <Field label="合规禁忌" value={productDraft.compliance_notes} onChange={(value) => updateProduct("compliance_notes", value)} multiline />
            <Field label="CTA 规则" value={productDraft.cta_notes} onChange={(value) => updateProduct("cta_notes", value)} multiline />
            <Field label="默认活动" value={productDraft.default_offer} onChange={(value) => updateProduct("default_offer", value)} />
          </div>
          <div className="action-row">
            <button type="button" className="primary" disabled={busy || !productDraft.name} onClick={handleSaveProduct}>
              保存产品
            </button>
            <Field label="处理条数" type="number" value={intakeMaxVideos} onChange={(value) => setIntakeMaxVideos(Number(value))} />
            <button
              type="button"
              disabled={busy || !productDraft.id || !productDraft.source_folder}
              onClick={handleStartIntake}
            >
              处理素材
            </button>
            {message ? <span className="inline-message">{message}</span> : null}
          </div>

          {productIntakeJobs.length ? (
            <>
              <h3>素材处理记录</h3>
              <div className="job-list">
                {productIntakeJobs.map((job) => (
                  <div key={job.id} className="job-row">
                    <span title={job.run_dir || job.source_dir}>{job.run_dir ? compactPath(job.run_dir) : job.source_dir}</span>
                    <Badge status={job.status}>{statusText(job.status)}</Badge>
                    <small>{formatTime(job.finished_at || job.started_at)}</small>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <h3>创建批量任务</h3>
          <div className="form-grid">
            <Field label="平台" value={brief.target_platform} onChange={(value) => setBrief({ ...brief, target_platform: value })} />
            <Field label="目标时长" type="number" value={brief.target_duration_s} onChange={(value) => setBrief({ ...brief, target_duration_s: Number(value) })} />
            <Field label="生成数量" type="number" value={brief.count} onChange={(value) => setBrief({ ...brief, count: Number(value) })} />
            <Field label="主卖点" value={brief.main_claim} onChange={(value) => setBrief({ ...brief, main_claim: value })} />
            <Field label="活动优惠" value={brief.offer} onChange={(value) => setBrief({ ...brief, offer: value })} />
            <Field label="禁忌" value={brief.forbidden} onChange={(value) => setBrief({ ...brief, forbidden: value })} />
            <Field label="风格" value={brief.style} onChange={(value) => setBrief({ ...brief, style: value })} />
            <Field label="受众" value={brief.audience} onChange={(value) => setBrief({ ...brief, audience: value })} />
            <Field label="CTA" value={brief.cta_policy} onChange={(value) => setBrief({ ...brief, cta_policy: value })} />
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

function Tasks({ state, selectedTask, setSelectedTaskId, retryTask, retryFailedTasks, revealPath, busy }) {
  const taskJobs = state.jobs.filter((job) => job.task_id === selectedTask?.id);
  const taskArtifacts = state.artifacts.filter((artifact) => artifact.task_id === selectedTask?.id);
  const qa = state.qa_reports.find((report) => report.task_id === selectedTask?.id);
  const batches = [...(state.batches || [])].slice(0, 6);

  return (
    <section className="page">
      {batches.length ? (
        <section className="panel">
          <div className="panel-head">
            <h2>批量队列</h2>
          </div>
          <div className="batch-list">
            {batches.map((batch) => {
              const summary = batchSummary(batch, state.tasks);
              return (
                <div key={batch.id} className="batch-row">
                  <div>
                    <strong>{batch.title}</strong>
                    <small>
                      总数 {summary.total} · 运行 {summary.running} · 待审 {summary.review} · 失败 {summary.failed} · 完成 {summary.done}
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={busy || summary.failedTaskIds.length === 0}
                    onClick={() => retryFailedTasks(summary.failedTaskIds)}
                  >
                    重试失败
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
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
              <div className="action-row compact">
                <button type="button" onClick={() => revealPath(selectedTask.task_dir)}>
                  打开任务目录
                </button>
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
                      <small title={artifact.path}>{compactPath(artifact.path)}</small>
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

function Outputs({ state, revealPath, reviewOutput, busy }) {
  const [reviewNotes, setReviewNotes] = useState({});
  const outputTasks = state.tasks.filter((task) => ["completed", "qa_warning", "awaiting_review"].includes(task.status));
  async function handleReview(taskId, decision) {
    await reviewOutput({
      task_id: taskId,
      decision,
      note: reviewNotes[taskId] || ""
    });
  }
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
              const quality = (state.quality_reports || []).find((report) => report.task_id === task.id);
              const review = (state.output_reviews || []).find((item) => item.task_id === task.id);
              const exportArtifact = state.artifacts.find((artifact) => artifact.task_id === task.id && artifact.kind === "export_record");
              const finalPath = task.task_dir ? `${task.task_dir}/hyperframes_subtitle_burn/final_subtitled.mp4` : "";
              return (
                <article key={task.id} className="output-card">
                  <div className="output-thumb">{Math.round(task.target_duration_s || 45)}s</div>
                  <h3>{task.title}</h3>
                  <p>{quality?.summary?.omni_final_status ? `Omni：${quality.summary.omni_final_status}` : qa?.summary || "等待 QA"}</p>
                  <Badge status={quality?.status || qa?.status || task.status}>
                    {statusText(quality?.status || qa?.status || task.status)}
                  </Badge>
                  {quality ? (
                    <small>
                      段落 {quality.summary?.audio_section_count || "-"} · clip {quality.summary?.selected_clip_count || "-"} · 时长{" "}
                      {quality.summary?.final_duration_s || "-"}s
                    </small>
                  ) : null}
                  {review ? <small>审核：{review.decision}</small> : null}
                  <small title={finalPath || exportArtifact?.path || ""}>{compactPath(finalPath || exportArtifact?.path || "未登记最终视频")}</small>
                  <textarea
                    value={reviewNotes[task.id] || ""}
                    rows={2}
                    placeholder="审核备注"
                    onChange={(event) => setReviewNotes((current) => ({ ...current, [task.id]: event.target.value }))}
                  />
                  <div className="output-actions">
                    <button type="button" onClick={() => revealPath(finalPath || exportArtifact?.path)}>
                      打开成片
                    </button>
                    <button type="button" disabled={busy} onClick={() => revealPath(task.task_dir)}>
                      任务目录
                    </button>
                    <button type="button" disabled={busy || !quality?.report_path} onClick={() => revealPath(quality?.report_path)}>
                      质检报告
                    </button>
                    <button type="button" className="primary" disabled={busy} onClick={() => handleReview(task.id, "approved")}>
                      通过
                    </button>
                    <button type="button" disabled={busy} onClick={() => handleReview(task.id, "manual_review")}>
                      复查
                    </button>
                    <button type="button" disabled={busy} onClick={() => handleReview(task.id, "rejected")}>
                      退回
                    </button>
                  </div>
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

function Settings({ state, saveModelKey, deleteModelKey, saveSettings, previewTts, revealPath, busy }) {
  const [draftKeys, setDraftKeys] = useState({});
  const [settingsDraft, setSettingsDraft] = useState(state.settings || {});
  const [message, setMessage] = useState("");
  const [previewText, setPreviewText] = useState("今天这款气垫，上脸是自然气色，通勤补妆也很轻薄。");
  const [previewResult, setPreviewResult] = useState(state.tts_previews?.[0] || null);
  const modules = state.model_keys?.modules || browserPreviewModelModules.map((item) => ({ ...item, has_key: false, masked_key: "" }));

  function setDraft(moduleId, value) {
    setDraftKeys((current) => ({ ...current, [moduleId]: value }));
  }

  function updateCopy(field, value) {
    setSettingsDraft((current) => ({
      ...current,
      copy: {
        ...(current.copy || {}),
        [field]: value
      }
    }));
  }

  function updateTts(field, value) {
    setSettingsDraft((current) => ({
      ...current,
      tts: {
        ...(current.tts || {}),
        [field]: value
      }
    }));
  }

  function updateVoiceModify(field, value) {
    setSettingsDraft((current) => ({
      ...current,
      tts: {
        ...(current.tts || {}),
        voice_modify: {
          ...(current.tts?.voice_modify || {}),
          [field]: value
        }
      }
    }));
  }

  function updateSubtitle(field, value) {
    setSettingsDraft((current) => ({
      ...current,
      subtitle: {
        ...(current.subtitle || {}),
        [field]: value
      }
    }));
  }

  async function handleSave(moduleId) {
    const key = draftKeys[moduleId] || "";
    const result = await saveModelKey(moduleId, key);
    if (result?.ok) {
      setDraft(moduleId, "");
      setMessage("已保存");
      return;
    }
    setMessage(result?.message || "保存失败");
  }

  async function handleDelete(moduleId) {
    const result = await deleteModelKey(moduleId);
    if (result?.ok) {
      setDraft(moduleId, "");
      setMessage("已删除");
      return;
    }
    setMessage(result?.message || "删除失败");
  }

  async function handleSaveSettings() {
    const selectedVoice = TTS_VOICE_OPTIONS.find((item) => item.id === settingsDraft.tts?.voice_id);
    const selectedPreset = SUBTITLE_PRESETS.find((item) => item.id === settingsDraft.subtitle?.preset);
    const result = await saveSettings({
      copy: settingsDraft.copy || {},
      tts: {
        ...(settingsDraft.tts || {}),
        voice_label: selectedVoice?.label || settingsDraft.tts?.voice_label || "",
        speed: toNumber(settingsDraft.tts?.speed, 1.1),
        vol: toNumber(settingsDraft.tts?.vol, 1),
        pitch: toNumber(settingsDraft.tts?.pitch, 0),
        voice_modify: {
          pitch: toNumber(settingsDraft.tts?.voice_modify?.pitch, 20),
          intensity: toNumber(settingsDraft.tts?.voice_modify?.intensity, 20),
          timbre: toNumber(settingsDraft.tts?.voice_modify?.timbre, 0)
        }
      },
      subtitle: {
        ...(settingsDraft.subtitle || {}),
        preset_label: selectedPreset?.label || settingsDraft.subtitle?.preset_label || ""
      }
    });
    setMessage(result?.ok ? "设置已保存" : result?.message || "设置保存失败");
  }

  async function handlePreviewTts() {
    const selectedVoice = TTS_VOICE_OPTIONS.find((item) => item.id === settingsDraft.tts?.voice_id);
    const result = await previewTts({
      text: previewText,
      settings: state.settings || {},
      tts: {
        ...(settingsDraft.tts || {}),
        voice_label: selectedVoice?.label || settingsDraft.tts?.voice_label || "",
        speed: toNumber(settingsDraft.tts?.speed, 1.1),
        vol: toNumber(settingsDraft.tts?.vol, 1),
        pitch: toNumber(settingsDraft.tts?.pitch, 0),
        voice_modify: {
          pitch: toNumber(settingsDraft.tts?.voice_modify?.pitch, 20),
          intensity: toNumber(settingsDraft.tts?.voice_modify?.intensity, 20),
          timbre: toNumber(settingsDraft.tts?.voice_modify?.timbre, 0)
        }
      }
    });
    if (result?.ok) {
      setPreviewResult(result.preview);
      setMessage("试听已生成");
      return;
    }
    setMessage(result?.message || "试听失败");
  }

  const copy = settingsDraft.copy || {};
  const tts = settingsDraft.tts || {};
  const voiceModify = tts.voice_modify || {};
  const subtitle = settingsDraft.subtitle || {};

  return (
    <section className="page">
      <section className="panel settings-panel">
        <div className="panel-head">
          <div>
            <h2>模型 Key</h2>
            {message ? <p>{message}</p> : null}
          </div>
        </div>
        <div className="model-key-list">
          {modules.map((item) => (
            <div key={item.id} className="model-key-row">
              <div className="model-key-name">
                <strong>
                  {item.module} / {item.model}
                </strong>
                {item.has_key ? <small>{item.masked_key}</small> : null}
              </div>
              <Badge status={item.has_key ? "ready" : "needs_intake"}>{item.has_key ? "已配置" : "未配置"}</Badge>
              <input
                type="password"
                value={draftKeys[item.id] || ""}
                placeholder={item.has_key ? "输入新 key 更新" : "输入 key"}
                autoComplete="off"
                onChange={(event) => setDraft(item.id, event.target.value)}
              />
              <button
                type="button"
                className="primary"
                disabled={busy || !(draftKeys[item.id] || "").trim()}
                onClick={() => handleSave(item.id)}
              >
                保存
              </button>
              <button type="button" disabled={busy || !item.has_key} onClick={() => handleDelete(item.id)}>
                删除
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="panel-head">
          <div>
            <h2>生产默认参数</h2>
            <p>创建任务时会保存一份快照。</p>
          </div>
          <button type="button" className="primary" disabled={busy} onClick={handleSaveSettings}>
            保存设置
          </button>
        </div>

        <div className="settings-grid">
          <div className="settings-block">
            <h3>文案</h3>
            <Field label="默认风格" value={copy.default_style || ""} onChange={(value) => updateCopy("default_style", value)} />
            <Field label="默认受众" value={copy.default_audience || ""} onChange={(value) => updateCopy("default_audience", value)} />
            <Field label="默认活动" value={copy.default_offer || ""} onChange={(value) => updateCopy("default_offer", value)} />
            <Field label="违禁/禁忌" value={copy.forbidden_terms || ""} onChange={(value) => updateCopy("forbidden_terms", value)} multiline />
            <Field label="CTA 规则" value={copy.cta_policy || ""} onChange={(value) => updateCopy("cta_policy", value)} multiline />
          </div>

          <div className="settings-block">
            <h3>TTS</h3>
            <Field
              label="音色"
              value={tts.voice_id || ""}
              onChange={(value) => updateTts("voice_id", value)}
              options={TTS_VOICE_OPTIONS.map((item) => ({ value: item.id, label: item.label }))}
            />
            <Field label="模型" value={tts.model || "speech-2.8-hd"} onChange={(value) => updateTts("model", value)} />
            <Field label="情绪" value={tts.emotion || "happy"} onChange={(value) => updateTts("emotion", value)} />
            <Field label="语速" type="number" step="0.05" value={tts.speed ?? 1.1} onChange={(value) => updateTts("speed", value)} />
            <Field label="音量" type="number" step="0.1" value={tts.vol ?? 1} onChange={(value) => updateTts("vol", value)} />
            <Field label="音调" type="number" value={tts.pitch ?? 0} onChange={(value) => updateTts("pitch", value)} />
            <Field label="Pitch" type="number" value={voiceModify.pitch ?? 20} onChange={(value) => updateVoiceModify("pitch", value)} />
            <Field label="Intensity" type="number" value={voiceModify.intensity ?? 20} onChange={(value) => updateVoiceModify("intensity", value)} />
            <Field label="Timbre" type="number" value={voiceModify.timbre ?? 0} onChange={(value) => updateVoiceModify("timbre", value)} />
            <Field label="试听文本" value={previewText} onChange={setPreviewText} multiline />
            <div className="preview-box">
              <button type="button" className="primary" disabled={busy || !previewText.trim()} onClick={handlePreviewTts}>
                生成试听
              </button>
              {previewResult?.audio_path ? (
                <>
                  <audio controls src={mediaSrc(previewResult.audio_path)} />
                  <small title={previewResult.audio_path}>{compactPath(previewResult.audio_path)}</small>
                  <button type="button" onClick={() => revealPath(previewResult.audio_path)}>
                    打开试听
                  </button>
                </>
              ) : (
                <small>还没有试听音频</small>
              )}
            </div>
          </div>

          <div className="settings-block">
            <h3>字幕</h3>
            <Field
              label="样式"
              value={subtitle.preset || "songti_white_gold_lower"}
              onChange={(value) => updateSubtitle("preset", value)}
              options={SUBTITLE_PRESETS.map((item) => ({ value: item.id, label: item.label }))}
            />
            <Field label="字体文件" value={subtitle.font_source || ""} onChange={(value) => updateSubtitle("font_source", value)} />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={subtitle.split_punctuation !== false}
                onChange={(event) => updateSubtitle("split_punctuation", event.target.checked)}
              />
              <span>按标点拆字幕</span>
            </label>
          </div>
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

function Field({ label, value, onChange, type = "text", step, options, multiline = false }) {
  return (
    <label className="field">
      <span>{label}</span>
      {options ? (
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : multiline ? (
        <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} />
      ) : (
        <input type={type} step={step} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
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
