#!/usr/bin/env python3
"""Assemble segmented Voah TTS audio into the canonical audio axis."""

from __future__ import annotations

import argparse
import json
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


def ffprobe_json(path: Path) -> dict[str, Any]:
    proc = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,sample_rate,channels",
            "-show_entries",
            "format=duration,bit_rate",
            "-of",
            "json",
            str(path),
        ]
    )
    if proc.returncode != 0:
        return {"error": (proc.stderr or proc.stdout).strip()}
    return json.loads(proc.stdout or "{}")


def probe_duration(path: Path) -> float:
    data = ffprobe_json(path)
    try:
        return round(float(data.get("format", {}).get("duration")), 3)
    except (TypeError, ValueError):
        raise RuntimeError(f"cannot probe duration: {path}")


def probe_audio(path: Path) -> dict[str, Any]:
    data = ffprobe_json(path)
    stream = next((item for item in data.get("streams", []) if item.get("codec_type") == "audio"), {})
    duration = None
    try:
        duration = round(float(data.get("format", {}).get("duration")), 3)
    except (TypeError, ValueError):
        pass
    return {
        "duration_s": duration,
        "codec_name": stream.get("codec_name"),
        "sample_rate": int(stream["sample_rate"]) if str(stream.get("sample_rate", "")).isdigit() else stream.get("sample_rate"),
        "channels": stream.get("channels"),
        "bit_rate": int(data.get("format", {}).get("bit_rate")) if str(data.get("format", {}).get("bit_rate", "")).isdigit() else data.get("format", {}).get("bit_rate"),
    }


def normalize_pronunciation(text: str) -> tuple[str, list[dict[str, str]]]:
    notes: list[dict[str, str]] = []
    normalized = text or ""
    replacements = [
        (r"SPF\s*50\+", "SPF五十加", "SPF50+"),
        (r"SPF\s*50", "SPF五十", "SPF50"),
        (r"PA\s*\+\+\+", "PA三个加", "PA+++"),
        (r"PA\s*\+\+", "PA两个加", "PA++"),
        (r"PA\s*\+", "PA加", "PA+"),
        (r"(?<!\d)618(?!\d)", "六一八", "618"),
    ]
    for pattern, repl, label in replacements:
        before = normalized
        normalized = re.sub(pattern, repl, normalized, flags=re.IGNORECASE)
        if before != normalized:
            notes.append({"source_text": label, "normalized_text": repl, "reason": "tts_pronunciation_normalization"})
    normalized = re.sub(r"\s+", "", normalized)
    return normalized, notes


def as_abs(path: str | Path, base: Path | None = None) -> Path:
    value = Path(path).expanduser()
    if not value.is_absolute() and base is not None:
        value = base / value
    return value.resolve()


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^0-9A-Za-z_.-]+", "_", value or "").strip("_")
    return slug or "segment"


def sorted_raw_audio(tts_dir: Path) -> list[Path]:
    files = sorted(tts_dir.glob("*_raw.wav"))
    if files:
        return files
    return sorted(tts_dir.glob("*.wav"))


def read_provider_from_payload(payload_path: Path) -> dict[str, Any]:
    if not payload_path.exists():
        return {}
    try:
        payload = load_json(payload_path)
    except json.JSONDecodeError:
        return {}
    return {
        "model": payload.get("model"),
        "voice_setting": payload.get("voice_setting"),
        "audio_setting": payload.get("audio_setting"),
        "voice_modify": payload.get("voice_modify"),
        "language_boost": payload.get("language_boost"),
        "subtitle_enable": payload.get("subtitle_enable"),
    }


def concat_wavs(parts: list[Path], output_wav: Path, concat_file: Path) -> None:
    write_text(concat_file, "\n".join(f"file '{escape_concat_path(path)}'" for path in parts) + "\n")
    proc = run_command(
        [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_file),
            "-ar",
            "32000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(output_wav),
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "failed to concat wav").strip())


