#!/usr/bin/env python3
"""Retrieve story units for Voah audio sections and render a preview video."""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


SEARCH_SCRIPT = Path("/Users/noah/.codex/skills/voah-shot-retrieval/scripts/search.py")


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_search_module():
    spec = importlib.util.spec_from_file_location("voah_search", SEARCH_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load search module: {SEARCH_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def as_abs(path: str | Path, base: Path | None = None) -> Path:
    value = Path(path).expanduser()
    if not value.is_absolute() and base is not None:
        value = base / value
    return value.resolve()


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
    if not path.exists():
        return {"exists": False}
    proc = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
            "-show_entries",
            "format=duration,size,bit_rate",
            "-of",
            "json",
            str(path),
        ]
    )
    if proc.returncode != 0:
        return {"exists": True, "error": (proc.stderr or proc.stdout).strip()}
    data = json.loads(proc.stdout or "{}")
    data["exists"] = True
    return data


def safe_filename(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z_.-]+", "_", value or "").strip("_") or "clip"


def text_blob(record: dict[str, Any]) -> str:
    parts = [
        record.get("label", ""),
        record.get("visual_summary", ""),
        record.get("source_meaning", ""),
        " ".join(record.get("selling_points") or []),
        " ".join(record.get("timeline_roles") or []),
        record.get("shot_type", ""),
    ]
    return " ".join(str(part) for part in parts if part)


def section_query(section: dict[str, Any]) -> str:
    parts = [
        section.get("intention_copy", ""),
        section.get("required_meaning", ""),
        section.get("required_visual", ""),
        section.get("voice_text", ""),
        " ".join(section.get("keywords") or []),
    ]
    return " ".join(str(part) for part in parts if part)


def candidate_ids(candidates: list[dict[str, Any]]) -> list[str]:
    return [str(item.get("shot_id")) for item in candidates if item.get("shot_id")]


def role_for_search(role: str | None) -> str:
    if role in ("opening", "proof", "product", "cta", "transition"):
        return role
    if role in ("product_intro", "product_effect"):
        return "product"
    if role in ("proof_test", "outdoor", "outdoor_scene"):
        return "proof"
    if role in ("trust", "trust_endorsement"):
        return "cta"
    return ""


def duration_score(duration: float, target: float) -> float:
    if duration <= 0 or target <= 0:
        return -0.2
    if duration >= target:
        return 0.18 - min(0.08, (duration - target) * 0.01)
    ratio = duration / target
    return -0.22 * (1 - ratio)


def local_keyword_bonus(record: dict[str, Any], section: dict[str, Any]) -> float:
    blob = text_blob(record)
    query = section_query(section)
    tokens = [item for item in re.split(r"[\s，。！？、,.!?；;：]+", query) if len(item) >= 2]
    hits = [item for item in tokens if item in blob]
    return min(0.12, len(hits) * 0.02)


def adjusted_candidate(candidate: dict[str, Any], section: dict[str, Any], used_counts: dict[str, int]) -> dict[str, Any]:
    target = float(section.get("audio_duration_s") or 0)
    duration = float(candidate.get("duration_s") or 0)
    asset_id = str(candidate.get("asset_id") or "")
    shot_id = str(candidate.get("shot_id") or "")
    score = float(candidate.get("score") or 0)
    reasons = list(candidate.get("rerank_reasons") or [])
    risks = list(candidate.get("risks") or [])
    score += duration_score(duration, target)
    if duration >= target:
        reasons.append("单段素材足够覆盖口播段，可裁切")
    else:
        risks.append(f"素材短于口播段 {duration:.3f}s < {target:.3f}s")
    bonus = local_keyword_bonus(candidate, section)
    if bonus > 0:
        score += bonus
        reasons.append("口播/意图关键词与素材字段命中")
    reuse_penalty = used_counts.get(shot_id, 0) * 0.18 + used_counts.get(asset_id, 0) * 0.025
    if reuse_penalty:
        score -= reuse_penalty
        risks.append(f"复用惩罚 {reuse_penalty:.3f}")
    subtitle = candidate.get("hard_subtitle_risk")
    if subtitle in ("medium", "high"):
        score -= 0.06 if subtitle == "medium" else 0.14
    output = dict(candidate)
    output["adjusted_score"] = round(score, 6)
    output["fill_reasons"] = reasons
    output["fill_risks"] = risks
    return output


