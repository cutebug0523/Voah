export function buildProductionArgs(settings = {}) {
  const args = [];
  const copy = settings.copy || {};
  const tts = settings.tts || {};
  const subtitle = settings.subtitle || {};
  const render = settings.render || {};
  const mapping = [
    ["--platform", copy.platform],
    ["--style", copy.style],
    ["--audience", copy.audience],
    ["--forbidden", copy.forbidden],
    ["--cta", copy.cta],
    ["--tts-provider", tts.provider],
    ["--tts-model", tts.model],
    ["--voice-id", tts.voice_id],
    ["--speed", tts.speed],
    ["--vol", tts.vol],
    ["--pitch", tts.pitch],
    ["--emotion", tts.emotion],
    ["--modify-pitch", tts.modify_pitch],
    ["--modify-intensity", tts.intensity],
    ["--modify-timbre", tts.timbre],
    ["--subtitle-preset", subtitle.preset],
    ["--font-source", subtitle.font_source],
    ["--hyperframes-workers", render.hyperframes_workers]
  ];
  for (const [flag, value] of mapping) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      args.push(flag, String(value));
    }
  }
  const gpu = String(render.gpu || "auto");
  if (gpu === "on") args.push("--gpu");
  if (gpu === "off") args.push("--no-gpu");
  return args;
}