def encode_mp3(input_wav: Path, output_mp3: Path) -> None:
    proc = run_command(["ffmpeg", "-y", "-i", str(input_wav), "-c:a", "libmp3lame", "-b:a", "128k", str(output_mp3)])
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "failed to encode mp3").strip())


def build_segments(voice_script: dict[str, Any], tts_dir: Path, raw_files: list[Path]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    items = voice_script.get("script_items") or []
    if len(items) != len(raw_files):
        raise ValueError(f"script_items count {len(items)} != raw audio count {len(raw_files)}")

    segments: list[dict[str, Any]] = []
    normalization_notes: list[dict[str, str]] = []
    cursor = 0.0
    for index, (item, raw_path) in enumerate(zip(items, raw_files), start=1):
        duration = probe_duration(raw_path)
        pronounce_text = item.get("pronounce_text")
        notes: list[dict[str, str]] = []
        if not pronounce_text:
            pronounce_text, notes = normalize_pronunciation(str(item.get("voice_text") or ""))
        normalization_notes.extend(notes)

        payload_stem = raw_path.name.replace("_raw.wav", "")
        provider_payload = read_provider_from_payload(tts_dir / f"{payload_stem}.payload.json")
        section = {
            "timeline_order": int(item.get("timeline_order") or index),
            "slot_id": item.get("slot_id"),
            "role": item.get("role"),
            "shot_id": item.get("shot_id") or item.get("story_unit_id"),
            "parent_shot_id": item.get("parent_shot_id"),
            "asset_id": item.get("asset_id"),
            "trimmed_clip_path": item.get("trimmed_clip_path"),
            "voice_text": item.get("voice_text"),
            "pronounce_text": pronounce_text,
            "subtitle_text": item.get("subtitle_text") or item.get("voice_text"),
            "keywords": item.get("keywords") or [],
            "voice_wav": str(raw_path),
            "source_audio_probe": probe_audio(raw_path),
            "audio_duration_s": duration,
            "timeline_start_s": round(cursor, 3),
            "timeline_end_s": round(cursor + duration, 3),
            "caption_start_s": round(cursor, 3),
            "caption_end_s": round(cursor + duration, 3),
            "alignment_policy": "segmented_tts_duration_accumulation_raw_audio",
            "provider_payload_summary": provider_payload,
        }
        segments.append(section)
        cursor += duration

    return segments, normalization_notes


def main() -> int:
    parser = argparse.ArgumentParser(description="Assemble segmented Voah TTS raw wav files into canonical audio-axis artifacts.")
    parser.add_argument("--voice-script", required=True, help="Path to voice_script.json.")
    parser.add_argument("--tts-dir", default=None, help="Directory containing segmented *_raw.wav files.")
    parser.add_argument("--task-dir", default=None, help="Task directory. Defaults to voice_script parent.")
    parser.add_argument("--provider", default="minimax-official")
    parser.add_argument("--output-wav", default="voice.wav")
    parser.add_argument("--output-mp3", default="voice_minimax_segmented.mp3")
    args = parser.parse_args()

    voice_script_path = as_abs(args.voice_script)
    task_dir = as_abs(args.task_dir) if args.task_dir else voice_script_path.parent
    tts_dir = as_abs(args.tts_dir) if args.tts_dir else task_dir / "tts_segments"
    output_wav = as_abs(args.output_wav, task_dir) if args.output_wav == "voice.wav" else as_abs(args.output_wav)
    output_mp3 = as_abs(args.output_mp3, task_dir) if args.output_mp3 == "voice_minimax_segmented.mp3" else as_abs(args.output_mp3)

    voice_script = load_json(voice_script_path)
    raw_files = sorted_raw_audio(tts_dir)
    if not raw_files:
        raise FileNotFoundError(f"no segmented wav files found in {tts_dir}")

    segments, normalization_notes = build_segments(voice_script, tts_dir, raw_files)
    concat_wavs([Path(item["voice_wav"]) for item in segments], output_wav, task_dir / "voice_segments_raw_concat.txt")
    encode_mp3(output_wav, output_mp3)

    total_duration = probe_duration(output_wav)
    product = voice_script.get("product") or {}
    full_voice_text = voice_script.get("full_voice_text") or "".join(str(item.get("voice_text") or "") for item in voice_script.get("script_items") or [])
    pronounce_text = voice_script.get("pronounce_text")
    if not pronounce_text:
        pronounce_text, more_notes = normalize_pronunciation(full_voice_text)
        normalization_notes.extend(more_notes)

    target_range = voice_script.get("script_stats", {}).get("target_duration_range_s") or [40, 50]
    warnings: list[str] = []
    if not (float(target_range[0]) <= total_duration <= float(target_range[1])):
        warnings.append(f"voice duration {total_duration}s outside target range {target_range[0]}-{target_range[1]}s")
    if any(Path(item["voice_wav"]).name.endswith("_raw.wav") for item in segments):
        warnings.append("using raw segmented wav files; trimmed wav files are ignored because prior silenceremove over-trimmed some segments")

    tts_segments_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_segmented_tts_segments",
        "created_at": iso_now(),
        "product": product,
        "inputs": {
            "voice_script": str(voice_script_path),
            "tts_dir": str(tts_dir),
        },
        "provider": {
            "name": args.provider,
            "key_policy": "read_from_local_env_only_never_persist",
        },
        "segments": segments,
        "summary": {
            "segment_count": len(segments),
            "total_audio_duration_s": total_duration,
            "alignment_policy": "segmented_tts_duration_accumulation_raw_audio",
        },
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
    }
    audio_sections_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_audio_sections",
        "created_at": iso_now(),
        "product": product,
        "inputs": {
            "voice_script": str(voice_script_path),
            "tts_segments": str(task_dir / "tts_segments.json"),
        },
        "outputs": {
            "audio_sections": str(task_dir / "audio_sections.json"),
            "next_artifact": str(task_dir / "timeline_fill.json"),
        },
        "timing_policy": "segmented_tts_duration_accumulation",
        "sections": segments,
        "summary": {
            "section_count": len(segments),
            "total_duration_s": total_duration,
        },
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
        "next_consumers": ["voah-video-fill", "voah-caption-plan"],
    }
    tts_audio_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_tts",
        "created_at": iso_now(),
        "product": product,
        "inputs": {
            "voice_script": str(voice_script_path),
            "tts_segments_dir": str(tts_dir),
        },
        "outputs": {
            "voice_wav": str(output_wav),
            "voice_mp3": str(output_mp3),
            "tts_segments": str(task_dir / "tts_segments.json"),
            "audio_sections": str(task_dir / "audio_sections.json"),
            "next_artifact": str(task_dir / "timeline_fill.json"),
        },
        "provider": {
            "name": args.provider,
            "key_policy": "read_from_local_env_only_never_persist",
        },
        "script_stats": {
            "full_voice_text": full_voice_text,
            "pronounce_text": pronounce_text,
            "normalization_notes": normalization_notes,
            "item_count": len(segments),
        },
        "timing": {
            "target_timeline_duration_s": sum(float(item.get("target_duration_s") or 0) for item in voice_script.get("script_items") or []),
            "target_duration_range_s": target_range,
            "actual_audio_duration_s": total_duration,
            "alignment_policy": "segmented_tts_duration_accumulation_raw_audio",
        },
        "audio_probe": probe_audio(output_wav),
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
        "next_consumers": ["voah-video-fill", "voah-caption-plan", "voah-render"],
    }

    write_json(task_dir / "tts_segments.json", tts_segments_payload)
    write_json(task_dir / "audio_sections.json", audio_sections_payload)
    write_json(task_dir / "tts_audio.json", tts_audio_payload)

    print(f"voice_wav={output_wav}")
    print(f"voice_mp3={output_mp3}")
    print(f"audio_sections={task_dir / 'audio_sections.json'}")
    print(f"duration_s={total_duration}")
    print(f"qa={tts_audio_payload['qa']['status']}")
    return 0


if __name__ == "__main__":
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("ffmpeg and ffprobe are required")
    raise SystemExit(main())
