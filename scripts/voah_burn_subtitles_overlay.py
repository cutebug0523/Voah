#!/usr/bin/env python3
"""Burn Voah caption_plan subtitles with PNG overlays and FFmpeg."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        raise TypeError(f"expected JSON object: {path}")
    return payload


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def as_abs(value: str | Path) -> Path:
    return Path(value).expanduser().resolve()


def safe_float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def shell_escape_filter_path(path: Path) -> str:
    value = str(path)
    value = value.replace("\\", "\\\\")
    value = value.replace(":", "\\:")
    value = value.replace("'", "\\'")
    return value


def load_font(font_source: str, size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        Path(font_source).expanduser() if font_source else None,
        Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
        Path("/System/Library/Fonts/PingFang.ttc"),
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            try:
                return ImageFont.truetype(str(candidate), size=size, index=0)
            except OSError:
                continue
    return ImageFont.load_default(size=size)


def text_size(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    stroke_width: int = 0,
) -> tuple[int, int]:
    box = draw.multiline_textbbox(
        (0, 0),
        text,
        font=font,
        spacing=4,
        align="center",
        stroke_width=stroke_width,
    )
    return int(box[2] - box[0]), int(box[3] - box[1])


def line_width_px(text: str, font: ImageFont.ImageFont) -> float:
    if hasattr(font, "getlength"):
        return float(font.getlength(text))
    image = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    box = draw.textbbox((0, 0), text, font=font)
    return float(box[2] - box[0])


def caption_text_max_width(canvas_width: int, preset: str) -> int:
    if preset == "live_bar_lower":
        return max(1, canvas_width - 2 * (46 + 30))
    return max(1, canvas_width - 2 * 34)


def is_line_start_punctuation(char: str) -> bool:
    return char in "！？、!?；;：:\"'”’）)]】》"


def wrap_caption(text: str, font: ImageFont.ImageFont, max_width_px: int) -> str:
    value = str(text or "").strip()
    if not value or line_width_px(value, font) <= max_width_px:
        return value

    lines: list[str] = []
    for raw_line in value.splitlines() or [value]:
        buffer = ""
        for char in raw_line:
            candidate = buffer + char
            if buffer and line_width_px(candidate, font) > max_width_px:
                if is_line_start_punctuation(char) and len(buffer) > 1:
                    lines.append(buffer[:-1].strip())
                    buffer = buffer[-1] + char
                else:
                    lines.append(buffer.strip())
                    buffer = char
            else:
                buffer = candidate
        if buffer.strip():
            lines.append(buffer.strip())
    return "\n".join(line for line in lines if line) or value


def render_caption_png(caption: dict[str, Any], plan: dict[str, Any], output: Path) -> None:
    canvas = plan.get("canvas") or {}
    width = int(canvas.get("width") or 720)
    height = int(canvas.get("height") or 1280)
    style = plan.get("style") or {}
    preset = str(style.get("preset") or "songti_white_gold_lower")
    font_size = 43 if preset == "live_bar_lower" else 54
    font = load_font(str(style.get("font_source") or ""), font_size)
    max_text_width = caption_text_max_width(width, preset)
    text = wrap_caption(str(caption.get("text") or ""), font, max_text_width)

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    stroke = 4 if preset != "live_bar_lower" else 3
    text_w, text_h = text_size(draw, text, font, stroke_width=stroke)
    x = max(24, int((width - text_w) / 2))
    bottom = 246 if preset == "live_bar_lower" else 260
    y = max(24, height - bottom - text_h)

    if preset == "live_bar_lower":
        pad_x = 30
        pad_y = 18
        rect = [
            max(24, x - pad_x),
            max(24, y - pad_y),
            min(width - 24, x + text_w + pad_x),
            min(height - 24, y + text_h + pad_y),
        ]
        draw.rounded_rectangle(rect, radius=8, fill=(18, 22, 20, 210), outline=(244, 209, 155, 200), width=2)

    draw.multiline_text(
        (x, y),
        text,
        font=font,
        fill=(255, 253, 244, 255),
        anchor=None,
        spacing=4,
        align="center",
        stroke_width=stroke,
        stroke_fill=(16, 16, 16, 245),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)


def build_filter(captions: list[dict[str, Any]], overlay_dir: Path) -> tuple[list[str], str]:
    inputs = []
    chains = []
    current = "[0:v]"
    for index, caption in enumerate(captions):
        png = overlay_dir / f"caption_{index + 1:03d}.png"
        inputs.extend(["-i", str(png)])
        start = safe_float(caption.get("start_s"), 0.0)
        end = safe_float(caption.get("end_s"), start + safe_float(caption.get("duration_s"), 0.01))
        if end <= start:
            end = start + 0.01
        out = f"[v{index + 1}]"
        chains.append(
            f"{current}[{index + 2}:v]overlay=0:0:enable='between(t,{start:.3f},{end:.3f})'{out}"
        )
        current = out
    return inputs, ";".join(chains)


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Burn Voah subtitles with PNG overlays.")
    parser.add_argument("--caption-plan", required=True)
    parser.add_argument("--base-video", required=True)
    parser.add_argument("--voice-wav", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--manifest", default="")
    parser.add_argument("--reason", default="hyperframes-render-fallback")
    args = parser.parse_args()

    caption_plan = as_abs(args.caption_plan)
    base_video = as_abs(args.base_video)
    voice_wav = as_abs(args.voice_wav)
    output = as_abs(args.output)
    work_dir = as_abs(args.work_dir)
    manifest_path = as_abs(args.manifest) if args.manifest else work_dir / "overlay_subtitle_burn_manifest.json"
    overlay_dir = work_dir / "overlay_captions"

    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found")
    if not base_video.exists():
        raise FileNotFoundError(base_video)
    if not voice_wav.exists():
        raise FileNotFoundError(voice_wav)

    plan = load_json(caption_plan)
    captions = list(plan.get("captions") or [])
    if not captions:
        raise RuntimeError("caption_plan has no captions")
    for index, caption in enumerate(captions):
        render_caption_png(caption, plan, overlay_dir / f"caption_{index + 1:03d}.png")

    overlay_inputs, filter_complex = build_filter(captions, overlay_dir)
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(base_video),
        "-i",
        str(voice_wav),
        *overlay_inputs,
        "-filter_complex",
        filter_complex,
        "-map",
        f"[v{len(captions)}]",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        "-movflags",
        "+faststart",
        str(output),
    ]
    proc = run(command)
    manifest = {
        "schema_version": "1.0.0",
        "stage": "voah_overlay_subtitle_burn",
        "created_at": iso_now(),
        "renderer": "ffmpeg-png-overlay",
        "fallback_reason": args.reason,
        "inputs": {
            "caption_plan": str(caption_plan),
            "base_video": str(base_video),
            "voice_wav": str(voice_wav),
        },
        "outputs": {
            "overlay_dir": str(overlay_dir),
            "final_subtitled": str(output),
            "manifest": str(manifest_path),
        },
        "style": {
            "preset": str((plan.get("style") or {}).get("preset") or "songti_white_gold_lower"),
            "text_source": "voice_script.json via audio_sections.json via caption_plan.json",
        },
        "summary": {
            "caption_count": len(captions),
        },
        "command": command,
        "process": {
            "returncode": proc.returncode,
            "stdout_tail": (proc.stdout or "").splitlines()[-20:],
            "stderr_tail": (proc.stderr or "").splitlines()[-40:],
        },
        "qa": {
            "status": "ok" if proc.returncode == 0 and output.exists() else "block",
            "warnings": [] if proc.returncode == 0 and output.exists() else ["ffmpeg PNG overlay subtitle burn failed"],
        },
        "next_consumers": ["voah-qa-gate", "voah-export-record"],
    }
    write_json(manifest_path, manifest)
    if proc.returncode != 0:
        tail = "\n".join(manifest["process"]["stderr_tail"] or manifest["process"]["stdout_tail"])
        raise RuntimeError(f"ffmpeg PNG overlay subtitle burn failed: {tail}")
    print(f"final_subtitled={output}")
    print(f"overlay_dir={overlay_dir}")
    print(f"manifest={manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
