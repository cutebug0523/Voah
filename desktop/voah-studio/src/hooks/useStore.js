import { create } from "zustand";

// 全局状态：批次列表、产品列表。以 manifest 文件为真源，定时轮询拉取。
export const useStore = create((set, get) => ({
  batches: [],
  products: [],
  outputs: [],
  taskCenter: { summary: null, running: [], needs_attention: [], recent_outputs: [] },
  config: null,
  studioSettings: null,
  loading: true,
  lastError: "",

  async refresh() {
    if (!window.voah) {
      set({ loading: false, lastError: "未连接到主进程（请在 Electron 中运行）" });
      return;
    }
    try {
      const [batches, products, outputs, taskCenter] = await Promise.all([
        window.voah.listBatches(),
        window.voah.listProducts(),
        window.voah.listOutputs(),
        window.voah.listTaskCenter ? window.voah.listTaskCenter() : Promise.resolve(null)
      ]);
      set({ batches, products, outputs, taskCenter: normalizeTaskCenter(taskCenter, batches, outputs), loading: false, lastError: "" });
    } catch (err) {
      set({ loading: false, lastError: String(err?.message || err) });
    }
  },

  async loadSettings() {
    const [config, studioSettings] = await Promise.all([window.voah.getConfig(), window.voah.getStudioSettings()]);
    set({ config, studioSettings });
    return { config, studioSettings };
  },

  async saveStudioSettings(settings) {
    const res = await window.voah.saveStudioSettings(settings);
    await get().loadSettings();
    return res;
  },

  async setConfig(key, value) {
    const res = await window.voah.setConfig({ key, value });
    await get().loadSettings();
    return res;
  },

  async createProduct(params) {
    const res = await window.voah.createProduct(params);
    await get().refresh();
    return res;
  },

  async startIntake(params) {
    const res = await window.voah.startIntake(params);
    await get().refresh();
    return res;
  },

  async createBatch(params) {
    const res = await window.voah.createBatch(params);
    await get().refresh();
    return res;
  },

  async retryTask(taskDir, fromStage) {
    const res = await window.voah.retryTask({ taskDir, fromStage });
    await get().refresh();
    return res;
  },

  async pauseBatch(batchDir) {
    const res = await window.voah.pauseBatch(batchDir);
    await get().refresh();
    return res;
  },

  async resumeBatch(batchDir) {
    const res = await window.voah.resumeBatch(batchDir);
    await get().refresh();
    return res;
  },

  async saveReview(params) {
    const res = await window.voah.saveReview(params);
    await get().refresh();
    return res;
  }
}));

// 今日产能汇总（跨所有批次）。纯函数，避免放进 zustand selector 造成无限渲染。
export function computeSummary(batches, taskCenter = null) {
  if (taskCenter?.summary) return taskCenter.summary;
  const counts = { running: 0, needs_review: 0, failed: 0, succeeded: 0, total: 0 };
  for (const b of batches) {
    counts.running += b.counts.running;
    counts.needs_review += b.counts.needs_review;
    counts.failed += b.counts.failed;
    counts.succeeded += b.counts.succeeded;
    counts.total += b.total;
  }
  return counts;
}

function normalizeTaskCenter(taskCenter, batches, outputs) {
  if (taskCenter?.ok) return taskCenter;
  return {
    ok: true,
    summary: computeSummary(batches),
    running: [],
    needs_attention: [],
    recent_outputs: outputs || []
  };
}

// 轮询：运行中时 2s 一次，全空闲时降到 6s。
export function startPolling() {
  const tick = async () => {
    await useStore.getState().refresh();
    const state = useStore.getState();
    const s = computeSummary(state.batches, state.taskCenter);
    const interval = s.running > 0 ? 2000 : 6000;
    timer = setTimeout(tick, interval);
  };
  let timer = setTimeout(tick, 0);
  return () => clearTimeout(timer);
}