def candidate_from_index_record(record: dict[str, Any], section: dict[str, Any]) -> dict[str, Any]:
    return {
        "rank": 0,
        "shot_id": record.get("shot_id"),
        "parent_shot_id": record.get("parent_shot_id", ""),
        "semantic_shot_id": record.get("semantic_shot_id", ""),
        "is_physical_shot": record.get("is_physical_shot", False),
        "boundary_source": record.get("boundary_source", ""),
        "asset_id": record.get("asset_id"),
        "segment_id": record.get("segment_id", ""),
        "label": record.get("label", ""),
        "product": record.get("product", {}),
        "time_range": record.get("time_range", []),
        "usable_range": record.get("usable_range", []),
        "duration_s": record.get("duration_s"),
        "score": None,
        "base_similarity": None,
        "channel_scores": {},
        "rerank_reasons": ["selection_overrides.json 指定：用于验证/修正当前 rerank 的画面匹配"],
        "risks": [],
        "retrieval_role": section.get("role"),
        "hard_subtitle_risk": record.get("hard_subtitle_risk"),
        "voiceover_fit": record.get("voiceover_fit"),
        "can_standalone": record.get("can_standalone"),
        "shot_type": record.get("shot_type", ""),
        "selling_points": record.get("selling_points", []),
        "visual_summary": record.get("visual_summary", ""),
        "source_meaning": record.get("source_meaning", ""),
        "source_asr": record.get("source_asr", ""),
        "source_ocr": record.get("source_ocr", []),
        "trimmed_clip_path": record.get("trimmed_clip_path", ""),
        "trimmed_oss_url": record.get("trimmed_oss_url", ""),
        "adjusted_score": None,
        "fill_reasons": ["final selection override: semantic/visual fit is better than raw top score"],
        "fill_risks": [],
    }


def apply_selection_overrides(
    section: dict[str, Any],
    candidates: list[dict[str, Any]],
    records_by_id: dict[str, dict[str, Any]],
    overrides: dict[str, Any],
) -> list[dict[str, Any]] | None:
    section_id = str(section.get("section_id") or "")
    override_ids = overrides.get(section_id)
    if not override_ids:
        return None
    if isinstance(override_ids, str):
        override_ids = [override_ids]
    candidate_by_id = {str(item.get("shot_id")): item for item in candidates}
    selected: list[dict[str, Any]] = []
    missing: list[str] = []
    for shot_id in override_ids:
        sid = str(shot_id)
        if sid in candidate_by_id:
            item = dict(candidate_by_id[sid])
            item.setdefault("fill_reasons", [])
            item["fill_reasons"] = list(item.get("fill_reasons") or []) + [
                "selection_overrides.json 指定：语义/画面复核后优先"
            ]
            selected.append(item)
        elif sid in records_by_id:
            selected.append(candidate_from_index_record(records_by_id[sid], section))
        else:
            missing.append(sid)
    if missing:
        raise KeyError(f"{section_id}: selection override shot ids not found: {missing}")
    return selected


