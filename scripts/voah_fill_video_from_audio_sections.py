#!/usr/bin/env python3
"""Build a Voah video preview from audio_sections.json."""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
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


def run_command(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def escape_concat_path(path: Path) -> str:
    return str(path.resolve()).replace("'", "'\\''")


def as_abs(path: str | Path, base: Path | None = None) -> Path:
    value = Path(path).expanduser()
    if not value.is_absolute() and base is not None:
        value = base / value
    return value.resolve()


def safe_filename(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z_.-]+", "_", value or "").strip("_") or "clip"


def probe_duration(path: Path) -> float | None:
    if not path.exists():
        return None
    proc = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    if proc.returncode != 0:
        return None
    try:
        return round(float(proc.stdout.strip()), 3)
    except ValueError:
        return None


def probe_media(path: Path) -> dict[str, Any]:
    proc = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
            "-show_entries",
            "format=duration,bit_rate",
            "-of",
            "json",
            str(path),
        ]
    )
    if proc.returncode != 0:
        return {"error": (proc.stderr or proc.stdout).strip()}
    data = json.loads(proc.stdout or "{}")
    duration = None
    try:
        duration = round(float(data.get("format", {}).get("duration")), 3)
    except (TypeError, ValueError):
        pass
    video_stream = next((item for item in data.get("streams", []) if item.get("codec_type") == "video"), {})
    audio_stream = next((item for item in data.get("streams", []) if item.get("codec_type") == "audio"), {})
    return {
        "duration_s": duration,
        "video": {
            "codec_name": video_stream.get("codec_name"),
            "width": video_stream.get("width"),
            "height": video_stream.get("height"),
            "avg_frame_rate": video_stream.get("avg_frame_rate"),
        },
        "audio": {
            "codec_name": audio_stream.get("codec_name"),
            "sample_rate": audio_stream.get("sample_rate"),
            "channels": audio_stream.get("channels"),
        },
        "bit_rate": data.get("format", {}).get("bit_rate"),
    }


def render_section_clip(source: Path, output: Path, duration: float, width: int, height: int, fps: int, preset: str) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    source_duration = probe_duration(source)
    if source_duration is None:
        raise RuntimeError(f"cannot probe source duration: {source}")
    if source_duration + 0.05 < duration:
        warnings.append(f"source clip {source.name} {source_duration}s shorter than audio section {duration}s; looped")
    frames = max(1, int(math.ceil(duration * fps)))
    vf = (
        "setpts=PTS-STARTPTS,"
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,fps={fps},format=yuv420p"
    )
    command = [
        "ffmpeg",
        "-y",
        "-stream_loop",
        "-1",
        "-i",
        str(source),
        "-an",
        "-vf",
        vf,
        "-frames:v",
        str(frames),
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        str(output),
    ]
    proc = run_command(command)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"failed to render {source}").strip())
    return {
        "source_duration_s": source_duration,
        "rendered_duration_s": probe_duration(output),
        "rendered_clip_path": str(output),
    }, warnings


def concat_video(parts: list[Path], output: Path, concat_file: Path) -> None:
    write_text(concat_file, "\n".join(f"file '{escape_concat_path(path)}'" for path in parts) + "\n")
    proc = run_command(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(output)])
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "failed to concat video").strip())


def mux_audio(video: Path, audio: Path, output: Path) -> None:
    proc = run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video),
            "-i",
            str(audio),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            str(output),
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "failed to mux audio").strip())


