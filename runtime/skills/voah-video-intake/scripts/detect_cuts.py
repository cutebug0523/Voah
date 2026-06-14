#!/usr/bin/env python3
"""
Refine Omni story units into physical shots using visual cut points.

Run this AFTER Omni understanding and normalize. It does not decide which parts
of the video are useful or belong to the same scene; Omni does that. This
script only splits each useful story unit by visual scene boundaries.

Input:
- assets.json
- story_units.json (preferred: same-segment units from Omni)
- shots.json (fallback: semantic highlights from Omni)

Output:
- scene_cuts.json
- physical_shots.json

The generated physical shots are intended for clean trimming/vectorization. They
keep parent_shot_id/story_unit_id so later planning can still group them back
into the original same-segment unit.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Tuple


SHOWINFO_TIME_RE = re.compile(r"pts_time:([0-9.]+)")


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def first(record: dict, *keys, default=None):
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return default


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


def asset_id_of(asset: dict) -> str:
    return first(asset, "asset_id", "id", default="")


def shot_id_of(shot: dict) -> str:
    return first(shot, "shot_id", "id", default="")


def asset_local_path(asset: dict) -> str:
    nested_file = asset.get("file") if isinstance(asset.get("file"), dict) else {}
    return first(asset, "local_path", default=first(nested_file, "local", default=""))


def asset_duration(asset: dict) -> float:
    media = asset.get("media") if isinstance(asset.get("media"), dict) else {}
    nested_file = asset.get("file") if isinstance(asset.get("file"), dict) else {}
    return as_float(first(asset, "duration_s", default=first(media, "duration_s", default=first(nested_file, "duration_s", default=0))))


def shot_bounds(shot: dict) -> Tuple[float, float]:
    start = as_float(first(shot, "usable_start", "start_s", "start_time", default=0))
    end = as_float(first(shot, "usable_end", "end_s", "end_time", default=start))
    return start, end


def ffmpeg_scene_cuts(video_path: str, threshold: float, timeout: int) -> List[float]:
    expr = "select='gt(scene,{})',showinfo".format(threshold)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        video_path,
        "-vf",
        expr,
        "-an",
        "-f",
        "null",
        "-",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-1000:])
    times = sorted({round(float(m.group(1)), 3) for m in SHOWINFO_TIME_RE.finditer(result.stderr)})
    return [t for t in times if t > 0.25]


def merge_short_segments(bounds: List[float], min_duration: float) -> List[Tuple[float, float]]:
    if len(bounds) < 2:
        return []
    segments = [[bounds[i], bounds[i + 1]] for i in range(len(bounds) - 1)]
    changed = True
    while changed and len(segments) > 1:
        changed = False
        for i, seg in enumerate(list(segments)):
            duration = seg[1] - seg[0]
            if duration >= min_duration:
                continue
            if i == 0:
                segments[1][0] = seg[0]
            elif i == len(segments) - 1:
                segments[i - 1][1] = seg[1]
            else:
                prev_len = segments[i - 1][1] - segments[i - 1][0]
                next_len = segments[i + 1][1] - segments[i + 1][0]
                if prev_len <= next_len:
                    segments[i - 1][1] = seg[1]
                else:
                    segments[i + 1][0] = seg[0]
            segments.pop(i)
            changed = True
            break
    return [(round(s, 3), round(e, 3)) for s, e in segments if e - s > 0.05]


def split_semantic_shot(shot: dict, cuts: List[float], min_duration: float, edge_padding: float) -> List[Tuple[float, float]]:
    start, end = shot_bounds(shot)
    if end <= start:
        return []
    inner_cuts = [
        cut for cut in cuts
        if cut > start + edge_padding and cut < end - edge_padding
    ]
    bounds = [start] + inner_cuts + [end]
    return merge_short_segments(bounds, min_duration)


def snap_planning_records_to_cuts(
    records: List[dict],
    cuts: List[float],
    asset_start: float,
    asset_end: float,
    min_duration: float,
    snap_tolerance: float,
) -> List[dict]:
    """Snap story-unit boundaries to visual cuts before trimming/indexing.

    Omni timestamps are semantic and often drift across visual edits. For a
    planning unit, dirty visual boundaries are worse than a slightly shorter
    semantic range, so internal boundaries snap to the nearest detected scene cut
    within tolerance. The first/last bounds stay at asset edges unless there is
    no usable duration.
    """
    if not records:
        return records

    ordered = sorted(records, key=lambda r: as_float(first(r, "start_s", "start_time", "usable_start", default=0)))
    snap_points = [asset_start] + [cut for cut in cuts if asset_start < cut < asset_end] + [asset_end]

    def nearest_cut(value: float) -> tuple:
        candidates = [cut for cut in snap_points if abs(cut - value) <= snap_tolerance]
        if not candidates:
            return value, "omni"
        # Prefer the earlier cut on ties/near-ties, because Omni often timestamps
        # the semantic sentence ending after the visual edit already happened.
        best = min(candidates, key=lambda cut: (abs(cut - value), cut))
        return best, "scene_cut"

    snapped_bounds = []
    for idx, record in enumerate(ordered):
        raw_start, raw_end = shot_bounds(record)
        if idx == 0:
            start, start_source = raw_start, "omni"
        else:
            start, start_source = nearest_cut(raw_start)
        if idx == len(ordered) - 1:
            end, end_source = raw_end, "omni"
        else:
            end, end_source = nearest_cut(raw_end)
        snapped_bounds.append([start, end, start_source, end_source])

    # Keep neighboring story units contiguous when both touched the same rough
    # boundary. Prefer the earlier unit's snapped end as the shared boundary.
    for idx in range(len(snapped_bounds) - 1):
        boundary = snapped_bounds[idx][1]
        next_boundary = snapped_bounds[idx + 1][0]
        if abs(boundary - next_boundary) <= snap_tolerance:
            shared = boundary if snapped_bounds[idx][3] == "scene_cut" else next_boundary
            snapped_bounds[idx][1] = shared
            snapped_bounds[idx + 1][0] = shared

    for record, (start, end, start_source, end_source) in zip(ordered, snapped_bounds):
        raw_start, raw_end = shot_bounds(record)
        if end - start < min_duration:
            start, end = raw_start, raw_end
            start_source, end_source = "omni_min_duration_fallback", "omni_min_duration_fallback"
        record["raw_omni_start_s"] = raw_start
        record["raw_omni_end_s"] = raw_end
        record["start_time"] = round(start, 3)
        record["start_s"] = round(start, 3)
        record["usable_start"] = round(start, 3)
        record["end_time"] = round(end, 3)
        record["end_s"] = round(end, 3)
        record["usable_end"] = round(end, 3)
        record["duration_s"] = round(max(0.0, end - start), 3)
        record["boundary_source"] = "omni_story_unit+scene_cut_snap"
        record["boundary_snap"] = {
            "start_source": start_source,
            "end_source": end_source,
            "snap_tolerance": snap_tolerance,
        }

    return ordered


def build_physical_record(parent: dict, segment: Tuple[float, float], sub_index: int, total: int) -> dict:
    start, end = segment
    parent_id = shot_id_of(parent)
    story_unit_id = first(parent, "story_unit_id", default=parent_id)
    physical_id = "{}_p{:02d}".format(parent_id.replace("shot_", "pshot_"), sub_index)
    duration = round(end - start, 3)
    label = first(parent, "label", default="")
    suffix = " [{}/{}]".format(sub_index + 1, total) if total > 1 else ""
    is_split_child = total > 1
    child_precision = "parent_context_only" if is_split_child else "story_unit_exact"
    child_visual_summary = "" if is_split_child else first(parent, "visual_summary", default="")
    child_source_meaning = "" if is_split_child else first(parent, "source_meaning", default="")
    child_source_asr = "" if is_split_child else first(parent, "source_asr", default="")
    child_source_ocr = [] if is_split_child else first(parent, "source_ocr", default=[])
    child_selling_points = [] if is_split_child else as_list(first(parent, "selling_points", default=[]))
    child_visual_actions = [] if is_split_child else as_list(first(parent, "visual_actions", default=[]))
    child_shot_type = "" if is_split_child else first(parent, "shot_type", "shot_type_hint", default="")

    return {
        "id": physical_id,
        "shot_id": physical_id,
        "parent_shot_id": parent_id,
        "semantic_shot_id": parent_id,
        "story_unit_id": story_unit_id,
        "is_physical_shot": True,
        "planning_granularity": "physical_shot",
        "boundary_source": "ffmpeg_scene_detection",
        "asset_id": first(parent, "asset_id", default=""),
        "segment_id": first(parent, "segment_id", default=""),
        "product": first(parent, "product", default=""),
        "index": sub_index,
        "label": "{}{}".format(label, suffix),
        "start_time": start,
        "end_time": end,
        "start_s": start,
        "end_s": end,
        "duration_s": duration,
        "usable_start": start,
        "usable_end": end,
        "visual_summary": child_visual_summary,
        "source_meaning": child_source_meaning,
        "source_asr": child_source_asr,
        "source_ocr": child_source_ocr,
        "parent_visual_summary": first(parent, "visual_summary", default=""),
        "parent_source_meaning": first(parent, "source_meaning", default=""),
        "parent_source_asr": first(parent, "source_asr", default=""),
        "parent_source_ocr": first(parent, "source_ocr", default=[]),
        "child_metadata_precision": child_precision,
        "metadata_source": child_precision,
        "text_embedding_policy": "video_only_until_child_vlm_refine" if is_split_child else "allow_child_text_channels",
        "hard_subtitle_risk": first(parent, "hard_subtitle_risk", default="unknown"),
        "voiceover_fit": first(parent, "voiceover_fit", default="unknown"),
        "can_standalone": bool(first(parent, "can_standalone", default=False)) and not is_split_child,
        "shot_type": child_shot_type,
        "shot_type_hint": child_shot_type,
        "parent_shot_type": first(parent, "shot_type", "shot_type_hint", default=""),
        "selling_points": child_selling_points,
        "parent_selling_points": as_list(first(parent, "selling_points", default=[])),
        "visual_actions": child_visual_actions,
        "parent_visual_actions": as_list(first(parent, "visual_actions", default=[])),
        "source_highlight_ids": as_list(first(parent, "child_shot_ids", default=[])),
        "trimmed_clip_path": "",
        "trimmed_oss_url": "",
        "needs_vlm_refine": is_split_child,
    }


def detect_and_split(
    run_dir: Path,
    threshold: float,
    min_duration: float,
    edge_padding: float,
    timeout: int,
) -> Tuple[dict, List[dict]]:
    assets = {asset_id_of(asset): asset for asset in load_json(run_dir / "assets.json")}
    planning_file = run_dir / "story_units.json"
    if planning_file.exists():
        planning_records = load_json(planning_file)
        records_source_file = "story_units.json"
    else:
        planning_file = run_dir / "shots.json"
        planning_records = load_json(planning_file)
        records_source_file = "shots.json"

    records_by_asset: Dict[str, List[dict]] = {}
    for record in planning_records:
        records_by_asset.setdefault(first(record, "asset_id", default=""), []).append(record)

    scene_cuts = {
        "schema_version": "1.1.0",
        "records_source_file": records_source_file,
        "threshold": threshold,
        "min_duration": min_duration,
        "edge_padding": edge_padding,
        "assets": [],
    }
    physical_shots = []
    child_physical_by_parent: Dict[str, List[str]] = {}

    for asset_id, asset in sorted(assets.items()):
        source_path = asset_local_path(asset)
        if not source_path or not os.path.exists(source_path):
            scene_cuts["assets"].append({
                "asset_id": asset_id,
                "status": "error",
                "error": "source video not found: {}".format(source_path),
                "cuts": [],
            })
            continue

        print("[{}] detecting cuts...".format(asset_id), flush=True)
        cuts = ffmpeg_scene_cuts(source_path, threshold, timeout)
        duration = asset_duration(asset)
        scene_cuts["assets"].append({
            "asset_id": asset_id,
            "video_id": first(asset, "video_id", default=asset_id.replace("asset_", "")),
            "source_path": source_path,
            "duration_s": duration,
            "status": "ok",
            "cuts": cuts,
            "cut_count": len(cuts),
        })

        asset_records = snap_planning_records_to_cuts(
            records=records_by_asset.get(asset_id, []),
            cuts=cuts,
            asset_start=0.0,
            asset_end=duration,
            min_duration=min_duration,
            snap_tolerance=0.95,
        )
        records_by_asset[asset_id] = asset_records

        for record in asset_records:
            segments = split_semantic_shot(record, cuts, min_duration, edge_padding)
            for sub_index, segment in enumerate(segments):
                physical_record = build_physical_record(record, segment, sub_index, len(segments))
                physical_shots.append(physical_record)
                parent_id = physical_record["parent_shot_id"]
                child_physical_by_parent.setdefault(parent_id, []).append(physical_record["shot_id"])

    for record in planning_records:
        rid = shot_id_of(record)
        record["child_physical_shot_ids"] = child_physical_by_parent.get(rid, [])
        record["physical_shot_count"] = len(record["child_physical_shot_ids"])
    write_json(planning_file, planning_records)

    return scene_cuts, physical_shots


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True, help="voah-video-intake run directory")
    parser.add_argument("--threshold", type=float, default=0.36, help="ffmpeg scene threshold")
    parser.add_argument("--min-duration", type=float, default=1.2, help="merge fragments shorter than this many seconds")
    parser.add_argument("--edge-padding", type=float, default=0.25, help="ignore cuts too close to semantic-shot edges")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--cuts-output", help="scene_cuts.json path")
    parser.add_argument("--physical-output", help="physical_shots.json path")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).expanduser().resolve()
    if not run_dir.exists():
        print("run dir not found: {}".format(run_dir), file=sys.stderr)
        return 1

    scene_cuts, physical_shots = detect_and_split(
        run_dir=run_dir,
        threshold=args.threshold,
        min_duration=args.min_duration,
        edge_padding=args.edge_padding,
        timeout=args.timeout,
    )

    cuts_output = Path(args.cuts_output).expanduser().resolve() if args.cuts_output else run_dir / "scene_cuts.json"
    physical_output = Path(args.physical_output).expanduser().resolve() if args.physical_output else run_dir / "physical_shots.json"
    write_json(cuts_output, scene_cuts)
    write_json(physical_output, physical_shots)

    split_parents = len({p["parent_shot_id"] for p in physical_shots if p.get("needs_vlm_refine")})
    print("Scene cuts written: {}".format(cuts_output))
    print("Physical shots written: {}".format(physical_output))
    print("Physical shots: {}".format(len(physical_shots)))
    print("Split semantic parents: {}".format(split_parents))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
