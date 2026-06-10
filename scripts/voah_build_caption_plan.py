#!/usr/bin/env python3
"""Create caption_plan.json from Voah audio_sections.json."""

from __future__ import annotations

import argparse
import json
import re
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


def as_abs(path: str | Path, base: Path | None = None) -> Path:
    value = Path(path).expanduser()
    if not value.is_absolute() and base is not None:
        value = base / value
    return value.resolve()


PUNCT_RE = re.compile(r"([。！？!?；;，,])")
WEIGHT_RE = re.compile(r"[\s，。！？、,.!?；;：:\"'“”‘’（）()\[\]【】《》<>+\-_/]+")


def speech_units(text: str) -> int:
    return max(1, len(WEIGHT_RE.sub("", text or "")))


def visible_units(text: str) -> int:
    return len(WEIGHT_RE.sub("", text or ""))


def split_caption_chunk(chunk: str, max_units: int) -> list[str]:
    chunk = str(chunk or "").strip()
    if not chunk:
        return []
    if speech_units(chunk) <= max_units:
        return [chunk]

    output: list[str] = []
    buffer = ""
    units = 0
    for char in chunk:
        buffer += char
        units += visible_units(char)
        if units >= max_units:
            output.append(buffer.strip())
            buffer = ""
            units = 0
    if buffer.strip():
        output.append(buffer.strip())
    return output or [chunk]


def split_caption_text(text: str, max_units: int = 14) -> list[str]:
    text = str(text or "").strip()
    if not text:
        return [""]
    parts = []
    start = 0
    for match in PUNCT_RE.finditer(text):
        end = match.end()
        chunk = text[start:end].strip()
        if chunk:
            parts.append(chunk)
        start = end
    tail = text[start:].strip()
    if tail:
        parts.append(tail)

    merged: list[str] = []
    buffer = ""
    for part in parts or [text]:
        candidate = buffer + part if buffer else part
        if buffer and speech_units(candidate) > max_units:
            merged.append(buffer)
            buffer = part
        else:
            buffer = candidate
    if buffer:
        merged.append(buffer)

    output: list[str] = []
    for chunk in merged:
        if speech_units(chunk) <= max_units:
            output.append(chunk)
            continue
        subparts = [item for item in re.split(r"(?<=、)", chunk) if item]
        if len(subparts) <= 1:
            output.extend(split_caption_chunk(chunk, max_units))
        else:
            buffer = ""
            for part in subparts:
                candidate = buffer + part if buffer else part
                if buffer and speech_units(candidate) > max_units:
                    output.extend(split_caption_chunk(buffer, max_units))
                    buffer = part
                else:
                    buffer = candidate
            if buffer:
                output.extend(split_caption_chunk(buffer, max_units))
    return output or [text]


def caption_fragments(section: dict[str, Any], split_punctuation: bool) -> list[dict[str, Any]]:
    text = str(section.get("subtitle_text") or section.get("voice_text") or "").strip()
    start_s = float(section.get("caption_start_s", section.get("timeline_start_s", 0)) or 0)
    end_s = float(section.get("caption_end_s", section.get("timeline_end_s", start_s)) or start_s)
    if not split_punctuation:
        return [{"text": text, "start_s": start_s, "end_s": end_s}]
    chunks = split_caption_text(text)
    weights = [speech_units(chunk) for chunk in chunks]
    total = max(1, sum(weights))
    cursor = start_s
    fragments = []
    for index, (chunk, weight) in enumerate(zip(chunks, weights), start=1):
        if index == len(chunks):
            frag_end = end_s
        else:
            frag_end = cursor + (end_s - start_s) * weight / total
        fragments.append(
            {
                "text": chunk,
                "start_s": round(cursor, 3),
                "end_s": round(max(cursor + 0.05, frag_end), 3),
            }
        )
        cursor = frag_end
    return fragments


