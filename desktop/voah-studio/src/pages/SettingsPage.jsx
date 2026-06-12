import { useEffect, useMemo, useState } from "react";
import { EmptyHint } from "../components/EmptyHint.jsx";
import { useStore } from "../hooks/useStore.js";
import {
  DEFAULT_PREVIEW_TEXT,
  FALLBACK_TTS_VOICES,
  FONT_OPTIONS,
  SUBTITLE_PRESETS,
  TTS_EMOTIONS,
  TTS_RANGES
} from "../lib/studioOptions.js";

export function SettingsPage() {
  const config = useStore((s) => s.config);
  const studioSettings = useStore((s) => s.studioSettings);
  const loadSettings = useStore((s) => s.loadSettings);
  const saveStudioSettings = useStore((s) => s.saveStudioSettings);
  const setConfig = useStore((s) => s.setConfig);
  const [form, setForm] = useState(null);
  const [keyModal, setKeyModal] = useState(null);
  const [keyValue, setKeyValue] = useState("");
  const [voices, setVoices] = useState(FALLBACK_TTS_VOICES);
  const [fonts, setFonts] = useState(FONT_OPTIONS);
  const [fontsReady, setFontsReady] = useState(false);
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (studioSettings && !form) setForm(normalizeSettings(studioSettings));
  }, [studioSettings, form]);

  useEffect(() => {
    let alive = true;
    async function loadOptions() {
      window.voah?.listSubtitleFonts?.()
        .then((fontRes) => {
          if (!alive) return;
          if (fontRes?.fonts?.length) {
            setFonts(fontRes.fonts);
          }
          setFontsReady(true);
        })
        .catch(() => {
          if (alive) setFontsReady(true);
        });
      const voiceRes = await window.voah?.listTtsVoices?.();
      if (!alive) return;
      if (voiceRes?.voices?.length) {
        setVoices(voiceRes.voices);
      }
    }
    loadOptions();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    injectFontFaces(fonts);
  }, [fonts]);

  const modules = config?.modules || [];
  const providers = config?.providers || providersFromModules(modules);
  const selectedVoice = useMemo(
    () => voices.find((item) => item.voice_id === form?.tts?.voice_id) || voices[0],
    [voices, form?.tts?.voice_id]
  );
  const availableFonts = useMemo(
    () => fonts.filter((item) => !fontsReady || item.installed),
    [fonts, fontsReady]
  );
  const selectedFont = useMemo(
    () => {
      const candidates = availableFonts.length ? availableFonts : fonts;
      return candidates.find((item) => item.id === form?.subtitle?.font) || candidates.find((item) => item.installed_path === form?.subtitle?.font_source) || candidates[0];
    },
    [availableFonts, fonts, form?.subtitle?.font, form?.subtitle?.font_source]
  );
  if (!form) return <EmptyHint icon="fa-spinner fa-spin" title="加载中…" />;

  async function saveDefaults() {
    setBusy("settings");
    setMessage("");
    const res = await saveStudioSettings(normalizedForm());
    setBusy("");
    setMessage(res?.ok ? "已保存" : res?.error || "保存失败");
  }

  async function saveKey() {
    if (!keyModal) return;
    setBusy("key");
    setMessage("");
    const res = await setConfig(keyModal.config_key, keyValue);
    setBusy("");
    setMessage(res?.ok ? `${keyModal.name || keyModal.module} 已配置` : res?.stderr || res?.error || "配置失败");
    if (res?.ok) {
      setKeyModal(null);
      setKeyValue("");
    }
  }

  async function previewTts() {
    setBusy("preview");
    setMessage("");
    setPreview(null);
    const tts = normalizedForm().tts;
    const res = await window.voah?.ttsPreview?.({
      text: previewText,
      provider: tts.provider,
      model: tts.model,
      voiceId: tts.voice_id,
      speed: tts.speed,
      vol: tts.vol,
      voiceSettingPitch: tts.pitch,
      emotion: tts.emotion,
      modifyPitch: tts.modify_pitch,
      intensity: tts.intensity,
      timbre: tts.timbre
    });
    setBusy("");
    setPreview(res?.audio_url || null);
    setMessage(res?.ok && res?.audio_url ? "试听已生成" : res?.stderr || res?.error || "试听失败");
  }

  function selectVoice(voiceId) {
    const voice = voices.find((item) => item.voice_id === voiceId);
    setNested(setForm, "tts.voice_id", voiceId);
    setNested(setForm, "tts.voice_label", voice?.voice_name || voiceId);
  }

  function selectFont(fontId) {
    const font = fonts.find((item) => item.id === fontId);
    if (!font) return;
    applyFont(font);
  }

  function applyFont(font) {
    setForm((prev) => ({
      ...prev,
      subtitle: {
        ...(prev.subtitle || {}),
        font: font.id,
        font_label: font.label,
        font_source: font.installed_path || ""
      }
    }));
  }

  function normalizedForm() {
    const normalized = normalizeSettings(form);
    const font = selectedFont || availableFonts[0] || fonts[0];
    if (font) {
      normalized.subtitle = {
        ...(normalized.subtitle || {}),
        font: font.id,
        font_label: font.label,
        font_source: font.installed_path || normalized.subtitle?.font_source || ""
      };
    }
    return normalized;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div className="font-semibold">模型密钥</div>
        </div>
        <div className="divide-y divide-slate-50">
          {providers.map((item) => (
            <div key={item.id} className="px-4 py-3 grid grid-cols-[150px_1fr_86px_72px] gap-3 items-center">
              <div className="font-medium text-ink-800">{item.name}</div>
              <div className="text-xs text-ink-500 truncate">{providerModels(item, modules)}</div>
              <Configured ok={item.configured} />
              <button
                onClick={() => {
                  setKeyModal(item);
                  setKeyValue("");
                }}
                className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-ink-700 hover:bg-slate-50"
              >
                设置
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div className="font-semibold">生产默认参数</div>
        </div>
        <div className="p-4 grid grid-cols-[1fr_1.25fr_1fr] gap-4 items-start">
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
            <Field label="禁忌词与边界">
              <textarea className="input h-20 resize-none" value={form.copy.forbidden} onChange={(e) => setNested(setForm, "copy.forbidden", e.target.value)} />
            </Field>
            <Field label="行动引导">
              <input className="input" value={form.copy.cta} onChange={(e) => setNested(setForm, "copy.cta", e.target.value)} />
            </Field>
          </Block>

          <Block title="配音">
            <Field label="音色">
              <select className="input" value={selectedVoice?.voice_id || ""} onChange={(e) => selectVoice(e.target.value)}>
                {groupVoices(voices).map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.items.map((voice) => (
                      <option key={voice.voice_id} value={voice.voice_id}>
                        {voice.voice_name || voice.voice_id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <RangeField label="语速" value={form.tts.speed} range={TTS_RANGES.speed} onChange={(value) => setNested(setForm, "tts.speed", value)} />
              <RangeField label="音量" value={form.tts.vol} range={TTS_RANGES.vol} onChange={(value) => setNested(setForm, "tts.vol", value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="情绪">
                <select className="input" value={form.tts.emotion} onChange={(e) => setNested(setForm, "tts.emotion", e.target.value)}>
                  {TTS_EMOTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
              <RangeField label="基础音调" value={form.tts.pitch} range={TTS_RANGES.pitch} onChange={(value) => setNested(setForm, "tts.pitch", value)} />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <RangeField label="音色明暗" value={form.tts.modify_pitch} range={TTS_RANGES.modifyPitch} onChange={(value) => setNested(setForm, "tts.modify_pitch", value)} />
              <RangeField label="声音力度" value={form.tts.intensity} range={TTS_RANGES.intensity} onChange={(value) => setNested(setForm, "tts.intensity", value)} />
              <RangeField label="音色质感" value={form.tts.timbre} range={TTS_RANGES.timbre} onChange={(value) => setNested(setForm, "tts.timbre", value)} />
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-ink-700">试听文案</label>
                <button
                  onClick={previewTts}
                  disabled={busy === "preview" || !previewText.trim()}
                  className="px-3 py-1.5 rounded-md bg-brand-600 hover:bg-brand-700 disabled:bg-ink-300 text-white text-xs font-medium"
                >
                  <i className={`fa ${busy === "preview" ? "fa-spinner fa-spin" : "fa-volume-up"} mr-1`} />
                  {busy === "preview" ? "生成中" : "试听"}
                </button>
              </div>
              <textarea className="input h-16 resize-none" value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
              {preview && <audio className="w-full h-8" src={preview} controls />}
            </div>
          </Block>

          <Block title="字幕">
            <Field label="字幕样式">
              <select className="input" value={form.subtitle.preset} onChange={(e) => setNested(setForm, "subtitle.preset", e.target.value)}>
                {SUBTITLE_PRESETS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="字体">
              <select className="input" value={selectedFont?.id || ""} onChange={(e) => selectFont(e.target.value)}>
                {availableFonts.map((font) => (
                  <option key={font.id} value={font.id}>
                    {font.label}
                  </option>
                ))}
              </select>
              <FontPreview font={selectedFont} ready={fontsReady} />
            </Field>
          </Block>

          <Block title="渲染">
            <Field label="Workers">
              <select className="input" value={form.render.hyperframes_workers} onChange={(e) => setNested(setForm, "render.hyperframes_workers", e.target.value)}>
                <option value="auto">auto</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
              </select>
            </Field>
            <Field label="GPU">
              <select className="input" value={form.render.gpu} onChange={(e) => setNested(setForm, "render.gpu", e.target.value)}>
                <option value="auto">自动</option>
                <option value="on">开启</option>
                <option value="off">关闭</option>
              </select>
            </Field>
          </Block>
        </div>
        <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-ink-400 truncate">{message}</span>
          <button
            onClick={saveDefaults}
            disabled={busy === "settings"}
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-ink-300 text-white font-medium"
          >
            {busy === "settings" ? "保存中…" : "保存默认参数"}
          </button>
        </div>
      </section>

      {keyModal && (
        <KeyModal
          module={keyModal}
          value={keyValue}
          busy={busy === "key"}
          onChange={setKeyValue}
          onClose={() => {
            setKeyModal(null);
            setKeyValue("");
          }}
          onSave={saveKey}
        />
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

function RangeField({ label, value, range, onChange }) {
  const safeValue = value ?? range.defaultValue;
  function update(next) {
    const number = Number(next);
    if (Number.isFinite(number)) onChange(clamp(number, range.min, range.max));
  }
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={safeValue}
          onChange={(e) => update(e.target.value)}
          className="min-w-0 flex-1 accent-brand-600"
        />
        <input
          className="input w-16 px-2 text-center"
          type="number"
          min={range.min}
          max={range.max}
          step={range.step}
          value={safeValue}
          onChange={(e) => update(e.target.value)}
        />
      </div>
    </Field>
  );
}

function Configured({ ok }) {
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border text-center ${ok ? "text-ok bg-ok/5 border-ok/20" : "text-ink-400 bg-slate-50 border-slate-200"}`}>
      {ok ? "已配置" : "未配置"}
    </span>
  );
}

function FontPreview({ font, ready }) {
  if (!font) return null;
  if (ready && !font.installed) return null;
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink-800 truncate">{font.label}</div>
          <div className="text-[11px] text-ink-400 truncate">{font.style}</div>
        </div>
      </div>
      <div className="mt-2 text-xl leading-7 truncate" style={{ fontFamily: `"${font.family}", serif` }}>
        上脸服帖自然
      </div>
    </div>
  );
}

function injectFontFaces(fonts) {
  if (typeof document === "undefined") return;
  const id = "voah-bundled-font-faces";
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = (fonts || [])
    .filter((font) => font.installed && font.font_url && font.family)
    .map((font) => {
      const family = String(font.family).replace(/"/g, "");
      const format = font.font_format || (String(font.installed_path || "").toLowerCase().endsWith(".otf") ? "opentype" : "truetype");
      return `@font-face{font-family:"${family}";src:url("${font.font_url}") format("${format}");font-display:swap;}`;
    })
    .join("\n");
}

function KeyModal({ module, value, busy, onChange, onClose, onSave }) {
  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white border border-slate-200 shadow-2xl">
        <div className="h-14 px-4 flex items-center justify-between border-b border-slate-100">
          <div>
            <div className="font-semibold">{module.name || module.module}</div>
            <div className="text-[11px] text-ink-400">{module.model || module.env_key || ""}</div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <i className="fa fa-times" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <Field label="密钥">
            <input className="input" type="password" autoFocus value={value} onChange={(e) => onChange(e.target.value)} />
          </Field>
        </div>
        <div className="px-4 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg border border-slate-200 text-ink-700 hover:bg-slate-50">
            取消
          </button>
          <button
            onClick={onSave}
            disabled={!value.trim() || busy}
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-ink-300 text-white font-medium"
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </>
  );
}

function setNested(setter, path, value) {
  const keys = path.split(".");
  setter((prev) => {
    const next = structuredClone(prev);
    let cursor = next;
    for (const key of keys.slice(0, -1)) cursor = cursor[key] ||= {};
    cursor[keys.at(-1)] = value;
    return next;
  });
}

function normalizeSettings(settings) {
  const tts = settings?.tts || {};
  const subtitle = settings?.subtitle || {};
  const render = settings?.render || {};
  const legacyModifyPitch = tts.modify_pitch ?? (Number(tts.pitch) > 12 ? tts.pitch : undefined);
  return {
    ...settings,
    copy: settings?.copy || {},
    tts: {
      provider: tts.provider || "minimax-official",
      model: tts.model || "speech-2.8-hd",
      voice_id: tts.voice_id || FALLBACK_TTS_VOICES[0].voice_id,
      voice_label: tts.voice_label || FALLBACK_TTS_VOICES[0].voice_name,
      speed: numberOr(tts.speed, TTS_RANGES.speed.defaultValue),
      vol: numberOr(tts.vol, TTS_RANGES.vol.defaultValue),
      pitch: clamp(numberOr(Number(tts.pitch) > 12 ? 0 : tts.pitch, TTS_RANGES.pitch.defaultValue), TTS_RANGES.pitch.min, TTS_RANGES.pitch.max),
      emotion: tts.emotion || "happy",
      modify_pitch: clamp(numberOr(legacyModifyPitch, TTS_RANGES.modifyPitch.defaultValue), TTS_RANGES.modifyPitch.min, TTS_RANGES.modifyPitch.max),
      intensity: clamp(numberOr(tts.intensity, TTS_RANGES.intensity.defaultValue), TTS_RANGES.intensity.min, TTS_RANGES.intensity.max),
      timbre: clamp(numberOr(tts.timbre, TTS_RANGES.timbre.defaultValue), TTS_RANGES.timbre.min, TTS_RANGES.timbre.max)
    },
    subtitle: {
      preset: subtitle.preset === "方案1" ? "songti_white_gold_lower" : subtitle.preset || "songti_white_gold_lower",
      font: subtitle.font || "smiley-sans",
      font_label: subtitle.font_label || "得意黑",
      font_source: subtitle.font_source || ""
    },
    render: {
      hyperframes_workers: String(render.hyperframes_workers || "auto"),
      gpu: ["on", "off", "auto"].includes(String(render.gpu || "")) ? String(render.gpu) : "auto"
    }
  };
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function groupVoices(voices) {
  const groups = new Map();
  for (const voice of voices || []) {
    const label = voice.group || "其他音色";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(voice);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}

function providersFromModules(modules) {
  const byId = new Map();
  for (const item of modules || []) {
    if (!item.provider_id || item.provider_id === "vectorengine") continue;
    if (!byId.has(item.provider_id)) {
      byId.set(item.provider_id, {
        id: item.provider_id,
        name: item.provider_name,
        config_key: item.config_key,
        configured: item.configured
      });
    }
  }
  return [...byId.values()];
}

function providerModels(provider, modules) {
  return [...new Set((modules || []).filter((item) => item.provider_id === provider.id).map((item) => item.model).filter(Boolean))].join(" / ");
}
