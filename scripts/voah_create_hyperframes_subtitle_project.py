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


def caption_html(caption: dict[str, Any]) -> str:
    start = float(caption.get("start_s") or 0)
    duration = max(0.01, float(caption.get("duration_s") or 0))
    text = html.escape(str(caption.get("text") or ""))
    keywords = ",".join(html.escape(str(item)) for item in caption.get("keywords") or [])
    order = int(caption.get("caption_order") or 0)
    return f'''      <div
        id="caption-{order:03d}"
        class="clip caption-clip"
        data-start="{start:.3f}"
        data-duration="{max(0.01, duration - 0.01):.3f}"
        data-track-index="2"
      >
        <div
          class="songti-caption"
          data-highlight-text="{text}"
          data-highlight-keywords="{keywords}"
        ></div>
      </div>'''


def build_index_html(project_dir: Path, base_video: Path, voice_audio: Path, plan: dict[str, Any]) -> str:
    duration = float(plan.get("summary", {}).get("total_duration_s") or 0)
    width = int(plan.get("canvas", {}).get("width") or 720)
    height = int(plan.get("canvas", {}).get("height") or 1280)
    captions = "\n".join(caption_html(caption) for caption in plan.get("captions") or [])
    return f'''<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Voah Subtitle Burn</title>
    <style>
      @font-face {{
        font-family: "VoahSongti";
        src: url("./fonts/Songti.ttc");
      }}

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

      .songti-caption {{
        position: absolute;
        left: 34px;
        right: 34px;
        bottom: 260px;
        font-family: "VoahSongti", serif;
        font-size: 54px;
        line-height: 1.08;
        font-weight: 900;
        text-align: center;
        letter-spacing: 0;
        color: #fffdf4;
        -webkit-text-stroke: 2.2px rgba(16, 16, 16, 0.94);
        text-shadow:
          0 2px 0 rgba(255, 255, 255, 0.35),
          3px 5px 7px rgba(0, 0, 0, 0.58),
          0 0 10px rgba(0, 0, 0, 0.22);
      }}

      .songti-caption .highlight {{
        color: #f4d19b;
      }}
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
    fonts_dir = project_dir / "fonts"
    project_dir.mkdir(parents=True, exist_ok=True)
    media_dir.mkdir(parents=True, exist_ok=True)
    fonts_dir.mkdir(parents=True, exist_ok=True)

    plan = load_json(caption_plan)
    font_source = as_abs(plan.get("style", {}).get("font_source") or "")
    if not font_source.exists():
        raise FileNotFoundError(f"font not found: {font_source}")

    base_video = media_dir / "base_video.mp4"
    voice_audio = media_dir / "voice.wav"
    shutil.copy2(base_video_source, base_video)
    shutil.copy2(voice_wav_source, voice_audio)
    shutil.copy2(font_source, fonts_dir / "Songti.ttc")

    design = """# Voah Subtitle Burn

## Style Prompt

美妆带货短视频字幕烧录工程。字幕采用宋体白金描边，固定在下方安全区，突出重点词，但不遮挡产品和人脸中心。

## Colors

- Soft white: `#FFFDF4` for main text.
- Warm gold: `#F4D19B` for keyword highlight.
- Ink stroke: `rgba(16, 16, 16, 0.94)` for readable outline.

## Typography

- Font: bundled `fonts/Songti.ttc` as `VoahSongti`.
- Lower-safe-area captions, 54px, no negative letter spacing.

## What NOT to Do

- Do not use MiniMax subtitle text or ASR text as subtitle source.
- Do not place persistent captions over product center or faces.
- Do not hand-write highlight spans; use keyword matching.
"""
    write_text(project_dir / "DESIGN.md", design)
    write_text(project_dir / "index.html", build_index_html(project_dir, base_video, voice_audio, plan))

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
        "style": plan.get("style") or {},
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