def enforce_monotonic_captions(captions: list[dict[str, Any]], warnings: list[str]) -> list[dict[str, Any]]:
    if not captions:
        return captions
    ordered = sorted(
        captions,
        key=lambda item: (
            float(item.get("start_s") or 0),
            int(item.get("caption_order") or 0),
        ),
    )
    fixed: list[dict[str, Any]] = []
    cursor = 0.0
    for index, caption in enumerate(ordered, start=1):
        item = dict(caption)
        original_start = float(item.get("start_s") or 0)
        original_end = float(item.get("end_s") or original_start)
        start_s = max(original_start, cursor)
        end_s = max(original_end, start_s + 0.05)
        if abs(start_s - original_start) > 0.001 or abs(end_s - original_end) > 0.001:
            warnings.append(
                f"caption {item.get('caption_order') or index} timing adjusted {original_start:.3f}-{original_end:.3f} -> {start_s:.3f}-{end_s:.3f}"
            )
        item["caption_order"] = index
        item["start_s"] = round(start_s, 3)
        item["end_s"] = round(end_s, 3)
        item["duration_s"] = round(max(0.05, end_s - start_s), 3)
        fixed.append(item)
        cursor = end_s
    return fixed


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Voah caption_plan.json.")
    parser.add_argument("--audio-sections", required=True)
    parser.add_argument("--task-dir", default=None)
    parser.add_argument("--output", default="caption_plan.json")
    parser.add_argument("--preset", default="songti_white_gold_lower")
    parser.add_argument("--split-punctuation", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--style-source", default="/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_164301_minimax_voice_audio_master_v1/hyperframes_style_preview/subtitle_presets.json")
    parser.add_argument("--font-source", default="/System/Library/Fonts/Supplemental/Songti.ttc")
    args = parser.parse_args()

    audio_sections_path = as_abs(args.audio_sections)
    task_dir = as_abs(args.task_dir) if args.task_dir else audio_sections_path.parent
    output = as_abs(args.output, task_dir) if args.output == "caption_plan.json" else as_abs(args.output)
    payload = load_json(audio_sections_path)
    sections = payload.get("sections") or []
    captions = []
    warnings: list[str] = []
    caption_order = 0
    for index, section in enumerate(sections, start=1):
        fragments = caption_fragments(section, args.split_punctuation)
        section_text = "".join(fragment["text"] for fragment in fragments)
        original_text = str(section.get("subtitle_text") or section.get("voice_text") or "").strip()
        if section_text != original_text:
            warnings.append(f"section {index} caption fragments do not concatenate to original text")
        for fragment_index, fragment in enumerate(fragments, start=1):
            text = str(fragment.get("text") or "").strip()
            if not text:
                warnings.append(f"section {index}.{fragment_index} has empty subtitle text")
            start_s = float(fragment.get("start_s") or 0)
            end_s = float(fragment.get("end_s") or start_s)
            if end_s <= start_s:
                warnings.append(f"section {index}.{fragment_index} has invalid caption timing")
            caption_order += 1
            captions.append(
                {
                    "caption_order": caption_order,
                    "section_order": int(section.get("timeline_order") or index),
                    "fragment_order": fragment_index,
                    "slot_id": section.get("slot_id"),
                    "section_id": section.get("section_id"),
                    "role": section.get("role"),
                    "shot_id": section.get("shot_id"),
                    "start_s": round(start_s, 3),
                    "end_s": round(end_s, 3),
                    "duration_s": round(max(0.0, end_s - start_s), 3),
                    "text": text,
                    "keywords": section.get("keywords") or [],
                    "preset": args.preset,
                    "position": "lower_safe_area",
                    "text_source": "voice_script.json via audio_sections.json",
                    "timing_source": section.get("timing_source") or payload.get("policy", {}).get("timing_source") or "audio_sections",
                }
            )

    captions = enforce_monotonic_captions(captions, warnings)
    total_duration = round(captions[-1]["end_s"], 3) if captions else 0
    plan = {
        "schema_version": "1.0.0",
        "stage": "voah_caption_plan",
        "created_at": iso_now(),
        "product": payload.get("product") or {},
        "inputs": {
            "audio_sections": str(audio_sections_path),
        },
        "outputs": {
            "caption_plan": str(output),
            "next_artifact": str(task_dir / "hyperframes_subtitle_burn" / "index.html"),
        },
        "policy": {
            "caption_text_source": "voice_script.json",
            "timing_source": payload.get("policy", {}).get("timing_source") or "audio_sections",
            "minimax_subtitle_file_allowed": False,
            "asr_allowed_for_text": False,
            "asr_allowed_for_forced_alignment_only": True,
        },
        "style": {
            "preset": args.preset,
            "split_punctuation": args.split_punctuation,
            "style_source": str(as_abs(args.style_source)),
            "font_source": str(as_abs(args.font_source)),
            "font_family": "VoahSongti",
            "font_policy": "copy_font_into_hyperframes_project",
        },
        "canvas": {
            "width": 720,
            "height": 1280,
            "fps": 30,
        },
        "captions": captions,
        "summary": {
            "caption_count": len(captions),
            "total_duration_s": total_duration,
        },
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
        "next_consumers": ["hyperframes-subtitle-burn", "voah-render-qa"],
    }
    write_json(output, plan)
    print(f"caption_plan={output}")
    print(f"caption_count={len(captions)}")
    print(f"duration_s={total_duration}")
    print(f"qa={plan['qa']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
