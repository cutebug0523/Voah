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
    runTask: (payload) => bridgeRequest("runTask", payload),
    retryTask: (payload) => bridgeRequest("retryTask", payload),
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

function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function compactPath(value) {
  const text = String(value || "");
  if (text.length <= 80) return text;
  return `...${text.slice(-77)}`;
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
        await voah.runTask({ task_id: task.id });
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
            revealPath={revealPath}
            busy={busy}
          />
        ) : null}
        {active === "outputs" ? <Outputs state={state} revealPath={revealPath} /> : null}
        {active === "settings" ? (
          <Settings
            key={JSON.stringify(state.settings || {})}
            state={state}
            saveModelKey={saveModelKey}
            deleteModelKey={deleteModelKey}
            saveSettings={saveSettings}
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
              <h2>{selectedProduct?.name}</h2>
              <p>{selectedProduct?.claim_summary}</p>
            </div>
            <Badge status={selectedProduct?.status}>{selectedProduct?.material_status}</Badge>
          </div>
          <div className="detail-grid">
            <Info label="素材文件夹" value={selectedProduct?.source_folder} />
            <Info label="最近入库" value={selectedProduct?.latest_intake_run || "无"} />
            <Info label="更新时间" value={formatTime(selectedProduct?.updated_at)} />
            <Info label="全量卖点" value={selectedProduct?.selling_points || selectedProduct?.claim_summary} />
            <Info label="合规禁忌" value={selectedProduct?.compliance_notes} />
            <Info label="CTA 规则" value={selectedProduct?.cta_notes} />
          </div>

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

function Tasks({ state, selectedTask, setSelectedTaskId, retryTask, revealPath, busy }) {
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

function Outputs({ state, revealPath }) {
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
              const exportArtifact = state.artifacts.find((artifact) => artifact.task_id === task.id && artifact.kind === "export_record");
              const finalPath = task.task_dir ? `${task.task_dir}/hyperframes_subtitle_burn/final_subtitled.mp4` : "";
              return (
                <article key={task.id} className="output-card">
                  <div className="output-thumb">45s</div>
                  <h3>{task.title}</h3>
                  <p>{qa?.summary || "等待 QA"}</p>
                  <Badge status={qa?.status || task.status}>{qa?.status || statusText(task.status)}</Badge>
                  <small title={finalPath || exportArtifact?.path || ""}>{compactPath(finalPath || exportArtifact?.path || "未登记最终视频")}</small>
                  <button type="button" onClick={() => revealPath(finalPath || exportArtifact?.path)}>
                    打开成片
                  </button>
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

function Settings({ state, saveModelKey, deleteModelKey, saveSettings, busy }) {
  const [draftKeys, setDraftKeys] = useState({});
  const [settingsDraft, setSettingsDraft] = useState(state.settings || {});
  const [message, setMessage] = useState("");
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

function Info({ label, value }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong>{value || "未设置"}</strong>
    </div>
  );
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
