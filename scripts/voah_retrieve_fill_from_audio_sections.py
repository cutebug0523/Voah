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

DOMAIN_TERMS = [
    "SPF50+",
    "SPF",
    "PA+++",
    "PA",
    "紫外线",
    "测试卡",
    "感应卡",
    "防晒值",
    "防晒力",
    "防晒",
    "防水",
    "防汗",
    "出汗",
    "遇水",
    "泼水",
    "纸巾",
    "海边",
    "海滩",
    "户外",
    "持妆",
    "通勤",
    "上班",
    "车里",
    "车内",
    "出去玩",
    "气色",
    "快速",
    "补妆",
    "开盖",
    "蘸粉",
    "粉扑",
    "轻拍",
    "泛红",
    "暗沉",
    "柔焦",
    "干净",
    "四效合一",
    "底妆",
    "定妆",
    "礼盒",
    "赠品",
    "618",
    "直播间",
]

TERM_ALIASES = {
    "SPF50+": ["SPF50", "SPF五十"],
    "PA+++": ["PA三个加"],
    "紫外线": ["UV"],
    "测试卡": ["感应卡"],
    "防晒": ["防晒值", "防晒力"],
    "遇水": ["泼水", "防水"],
    "出汗": ["汗", "高温"],
    "海边": ["海滩"],
    "车里": ["车内", "车上"],
    "出去玩": ["户外", "出游"],
    "气色": ["素颜", "带妆"],
    "礼盒": ["套装"],
    "赠品": ["送"],
    "618": ["六一八", "大促"],
}


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


def normalized(value: str) -> str:
    return str(value or "").lower()


def split_query_terms(value: str) -> list[str]:
    tokens = [
        item
        for item in re.split(r"[\s，。！？、,.!?；;：/]+", value)
        if 2 <= len(item) <= 10
    ]
    return list(dict.fromkeys(tokens))


def section_query(section: dict[str, Any]) -> str:
    parts = [
        section.get("intention_copy", ""),
        section.get("required_meaning", ""),
        section.get("required_visual", ""),
        section.get("voice_text", ""),
        " ".join(section.get("keywords") or []),
    ]
    return " ".join(str(part) for part in parts if part)


def section_terms(section: dict[str, Any]) -> list[tuple[str, float]]:
    weighted: dict[str, float] = {}

    def add(term: str, weight: float) -> None:
        value = str(term or "").strip()
        if len(value) < 2:
            return
        weighted[value] = max(weighted.get(value, 0.0), weight)

    for keyword in section.get("keywords") or []:
        add(str(keyword), 1.05)

    fields = [
        ("required_visual", 1.1),
        ("required_meaning", 1.0),
        ("intention_copy", 0.85),
        ("voice_text", 0.75),
    ]
    for field, weight in fields:
        value = str(section.get(field) or "")
        for term in DOMAIN_TERMS:
            if term in value:
                add(term, weight)
        for token in split_query_terms(value):
            add(token, min(weight, 0.55))

    return sorted(weighted.items(), key=lambda item: item[1], reverse=True)


def term_variants(term: str) -> list[str]:
    return [term, *(TERM_ALIASES.get(term) or [])]


def term_hit_info(record: dict[str, Any], section: dict[str, Any]) -> list[dict[str, Any]]:
    blob = normalized(text_blob(record))
    hits: list[dict[str, Any]] = []
    for term, weight in section_terms(section):
        variants = term_variants(term)
        if any(normalized(variant) in blob for variant in variants):
            hits.append({"term": term, "weight": weight})
    return hits


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
    hits = keyword_hits(record, section)
    return min(0.12, len(hits) * 0.02)


def keyword_hits(record: dict[str, Any], section: dict[str, Any]) -> list[str]:
    return [item["term"] for item in term_hit_info(record, section)]


def semantic_match_bonus(record: dict[str, Any], section: dict[str, Any]) -> tuple[float, list[str]]:
    hits = term_hit_info(record, section)
    if not hits:
        return 0.0, []
    score = min(0.34, sum(float(item["weight"]) for item in hits) * 0.045)
    terms = [str(item["term"]) for item in hits[:8]]
    return score, terms


def semantic_hit_weight(record: dict[str, Any], section: dict[str, Any]) -> float:
    return sum(float(item["weight"]) for item in term_hit_info(record, section))


def candidate_semantic_score(candidate: dict[str, Any]) -> float:
    try:
        return float(candidate.get("semantic_score") or 0)
    except (TypeError, ValueError):
        return 0.0


