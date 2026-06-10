import { create } from "zustand";

// 全局状态：批次列表、产品列表。以 manifest 文件为真源，定时轮询拉取。
export const useStore = create((set, get) => ({
  batches: [],
  products: [],
  loading: true,
  lastError: "",

  async refresh() {
    if (!window.voah) {
      set({ loading: false, lastError: "未连接到主进程（请在 Electron 中运行）" });
      return;
    }
    try {
      const [batches, products] = await Promise.all([window.voah.listBatches(), window.voah.listProducts()]);
      set({ batches, products, loading: false, lastError: "" });
    } catch (err) {
      set({ loading: false, lastError: String(err?.message || err) });
    }
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
  }
}));

// 今日产能汇总（跨所有批次）。纯函数，避免放进 zustand selector 造成无限渲染。
export function computeSummary(batches) {
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

// 轮询：运行中时 2s 一次，全空闲时降到 6s。
export function startPolling() {
  const tick = async () => {
    await useStore.getState().refresh();
    const s = computeSummary(useStore.getState().batches);
    const interval = s.running > 0 ? 2000 : 6000;
    timer = setTimeout(tick, interval);
  };
  let timer = setTimeout(tick, 0);
  return () => clearTimeout(timer);
}
