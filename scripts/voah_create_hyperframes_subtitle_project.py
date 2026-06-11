#!/usr/bin/env python3
"""Create a HyperFrames subtitle burn project from a Voah caption plan."""

from __future__ import annotations

import argparse
import html
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        f.write(text)


def as_abs(path: str | Path, base: Path | None = None) -> Path:
    value = Path(path).expanduser()
    if not value.is_absolute() and base is not None:
        value = base / value
    return value.resolve()


def rel(path: Path, base: Path) -> str:
    return path.relative_to(base).as_posix()


def caption_class_for_preset(preset: str) -> str:
    if preset == "live_bar_lower":
        return "live-bar-caption"
    return "songti-caption"


def embedded_font_name(font_source: Path) -> str:
    return f"VoahFont{font_source.suffix.lower().replace('.', '').upper()}"


def should_embed_font(font_source: Path, max_mb: float = 8.0) -> bool:
    if not font_source.exists() or not font_source.is_file():
        return False
    if font_source.suffix.lower() not in {".ttf", ".otf", ".woff", ".woff2"}:
        return False
    return font_source.stat().st_size <= max_mb * 1024 * 1024


def font_face_css(font_source: Path, project_dir: Path) -> tuple[str, str, dict[str, Any]]:
    fallback_stack = '"Songti SC", "Songti TC", STSong, "Noto Serif CJK SC", serif'
    if not should_embed_font(font_source):
        reason = "missing"
        size_mb = 0.0
        if font_source.exists() and font_source.is_file():
            size_mb = round(font_source.stat().st_size / 1024 / 1024, 3)
            reason = "unsupported_or_too_large"
        family = "VoahSystemSongti"
        local_candidates = ["Songti SC", "Songti TC", "STSong", "Noto Serif CJK SC"]
        local_sources = ", ".join(f'local("{candidate}")' for candidate in local_candidates)
        return (
            f'''      @font-face {{
        font-family: "{family}";
        src: {local_sources};
      }}
''',
            f'"{family}", serif',
            {
                "font_family": family,
                "font_stack": f'"{family}", serif',
                "font_source": str(font_source) if str(font_source) else "",
                "font_policy": "system_local_font_face_no_copy",
                "embedded": False,
                "font_size_mb": size_mb,
                "local_font_candidates": local_candidates,
                "reason": reason,
            },
        )

    fonts_dir = project_dir / "fonts"
    fonts_dir.mkdir(parents=True, exist_ok=True)
    target = fonts_dir / font_source.name
    shutil.copyfile(font_source, target)
    family = embedded_font_name(font_source)
    rel_target = rel(target, project_dir)
    return (
        f'''      @font-face {{
        font-family: "{family}";
        src: url("./{rel_target}");
      }}
''',
        f'"{family}", {fallback_stack}',
        {
            "font_family": family,
            "font_stack": f'"{family}", {fallback_stack}',
            "font_source": str(font_source),
            "font_policy": "embed_small_web_font",
            "embedded": True,
            "embedded_font": str(target),
            "font_size_mb": round(font_source.stat().st_size / 1024 / 1024, 3),
        },
    )


def style_css_for_preset(preset: str, font_stack: str) -> str:
    if preset == "live_bar_lower":
        css = """
      .live-bar-caption {
        position: absolute;
        left: 46px;
        right: 46px;
        bottom: 246px;
        min-height: 94px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 18px 30px 20px;
        border-radius: 8px;
        font-family: __VOAH_CAPTION_FONT_STACK__;
        font-size: 44px;
        line-height: 1.12;
        font-weight: 900;
        text-align: center;
        letter-spacing: 0;
        color: #fffdf4;
        background: rgba(18, 22, 20, 0.82);
        border: 2px solid rgba(244, 209, 155, 0.78);
        box-shadow:
          0 10px 26px rgba(0, 0, 0, 0.36),
          inset 0 0 0 1px rgba(255, 255, 255, 0.12);
        text-shadow: 2px 3px 5px rgba(0, 0, 0, 0.62);
      }

      .live-bar-caption .highlight {
        color: #f6cf82;
      }
"""
        return css.replace("__VOAH_CAPTION_FONT_STACK__", font_stack)
    css = """
      .songti-caption {
        position: absolute;
        left: 34px;
        right: 34px;
        bottom: 260px;
        box-sizing: border-box;
        max-width: 652px;
        font-family: __VOAH_CAPTION_FONT_STACK__;
        font-size: 54px;
        line-height: 1.08;
        font-weight: 900;
        text-align: center;
        letter-spacing: 0;
        white-space: normal;
        word-break: break-word;
        overflow-wrap: break-word;
        color: #fffdf4;
        -webkit-text-stroke: 2.2px rgba(16, 16, 16, 0.94);
        text-shadow:
          0 2px 0 rgba(255, 255, 255, 0.35),
          3px 5px 7px rgba(0, 0, 0, 0.58),
          0 0 10px rgba(0, 0, 0, 0.22);
      }

      .songti-caption .highlight {
        color: #f4d19b;
      }
"""
    return css.replace("__VOAH_CAPTION_FONT_STACK__", font_stack)