def qa_status_from(warnings: list[str], manual_reviews: list[str] | None = None, blocks: list[str] | None = None) -> str:
    if blocks:
        return "block"
    if warnings or manual_reviews:
        return "manual_review"
    return "ok"


def candidate_duration(candidate: dict[str, Any]) -> float:
    try:
        return max(0.0, float(candidate.get("duration_s") or candidate.get("source_duration_s") or 0))
    except (TypeError, ValueError):
        return 0.0


def candidate_score(candidate: dict[str, Any]) -> float:
    try:
        return float(candidate.get("adjusted_score") if candidate.get("adjusted_score") is not None else candidate.get("score") or 0)
    except (TypeError, ValueError):
        return 0.0


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
    bonus, semantic_terms = semantic_match_bonus(candidate, section)
    semantic_score = semantic_hit_weight(candidate, section)
    if bonus > 0:
        score += bonus
        reasons.append(f"口播/意图与素材字段命中：{'、'.join(semantic_terms)}")
    elif section.get("role") in ("proof", "product", "cta"):
        score -= 0.08
        risks.append("未命中本段必要语义/视觉术语")
    reuse_penalty = used_counts.get(shot_id, 0) * 0.42 + used_counts.get(asset_id, 0) * 0.035
    if reuse_penalty:
        score -= reuse_penalty
        risks.append(f"复用惩罚 {reuse_penalty:.3f}")
    subtitle = candidate.get("hard_subtitle_risk")
    if subtitle in ("medium", "high"):
        if subtitle == "medium":
            score -= 0.035 if len(semantic_terms) >= 2 else 0.06
        else:
            score -= 0.14
    output = dict(candidate)
    output["adjusted_score"] = round(score, 6)
    output["fill_reasons"] = reasons
    output["fill_risks"] = risks
    output["semantic_hits"] = semantic_terms
    output["semantic_score"] = round(semantic_score, 3)
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


def selected_clip_plan(candidate: dict[str, Any], section: dict[str, Any], clip_order: int, planned_duration: float) -> dict[str, Any]:
    return {
        "clip_order": clip_order,
        "shot_id": candidate.get("shot_id"),
        "asset_id": candidate.get("asset_id"),
        "label": candidate.get("label"),
        "score": candidate.get("score"),
        "adjusted_score": candidate.get("adjusted_score"),
        "source_clip_path": candidate.get("trimmed_clip_path") or candidate.get("source_clip_path") or "",
        "source_duration_s": round(candidate_duration(candidate), 3),
        "planned_duration_s": round(max(0.0, planned_duration), 3),
        "allow_loop": False,
        "loop_policy": "disabled_by_default",
        "visual_summary": candidate.get("visual_summary"),
        "source_meaning": candidate.get("source_meaning"),
        "selling_points": candidate.get("selling_points", []),
        "hard_subtitle_risk": candidate.get("hard_subtitle_risk"),
        "voiceover_fit": candidate.get("voiceover_fit"),
        "selection_reasons": candidate.get("fill_reasons", []),
        "selection_risks": candidate.get("fill_risks", []),
        "semantic_hits": candidate.get("semantic_hits", []),
        "semantic_score": candidate.get("semantic_score"),
    }


def allocate_clip_plan(selected: list[dict[str, Any]], section: dict[str, Any]) -> tuple[list[dict[str, Any]], float, float]:
    target = float(section.get("audio_duration_s") or 0)
    remaining = target
    plans: list[dict[str, Any]] = []
    total_source = 0.0
    for clip_order, item in enumerate(selected, start=1):
        source_duration = candidate_duration(item)
        total_source += source_duration
        planned_duration = min(source_duration, remaining) if remaining > 0 else 0.0
        plans.append(selected_clip_plan(item, section, clip_order, planned_duration))
        remaining = max(0.0, remaining - planned_duration)
    return plans, round(total_source, 3), round(max(0.0, remaining), 3)


def reject_reason(candidate: dict[str, Any], section: dict[str, Any], selected_ids: set[str], target: float) -> str:
    shot_id = str(candidate.get("shot_id") or "")
    if shot_id in selected_ids:
        return "已被选中"
    if not candidate.get("trimmed_clip_path") and not candidate.get("source_clip_path"):
        return "缺少可渲染素材路径"
    duration = candidate_duration(candidate)
    hits = keyword_hits(candidate, section)
    risks = candidate.get("fill_risks") or candidate.get("risks") or []
    if duration < target and not hits:
        return "时长不足且文本语义命中弱"
    if candidate.get("hard_subtitle_risk") == "high":
        return "硬字幕风险高"
    if risks:
        return str(risks[0])
    if duration < target:
        return "时长不足，优先使用更长或更匹配候选"
    return "综合分低于已选候选"


