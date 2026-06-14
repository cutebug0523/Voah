#!/usr/bin/env python3
"""
参考实现：将 Omni 结果 + ffprobe 数据规范化为分层记录。

关键要求：
1. 每个 Shot 保留 shot 级字段，不只依赖 Asset/full-video 汇总。
2. 兼容 Omni highlight 的 start/end 与 start_time/end_time。
3. 输出双字段别名：id/shot_id、start_time/start_s、end_time/end_s，避免后续脚本断链。
4. 如果 Omni 输出 story_units，同步落盘为剪辑规划主单位；physical shot 只作为其内部裁切单位。
"""

import glob
import json
import os

SHOT_FIELDS = [
    "visual_summary",
    "source_meaning",
    "source_asr",
    "source_ocr",
    "hard_subtitle_risk",
    "voiceover_fit",
    "usable_start",
    "usable_end",
    "can_standalone",
    "shot_type",
    "selling_points",
]

STORY_UNIT_FIELDS = [
    "visual_summary",
    "source_meaning",
    "source_asr",
    "source_ocr",
    "hard_subtitle_risk",
    "voiceover_fit",
    "usable_start",
    "usable_end",
    "can_standalone",
]


def first(record: dict, *keys, default=None):
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return default


def load_json(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def as_float(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def as_list(value):
    if value in (None, "", []):
        return []
    if isinstance(value, list):
        return value
    return [value]


def as_text(value) -> str:
    if value in (None, "", []):
        return ""
    if isinstance(value, list):
        return " ".join(str(item) for item in value if item not in (None, ""))
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def highlight_start(hl: dict) -> float:
    return as_float(first(hl, "start_time", "start", "start_s", default=0))


def highlight_end(hl: dict, start: float) -> float:
    return as_float(first(hl, "end_time", "end", "end_s", default=start))


def video_duration(probe: dict) -> float:
    return as_float(first(probe, "duration", "duration_s", default=0))


def probe_media(probe: dict) -> dict:
    return {
        "duration_s": video_duration(probe),
        "width": first(probe, "width"),
        "height": first(probe, "height"),
        "resolution": first(probe, "resolution"),
        "fps": first(probe, "fps"),
        "video_codec": first(probe, "vcodec", "video_codec"),
        "audio_codec": first(probe, "acodec", "audio_codec"),
        "size_bytes": first(probe, "size_bytes", "file_size"),
        "bit_rate": first(probe, "bit_rate"),
        "rotation": first(probe, "rotation", default=0),
    }


def build_asset(vid: str, omni: dict, probe: dict, product: str, product_slug: str) -> dict:
    asset_id = f"asset_{vid}"
    local_path = first(omni, "local_path", default=first(probe, "local", "local_path", default=""))
    oss_url = first(omni, "oss_url", default=first(probe, "oss_url", default=""))
    media = probe_media(probe)
    full_video_summary = first(omni, "full_video_summary", "omni_summary", default=omni) or {}

    return {
        "id": asset_id,
        "asset_id": asset_id,
        "video_id": vid,
        "product": {"slug": product_slug, "name": product},
        "product_slug": product_slug,
        "product_source": "directory",
        "local_path": local_path,
        "oss_url": oss_url,
        "file_name": os.path.basename(local_path),
        "file": {
            "local": local_path,
            "oss_url": oss_url,
            **media,
        },
        "media": media,
        "full_video_summary": full_video_summary,
        "omni_summary": {
            "visual_summary": first(full_video_summary, "visual_summary", default=first(omni, "visual_summary")),
            "source_ocr": first(full_video_summary, "source_ocr", default=first(omni, "source_ocr")),
            "source_asr": first(full_video_summary, "source_asr", default=first(omni, "source_asr")),
            "source_meaning": first(full_video_summary, "source_meaning", default=first(omni, "source_meaning")),
            "selling_points": first(full_video_summary, "selling_points", default=first(omni, "selling_points")),
            "visual_actions": first(full_video_summary, "visual_actions", default=first(omni, "visual_actions")),
            "shot_type": first(full_video_summary, "shot_type", default=first(omni, "shot_type")),
            "timeline_roles": first(full_video_summary, "timeline_roles", default=first(omni, "timeline_roles")),
            "product_evidence": first(full_video_summary, "product_evidence", default=first(omni, "product_evidence")),
            "hard_subtitle_risk": first(full_video_summary, "hard_subtitle_risk", default=first(omni, "hard_subtitle_risk")),
            "voiceover_fit": first(full_video_summary, "voiceover_fit", default=first(omni, "voiceover_fit")),
            "usable_start": first(full_video_summary, "usable_start", default=first(omni, "usable_start")),
            "usable_end": first(full_video_summary, "usable_end", default=first(omni, "usable_end")),
        },
    }


def build_segment(asset: dict, omni: dict, vid: str, probe: dict, product: str) -> dict:
    segment_id = f"seg_{vid}"
    duration = video_duration(probe)
    summary = asset.get("omni_summary", {})
    return {
        "id": segment_id,
        "segment_id": segment_id,
        "asset_id": asset["asset_id"],
        "product": product,
        "segment_type": "full_video",
        "start_time": 0.0,
        "end_time": duration,
        "start_s": 0.0,
        "end_s": duration,
        "duration_s": duration,
        "source_meaning": summary.get("source_meaning", ""),
        "visual_summary": summary.get("visual_summary", ""),
        "source_asr": summary.get("source_asr", ""),
        "source_ocr": summary.get("source_ocr", ""),
        "selling_points": as_list(summary.get("selling_points")),
        "timeline_roles": summary.get("timeline_roles"),
        "hard_subtitle_risk": summary.get("hard_subtitle_risk"),
        "voiceover_fit": summary.get("voiceover_fit"),
        "child_shot_ids": [],
        "child_story_unit_ids": [],
    }


def build_shot(vid: str, asset_id: str, hl: dict, omni: dict, idx: int, product: str) -> dict:
    raw_start = highlight_start(hl)
    raw_end = highlight_end(hl, raw_start)
    usable_start = as_float(first(hl, "usable_start", default=raw_start), raw_start)
    usable_end = as_float(first(hl, "usable_end", default=raw_end), raw_end)
    if usable_end <= usable_start:
        usable_start, usable_end = raw_start, raw_end
    start = min(raw_start, usable_start)
    end = max(raw_end, usable_end)
    shot_id = f"shot_{vid}_{idx}"
    duration = round(max(0.0, end - start), 3)

    full_shot_types = as_list(first(omni, "shot_type", default=[]))
    shot_type_hint = (
        first(hl, "shot_type", "shot_type_hint", default="")
        or (full_shot_types[min(idx, len(full_shot_types) - 1)] if full_shot_types else "")
    )
    selling_points = as_list(first(hl, "selling_points", default=first(omni, "selling_points", default=[])))

    return {
        "id": shot_id,
        "shot_id": shot_id,
        "segment_id": f"seg_{vid}",
        "asset_id": asset_id,
        "product": product,
        "index": idx,
        "label": first(hl, "label", default=""),

        "start_time": start,
        "end_time": end,
        "start_s": start,
        "end_s": end,
        "duration_s": duration,

        "visual_summary": first(hl, "visual_summary", default=""),
        "source_meaning": first(hl, "source_meaning", default=""),
        "source_asr": first(hl, "source_asr", default=""),
        "source_ocr": first(hl, "source_ocr", default=[]),
        "hard_subtitle_risk": first(hl, "hard_subtitle_risk", default="unknown"),
        "voiceover_fit": first(hl, "voiceover_fit", default="unknown"),
        "usable_start": usable_start,
        "usable_end": usable_end,
        "can_standalone": bool(first(hl, "can_standalone", default=False)),

        "shot_type": shot_type_hint,
        "shot_type_hint": shot_type_hint,
        "selling_points": selling_points,
        "visual_actions": as_list(first(hl, "visual_actions", default=[])),
        "child_moment_ids": [],

        "trimmed_clip_path": "",
        "trimmed_oss_url": "",
    }


def overlap_seconds(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def story_bounds(unit: dict) -> tuple:
    raw_start = as_float(first(unit, "start_time", "start", "start_s", default=0))
    raw_end = as_float(first(unit, "end_time", "end", "end_s", default=raw_start))
    usable_start = as_float(first(unit, "usable_start", default=raw_start), raw_start)
    usable_end = as_float(first(unit, "usable_end", default=raw_end), raw_end)
    if usable_end <= usable_start:
        usable_start, usable_end = raw_start, raw_end
    start = min(raw_start, usable_start)
    end = max(raw_end, usable_end)
    return start, end, usable_start, usable_end


def build_story_unit(
    vid: str,
    asset_id: str,
    unit: dict,
    idx: int,
    product: str,
    child_shots: list,
) -> dict:
    start, end, usable_start, usable_end = story_bounds(unit)
    unit_id = f"unit_{vid}_{idx}"
    duration = round(max(0.0, end - start), 3)

    overlapping = []
    for shot in child_shots:
        shot_start = as_float(first(shot, "start_s", "start_time", default=0))
        shot_end = as_float(first(shot, "end_s", "end_time", default=shot_start))
        if overlap_seconds(start, end, shot_start, shot_end) > 0.05:
            overlapping.append(shot["shot_id"])

    if not overlapping and child_shots:
        nearest = min(
            child_shots,
            key=lambda shot: abs(as_float(first(shot, "start_s", "start_time", default=0)) - start),
        )
        overlapping = [nearest["shot_id"]]

    selling_points = as_list(first(unit, "selling_points", default=[]))
    timeline_roles = as_list(first(unit, "timeline_roles", "roles", default=[]))
    source_ocr = first(unit, "source_ocr", default=[])

    return {
        "id": unit_id,
        "shot_id": unit_id,
        "story_unit_id": unit_id,
        "segment_id": f"seg_{vid}",
        "asset_id": asset_id,
        "product": product,
        "index": idx,
        "is_story_unit": True,
        "planning_granularity": "story_unit",
        "boundary_source": first(unit, "boundary_source", default="omni_story_unit"),
        "label": first(unit, "label", "title", default=""),

        "start_time": start,
        "end_time": end,
        "start_s": start,
        "end_s": end,
        "duration_s": duration,

        "visual_summary": first(unit, "visual_summary", default=""),
        "source_meaning": first(unit, "source_meaning", "meaning", default=""),
        "source_asr": first(unit, "source_asr", default=""),
        "source_ocr": source_ocr,
        "hard_subtitle_risk": first(unit, "hard_subtitle_risk", default="unknown"),
        "voiceover_fit": first(unit, "voiceover_fit", default="unknown"),
        "usable_start": usable_start,
        "usable_end": usable_end,
        "can_standalone": bool(first(unit, "can_standalone", default=False)),

        "shot_type": first(unit, "shot_type", "shot_type_hint", default=""),
        "shot_type_hint": first(unit, "shot_type", "shot_type_hint", default=""),
        "selling_points": selling_points,
        "visual_actions": as_list(first(unit, "visual_actions", default=[])),
        "timeline_roles": timeline_roles,
        "editor_role": first(unit, "editor_role", "role", default=""),
        "same_segment_reason": first(unit, "same_segment_reason", "reason", default=""),
        "scene_segment_ids": as_list(first(unit, "scene_segment_ids", default=[])),
        "child_shot_ids": overlapping,
        "child_physical_shot_ids": [],

        "trimmed_clip_path": "",
        "trimmed_oss_url": "",
    }


def infer_story_units_from_shots(vid: str, asset_id: str, shots: list, product: str) -> list:
    """Fallback when Omni only returns highlights.

    This deliberately merges only near-contiguous highlights from the same asset.
    Omni-provided story_units remain the preferred source of truth.
    """
    if not shots:
        return []

    ordered = sorted(shots, key=lambda shot: as_float(first(shot, "start_s", "start_time", default=0)))
    groups = []
    current = [ordered[0]]
    for shot in ordered[1:]:
        prev = current[-1]
        prev_end = as_float(first(prev, "end_s", "end_time", default=0))
        start = as_float(first(shot, "start_s", "start_time", default=0))
        merged_duration = as_float(first(shot, "end_s", "end_time", default=start)) - as_float(first(current[0], "start_s", "start_time", default=0))
        if start - prev_end <= 0.8 and merged_duration <= 9.0:
            current.append(shot)
        else:
            groups.append(current)
            current = [shot]
    groups.append(current)

    units = []
    for idx, group in enumerate(groups):
        start = min(as_float(first(shot, "start_s", "start_time", default=0)) for shot in group)
        end = max(as_float(first(shot, "end_s", "end_time", default=start)) for shot in group)
        visual_summary = "；".join(filter(None, [shot.get("visual_summary", "") for shot in group]))
        source_meaning = "；".join(filter(None, [shot.get("source_meaning", "") for shot in group]))
        source_asr = " ".join(filter(None, [as_text(shot.get("source_asr", "")) for shot in group]))
        source_ocr = []
        for shot in group:
            source_ocr.extend(as_list(shot.get("source_ocr")))
        selling_points = []
        for shot in group:
            selling_points.extend(as_list(shot.get("selling_points")))
        unit = {
            "start": start,
            "end": end,
            "usable_start": start,
            "usable_end": end,
            "label": group[0].get("label", "") if len(group) == 1 else f"{group[0].get('label', '')} 等连续内容",
            "visual_summary": visual_summary,
            "source_meaning": source_meaning,
            "source_asr": source_asr,
            "source_ocr": source_ocr,
            "hard_subtitle_risk": group[0].get("hard_subtitle_risk", "unknown"),
            "voiceover_fit": group[0].get("voiceover_fit", "unknown"),
            "can_standalone": any(bool(shot.get("can_standalone")) for shot in group),
            "shot_type": group[0].get("shot_type", ""),
            "selling_points": sorted(set(selling_points)),
            "visual_actions": [],
            "boundary_source": "fallback_merge_adjacent_highlights",
            "same_segment_reason": "Omni 未输出 story_units；按同一原片内相邻高光片段兜底合并。",
        }
        units.append(build_story_unit(vid, asset_id, unit, idx, product, group))
    return units


def build_moment(shot: dict, product: str) -> dict:
    moment_id = shot["shot_id"].replace("shot_", "moment_")
    return {
        "id": moment_id,
        "moment_id": moment_id,
        "shot_id": shot["shot_id"],
        "segment_id": shot["segment_id"],
        "asset_id": shot["asset_id"],
        "product": product,
        "start_time": shot["start_time"],
        "end_time": shot["end_time"],
        "start_s": shot["start_s"],
        "end_s": shot["end_s"],
        "duration_s": shot["duration_s"],
        "label": shot["label"],
        "visual_summary": shot.get("visual_summary", ""),
        "source_meaning": shot.get("source_meaning", ""),
        "source_asr": shot.get("source_asr", ""),
        "source_ocr": shot.get("source_ocr", []),
        "is_highlight": True,
    }


def normalize(omni_dir: str, output_dir: str, probes: dict, product: str, product_slug: str):
    omni_results = {}
    for path in sorted(glob.glob(os.path.join(omni_dir, "omni_*.json"))):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        vid = first(data, "video_id", default=os.path.basename(path)[5:-5])
        if vid == "summary":
            continue
        omni_results[vid] = data

    assets, segments, story_units, shots, moments = [], [], [], [], []

    for vid, omni in omni_results.items():
        probe = probes.get(vid, {})
        asset = build_asset(vid, omni, probe, product, product_slug)
        segment = build_segment(asset, omni, vid, probe, product)
        assets.append(asset)
        segments.append(segment)

        asset_shots = []
        for idx, hl in enumerate(omni.get("highlights", [])):
            shot = build_shot(vid, asset["asset_id"], hl, omni, idx, product)
            moment = build_moment(shot, product)
            shot["child_moment_ids"] = [moment["moment_id"]]
            shots.append(shot)
            asset_shots.append(shot)
            moments.append(moment)

        raw_story_units = first(omni, "story_units", "story_segments", "same_segments", default=[])
        if raw_story_units:
            for idx, unit in enumerate(raw_story_units):
                story_units.append(build_story_unit(vid, asset["asset_id"], unit, idx, product, asset_shots))
        else:
            story_units.extend(infer_story_units_from_shots(vid, asset["asset_id"], asset_shots, product))

        segment["child_shot_ids"] = [
            shot["shot_id"] for shot in shots if shot["segment_id"] == segment["segment_id"]
        ]
        segment["child_story_unit_ids"] = [
            unit["story_unit_id"] for unit in story_units if unit["segment_id"] == segment["segment_id"]
        ]
        segment["shot_count"] = len(segment["child_shot_ids"])
        segment["story_unit_count"] = len(segment["child_story_unit_ids"])

    def write_json(filename, data):
        path = os.path.join(output_dir, filename)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"  -> {filename} ({len(data)} records)")
        return path

    write_json("assets.json", assets)
    write_json("segments.json", segments)
    write_json("story_units.json", story_units)
    write_json("shots.json", shots)
    write_json("moments.json", moments)

    missing = 0
    for shot in shots:
        for field in SHOT_FIELDS:
            value = shot.get(field)
            if field in ("source_asr", "source_ocr", "selling_points"):
                continue
            if value in (None, "", []):
                print(f"  WARNING: {shot['shot_id']} missing field {field}")
                missing += 1
    if missing == 0:
        print("All required shot-level fields present")

    unit_missing = 0
    for unit in story_units:
        for field in STORY_UNIT_FIELDS:
            value = unit.get(field)
            if field in ("source_asr", "source_ocr"):
                continue
            if value in (None, "", []):
                print(f"  WARNING: {unit['story_unit_id']} missing field {field}")
                unit_missing += 1
    if story_units and unit_missing == 0:
        print("All required story-unit fields present")

    print(
        f"\nNormalize done: {len(assets)} assets -> {len(segments)} segments -> "
        f"{len(story_units)} story units -> {len(shots)} shots -> {len(moments)} moments"
    )
    return assets, segments, story_units, shots, moments


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("omni_dir", nargs="?", default=".")
    parser.add_argument("output_dir", nargs="?", default=None)
    parser.add_argument("--product", default="防晒气垫")
    parser.add_argument("--product-slug", default="fangshai-qidian")
    parser.add_argument("--probes", help="Optional ffprobe summary JSON keyed by video_id")
    args = parser.parse_args()

    probes = load_json(args.probes) if args.probes else {}
    normalize(
        args.omni_dir,
        args.output_dir or args.omni_dir,
        probes,
        args.product,
        args.product_slug,
    )
