import { useEffect, useState } from "react";
import { useStore } from "../hooks/useStore.js";
import { DURATION_PRESETS } from "../lib/status.js";
import { buildProductionArgs } from "../lib/productionArgs.js";

const RESOLUTION_PRESETS = [
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" }
];

export function NewBatchDrawer({ open, onClose, onOpenSample }) {
  const products = useStore((s) => s.products);
  const studioSettings = useStore((s) => s.studioSettings);
  const loadSettings = useStore((s) => s.loadSettings);
  const createBatch = useStore((s) => s.createBatch);

  const [product, setProduct] = useState("");
  const [count, setCount] = useState(20);
  const [duration, setDuration] = useState(45);
  const [customDuration, setCustomDuration] = useState("");
  const [concurrency, setConcurrency] = useState(1);
  const [resolution, setResolution] = useState("720p");
  const [submitting, setSubmitting] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (open && products.length && !product) setProduct(products[0].slug);
  }, [open, products, product]);

  useEffect(() => {
    if (open) loadSettings();
  }, [open, loadSettings]);

  const selected = products.find((p) => p.slug === product);
  const targetDuration = duration === "custom" ? Number(customDuration) || 45 : duration;
  const canSubmit = product && count > 0 && selected?.latest_intake_run && !submitting;

  async function handleRun() {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    const res = await createBatch({
      product,
      count: Number(count),
      targetDuration,
      intakeRun: selected.latest_intake_run,
      concurrency: Number(concurrency),
      resolution,
      extraArgs: buildProductionArgs(studioSettings)
    });
    setSubmitting(false);
    setResult(res);
    if (res?.ok) {
      setTimeout(onClose, 600);
    }
  }

  async function handleSample() {
    if (!canSubmit) return;
    setSampling(true);
    setResult(null);
    const res = await window.voah.createSampleTask({
      product,
      productName: selected?.name || product,
      targetDuration,
      intakeRun: selected.latest_intake_run,
      resolution,
      extraArgs: buildProductionArgs(studioSettings)
    });
    setSampling(false);
    setResult(res);
    if (res?.ok) {
      const taskDir = res.stdout.match(/task_dir=(.*)/)?.[1]?.trim();
      if (taskDir) {
        onOpenSample?.(taskDir);
        onClose?.();
      }
    }
  }

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />}
      <div
        className={`fixed inset-y-0 right-0 w-96 bg-white shadow-2xl border-l border-slate-200 z-50 flex flex-col transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="h-14 px-5 flex items-center justify-between border-b border-slate-100">
          <h2 className="font-semibold text-[15px]">新建批量</h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <i className="fa fa-times" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <Field label="产品">
            <select
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
            >
              {products.length === 0 && <option value="">（无已入库产品）</option>}
              {products.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
            {selected && !selected.latest_intake_run && (
              <p className="text-xs text-err mt-1">该产品还没有入库素材，请先入库。</p>
            )}
          </Field>

          <Field label="数量">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className="w-24 px-3 py-2 rounded-lg border border-slate-200 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              />
              <span className="text-ink-500 text-xs">条</span>
            </div>
          </Field>

          <Field label="时长">
            <div className="grid grid-cols-3 gap-2">
              {DURATION_PRESETS.map((d) => (
                <DurationBtn key={d} active={duration === d} onClick={() => setDuration(d)}>
                  {d}秒
                </DurationBtn>
              ))}
              <DurationBtn active={duration === "custom"} onClick={() => setDuration("custom")}>
                自定义
              </DurationBtn>
            </div>
            {duration === "custom" && (
              <input
                type="number"
                placeholder="秒"
                value={customDuration}
                onChange={(e) => setCustomDuration(e.target.value)}
                className="mt-2 w-24 px-3 py-2 rounded-lg border border-slate-200 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              />
            )}
          </Field>

          <details className="border-t border-slate-100 pt-3">
            <summary className="text-xs text-ink-500 cursor-pointer hover:text-ink-700">
              更多设置
            </summary>
            <div className="mt-3 space-y-3">
              <Field label="并发">
                <input
                  type="number"
                  min="1"
                  max="8"
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                  className="w-20 px-3 py-2 rounded-lg border border-slate-200 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                />
              </Field>
              <Field label="分辨率">
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  className="w-28 px-3 py-2 rounded-lg border border-slate-200 bg-white focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                >
                  {RESOLUTION_PRESETS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </details>

          {result && !result.ok && (
            <div className="text-xs text-err bg-err/5 border border-err/20 rounded-lg p-3">
              批量启动失败：{result.stderr || result.error || `退出码 ${result.code}`}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-slate-100 flex gap-2">
          <button
            onClick={handleSample}
            disabled={!canSubmit || sampling}
            className="flex-1 py-2.5 rounded-lg border border-slate-200 text-ink-700 hover:bg-slate-50 disabled:text-ink-300 disabled:cursor-not-allowed font-medium"
          >
            <i className={`fa ${sampling ? "fa-spinner fa-spin" : "fa-flask"}`} /> {sampling ? "打样中…" : "打样 1 条"}
          </button>
          <button
            onClick={handleRun}
            disabled={!canSubmit}
            className="flex-1 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-ink-300 text-white font-medium shadow-sm"
          >
            {submitting ? "启动中…" : "直接开跑"}
          </button>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-ink-700 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function DurationBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`py-2 rounded-lg font-medium ${
        active ? "border-2 border-brand-500 bg-brand-50 text-brand-700" : "border border-slate-200 text-ink-700 hover:border-brand-500"
      }`}
    >
      {children}
    </button>
  );
}