def build_rejected_candidates(
    candidates: list[dict[str, Any]],
    section: dict[str, Any],
    selected: list[dict[str, Any]],
    limit: int = 8,
) -> list[dict[str, Any]]:
    target = float(section.get("audio_duration_s") or 0)
    selected_ids = {str(item.get("shot_id") or "") for item in selected}
    rejected: list[dict[str, Any]] = []
    for item in candidates:
        if str(item.get("shot_id") or "") in selected_ids:
            continue
        rejected.append(
            {
                "rank": item.get("rank"),
                "shot_id": item.get("shot_id"),
                "asset_id": item.get("asset_id"),
                "label": item.get("label"),
                "score": item.get("score"),
                "adjusted_score": item.get("adjusted_score"),
                "duration_s": item.get("duration_s"),
                "rejected_reason": reject_reason(item, section, selected_ids, target),
            }
        )
        if len(rejected) >= limit:
            break
    return rejected


def confidence_for_selection(
    selected: list[dict[str, Any]],
    section: dict[str, Any],
    missing_duration_s: float,
    strategy: str,
    has_override: bool,
) -> float:
    if not selected:
        return 0.0
    scores = [candidate_score(item) for item in selected]
    avg_score = sum(scores) / len(scores) if scores else 0.0
    keyword_ratio = sum(1 for item in selected if keyword_hits(item, section)) / len(selected)
    confidence = 0.52 + min(0.24, max(0.0, avg_score) * 0.18) + keyword_ratio * 0.12
    if strategy == "single_story_unit_trim_to_audio":
        confidence += 0.08
    if has_override:
        confidence = max(confidence, 0.78)
    if any(item.get("hard_subtitle_risk") == "medium" for item in selected):
        confidence -= 0.08
    if any(item.get("hard_subtitle_risk") == "high" for item in selected):
        confidence -= 0.2
    if missing_duration_s > 0:
        confidence -= min(0.35, missing_duration_s * 0.06 + 0.12)
    return round(max(0.0, min(0.98, confidence)), 3)