def caption_html(caption: dict[str, Any], preset: str) -> str:
    start = float(caption.get("start_s") or 0)
    duration = max(0.01, float(caption.get("duration_s") or 0))
    text = html.escape(str(caption.get("text") or ""))
    keywords = ",".join(html.escape(str(item)) for item in caption.get("keywords") or [])
    order = int(caption.get("caption_order") or 0)
    caption_class = caption_class_for_preset(preset)
    return f'''      <div
        id="caption-{order:03d}"
        class="clip caption-clip"
        data-start="{start:.3f}"
        data-duration="{max(0.01, duration - 0.01):.3f}"
        data-track-index="2"
      >
        <div
          class="{caption_class}"
          data-highlight-text="{text}"
          data-highlight-keywords="{keywords}"
        ></div>
      </div>'''


def build_index_html(project_dir: Path, base_video: Path, voice_audio: Path, plan: dict[str, Any], font_css: str, font_stack: str) -> str:
    duration = float(plan.get("summary", {}).get("total_duration_s") or 0)
    width = int(plan.get("canvas", {}).get("width") or 720)
    height = int(plan.get("canvas", {}).get("height") or 1280)
    preset = str(plan.get("style", {}).get("preset") or "songti_white_gold_lower")
    captions = "\n".join(caption_html(caption, preset) for caption in plan.get("captions") or [])
    preset_css = style_css_for_preset(preset, font_stack)
    return f'''<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Voah Subtitle Burn</title>
    <style>
{font_css}
      html,
      body {{
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #071016;
      }}

      #voah-subtitle-burn {{
        position: relative;
        width: {width}px;
        height: {height}px;
        overflow: hidden;
        background: #071016;
      }}

      .base-video {{
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        background: #071016;
      }}

      .vignette {{
        position: absolute;
        inset: 0;
        z-index: 2;
        pointer-events: none;
        background:
          linear-gradient(180deg, rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0) 28%, rgba(0, 0, 0, 0) 66%, rgba(0, 0, 0, 0.16)),
          radial-gradient(circle at 50% 52%, rgba(0, 0, 0, 0) 58%, rgba(0, 0, 0, 0.1));
      }}

      .caption-clip {{
        position: absolute;
        inset: 0;
        z-index: 5;
        pointer-events: none;
      }}

{preset_css}
    </style>
  </head>
  <body>
    <div
      id="voah-subtitle-burn"
      data-composition-id="voah-subtitle-burn"
      data-start="0"
      data-width="{width}"
      data-height="{height}"
      data-duration="{duration:.3f}"
    >
      <video
        id="base-video"
        class="base-video"
        src="./{rel(base_video, project_dir)}"
        data-start="0"
        data-duration="{duration:.3f}"
        data-track-index="0"
        muted
        playsinline
      ></video>
      <audio
        id="voice-audio"
        src="./{rel(voice_audio, project_dir)}"
        data-start="0"
        data-duration="{duration:.3f}"
        data-track-index="1"
        data-volume="1"
      ></audio>
      <div class="vignette" data-layout-ignore></div>
{captions}
    </div>

    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script>
      window.__timelines = window.__timelines || {{}};
      function escapeHtml(value) {{
        return value
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }}

      function applyKeywordHighlights(root) {{
        root.querySelectorAll("[data-highlight-text]").forEach((node) => {{
          const text = node.dataset.highlightText || "";
          const keywords = (node.dataset.highlightKeywords || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);
          const parts = [];
          let index = 0;
          while (index < text.length) {{
            const match = keywords.find((keyword) => text.startsWith(keyword, index));
            if (match) {{
              parts.push(`<span class="highlight">${{escapeHtml(match)}}</span>`);
              index += match.length;
            }} else {{
              parts.push(escapeHtml(text[index]));
              index += 1;
            }}
          }}
          node.innerHTML = parts.join("");
        }});
      }}

      applyKeywordHighlights(document);
      window.__timelines["voah-subtitle-burn"] = gsap.timeline({{ paused: true }});
    </script>
  </body>
</html>
'''


