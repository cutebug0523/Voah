import { useEffect, useMemo, useState } from "react";
import { EmptyHint } from "../components/EmptyHint.jsx";
import { useStore } from "../hooks/useStore.js";
import {
  DEFAULT_PREVIEW_TEXT,
  FALLBACK_TTS_VOICES,
  FONT_OPTIONS,
  MINIMAX_DOCS,
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
  const [voiceSource, setVoiceSource] = useState("");
  const [fonts, setFonts] = useState(FONT_OPTIONS);
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
      const [voiceRes, fontRes] = await Promise.all([
        window.voah?.listTtsVoices?.(),
        window.voah?.listSubtitleFonts?.()
      ]);
      if (!alive) return;
      if (voiceRes?.voices?.length) {
        setVoices(voiceRes.voices);
        setVoiceSource(voiceRes.source === "minimax" ? "MiniMax 官方音色" : "内置音色表");
      }
      if (fontRes?.fonts?.length) {
        setFonts(fontRes.fonts);
      }
    }
    loadOptions();
    return () => {
      alive = false;
    };
  }, []);

  const modules = config?.modules || [];
  const selectedVoice = useMemo(
    () => voices.find((item) => item.voice_id === form?.tts?.voice_id) || voices[0],
    [voices, form?.tts?.voice_id]
  );
  if (!form) return <EmptyHint icon="fa-spinner fa-spin" title="加载中…" />;

  async function saveDefaults() {
    setBusy("settings");
    setMessage("");
    const res = await saveStudioSettings(normalizeSettings(form));
    setBusy("");
    setMessage(res?.ok ? "已保存" : res?.error || "保存失败");
  }

  async function saveKey() {
    if (!keyModal) return;
    setBusy("key");
    setMessage("");
    const res = await setConfig(keyModal.config_key, keyValue);
    setBusy("");
    setMessage(res?.ok ? `${keyModal.module} 已配置` : res?.stderr || res?.error || "配置失败");
    if (res?.ok) {
      setKeyModal(null);
      setKeyValue("");
    }
  }

  async function previewTts() {
    setBusy("preview");
    setMessage("");
    setPreview(null);
    const tts = normalizeSettings(form).tts;
    const res = await window.voah?.ttsPreview?.({
      text: previewText,
      voiceId: tts.voice_id,
      speed: tts.speed,
      emotion: tts.emotion,
      pitch: tts.modify_pitch,
      intensity: tts.intensity,
      timbre: tts.timbre
    });
    setBusy("");
    setPreview(res?.audio_url || res?.audio || null);
    setMessage(res?.ok ? "试听已生成" : res?.stderr || res?.error || "试听失败");
  }

  function selectVoice(voiceId) {
    const voice = voices.find((item) => item.voice_id === voiceId);
    setNested(setForm, "tts.voice_id", voiceId);
    setNested(setForm, "tts.voice_label", voice?.voice_name || voiceId);
  }

  function selectFont(fontId) {
    const font = fonts.find((item) => item.id === fontId);
    if (!font) return;
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

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div className="font-semibold">模型密钥</div>
          <div className="text-[11px] text-ink-400">本机保存，只显示状态</div>
        </div>
        <div className="divide-y divide-slate-50">
          {modules.map((item) => (
            <div key={item.id} className="px-4 py-3 grid grid-cols-[150px_1fr_86px_72px] gap-3 items-center">
              <div className="font-medium text-ink-800">{item.module}</div>
              <div className="text-xs text-ink-500 truncate">{item.model}</div>
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
          <div className="text-[11px] text-ink-400">{voiceSource || "音色加载中"}</div>
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
              <div className="mt-1 text-[11px] text-ink-400 truncate">{selectedVoice?.description || selectedVoice?.voice_id}</div>
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
            <div className="space-y-2">
              <div className="text-xs font-medium text-ink-700">字体</div>
              <div className="grid grid-cols-1 gap-2">
                {fonts.map((font) => (
                  <button
                    key={font.id}
                    onClick={() => selectFont(font.id)}
                    className={`text-left rounded-lg border p-3 ${
                      form.subtitle.font === font.id ? "border-brand-500 bg-brand-50" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink-800">{font.label}</span>
                      <span className={`text-[11px] ${font.installed ? "text-ok" : "text-ink-400"}`}>{font.installed ? "可用" : "未安装"}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-ink-500">{font.style}</div>
                    <div className="mt-2 text-lg leading-none" style={{ fontFamily: font.installed ? `"${font.family}", serif` : "serif" }}>
                      上脸服帖自然
                    </div>
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-ink-400 leading-5">
                字体文件不进仓库；已安装字体会随任务传给字幕渲染。License 来源随字体记录保存。
              </div>
            </div>
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

      <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 font-semibold">来源记录</div>
        <div className="p-4 grid grid-cols-3 gap-3 text-xs text-ink-500">
          <SourceLink label="MiniMax TTS 参数" url={MINIMAX_DOCS.t2a} />
          <SourceLink label="MiniMax 音色接口" url={MINIMAX_DOCS.getVoice} />
          <SourceLink label="系统音色表" url={MINIMAX_DOCS.systemVoiceList} />
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

function KeyModal({ module, value, busy, onChange, onClose, onSave }) {
  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white border border-slate-200 shadow-2xl">
        <div className="h-14 px-4 flex items-center justify-between border-b border-slate-100">
          <div>
            <div className="font-semibold">{module.module}</div>
            <div className="text-[11px] text-ink-400">{module.model}</div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <i className="fa fa-times" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <Field label="密钥">
            <input className="input" type="password" autoFocus value={value} onChange={(e) => onChange(e.target.value)} />
          </Field>
          <div className="text-[11px] text-ink-400">保存后只显示已配置，不回显明文。</div>
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

function SourceLink({ label, url }) {
  return (
    <a className="rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50 truncate" href={url} target="_blank" rel="noreferrer">
      {label}
    </a>
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
      font: subtitle.font || "songti-sc",
      font_label: subtitle.font_label || "系统宋体",
      font_source: subtitle.font_source || "/System/Library/Fonts/Supplemental/Songti.ttc"
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