def build_selection_section(
    section: dict[str, Any],
    candidates: list[dict[str, Any]],
    used_counts: dict[str, int],
    max_clips_per_section: int,
    records_by_id: dict[str, dict[str, Any]],
    selection_overrides: dict[str, Any],
) -> tuple[dict[str, Any], list[str], list[str]]:
    warnings: list[str] = []
    manual_reviews: list[str] = []
    target = float(section.get("audio_duration_s") or 0)
    adjusted = [adjusted_candidate(item, section, used_counts) for item in candidates]
    adjusted.sort(key=lambda item: candidate_score(item), reverse=True)

    selected_override = apply_selection_overrides(section, adjusted, records_by_id, selection_overrides)
    has_override = selected_override is not None
    if selected_override is not None:
        selected = [adjusted_candidate(item, section, used_counts) for item in selected_override]
        strategy = "manual_selection_override"
        selection_reason = "使用人工锁片 selection_overrides.json，脚本只校验时长和风险。"
    else:
        usable = [
            item
            for item in adjusted
            if (item.get("trimmed_clip_path") or item.get("source_clip_path")) and candidate_duration(item) > 0
        ]
        long_enough = [item for item in usable if candidate_duration(item) >= target - 0.03]
        strong_semantic = [item for item in usable if candidate_semantic_score(item) >= 1.6]
        best_long = long_enough[0] if long_enough else None
        best_long_is_semantic = best_long is not None and candidate_semantic_score(best_long) >= 1.6
        if best_long and (best_long_is_semantic or not strong_semantic):
            selected = [long_enough[0]]
            strategy = "single_story_unit_trim_to_audio"
            selection_reason = "优先选择单条足够长的 story unit，渲染时按口播时长裁切。"
        else:
            selected = []
            selected_assets: set[str] = set()
            total = 0.0
            first_hits: set[str] = set()
            semantic_pool = strong_semantic or usable
            for item in semantic_pool:
                if len(selected) >= max_clips_per_section:
                    break
                shot_id = str(item.get("shot_id") or "")
                if any(str(existing.get("shot_id") or "") == shot_id for existing in selected):
                    continue
                hits = set(keyword_hits(item, section))
                asset_id = str(item.get("asset_id") or "")
                if selected:
                    same_asset = asset_id in selected_assets
                    same_semantic = bool(hits and first_hits and hits.intersection(first_hits))
                    same_dimension = bool(hits) and len(hits.intersection(set(split_query_terms(section_query(section))))) > 0
                    if not (same_semantic or same_dimension or same_asset):
                        continue
                selected.append(item)
                selected_assets.add(asset_id)
                if not first_hits:
                    first_hits = hits
                total += candidate_duration(item)
                if total >= target - 0.03:
                    break
            strategy = "multi_story_unit_semantic_fill"
            selection_reason = f"单条长素材语义命中不足或不存在，改用最多 {max_clips_per_section} 条同语义候选拼接。"

    selected_clips, selected_duration_s, missing_duration_s = allocate_clip_plan(selected, section)
    if not selected_clips:
        message = f"{section.get('section_id')}: 没有可用候选，缺口 {target:.3f}s"
        warnings.append(message)
        manual_reviews.append(message)
        strategy = "no_usable_candidate_manual_review"
        selection_reason = "候选池没有可渲染素材，需重新召回、改文案或人工锁片。"
    elif missing_duration_s > 0.08:
        message = (
            f"{section.get('section_id')}: 已选素材总时长 {selected_duration_s:.3f}s "
            f"短于口播 {target:.3f}s，缺口 {missing_duration_s:.3f}s；默认不 loop"
        )
        warnings.append(message)
        manual_reviews.append(message)
    if any(item.get("hard_subtitle_risk") == "high" for item in selected):
        message = f"{section.get('section_id')}: 已选素材存在 hard_subtitle_risk=high"
        warnings.append(message)
        manual_reviews.append(message)
    if any(item.get("hard_subtitle_risk") == "medium" for item in selected):
        message = f"{section.get('section_id')}: 已选素材存在 hard_subtitle_risk=medium，建议人工复核"
        warnings.append(message)
        manual_reviews.append(message)

    requires_review = bool(manual_reviews)
    confidence = confidence_for_selection(selected, section, missing_duration_s, strategy, has_override)
    selection_section = {
        "section_id": section.get("section_id"),
        "timeline_order": section.get("timeline_order"),
        "role": section.get("role"),
        "audio_duration_s": target,
        "query": section_query(section),
        "selection_strategy": strategy,
        "selection_source": "manual_override" if has_override else "rules_text_planner_v1",
        "selection_reason": selection_reason,
        "selected_shot_ids": candidate_ids(selected),
        "selected_clips": selected_clips,
        "selected_duration_s": selected_duration_s,
        "missing_duration_s": missing_duration_s,
        "rejected_candidates": build_rejected_candidates(adjusted, section, selected),
        "confidence": confidence,
        "requires_review": requires_review,
        "qa": {
            "status": "manual_review" if requires_review else "ok",
            "warnings": warnings,
        },
    }
    return selection_section, warnings, manual_reviews