def render_clip(
    source: Path,
    output: Path,
    duration: float,
    width: int,
    height: int,
    fps: int,
    preset: str,
    allow_loop: bool,
) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    source_duration = probe_duration(source)
    if source_duration is None:
        raise RuntimeError(f"cannot probe source duration: {source}")
    loop_args: list[str] = []
    if source_duration + 0.04 < duration:
        if not allow_loop:
            duration = source_duration
            warnings.append(f"source shorter than requested; rendered natural length {source_duration:.3f}s")
        else:
            loop_args = ["-stream_loop", "-1"]
            warnings.append(f"source shorter than requested; looped {source_duration:.3f}s to {duration:.3f}s")

    frames = max(1, int(math.ceil(duration * fps)))
    vf = (
        "setpts=PTS-STARTPTS,"
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,fps={fps},format=yuv420p"
    )
    command = [
        "ffmpeg",
        "-y",
        *loop_args,
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
    rendered_duration = probe_duration(output)
    return {
        "source_duration_s": source_duration,
        "requested_duration_s": round(duration, 3),
        "rendered_duration_s": rendered_duration,
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


def choose_clips_for_section(
    section: dict[str, Any],
    candidates: list[dict[str, Any]],
    used_counts: dict[str, int],
    max_clips_per_section: int,
) -> tuple[list[dict[str, Any]], str, list[str]]:
    warnings: list[str] = []
    target = float(section.get("audio_duration_s") or 0)
    adjusted = [adjusted_candidate(item, section, used_counts) for item in candidates]
    adjusted.sort(key=lambda item: float(item.get("adjusted_score") or 0), reverse=True)

    long_enough = [item for item in adjusted if float(item.get("duration_s") or 0) >= target - 0.03 and item.get("trimmed_clip_path")]
    if long_enough:
        return [long_enough[0]], "single_story_unit_trim_to_audio", warnings

    selected: list[dict[str, Any]] = []
    selected_assets: set[str] = set()
    total = 0.0
    section_blob = section_query(section)
    for item in adjusted:
        if len(selected) >= max_clips_per_section:
            break
        if not item.get("trimmed_clip_path"):
            continue
        shot_id = str(item.get("shot_id") or "")
        if any(str(existing.get("shot_id") or "") == shot_id for existing in selected):
            continue
        asset_id = str(item.get("asset_id") or "")
        if selected and asset_id not in selected_assets and len(selected_assets) >= 2:
            continue
        if selected:
            shared = local_keyword_bonus(item, section)
            same_asset = asset_id in selected_assets
            if shared <= 0 and not same_asset and not any(term in text_blob(item) for term in re.split(r"[\s，。！？、,.!?；;：]+", section_blob) if len(term) >= 2):
                continue
        selected.append(item)
        selected_assets.add(asset_id)
        total += float(item.get("duration_s") or 0)
        if total >= target - 0.03:
            return selected, "multi_story_unit_semantic_fill", warnings

    if selected:
        warnings.append(f"selected semantic clips total {total:.3f}s shorter than target {target:.3f}s; last clip may loop")
        return selected, "multi_story_unit_fill_with_last_clip_loop_fallback", warnings
    raise RuntimeError(f"no usable candidates for section {section.get('section_id')}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Retrieve story units by audio section and render preview.")
    parser.add_argument("--audio-sections", required=True)
    parser.add_argument("--index", required=True)
    parser.add_argument("--voice-wav", required=True)
    parser.add_argument("--task-dir", default=None)
    parser.add_argument("--product", default="防晒气垫")
    parser.add_argument("--top-k", type=int, default=14)
    parser.add_argument("--pool-k", type=int, default=36)
    parser.add_argument("--max-clips-per-section", type=int, default=3)
    parser.add_argument("--selection-overrides", default="")
    parser.add_argument("--width", type=int, default=720)
    parser.add_argument("--height", type=int, default=1280)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--preset", default="veryfast")
    parser.add_argument("--output", default="preview_no_subtitles.mp4")
    args = parser.parse_args()

    search_module = load_search_module()
    if not search_module.load_env():
        return 1

    audio_sections_path = as_abs(args.audio_sections)
    index_path = as_abs(args.index)
    voice_wav = as_abs(args.voice_wav)
    task_dir = as_abs(args.task_dir) if args.task_dir else audio_sections_path.parent
    output = as_abs(args.output, task_dir) if args.output == "preview_no_subtitles.mp4" else as_abs(args.output)
    work_dir = task_dir / "timeline_fill_clips"
    work_dir.mkdir(parents=True, exist_ok=True)

    audio_sections = load_json(audio_sections_path)
    index = load_json(index_path)
    records_by_id = {str(record.get("shot_id")): record for record in index.get("records", [])}
    selection_overrides = load_json(as_abs(args.selection_overrides)) if args.selection_overrides else {}
    sections = audio_sections.get("sections") or []
    if not sections:
        raise ValueError("audio_sections has no sections")

    candidate_sections: list[dict[str, Any]] = []
    timeline_sections: list[dict[str, Any]] = []
    rendered_parts: list[Path] = []
    warnings: list[str] = []
    used_counts: dict[str, int] = {}

    for section_index, section in enumerate(sections, start=1):
        query = section_query(section)
        role = role_for_search(section.get("role"))
        query_vector = search_module.embed_query(query)
        weights = search_module.parse_weights("", role)
        candidates = search_module.search_ranked(
            index=index,
            query=query,
            query_vector=query_vector,
            product=args.product,
            role=role,
            top_k=args.top_k,
            weights=weights,
            target_duration=float(section.get("audio_duration_s") or 0),
            allow_cross_product=False,
            dedupe_parent=True,
            max_per_parent=1,
            max_per_asset=0,
            pool_k=args.pool_k,
        )
        adjusted = [adjusted_candidate(item, section, used_counts) for item in candidates]
        adjusted.sort(key=lambda item: float(item.get("adjusted_score") or 0), reverse=True)
        selected_override = apply_selection_overrides(section, candidates, records_by_id, selection_overrides)
        if selected_override is not None:
            selected = selected_override
            fill_policy = "selection_override_semantic_visual_fit"
            select_warnings = []
        else:
            selected, fill_policy, select_warnings = choose_clips_for_section(
                section=section,
                candidates=candidates,
                used_counts=used_counts,
                max_clips_per_section=args.max_clips_per_section,
            )
        warnings.extend([f"{section.get('section_id')}: {warning}" for warning in select_warnings])

        target_duration = float(section.get("audio_duration_s") or 0)
        remaining = target_duration
        clip_items: list[dict[str, Any]] = []
        for clip_index, selected_item in enumerate(selected, start=1):
            source = as_abs(selected_item.get("trimmed_clip_path") or "")
            source_duration = float(selected_item.get("duration_s") or 0)
            if clip_index < len(selected):
                render_duration = min(source_duration, max(0.25, remaining))
                allow_loop = False
            else:
                render_duration = max(0.25, remaining)
                allow_loop = source_duration + 0.03 < remaining
            out_clip = work_dir / f"{section_index:03d}_{clip_index:02d}_{safe_filename(str(selected_item.get('shot_id') or 'shot'))}.mp4"
            probe, render_warnings = render_clip(
                source=source,
                output=out_clip,
                duration=render_duration,
                width=args.width,
                height=args.height,
                fps=args.fps,
                preset=args.preset,
                allow_loop=allow_loop,
            )
            warnings.extend([f"{section.get('section_id')}/{selected_item.get('shot_id')}: {warning}" for warning in render_warnings])
            rendered_parts.append(out_clip)
            actual_rendered = float(probe.get("rendered_duration_s") or render_duration)
            remaining = max(0.0, remaining - actual_rendered)
            used_counts[str(selected_item.get("shot_id") or "")] = used_counts.get(str(selected_item.get("shot_id") or ""), 0) + 1
            used_counts[str(selected_item.get("asset_id") or "")] = used_counts.get(str(selected_item.get("asset_id") or ""), 0) + 1
            clip_items.append(
                {
                    "clip_order": clip_index,
                    "shot_id": selected_item.get("shot_id"),
                    "asset_id": selected_item.get("asset_id"),
                    "label": selected_item.get("label"),
                    "score": selected_item.get("score"),
                    "adjusted_score": selected_item.get("adjusted_score"),
                    "source_clip_path": str(source),
                    "visual_summary": selected_item.get("visual_summary"),
                    "source_meaning": selected_item.get("source_meaning"),
                    "selling_points": selected_item.get("selling_points", []),
                    "hard_subtitle_risk": selected_item.get("hard_subtitle_risk"),
                    "voiceover_fit": selected_item.get("voiceover_fit"),
                    "fill_reasons": selected_item.get("fill_reasons", []),
                    "fill_risks": selected_item.get("fill_risks", []),
                    **probe,
                }
            )

        if remaining > 0.08:
            warnings.append(f"{section.get('section_id')}: rendered video is still {remaining:.3f}s short")

        candidate_sections.append(
            {
                "section_id": section.get("section_id"),
                "timeline_order": section.get("timeline_order"),
                "role": section.get("role"),
                "query": query,
                "search_role": role,
                "audio_duration_s": target_duration,
                "selected_shot_ids": candidate_ids(selected),
                "candidate_count": len(adjusted),
                "candidates": adjusted,
            }
        )
        timeline_sections.append(
            {
                **section,
                "fill_policy": fill_policy,
                "selected_shot_ids": candidate_ids(selected),
                "clips": clip_items,
                "rendered_duration_s": round(sum(float(item.get("rendered_duration_s") or 0) for item in clip_items), 3),
            }
        )

    video_no_audio = task_dir / "preview_no_audio.mp4"
    concat_video(rendered_parts, video_no_audio, task_dir / "timeline_fill_video_concat.txt")
    mux_audio(video_no_audio, voice_wav, output)

    voice_duration = probe_duration(voice_wav)
    preview_duration = probe_duration(output)
    if voice_duration is not None and preview_duration is not None and abs(voice_duration - preview_duration) > 0.15:
        warnings.append(f"preview duration {preview_duration}s differs from voice duration {voice_duration}s")

    candidate_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_audio_section_retrieval_candidates",
        "created_at": iso_now(),
        "product": audio_sections.get("product") or {},
        "inputs": {
            "audio_sections": str(audio_sections_path),
            "index": str(index_path),
        },
        "outputs": {
            "candidate_sections": str(task_dir / "candidate_sections.json"),
            "next_artifact": str(task_dir / "timeline_fill.json"),
        },
        "policy": {
            "script_first": True,
            "tts_after_script": True,
            "retrieval_unit": index.get("planning_granularity", "story_unit"),
            "prefer_long_material": True,
            "loop_is_last_resort": True,
            "selection_overrides": str(as_abs(args.selection_overrides)) if args.selection_overrides else "",
        },
        "sections": candidate_sections,
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
        "next_consumers": ["voah-video-fill"],
    }
    write_json(task_dir / "candidate_sections.json", candidate_payload)

    timeline_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_video_fill_from_audio_section_retrieval",
        "created_at": iso_now(),
        "product": audio_sections.get("product") or {},
        "inputs": {
            "audio_sections": str(audio_sections_path),
            "candidate_sections": str(task_dir / "candidate_sections.json"),
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
            "section_count": len(timeline_sections),
            "voice_duration_s": voice_duration,
            "preview_duration_s": preview_duration,
            "render_policy": "audio_section_semantic_retrieval_with_trim_or_semantic_fill",
            "selected_clip_count": sum(len(item.get("clips") or []) for item in timeline_sections),
        },
        "timeline": timeline_sections,
        "media_probe": probe_media(output),
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
        "next_consumers": ["voah-caption-plan", "hyperframes-subtitle-burn"],
    }
    write_json(task_dir / "timeline_fill.json", timeline_payload)

    print(f"candidate_sections={task_dir / 'candidate_sections.json'}")
    print(f"timeline_fill={task_dir / 'timeline_fill.json'}")
    print(f"preview_no_subtitles={output}")
    print(f"duration_s={preview_duration}")
    print(f"qa={timeline_payload['qa']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