def main() -> int:
    parser = argparse.ArgumentParser(description="Fill video timeline from Voah audio sections.")
    parser.add_argument("--audio-sections", required=True)
    parser.add_argument("--voice-wav", required=True)
    parser.add_argument("--task-dir", default=None)
    parser.add_argument("--output", default="preview_no_subtitles.mp4")
    parser.add_argument("--width", type=int, default=720)
    parser.add_argument("--height", type=int, default=1280)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--preset", default="veryfast")
    args = parser.parse_args()

    audio_sections_path = as_abs(args.audio_sections)
    task_dir = as_abs(args.task_dir) if args.task_dir else audio_sections_path.parent
    voice_wav = as_abs(args.voice_wav)
    output = as_abs(args.output, task_dir) if args.output == "preview_no_subtitles.mp4" else as_abs(args.output)
    work_dir = task_dir / "timeline_fill_clips"
    work_dir.mkdir(parents=True, exist_ok=True)

    payload = load_json(audio_sections_path)
    sections = payload.get("sections") or []
    if not sections:
        raise ValueError("audio_sections has no sections")

    rendered_parts: list[Path] = []
    timeline: list[dict[str, Any]] = []
    warnings: list[str] = []
    for index, section in enumerate(sections, start=1):
        duration = float(section.get("audio_duration_s") or 0)
        if duration <= 0:
            warnings.append(f"section {index} has no duration")
            continue
        source = as_abs(section.get("trimmed_clip_path") or "")
        if not source.exists():
            raise FileNotFoundError(f"missing video clip for section {index}: {source}")
        out_clip = work_dir / f"{index:03d}_{safe_filename(str(section.get('shot_id') or 'shot'))}.mp4"
        render_probe, item_warnings = render_section_clip(source, out_clip, duration, args.width, args.height, args.fps, args.preset)
        warnings.extend([f"section {index}: {warning}" for warning in item_warnings])
        rendered_parts.append(out_clip)
        timeline.append(
            {
                "timeline_order": int(section.get("timeline_order") or index),
                "slot_id": section.get("slot_id"),
                "role": section.get("role"),
                "shot_id": section.get("shot_id"),
                "parent_shot_id": section.get("parent_shot_id"),
                "asset_id": section.get("asset_id"),
                "subtitle_text": section.get("subtitle_text"),
                "keywords": section.get("keywords") or [],
                "timeline_start_s": section.get("timeline_start_s"),
                "timeline_end_s": section.get("timeline_end_s"),
                "audio_duration_s": duration,
                "source_clip_path": str(source),
                "render_policy": "trim_or_loop_to_audio_section_duration",
                **render_probe,
            }
        )

    video_no_audio = task_dir / "preview_no_audio.mp4"
    concat_video(rendered_parts, video_no_audio, task_dir / "timeline_fill_video_concat.txt")
    mux_audio(video_no_audio, voice_wav, output)

    output_probe = probe_media(output)
    voice_duration = probe_duration(voice_wav)
    preview_duration = output_probe.get("duration_s")
    if voice_duration is not None and preview_duration is not None and abs(voice_duration - preview_duration) > 0.15:
        warnings.append(f"preview duration {preview_duration}s differs from voice duration {voice_duration}s")

    manifest = {
        "schema_version": "1.0.0",
        "stage": "voah_video_fill",
        "created_at": iso_now(),
        "product": payload.get("product") or {},
        "inputs": {
            "audio_sections": str(audio_sections_path),
            "voice_wav": str(voice_wav),
        },
        "outputs": {
            "timeline_fill": str(task_dir / "timeline_fill.json"),
            "preview_no_audio": str(video_no_audio),
            "preview_no_subtitles": str(output),
            "next_artifact": str(task_dir / "caption_plan.json"),
        },
        "canvas": {
            "width": args.width,
            "height": args.height,
            "fps": args.fps,
        },
        "summary": {
            "section_count": len(timeline),
            "voice_duration_s": voice_duration,
            "preview_duration_s": preview_duration,
            "render_policy": "trim_or_loop_to_audio_section_duration",
        },
        "timeline": timeline,
        "media_probe": output_probe,
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
        "next_consumers": ["voah-caption-plan", "hyperframes-subtitle-burn"],
    }
    write_json(task_dir / "timeline_fill.json", manifest)

    print(f"timeline_fill={task_dir / 'timeline_fill.json'}")
    print(f"preview_no_subtitles={output}")
    print(f"duration_s={preview_duration}")
    print(f"qa={manifest['qa']['status']}")
    return 0


if __name__ == "__main__":
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("ffmpeg and ffprobe are required")
    raise SystemExit(main())
