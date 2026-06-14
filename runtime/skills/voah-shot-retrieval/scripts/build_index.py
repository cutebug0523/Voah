#!/usr/bin/env python3
"""Build a local retrieval index from a voah-video-intake run directory.

Story units are the default planning granularity. Physical shots remain
available for clean trims and video embedding, but timeline planning should not
grab them as independent narrative units unless explicitly requested.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional

MODEL = "qwen3-vl-embedding"
DIMENSION = 2560


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


def child_metadata_precision(row: dict) -> str:
    return str(first(row, "child_metadata_precision", "metadata_source", default="")).strip()


def compact_physical_shot(row: dict, upload: Optional[dict] = None) -> dict:
    upload = upload or {}
    start = as_float(first(row, "start_s", "start_time", default=0))
    end = as_float(first(row, "end_s", "end_time", default=start))
    usable_start = as_float(first(row, "usable_start", default=start), start)
    usable_end = as_float(first(row, "usable_end", default=end), end)
    return {
        "shot_id": shot_id_of(row),
        "parent_shot_id": first(row, "parent_shot_id", "story_unit_id", "semantic_shot_id", default=""),
        "story_unit_id": first(row, "story_unit_id", "parent_shot_id", "semantic_shot_id", default=""),
        "asset_id": first(row, "asset_id", default=""),
        "label": first(row, "label", default=""),
        "time_range": [start, end],
        "usable_range": [usable_start, usable_end],
        "duration_s": round(max(0.0, usable_end - usable_start), 3),
        "clip_actual_duration_s": first(row, "clip_actual_duration_s", default=None),
        "clip_frames": first(row, "clip_frames", default=None),
        "trim_end_epsilon_s": first(row, "trim_end_epsilon_s", default=None),
        "visual_summary": first(row, "visual_summary", default=""),
        "source_meaning": first(row, "source_meaning", default=""),
        "source_asr": first(row, "source_asr", default=""),
        "source_ocr": first(row, "source_ocr", default=[]),
        "parent_visual_summary": first(row, "parent_visual_summary", default=""),
        "parent_source_meaning": first(row, "parent_source_meaning", default=""),
        "parent_source_asr": first(row, "parent_source_asr", default=""),
        "parent_source_ocr": first(row, "parent_source_ocr", default=[]),
        "child_metadata_precision": child_metadata_precision(row),
        "metadata_source": first(row, "metadata_source", default=child_metadata_precision(row)),
        "text_embedding_policy": first(row, "text_embedding_policy", default=""),
        "needs_vlm_refine": bool(first(row, "needs_vlm_refine", default=False)),
        "selling_points": as_list(first(row, "selling_points", default=[])),
        "parent_selling_points": as_list(first(row, "parent_selling_points", default=[])),
        "visual_actions": as_list(first(row, "visual_actions", default=[])),
        "parent_visual_actions": as_list(first(row, "parent_visual_actions", default=[])),
        "shot_type": first(row, "shot_type", "shot_type_hint", default=""),
        "parent_shot_type": first(row, "parent_shot_type", default=""),
        "hard_subtitle_risk": first(row, "hard_subtitle_risk", default="unknown"),
        "voiceover_fit": first(row, "voiceover_fit", default="unknown"),
        "can_standalone": bool(first(row, "can_standalone", default=False)),
        "trimmed_clip_path": first(row, "trimmed_clip_path", default=first(upload, "trimmed_path", default="")),
        "trimmed_oss_url": first(row, "trimmed_oss_url", default=first(upload, "oss_url", default="")),
    }


def normalize_product(value):
    if isinstance(value, dict):
        return {
            "name": first(value, "name", default=""),
            "slug": first(value, "slug", default=""),
        }
    return {"name": str(value or ""), "slug": ""}


def load_optional(run_dir: Path, name: str, default):
    path = run_dir / name
    return load_json(path) if path.exists() else default


def load_preferred(run_dir: Path, preferred: str, fallback: str, default=None):
    preferred_path = run_dir / preferred
    if preferred_path.exists():
        return load_json(preferred_path), preferred
    fallback_path = run_dir / fallback
    if fallback_path.exists():
        return load_json(fallback_path), fallback
    if default is not None:
        return default, ""
    raise FileNotFoundError(f"missing required file: {preferred} or {fallback}")


def asset_id_of(asset: dict) -> str:
    return first(asset, "asset_id", "id", default="")


def shot_id_of(shot: dict) -> str:
    return first(shot, "shot_id", "id", default="")


def build_upload_map(upload_rows: list) -> dict:
    upload_map = {}
    for item in upload_rows:
        if item.get("status") != "ok":
            continue
        sid = first(item, "shot_id", "id")
        if sid:
            upload_map[sid] = item
    return upload_map


def build_physical_map(rows: list) -> dict:
    by_parent = {}
    by_id = {}
    for row in rows:
        sid = shot_id_of(row)
        if not sid:
            continue
        by_id[sid] = row
        parent_id = first(row, "parent_shot_id", "story_unit_id", "semantic_shot_id", default="")
        if parent_id:
            by_parent.setdefault(parent_id, []).append(row)
    for items in by_parent.values():
        items.sort(key=lambda shot: as_float(first(shot, "start_s", "start_time", default=0)))
    return {"by_parent": by_parent, "by_id": by_id}


def normalize_embedding_rows(rows: list) -> dict:
    by_shot = {}
    for row in rows:
        if isinstance(row, dict) and "_summary" in row:
            continue
        sid = first(row, "shot_id", "id")
        if not sid:
            continue
        channels = first(row, "embeddings", "channels", default={}) or {}
        normalized = {}
        if isinstance(channels, list):
            iterator = []
            for item in channels:
                name = first(item, "channel", "name", "type", default="")
                if name:
                    iterator.append((name, item))
        else:
            iterator = channels.items()

        for channel, item in iterator:
            if not isinstance(item, dict):
                continue
            vector = first(item, "embedding", "vector")
            if not isinstance(vector, list):
                continue
            mode = first(item, "mode", "embedding_mode", "input_type", default="")
            if not mode:
                mode = "video" if channel == "video_chunk" else "text"
            normalized[channel] = {
                "mode": mode,
                "dim": len(vector),
                "status": first(item, "status", default="ok"),
                "embedding": vector,
            }
        by_shot[sid] = normalized
    return by_shot


def merge_child_channels(unit_id: str, child_shots: list, embeddings: dict, warnings: list) -> dict:
    if unit_id in embeddings:
        return embeddings[unit_id]
    merged = {}
    child_with_embeddings = [shot for shot in child_shots if embeddings.get(shot_id_of(shot))]
    if not child_with_embeddings:
        warnings.append(f"{unit_id}: no story-unit embedding and no child physical embeddings")
        return merged

    for channel in ("video_chunk", "visual_summary", "source_meaning", "asr", "ocr", "tags"):
        vectors = []
        mode = ""
        for shot in child_with_embeddings:
            sid = shot_id_of(shot)
            item = embeddings.get(sid, {}).get(channel)
            vector = item.get("embedding") if isinstance(item, dict) else None
            if isinstance(vector, list):
                vectors.append(vector)
                mode = item.get("mode", mode)
        if not vectors:
            continue
        dim = len(vectors[0])
        if any(len(vec) != dim for vec in vectors):
            warnings.append(f"{unit_id}/{channel}: child embedding dimensions mismatch")
            continue
        avg = [sum(vec[i] for vec in vectors) / len(vectors) for i in range(dim)]
        merged[channel] = {
            "mode": mode or ("video" if channel == "video_chunk" else "text"),
            "dim": dim,
            "status": "ok",
            "embedding": avg,
            "aggregation": "mean_child_physical",
            "child_count": len(vectors),
        }
    return merged


def build_index(run_dir: Path, output: Path, granularity: str = "story_unit") -> dict:
    if granularity == "physical":
        shots, shots_file = load_preferred(run_dir, "physical_shots.json", "shots.json")
    else:
        shots, shots_file = load_preferred(run_dir, "story_units.json", "shots.json")
    assets = {asset_id_of(asset): asset for asset in load_json(run_dir / "assets.json")}
    physical_rows = load_optional(run_dir, "physical_shots.json", [])
    physical_map = build_physical_map(physical_rows)
    embeddings = normalize_embedding_rows(load_json(run_dir / "embedding_results.json"))
    upload_rows, uploads_file = load_preferred(
        run_dir,
        "trim_upload_results_physical.json",
        "trim_upload_results.json",
        default=[],
    )
    uploads = build_upload_map(upload_rows)
    manifest = load_optional(run_dir, "run_manifest.json", {})
    product_meta = manifest.get("product", {}) if isinstance(manifest, dict) else {}

    records = []
    warnings = []
    for shot in shots:
        sid = shot_id_of(shot)
        asset_id = first(shot, "asset_id", default="")
        asset = assets.get(asset_id, {})
        product = normalize_product(first(shot, "product", default=first(asset, "product", default={})))
        if not product["name"]:
            product["name"] = first(asset, "product_slug", default="")

        start = as_float(first(shot, "start_s", "start_time", default=0))
        end = as_float(first(shot, "end_s", "end_time", default=start))
        usable_start = as_float(first(shot, "usable_start", default=start), start)
        usable_end = as_float(first(shot, "usable_end", default=end), end)
        duration = max(0.0, usable_end - usable_start)

        child_physical = physical_map["by_parent"].get(sid, [])
        channels = merge_child_channels(sid, child_physical, embeddings, warnings)
        if not channels:
            warnings.append(f"{sid}: no embedding channels")
        video = channels.get("video_chunk")
        if video and video.get("mode") != "video":
            warnings.append(f"{sid}: video_chunk mode is {video.get('mode')}")
        for channel, item in channels.items():
            if item.get("dim") != DIMENSION:
                warnings.append(f"{sid}/{channel}: dim {item.get('dim')} != {DIMENSION}")

        upload = uploads.get(sid, {})
        is_physical = bool(first(shot, "is_physical_shot", default=False)) or shots_file == "physical_shots.json"
        is_story_unit = bool(first(shot, "is_story_unit", default=False)) or shots_file == "story_units.json"
        child_physical_ids = [shot_id_of(item) for item in child_physical]
        child_physical_shots = [
            compact_physical_shot(child, uploads.get(shot_id_of(child), {}))
            for child in child_physical
        ]
        child_clip_paths = [
            first(child, "trimmed_clip_path", default=first(uploads.get(shot_id_of(child), {}), "trimmed_path", default=""))
            for child in child_physical
        ]
        child_clip_paths = [path for path in child_clip_paths if path]
        record = {
            "shot_id": sid,
            "story_unit_id": first(shot, "story_unit_id", default=sid if is_story_unit else ""),
            "parent_shot_id": first(shot, "parent_shot_id", "semantic_shot_id", default=""),
            "semantic_shot_id": first(shot, "semantic_shot_id", "parent_shot_id", default=""),
            "is_physical_shot": is_physical,
            "is_story_unit": is_story_unit,
            "planning_granularity": "story_unit" if is_story_unit else "physical_shot",
            "boundary_source": first(shot, "boundary_source", default=""),
            "asset_id": asset_id,
            "segment_id": first(shot, "segment_id", default=""),
            "product": product,
            "label": first(shot, "label", default=""),
            "time_range": [start, end],
            "usable_range": [usable_start, usable_end],
            "duration_s": round(duration, 3),
            "visual_summary": first(shot, "visual_summary", default=""),
            "source_meaning": first(shot, "source_meaning", default=""),
            "source_asr": first(shot, "source_asr", default=""),
            "source_ocr": first(shot, "source_ocr", default=[]),
            "selling_points": as_list(first(shot, "selling_points", default=[])),
            "shot_type": first(shot, "shot_type", "shot_type_hint", default=""),
            "hard_subtitle_risk": first(shot, "hard_subtitle_risk", default="unknown"),
            "voiceover_fit": first(shot, "voiceover_fit", default="unknown"),
            "can_standalone": bool(first(shot, "can_standalone", default=False)),
            "child_metadata_precision": child_metadata_precision(shot),
            "metadata_source": first(shot, "metadata_source", default=child_metadata_precision(shot)),
            "needs_vlm_refine": bool(first(shot, "needs_vlm_refine", default=False)),
            "child_shot_ids": as_list(first(shot, "child_shot_ids", default=[])),
            "child_physical_shot_ids": child_physical_ids or as_list(first(shot, "child_physical_shot_ids", default=[])),
            "child_physical_shots": child_physical_shots,
            "physical_shot_count": len(child_physical_ids) or int(first(shot, "physical_shot_count", default=0) or 0),
            "source_highlight_count": len(as_list(first(shot, "child_shot_ids", default=[]))),
            "same_segment_reason": first(shot, "same_segment_reason", default=""),
            "trimmed_clip_path": first(shot, "trimmed_clip_path", default=first(upload, "trimmed_path", default="")),
            "trimmed_oss_url": first(shot, "trimmed_oss_url", default=first(upload, "oss_url", default="")),
            "child_clip_paths": child_clip_paths,
            "channels": channels,
        }
        records.append(record)

    index = {
        "schema_version": "1.2.0",
        "source_run_dir": str(run_dir),
        "records_source_file": shots_file,
        "planning_granularity": "story_unit" if shots_file == "story_units.json" else "physical_shot",
        "uploads_source_file": uploads_file,
        "model": MODEL,
        "dimension": DIMENSION,
        "product_slug": first(product_meta, "slug", default=manifest.get("product_slug", "")),
        "total_shots": len(records),
        "records": records,
        "warnings": warnings,
    }
    write_json(output, index)
    return index


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True, help="voah-video-intake run directory")
    parser.add_argument("--output", help="output shot_index.json path")
    parser.add_argument(
        "--granularity",
        choices=["story_unit", "physical"],
        default="story_unit",
        help="default story_unit; use physical only for low-level boundary debugging",
    )
    args = parser.parse_args()

    run_dir = Path(args.run_dir).expanduser().resolve()
    if not run_dir.exists():
        print(f"run dir not found: {run_dir}", file=sys.stderr)
        return 1

    output = Path(args.output).expanduser().resolve() if args.output else run_dir / "shot_index.json"
    index = build_index(run_dir, output, granularity=args.granularity)
    print(f"Shot index written: {output}")
    print(f"Shots: {index['total_shots']}")
    print(f"Warnings: {len(index['warnings'])}")
    for warning in index["warnings"][:10]:
        print(f"  WARNING: {warning}")
    return 0 if not index["warnings"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
