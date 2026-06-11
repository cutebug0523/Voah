import { useEffect, useState } from "react";
import { EmptyHint } from "../components/EmptyHint.jsx";
import { useStore } from "../hooks/useStore.js";

const STATUS_META = {
  ready: { label: "就绪", cls: "text-ok bg-ok/5 border-ok/20" },
  intaking: { label: "入库中", cls: "text-run bg-run/5 border-run/20" },
  pending_intake: { label: "待入库", cls: "text-ink-500 bg-slate-50 border-slate-200" }
};

export function ProductsPage() {
  const products = useStore((s) => s.products);
  const loading = useStore((s) => s.loading);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [drawer, setDrawer] = useState(null);

  useEffect(() => {
    if (!selectedSlug && products[0]) setSelectedSlug(products[0].slug);
  }, [products, selectedSlug]);

  if (loading && products.length === 0) {
    return <EmptyHint icon="fa-spinner fa-spin" title="加载中…" />;
  }
  if (products.length === 0) {
    return (
      <>
        <div className="flex-1 grid place-items-center text-center p-10">
          <div>
            <i className="fa fa-cube text-4xl text-ink-300 mb-4" />
            <div className="font-medium text-ink-700">还没有产品</div>
            <div className="text-xs text-ink-400 mt-1 max-w-sm">先创建产品，再从产品详情里启动素材入库。</div>
            <button
              onClick={() => setDrawer("new")}
              className="mt-4 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-medium"
            >
              <i className="fa fa-plus mr-1.5" /> 新建产品
            </button>
          </div>
        </div>
        <ProductDrawer open={drawer === "new"} onClose={() => setDrawer(null)} />
      </>
    );
  }

  const selected = products.find((p) => p.slug === selectedSlug) || products[0];

  return (
    <div className="flex-1 overflow-hidden p-6 grid grid-cols-[320px_1fr] gap-4">
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <span className="font-semibold">产品列表</span>
          <button onClick={() => setDrawer("new")} className="text-xs text-brand-600 hover:underline">
            <i className="fa fa-plus" /> 新建
          </button>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
          {products.map((product) => (
            <button
              key={product.slug}
              onClick={() => setSelectedSlug(product.slug)}
              className={`w-full px-4 py-3 text-left row-hover ${selected?.slug === product.slug ? "bg-brand-50" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink-900 truncate">{product.name}</span>
                <Status status={product.status} />
              </div>
              <div className="text-xs text-ink-400 mt-1 truncate">{product.slug}</div>
              <div className="text-xs text-ink-500 mt-1">入库 {product.intake_run_count || 0} 次</div>
            </button>
          ))}
        </div>
      </section>

      <ProductDetail product={selected} onStartIntake={() => setDrawer("intake")} />
      <ProductDrawer open={drawer === "new"} onClose={() => setDrawer(null)} />
      <IntakeDrawer product={selected} open={drawer === "intake"} onClose={() => setDrawer(null)} />
    </div>
  );
}

function ProductDetail({ product, onStartIntake }) {
  const refresh = useStore((s) => s.refresh);
  const [detail, setDetail] = useState(null);
  const [edit, setEdit] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    setDetail(null);
    if (product?.slug) {
      window.voah?.inspectProduct(product.slug).then((res) => {
        if (alive) {
          setDetail(res);
          setEdit(toEditState(res, product));
        }
      });
    }
    return () => {
      alive = false;
    };
  }, [product?.slug]);

  if (!product) return null;
  const claims = detail?.claims?.claims || [];
  const campaigns = detail?.campaigns?.campaigns || [];
  const blocked = detail?.blocked_terms?.terms || [];
  const runs = detail?.intake_runs || [];

  async function save() {
    setSaving(true);
    setMessage("");
    const res = await window.voah.saveProductDetail({
      slug: product.slug,
      product: { name: edit.name, brand: edit.brand, cta: edit.cta },
      claims: edit.claims,
      campaigns: edit.campaigns,
      blockedTerms: edit.blockedTerms
    });
    setSaving(false);
    setMessage(res?.ok ? "已保存" : res?.error || "保存失败");
    await refresh();
    const next = await window.voah.inspectProduct(product.slug);
    setDetail(next);
    setEdit(toEditState(next, product));
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
        <div className="min-w-0">
          <div className="font-semibold truncate">{product.name}</div>
          <div className="text-xs text-ink-400 mt-0.5 truncate">{product.brand || product.slug}</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={!edit || saving}
            className="px-3 py-2 rounded-lg border border-slate-200 text-ink-700 hover:bg-slate-50 disabled:opacity-50 font-medium"
          >
            {saving ? "保存中…" : "保存资料"}
          </button>
          <button
            onClick={onStartIntake}
            className="px-3 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-medium shadow-sm"
          >
            <i className="fa fa-upload mr-1.5" /> 素材入库
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 p-3 space-y-3">
          <div className="text-xs font-medium text-ink-700">基础信息</div>
          <Field label="产品名">
            <input className="input" value={edit?.name || ""} onChange={(e) => setEdit((v) => ({ ...v, name: e.target.value }))} />
          </Field>
          <Field label="品牌">
            <input className="input" value={edit?.brand || ""} onChange={(e) => setEdit((v) => ({ ...v, brand: e.target.value }))} />
          </Field>
          <Field label="CTA">
            <input className="input" value={edit?.cta || ""} onChange={(e) => setEdit((v) => ({ ...v, cta: e.target.value }))} />
          </Field>
          {message && <div className="text-xs text-ink-500">{message}</div>}
        </div>
        <EditableBlock
          title="卖点 TOP"
          value={edit?.claims || linesFromItems(claims)}
          onChange={(value) => setEdit((v) => ({ ...v, claims: value }))}
          empty="一行一个卖点"
        />
        <EditableBlock
          title="活动优惠"
          value={edit?.campaigns || linesFromItems(campaigns)}
          onChange={(value) => setEdit((v) => ({ ...v, campaigns: value }))}
          empty="一行一个活动"
        />
        <EditableBlock
          title="禁忌词"
          value={edit?.blockedTerms || linesFromItems(blocked)}
          onChange={(value) => setEdit((v) => ({ ...v, blockedTerms: value }))}
          empty="一行一个禁忌"
        />
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 text-xs font-medium text-ink-700">入库记录</div>
          {runs.length === 0 ? (
            <div className="p-3 text-xs text-ink-400">暂无入库记录</div>
          ) : (
            <div className="divide-y divide-slate-50">
              {runs.map((run) => (
                <div key={run.run_dir} className="px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{run.name}</div>
                    <div className="text-[11px] text-ink-400">{run.shot_count != null ? `${run.shot_count} 段` : "处理中"}</div>
                  </div>
                  <button onClick={() => window.voah?.reveal(run.run_dir)} className="text-xs text-brand-600 hover:underline">
                    目录
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function EditableBlock({ title, value, onChange, empty }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <label className="block text-xs font-medium text-ink-700 mb-1.5">{title}</label>
      <textarea className="input h-32 resize-none text-xs leading-5" value={value} onChange={(e) => onChange(e.target.value)} placeholder={empty} />
    </div>
  );
}

function toEditState(detail, product) {
  return {
    name: detail?.product?.name || product?.name || "",
    brand: detail?.product?.brand || product?.brand || "",
    cta: detail?.product?.cta || "",
    claims: linesFromItems(detail?.claims?.claims || []),
    campaigns: linesFromItems(detail?.campaigns?.campaigns || []),
    blockedTerms: linesFromItems(detail?.blocked_terms?.terms || [])
  };
}

function linesFromItems(items) {
  return (items || []).map((item) => item.text || item.claim || item.name || item.term || item).filter(Boolean).join("\n");
}

function ProductDrawer({ open, onClose }) {
  const createProduct = useStore((s) => s.createProduct);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    const res = await createProduct({ slug, name, brand });
    setBusy(false);
    if (res?.ok) {
      setSlug("");
      setName("");
      setBrand("");
      onClose?.();
    } else {
      setError(res?.stderr || res?.error || "创建失败");
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
        <DrawerHead title="新建产品" onClose={onClose} />
        <div className="flex-1 p-5 space-y-4">
          <Field label="产品编号">
            <input value={slug} onChange={(e) => setSlug(e.target.value)} className="input" placeholder="huaxizi-qidian" />
          </Field>
          <Field label="产品名">
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="花西子气垫" />
          </Field>
          <Field label="品牌">
            <input value={brand} onChange={(e) => setBrand(e.target.value)} className="input" placeholder="花西子" />
          </Field>
          {error && <div className="text-xs text-err bg-err/5 border border-err/20 rounded-lg p-3">{error}</div>}
        </div>
        <div className="p-5 border-t border-slate-100">
          <button
            onClick={submit}
            disabled={!slug || busy}
            className="w-full py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-ink-300 text-white font-medium"
          >
            {busy ? "创建中…" : "创建产品"}
          </button>
        </div>
      </div>
    </>
  );
}

function IntakeDrawer({ product, open, onClose }) {
  const startIntake = useStore((s) => s.startIntake);
  const [sourceDir, setSourceDir] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function choose() {
    const res = await window.voah?.chooseDirectory();
    if (res?.ok) setSourceDir(res.path);
  }

  async function submit() {
    setBusy(true);
    setResult(null);
    const res = await startIntake({
      product: product.slug,
      productName: product.name,
      sourceDir,
      limit: limit ? Number(limit) : undefined
    });
    setBusy(false);
    setResult(res);
    if (res?.ok) setTimeout(onClose, 700);
  }

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />}
      <div
        className={`fixed inset-y-0 right-0 w-[420px] bg-white shadow-2xl border-l border-slate-200 z-50 flex flex-col transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <DrawerHead title="素材入库" onClose={onClose} />
        <div className="flex-1 p-5 space-y-4">
          <div className="text-xs text-ink-500">
            {product?.name} · {product?.slug}
          </div>
          <Field label="源目录">
            <div className="flex gap-2">
              <input value={sourceDir} onChange={(e) => setSourceDir(e.target.value)} className="input flex-1" />
              <button onClick={choose} className="px-3 rounded-lg border border-slate-200 text-ink-700 hover:bg-slate-50">
                选择
              </button>
            </div>
          </Field>
          <Field label="数量上限">
            <input value={limit} onChange={(e) => setLimit(e.target.value)} className="input w-28" placeholder="全部" />
          </Field>
          {result && (
            <div className={`text-xs rounded-lg p-3 border ${result.ok ? "text-run bg-run/5 border-run/20" : "text-err bg-err/5 border-err/20"}`}>
              {result.ok ? "入库任务已启动" : result.stderr || result.error || "启动失败"}
            </div>
          )}
        </div>
        <div className="p-5 border-t border-slate-100">
          <button
            onClick={submit}
            disabled={!sourceDir || !product?.slug || busy}
            className="w-full py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-ink-300 text-white font-medium"
          >
            {busy ? "启动中…" : "开始入库"}
          </button>
        </div>
      </div>
    </>
  );
}

function DrawerHead({ title, onClose }) {
  return (
    <div className="h-14 px-5 flex items-center justify-between border-b border-slate-100">
      <h2 className="font-semibold text-[15px]">{title}</h2>
      <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
        <i className="fa fa-times" />
      </button>
    </div>
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

function Status({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending_intake;
  return <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>;
}
