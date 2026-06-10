import { useEffect, useState } from "react";
import { EmptyHint } from "../components/EmptyHint.jsx";
import { useStore } from "../hooks/useStore.js";

export function SettingsPage() {
  const config = useStore((s) => s.config);
  const studioSettings = useStore((s) => s.studioSettings);
  const loadSettings = useStore((s) => s.loadSettings);
  const saveStudioSettings = useStore((s) => s.saveStudioSettings);
  const setConfig = useStore((s) => s.setConfig);
  const [form, setForm] = useState(null);
  const [keyDraft, setKeyDraft] = useState({ key: "", value: "" });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (studioSettings && !form) setForm(studioSettings);
  }, [studioSettings, form]);

  if (!form) return <EmptyHint icon="fa-spinner fa-spin" title="加载中…" />;

  async function saveDefaults() {
    setBusy("settings");
    setMessage("");
    const res = await saveStudioSettings(form);
    setBusy("");
    setMessage(res?.ok ? "已保存" : res?.error || "保存失败");
  }

  async function saveKey() {
    setBusy("key");
    setMessage("");
    const res = await setConfig(keyDraft.key, keyDraft.value);
    setBusy("");
    setMessage(res?.ok ? "已配置" : res?.stderr || res?.error || "配置失败");
    if (res?.ok) setKeyDraft({ key: "", value: "" });
  }

  const modules = config?.modules || [];

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 font-semibold">模型 Key</div>
        <div className="divide-y divide-slate-50">
          {modules.map((item) => (
            <div key={item.id} className="px-4 py-3 grid grid-cols-[160px_1fr_86px_72px] gap-3 items-center">
              <div className="font-medium text-ink-800">{item.module}</div>
              <div className="text-xs text-ink-500 truncate">{item.model}</div>
              <Configured ok={item.configured} />
              <button
                onClick={() => setKeyDraft({ key: item.config_key, value: "" })}
                className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-ink-700 hover:bg-slate-50"
              >
                设置
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 font-semibold">生产默认参数</div>
        <div className="p-4 grid grid-cols-3 gap-4">
          <Block title="文案">
            <Field label="平台">
              <input className="input" value={form.copy.platform} onChange={(e) => setNested(setForm, "copy.platform", e.target.value)} />
            </Field>
            <Field label="风格">
              <input className="input" value={form.copy.style} onChange={(e) => setNested(setForm, "copy.style", e.target.value)} />
            </Field>
            <Field label="受众">
              <input className="input" value={form.copy.audience} onChange={(e) => setNested(setForm, "copy.audience", e.target.value)} />
            </Field>
            <Field label="禁忌">
              <textarea className="input h-20 resize-none" value={form.copy.forbidden} onChange={(e) => setNested(setForm, "copy.forbidden", e.target.value)} />
            </Field>
            <Field label="CTA">
              <input className="input" value={form.copy.cta} onChange={(e) => setNested(setForm, "copy.cta", e.target.value)} />
            </Field>
          </Block>

          <Block title="TTS">
            <Field label="音色">
              <input className="input" value={form.tts.voice_id} onChange={(e) => setNested(setForm, "tts.voice_id", e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="语速">
                <input className="input" value={form.tts.speed} onChange={(e) => setNested(setForm, "tts.speed", e.target.value)} />
              </Field>
              <Field label="情绪">
                <input className="input" value={form.tts.emotion} onChange={(e) => setNested(setForm, "tts.emotion", e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Pitch">
                <input className="input" value={form.tts.pitch} onChange={(e) => setNested(setForm, "tts.pitch", e.target.value)} />
              </Field>
              <Field label="Intensity">
                <input className="input" value={form.tts.intensity} onChange={(e) => setNested(setForm, "tts.intensity", e.target.value)} />
              </Field>
              <Field label="Timbre">
                <input className="input" value={form.tts.timbre} onChange={(e) => setNested(setForm, "tts.timbre", e.target.value)} />
              </Field>
            </div>
          </Block>

          <Block title="字幕">
            <Field label="样式">
              <input className="input" value={form.subtitle.preset} onChange={(e) => setNested(setForm, "subtitle.preset", e.target.value)} />
            </Field>
            <Field label="字体">
              <input className="input" value={form.subtitle.font} onChange={(e) => setNested(setForm, "subtitle.font", e.target.value)} />
            </Field>
          </Block>
        </div>
        <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-ink-400">{message}</span>
          <button
            onClick={saveDefaults}
            disabled={busy === "settings"}
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-ink-300 text-white font-medium"
          >
            {busy === "settings" ? "保存中…" : "保存默认参数"}
          </button>
        </div>
      </section>

      {keyDraft.key && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div className="grid grid-cols-[180px_1fr_86px] gap-3 items-end">
            <Field label="Key">
              <input className="input" value={keyDraft.key} readOnly />
            </Field>
            <Field label="Value">
              <input
                className="input"
                type="password"
                value={keyDraft.value}
                onChange={(e) => setKeyDraft((v) => ({ ...v, value: e.target.value }))}
              />
            </Field>
            <button
              onClick={saveKey}
              disabled={!keyDraft.value || busy === "key"}
              className="py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-ink-300 text-white font-medium"
            >
              {busy === "key" ? "保存" : "写入"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Block({ title, children }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 space-y-3">
      <div className="text-xs font-medium text-ink-700">{title}</div>
      {children}
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

function Configured({ ok }) {
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border text-center ${ok ? "text-ok bg-ok/5 border-ok/20" : "text-ink-400 bg-slate-50 border-slate-200"}`}>
      {ok ? "已配置" : "未配置"}
    </span>
  );
}

function setNested(setter, path, value) {
  const keys = path.split(".");
  setter((prev) => {
    const next = structuredClone(prev);
    let cursor = next;
    for (const key of keys.slice(0, -1)) cursor = cursor[key];
    cursor[keys.at(-1)] = value;
    return next;
  });
}