def main() -> int:
    parser = argparse.ArgumentParser(description="Create HyperFrames project for Voah subtitle burn.")
    parser.add_argument("--caption-plan", required=True)
    parser.add_argument("--base-video", required=True)
    parser.add_argument("--voice-wav", required=True)
    parser.add_argument("--project-dir", required=True)
    args = parser.parse_args()

    caption_plan = as_abs(args.caption_plan)
    base_video_source = as_abs(args.base_video)
    voice_wav_source = as_abs(args.voice_wav)
    project_dir = as_abs(args.project_dir)
    media_dir = project_dir / "media"
    project_dir.mkdir(parents=True, exist_ok=True)
    media_dir.mkdir(parents=True, exist_ok=True)

    plan = load_json(caption_plan)
    preset = str(plan.get("style", {}).get("preset") or "songti_white_gold_lower")
    font_source = as_abs(plan.get("style", {}).get("font_source") or "")
    font_css, font_stack, font_policy = font_face_css(font_source, project_dir)

    base_video = media_dir / "base_video.mp4"
    voice_audio = media_dir / "voice.wav"
    shutil.copy2(base_video_source, base_video)
    shutil.copy2(voice_wav_source, voice_audio)

    preset_label = "直播间口播条，下方安全区" if preset == "live_bar_lower" else "宋体白金描边，下方安全区"
    design = f"""# Voah Subtitle Burn

## Style Prompt

美妆带货短视频字幕烧录工程。字幕采用{preset_label}，突出重点词，但不遮挡产品和人脸中心。

## Colors

- Soft white: `#FFFDF4` for main text.
- Warm gold: `#F4D19B` for keyword highlight.
- Ink stroke: `rgba(16, 16, 16, 0.94)` for readable outline.

## Typography

- Font: `{font_policy.get("font_family")}` via `{font_policy.get("font_policy")}`.
- Preset: `{preset}`.
- Lower-safe-area captions, no negative letter spacing.

## What NOT to Do

- Do not use MiniMax subtitle text or ASR text as subtitle source.
- Do not place persistent captions over product center or faces.
- Do not hand-write highlight spans; use keyword matching.
"""
    write_text(project_dir / "DESIGN.md", design)
    write_text(project_dir / "index.html", build_index_html(project_dir, base_video, voice_audio, plan, font_css, font_stack))

    manifest = {
        "schema_version": "1.0.0",
        "stage": "hyperframes_subtitle_project",
        "created_at": iso_now(),
        "inputs": {
            "caption_plan": str(caption_plan),
            "base_video": str(base_video_source),
            "voice_wav": str(voice_wav_source),
        },
        "outputs": {
            "project_dir": str(project_dir),
            "index_html": str(project_dir / "index.html"),
            "design": str(project_dir / "DESIGN.md"),
            "next_artifact": str(project_dir / "final_subtitled.mp4"),
        },
        "policy": plan.get("policy") or {},
        "style": {
            **(plan.get("style") or {}),
            **font_policy,
        },
        "qa": {
            "status": "ok",
            "warnings": [],
        },
        "next_consumers": ["hyperframes-render", "voah-render-qa"],
    }
    write_json(project_dir / "hyperframes_subtitle_burn_manifest.json", manifest)
    print(f"project_dir={project_dir}")
    print(f"index_html={project_dir / 'index.html'}")
    print(f"caption_count={len(plan.get('captions') or [])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
