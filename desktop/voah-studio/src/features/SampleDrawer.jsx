import { useEffect, useMemo, useState } from "react";
import { useStore } from "../hooks/useStore.js";

export function SampleDrawer({ taskDir, onClose }) {
  const products = useStore((s) => s.products);
  const studioSettings = useStore((s) => s.studioSettings);
  const loadSettings = useStore((s) => s.loadSettings);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setText("");
    if (taskDir) {
      window.voah?.taskDetail(taskDir).then((res) => {
        if (!alive) return;
        setDetail(res);
        setText((res.voice_script?.script_sections || []).map((s) => s.voice_text || s.tts_text || "").join("\n"));
      });
    }
    return () => {
      alive = false;
    };
  }, [taskDir]);

  const open = Boolean(taskDir);
  const sections = useMemo(() => text.split(/\n+/).map((line) => line.trim()).filter(Boolean), [text]);

  async function reload() {
    const res = await window.voah.taskDetail(taskDir);
    setDetail(res);
    setText((res.voice_script?.script_sections || []).map((s) => s.voice_text || s.tts_text || "").join("\n"));
  }

  async function runCopy() {
    setBusy("copy");
    setMessage("");
    const res = await window.voah.runCopyStage(taskDir);
    setBusy("");
    setMessage(res?.ok ? "文案已生成" : res?.stderr || res?.error || "文案失败");
    await reload();
  }

  async function saveScript() {
    setBusy("save");
    const old = detail?.voice_script || {};
    const next = {
      ...old,
      script_sections: sections.map((line, index) => ({
        ...(old.script_sections?.[index] || {}),
        voice_text: line,
        tts_text: line
      }))
    };
    const res = await window.voah.saveVoiceScript({ taskDir, voiceScript: next });
    setBusy("");
    setMessage(res?.ok ? "已保存，下游会重跑" : res?.error || "保存失败");
    await reload();
  }

  async function runTts() {
    setBusy("tts");
    setMessage("");
    const res = await window.voah.runTtsStage(taskDir);
    setBusy("");
    setMessage(res?.ok ? "配音已生成" : res?.stderr || res?.error || "配音失败");
    await reload();
  }

  async function previewTts() {
    const settings = studioSettings?.tts || {};
    setBusy("preview");
    setPreview(null);
    const res = await window.voah.ttsPreview({
      text: sections[0] || text || "这个妆效真的很适合日常出门。",
      voiceId: settings.voice_id,
      speed: settings.speed,
      emotion: settings.emotion,
      pitch: settings.pitch,
      intensity: settings.intensity,
      timbre: settings.timbre
    });
    setBusy("");
    setPreview(res?.audio || null);
    setMessage(res?.ok ? "试听已生成" : res?.stderr || res?.error || "试听失败");
  }

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />}
      <div
        className={`fixed inset-y-0 right-0 w-[560px] bg-white shadow-2xl border-l border-slate-200 z-50 flex flex-col transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="h-14 px-5 flex items-center justify-between border-b border-slate-100">
          <div>
            <h2 className="font-semibold text-[15px]">精修打样</h2>
            <div className="text-[11px] text-ink-400">{detail?.product_name || products[0]?.name || ""}</div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <i className="fa fa-times" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {!detail ? (
            <div className="text-sm text-ink-400">加载中…</div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Action label="生成文案" icon="fa-magic" busy={busy === "copy"} onClick={runCopy} />
                <Action label="保存文案" icon="fa-save" busy={busy === "save"} onClick={saveScript} disabled={!sections.length} />
                <Action label="生成配音" icon="fa-volume-up" busy={busy === "tts"} onClick={runTts} disabled={!sections.length} />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-700 mb-1.5">连续口播稿</label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className="input h-72 resize-none leading-6"
                  placeholder="先生成文案，或手动输入每段口播。"
                />
              </div>

              <div className="rounded-xl border border-slate-200 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-700">配音试听</span>
                  <button
                    onClick={previewTts}
                    disabled={busy === "preview"}
                    className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-ink-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {busy === "preview" ? "生成中…" : "试听首段"}
                  </button>
                </div>
                {preview && <audio controls src={`file://${preview}`} className="w-full" />}
                {detail.voice_wav && <audio controls src={`file://${detail.voice_wav}`} className="w-full" />}
              </div>

              {message && <div className="text-xs text-ink-500 bg-slate-50 border border-slate-200 rounded-lg p-3">{message}</div>}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Action({ label, icon, busy, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className="py-2 rounded-lg border border-slate-200 text-ink-700 hover:bg-slate-50 disabled:opacity-50 font-medium"
    >
      <i className={`fa ${busy ? "fa-spinner fa-spin" : icon} mr-1.5`} />
      {label}
    </button>
  );
}