def render_clip(
    source: Path,
    output: Path,
    duration: float,
    width: int,
    height: int,
    fps: int,
    preset: str,
) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    source_duration = probe_duration(source)
    if source_duration is None:
        raise RuntimeError(f"cannot probe source duration: {source}")
    if source_duration + 0.04 < duration:
        duration = source_duration
        warnings.append(f"source shorter than requested; rendered natural length {source_duration:.3f}s; loop disabled")

    frames = max(1, int(math.ceil(duration * fps)))
    vf = (
        "setpts=PTS-STARTPTS,"
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,fps={fps},format=yuv420p"
    )
    command = [
        "ffmpeg",
        "-y",
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
    parser.add_argument("--timeline-selection", default="timeline_selection.json")
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
    timeline_selection_path = as_abs(args.timeline_selection, task_dir)
    candidate_sections_path = task_dir / "candidate_sections.json"
    timeline_fill_path = task_dir / "timeline_fill.json"
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

    for section in sections:
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
        adjusted = [adjusted_candidate(item, section, {}) for item in candidates]
        adjusted.sort(key=lambda item: candidate_score(item), reverse=True)
        candidate_sections.append(
            {
                "section_id": section.get("section_id"),
                "timeline_order": section.get("timeline_order"),
                "role": section.get("role"),
                "query": query,
                "search_role": role,
                "audio_duration_s": float(section.get("audio_duration_s") or 0),
                "candidate_count": len(adjusted),
                "candidates": adjusted,
            }
        )

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
            "candidate_sections": str(candidate_sections_path),
            "next_artifact": str(timeline_selection_path),
        },
        "policy": {
            "script_first": True,
            "tts_after_script": True,
            "retrieval_unit": index.get("planning_granularity", "story_unit"),
            "prefer_long_material": True,
            "loop_default": False,
        },
        "sections": candidate_sections,
        "qa": {
            "status": "ok",
            "warnings": [],
        },
        "next_consumers": ["voah-timeline-selection"],
    }
    write_json(candidate_sections_path, candidate_payload)

    sections_by_id = {str(item.get("section_id") or ""): item for item in sections}
    selection_sections: list[dict[str, Any]] = []
    selection_warnings: list[str] = []
    selection_manual_reviews: list[str] = []
    used_counts: dict[str, int] = {}

    for candidate_section in candidate_payload.get("sections") or []:
        section = sections_by_id.get(str(candidate_section.get("section_id") or ""))
        if section is None:
            raise RuntimeError(f"candidate section has no matching audio section: {candidate_section.get('section_id')}")
        selection_section, select_warnings, select_manual_reviews = build_selection_section(
            section=section,
            candidates=candidate_section.get("candidates") or [],
            used_counts=used_counts,
            max_clips_per_section=args.max_clips_per_section,
            records_by_id=records_by_id,
            selection_overrides=selection_overrides,
        )
        selection_warnings.extend(select_warnings)
        selection_manual_reviews.extend(select_manual_reviews)
        selection_sections.append(selection_section)
        for selected_item in selection_section.get("selected_clips") or []:
            used_counts[str(selected_item.get("shot_id") or "")] = used_counts.get(str(selected_item.get("shot_id") or ""), 0) + 1
            used_counts[str(selected_item.get("asset_id") or "")] = used_counts.get(str(selected_item.get("asset_id") or ""), 0) + 1

    selection_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_timeline_selection_from_candidates",
        "created_at": iso_now(),
        "product": audio_sections.get("product") or {},
        "inputs": {
            "audio_sections": str(audio_sections_path),
            "candidate_sections": str(candidate_sections_path),
            "selection_overrides": {
                "path": str(as_abs(args.selection_overrides)) if args.selection_overrides else "",
                "source": "manual" if args.selection_overrides else "",
                "enabled": bool(args.selection_overrides),
            },
        },
        "outputs": {
            "timeline_selection": str(timeline_selection_path),
            "next_artifact": str(timeline_fill_path),
        },
        "policy": {
            "planner": "rules_text_planner_v1",
            "llm_provider": None,
            "multimodal_llm_default": False,
            "prefer_single_long_story_unit": True,
            "max_clips_per_section": args.max_clips_per_section,
            "loop_default": False,
            "material_shortage_action": "manual_review",
        },
        "sections": selection_sections,
        "summary": {
            "section_count": len(selection_sections),
            "selected_clip_count": sum(len(item.get("selected_clips") or []) for item in selection_sections),
            "requires_review_count": sum(1 for item in selection_sections if item.get("requires_review")),
            "missing_duration_s": round(sum(float(item.get("missing_duration_s") or 0) for item in selection_sections), 3),
        },
        "qa": {
            "status": qa_status_from(selection_warnings, selection_manual_reviews),
            "warnings": selection_warnings,
            "manual_review": selection_manual_reviews,
        },
        "next_consumers": ["voah-video-fill"],
    }
    write_json(timeline_selection_path, selection_payload)

    timeline_sections: list[dict[str, Any]] = []
    rendered_parts: list[Path] = []
    fill_warnings = list(selection_warnings)
    fill_manual_reviews = list(selection_manual_reviews)
    selection_by_id = {str(item.get("section_id") or ""): item for item in selection_sections}

    for section_index, section in enumerate(sections, start=1):
        selection_section = selection_by_id.get(str(section.get("section_id") or ""))
        if selection_section is None:
            raise RuntimeError(f"missing timeline_selection section: {section.get('section_id')}")

        clip_items: list[dict[str, Any]] = []
        section_rendered_duration = 0.0
        for clip_index, selected_item in enumerate(selection_section.get("selected_clips") or [], start=1):
            source = as_abs(selected_item.get("source_clip_path") or "")
            render_duration = float(selected_item.get("planned_duration_s") or 0)
            if render_duration <= 0:
                fill_warnings.append(f"{section.get('section_id')}/{selected_item.get('shot_id')}: planned duration is 0; skipped")
                fill_manual_reviews.append(f"{section.get('section_id')}/{selected_item.get('shot_id')}: planned duration is 0")
                continue
            out_clip = work_dir / f"{section_index:03d}_{clip_index:02d}_{safe_filename(str(selected_item.get('shot_id') or 'shot'))}.mp4"
            probe, render_item_warnings = render_clip(
                source=source,
                output=out_clip,
                duration=render_duration,
                width=args.width,
                height=args.height,
                fps=args.fps,
                preset=args.preset,
            )
            fill_warnings.extend([f"{section.get('section_id')}/{selected_item.get('shot_id')}: {warning}" for warning in render_item_warnings])
            if render_item_warnings:
                fill_manual_reviews.extend(
                    [f"{section.get('section_id')}/{selected_item.get('shot_id')}: {warning}" for warning in render_item_warnings]
                )
            rendered_parts.append(out_clip)
            section_rendered_duration += float(probe.get("rendered_duration_s") or render_duration)
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
                    "selection_reasons": selected_item.get("selection_reasons", []),
                    "selection_risks": selected_item.get("selection_risks", []),
                    "allow_loop": False,
                    "loop_policy": "disabled_by_default",
                    **probe,
                }
            )

        missing_duration_s = float(selection_section.get("missing_duration_s") or 0)
        if missing_duration_s > 0.08:
            fill_warnings.append(f"{section.get('section_id')}: rendered video is {missing_duration_s:.3f}s short; loop disabled")
            fill_manual_reviews.append(f"{section.get('section_id')}: missing_duration_s={missing_duration_s:.3f}")

        timeline_sections.append(
            {
                **section,
                "fill_policy": "execute_timeline_selection_no_loop",
                "selection_strategy": selection_section.get("selection_strategy"),
                "selection_reason": selection_section.get("selection_reason"),
                "selected_shot_ids": selection_section.get("selected_shot_ids"),
                "requires_review": selection_section.get("requires_review"),
                "missing_duration_s": missing_duration_s,
                "clips": clip_items,
                "rendered_duration_s": round(section_rendered_duration, 3),
            }
        )

    if not rendered_parts:
        raise RuntimeError("timeline_selection has no renderable clips")

    video_no_audio = task_dir / "preview_no_audio.mp4"
    concat_video(rendered_parts, video_no_audio, task_dir / "timeline_fill_video_concat.txt")
    mux_audio(video_no_audio, voice_wav, output)

    voice_duration = probe_duration(voice_wav)
    preview_duration = probe_duration(output)
    if voice_duration is not None and preview_duration is not None and abs(voice_duration - preview_duration) > 0.15:
        fill_warnings.append(f"preview duration {preview_duration}s differs from voice duration {voice_duration}s")
        fill_manual_reviews.append(f"preview_duration_s={preview_duration} differs from voice_duration_s={voice_duration}")

    timeline_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_video_fill_from_audio_section_retrieval",
        "created_at": iso_now(),
        "product": audio_sections.get("product") or {},
        "inputs": {
            "audio_sections": str(audio_sections_path),
            "candidate_sections": str(candidate_sections_path),
            "timeline_selection": str(timeline_selection_path),
            "voice_wav": str(voice_wav),
        },
        "outputs": {
            "timeline_fill": str(timeline_fill_path),
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
            "render_policy": "execute_timeline_selection_trim_or_concat_no_loop",
            "selected_clip_count": sum(len(item.get("clips") or []) for item in timeline_sections),
            "missing_duration_s": round(sum(float(item.get("missing_duration_s") or 0) for item in timeline_sections), 3),
        },
        "timeline": timeline_sections,
        "media_probe": probe_media(output),
        "qa": {
            "status": qa_status_from(fill_warnings, fill_manual_reviews),
            "warnings": fill_warnings,
            "manual_review": fill_manual_reviews,
        },
        "next_consumers": ["voah-caption-plan", "hyperframes-subtitle-burn"],
    }
    write_json(timeline_fill_path, timeline_payload)

    print(f"candidate_sections={candidate_sections_path}")
    print(f"timeline_selection={timeline_selection_path}")
    print(f"timeline_fill={timeline_fill_path}")
    print(f"preview_no_subtitles={output}")
    print(f"duration_s={preview_duration}")
    print(f"qa={timeline_payload['qa']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
