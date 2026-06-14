#!/usr/bin/env python3
"""Detect near-duplicate physical shots inside an intake run.

The worker is intentionally local and model-free. It marks duplicate groups
after physical clips have been trimmed, but it never deletes clips.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image


SCHEMA_VERSION = "voah.shot_dedupe.v1"
DEFAULT_SAMPLE_COUNT = 5
DEFAULT_FRAME_WIDTH = 96
DEFAULT_FRAME_HEIGHT = 170


def now_text() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{time.time_ns()}.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def as_list(value: Any) -> list[Any]:
    if value in (None, "", []):
        return []
    if isinstance(value, list):
        return value
    return [value]


def first(record: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return default


def shot_id_of(record: dict[str, Any]) -> str:
    return str(first(record, "shot_id", "id", default=""))


def time_range_of(record: dict[str, Any]) -> list[float]:
    raw = record.get("time_range")
    if isinstance(raw, list) and len(raw) >= 2:
        return [as_float(raw[0]), as_float(raw[1])]
    start = as_float(first(record, "start_s", "start_time", "usable_start", default=0))
    end = as_float(first(record, "end_s", "end_time", "usable_end", default=start))
    return [start, end]


def clip_path_of(record: dict[str, Any], trim_dir: Path) -> Path | None:
    raw = first(record, "trimmed_clip_path", "source_clip_path", "clip_path", default="")
    if raw:
        path = Path(str(raw)).expanduser()
        return path if path.is_absolute() else (trim_dir / path).resolve()
    shot_id = shot_id_of(record)
    if not shot_id:
        return None
    candidate = trim_dir / f"{shot_id}.mp4"
    return candidate if candidate.exists() else None


def probe_duration(path: Path) -> float:
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return 0.0
    return as_float(proc.stdout.strip(), 0.0)


def extract_sample_images(
    path: Path,
    duration_s: float,
    sample_count: int,
    width: int,
    height: int,
) -> list[Image.Image]:
    duration = duration_s if duration_s > 0 else probe_duration(path)
    fps = max(0.2, sample_count / max(duration, 0.1))
    frame_size = width * height
    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-vf",
            (
                f"fps={fps:.6f},scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,format=gray"
            ),
            "-frames:v",
            str(sample_count),
            "-an",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ],
        capture_output=True,
        check=True,
    )
    frames: list[Image.Image] = []
    count = len(proc.stdout) // frame_size
    for index in range(count):
        raw = proc.stdout[index * frame_size : (index + 1) * frame_size]
        frames.append(Image.frombytes("L", (width, height), raw))
    if not frames:
        frames.append(Image.new("L", (width, height), 0))
    while len(frames) < sample_count:
        frames.append(frames[-1].copy())
    return frames[:sample_count]


_DCT_BASIS: dict[int, list[list[float]]] = {}


def dct_basis(size: int = 32) -> list[list[float]]:
    cached = _DCT_BASIS.get(size)
    if cached is not None:
        return cached
    basis: list[list[float]] = []
    for u in range(8):
        alpha = math.sqrt(1 / size) if u == 0 else math.sqrt(2 / size)
        row = [
            alpha * math.cos(((2 * x + 1) * u * math.pi) / (2 * size))
            for x in range(size)
        ]
        basis.append(row)
    _DCT_BASIS[size] = basis
    return basis


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def phash(image: Image.Image) -> int:
    image = image.convert("L").resize((32, 32), Image.Resampling.LANCZOS)
    pixels = list(image.getdata())
    matrix = [pixels[row * 32 : (row + 1) * 32] for row in range(32)]
    basis = dct_basis(32)
    coeffs: list[float] = []
    for u in range(8):
        for v in range(8):
            total = 0.0
            bu = basis[u]
            bv = basis[v]
            for x in range(32):
                row = matrix[x]
                bux = bu[x]
                for y in range(32):
                    total += bux * bv[y] * row[y]
            coeffs.append(total)
    values = coeffs[1:]
    threshold = median(values)
    result = 0
    for value in values:
        result = (result << 1) | int(value > threshold)
    return result


def dhash(image: Image.Image) -> int:
    image = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = list(image.getdata())
    result = 0
    for row in range(8):
        offset = row * 9
        for col in range(8):
            result = (result << 1) | int(pixels[offset + col + 1] > pixels[offset + col])
    return result


def hex_hash(value: int, bits: int = 64) -> str:
    return f"{value:0{bits // 4}x}"


def hamming(a: int, b: int) -> int:
    return bin(int(a ^ b)).count("1")


class DedupeThresholds:
    def __init__(
        self,
        min_confidence_near: float = 0.55,
        min_confidence_strong: float = 0.68,
        strong_close_frames: int = 4,
        near_close_frames: int = 3,
        max_duration_gap_s: float = 1.5,
        max_duration_gap_ratio: float = 0.55,
    ):
        self.min_confidence_near = min_confidence_near
        self.min_confidence_strong = min_confidence_strong
        self.strong_close_frames = strong_close_frames
        self.near_close_frames = near_close_frames
        self.max_duration_gap_s = max_duration_gap_s
        self.max_duration_gap_ratio = max_duration_gap_ratio


def duration_compatible(a: dict[str, Any], b: dict[str, Any], thresholds: DedupeThresholds) -> bool:
    a_duration = as_float(a.get("duration_s"))
    b_duration = as_float(b.get("duration_s"))
    if a_duration <= 0 or b_duration <= 0:
        return True
    gap = abs(a_duration - b_duration)
    return gap <= max(thresholds.max_duration_gap_s, thresholds.max_duration_gap_ratio * max(a_duration, b_duration))


def evaluate_pair(
    a: dict[str, Any],
    b: dict[str, Any],
    thresholds: DedupeThresholds | None = None,
) -> dict[str, Any] | None:
    thresholds = thresholds or DedupeThresholds()
    if not duration_compatible(a, b, thresholds):
        return None
    phashes = [int(value) for value in as_list(a.get("phash_values"))]
    other_phashes = [int(value) for value in as_list(b.get("phash_values"))]
    dhashes = [int(value) for value in as_list(a.get("dhash_values"))]
    other_dhashes = [int(value) for value in as_list(b.get("dhash_values"))]
    sample_count = min(len(phashes), len(other_phashes), len(dhashes), len(other_dhashes))
    if sample_count <= 0:
        return None
    p_distances = [hamming(phashes[index], other_phashes[index]) for index in range(sample_count)]
    d_distances = [hamming(dhashes[index], other_dhashes[index]) for index in range(sample_count)]
    close_count = sum(
        1
        for p_distance, d_distance in zip(p_distances, d_distances)
        if (p_distance <= 9 and d_distance <= 12) or (p_distance <= 6 and d_distance <= 18)
    )
    mean_p = sum(p_distances) / sample_count
    mean_d = sum(d_distances) / sample_count
    confidence = 1.0 - min(1.0, (mean_p / 18 * 0.58) + (mean_d / 20 * 0.42))
    exact = bool(a.get("clip_sha256") and a.get("clip_sha256") == b.get("clip_sha256"))
    status = ""
    if exact or (close_count >= thresholds.strong_close_frames and confidence >= thresholds.min_confidence_strong):
        status = "strong_duplicate"
    elif close_count >= thresholds.near_close_frames and confidence >= thresholds.min_confidence_near:
        status = "near_duplicate_candidate"
    if not status:
        return None
    return {
        "shot_id_a": a.get("shot_id", ""),
        "shot_id_b": b.get("shot_id", ""),
        "asset_id_a": a.get("asset_id", ""),
        "asset_id_b": b.get("asset_id", ""),
        "same_asset": bool(a.get("asset_id") and a.get("asset_id") == b.get("asset_id")),
        "status": status,
        "confidence": round(confidence, 3),
        "exact_clip_sha256": exact,
        "close_frame_count": close_count,
        "sample_count": sample_count,
        "mean_phash_distance": round(mean_p, 3),
        "mean_dhash_distance": round(mean_d, 3),
        "sample_distances": [
            {"p": p_distances[index], "d": d_distances[index]}
            for index in range(sample_count)
        ],
    }


def fingerprint_record(
    record: dict[str, Any],
    trim_dir: Path,
    sample_count: int = DEFAULT_SAMPLE_COUNT,
    width: int = DEFAULT_FRAME_WIDTH,
    height: int = DEFAULT_FRAME_HEIGHT,
) -> dict[str, Any]:
    shot_id = shot_id_of(record)
    start, end = time_range_of(record)
    clip_path = clip_path_of(record, trim_dir)
    duration = as_float(first(record, "clip_actual_duration_s", "duration_s", default=max(0.0, end - start)))
    base = {
        "shot_id": shot_id,
        "asset_id": str(record.get("asset_id") or ""),
        "story_unit_id": str(record.get("story_unit_id") or record.get("parent_shot_id") or ""),
        "parent_shot_id": str(record.get("parent_shot_id") or ""),
        "clip_path": str(clip_path or ""),
        "duration_s": round(duration, 3),
        "time_range": [start, end],
        "status": "ok",
    }
    if not shot_id:
        return {**base, "status": "skipped", "error": "missing shot_id"}
    if not clip_path or not clip_path.exists():
        return {**base, "status": "skipped", "error": "missing trimmed clip"}
    try:
        images = extract_sample_images(clip_path, duration, sample_count, width, height)
    except (OSError, subprocess.SubprocessError) as exc:
        return {**base, "status": "failed", "error": str(exc)}
    phashes = [phash(image) for image in images]
    dhashes = [dhash(image) for image in images]
    return {
        **base,
        "clip_sha256": sha256_file(clip_path),
        "phash_values": phashes,
        "dhash_values": dhashes,
        "phash_hex": [hex_hash(value, 64) for value in phashes],
        "dhash_hex": [hex_hash(value, 64) for value in dhashes],
    }


def sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_duplicate_pairs(records: list[dict[str, Any]], thresholds: DedupeThresholds | None = None) -> list[dict[str, Any]]:
    thresholds = thresholds or DedupeThresholds()
    ok_records = [record for record in records if record.get("status") == "ok"]
    pairs: list[dict[str, Any]] = []
    for left_index, left in enumerate(ok_records):
        for right in ok_records[left_index + 1 :]:
            pair = evaluate_pair(left, right, thresholds)
            if pair:
                pairs.append(pair)
    pairs.sort(
        key=lambda item: (
            item["status"] != "strong_duplicate",
            item["same_asset"],
            -as_float(item.get("confidence")),
            item.get("shot_id_a", ""),
        )
    )
    return pairs


def choose_canonical(members: list[dict[str, Any]]) -> dict[str, Any]:
    def score(record: dict[str, Any]) -> tuple[float, str]:
        duration = as_float(record.get("duration_s"))
        return (duration, str(record.get("shot_id") or ""))

    return sorted(members, key=score, reverse=True)[0]


def build_duplicate_groups(records: list[dict[str, Any]], pairs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ids = [str(record.get("shot_id") or "") for record in records if record.get("status") == "ok" and record.get("shot_id")]
    parent = {shot_id: shot_id for shot_id in ids}

    def find(value: str) -> str:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    def union(a: str, b: str) -> None:
        if a not in parent or b not in parent:
            return
        ra = find(a)
        rb = find(b)
        if ra != rb:
            parent[rb] = ra

    for pair in pairs:
        union(str(pair.get("shot_id_a") or ""), str(pair.get("shot_id_b") or ""))

    by_id = {str(record.get("shot_id") or ""): record for record in records if record.get("shot_id")}
    grouped: dict[str, list[dict[str, Any]]] = {}
    for shot_id in ids:
        grouped.setdefault(find(shot_id), []).append(by_id[shot_id])

    pair_lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for pair in pairs:
        a = str(pair.get("shot_id_a") or "")
        b = str(pair.get("shot_id_b") or "")
        pair_lookup[tuple(sorted([a, b]))] = pair

    groups: list[dict[str, Any]] = []
    group_index = 1
    for members in grouped.values():
        if len(members) < 2:
            continue
        member_ids = [str(member.get("shot_id") or "") for member in members]
        group_pairs = [
            pair_lookup[key]
            for key in pair_lookup
            if key[0] in member_ids and key[1] in member_ids
        ]
        status = (
            "strong_duplicate"
            if group_pairs and all(pair.get("status") == "strong_duplicate" for pair in group_pairs)
            else "near_duplicate_candidate"
        )
        canonical = choose_canonical(members)
        canonical_id = str(canonical.get("shot_id") or "")
        assets = sorted({str(member.get("asset_id") or "") for member in members if member.get("asset_id")})
        groups.append(
            {
                "duplicate_group_id": f"dup_{group_index:03d}",
                "status": status,
                "canonical_physical_shot_id": canonical_id,
                "member_count": len(members),
                "asset_count": len(assets),
                "asset_ids": assets,
                "members": [
                    {
                        "shot_id": str(member.get("shot_id") or ""),
                        "asset_id": str(member.get("asset_id") or ""),
                        "story_unit_id": str(member.get("story_unit_id") or ""),
                        "clip_path": str(member.get("clip_path") or ""),
                        "duration_s": as_float(member.get("duration_s")),
                        "role": "canonical" if str(member.get("shot_id") or "") == canonical_id else "duplicate",
                    }
                    for member in sorted(members, key=lambda item: str(item.get("shot_id") or ""))
                ],
                "pair_evidence": group_pairs,
            }
        )
        group_index += 1
    groups.sort(key=lambda item: (item.get("status") != "strong_duplicate", -int(item.get("asset_count") or 0), item["duplicate_group_id"]))
    return groups


def public_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in record.items()
        if key not in {"phash_values", "dhash_values"} and not key.startswith("_")
    }


def annotate_physical_shots(physical_shots: list[dict[str, Any]], groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    annotations: dict[str, dict[str, Any]] = {}
    for group in groups:
        for member in group.get("members") or []:
            shot_id = str(member.get("shot_id") or "")
            role = str(member.get("role") or "")
            annotations[shot_id] = {
                "duplicate_group_id": group.get("duplicate_group_id", ""),
                "duplicate_status": group.get("status", ""),
                "duplicate_role": role,
                "canonical_physical_shot_id": group.get("canonical_physical_shot_id", ""),
                "duplicate_policy": "prefer_canonical" if group.get("status") == "strong_duplicate" else "soft_downrank",
            }

    updated: list[dict[str, Any]] = []
    for item in physical_shots:
        if not isinstance(item, dict):
            updated.append(item)
            continue
        shot_id = shot_id_of(item)
        next_item = dict(item)
        for key in (
            "duplicate_group_id",
            "duplicate_status",
            "duplicate_role",
            "canonical_physical_shot_id",
            "duplicate_policy",
        ):
            next_item.pop(key, None)
        if shot_id in annotations:
            next_item.update(annotations[shot_id])
        updated.append(next_item)
    return updated


def run_dedupe(
    physical_shots: list[dict[str, Any]],
    trim_dir: Path,
    sample_count: int = DEFAULT_SAMPLE_COUNT,
    width: int = DEFAULT_FRAME_WIDTH,
    height: int = DEFAULT_FRAME_HEIGHT,
) -> dict[str, Any]:
    started = time.time()
    records = [
        fingerprint_record(item, trim_dir, sample_count=sample_count, width=width, height=height)
        for item in physical_shots
        if isinstance(item, dict)
    ]
    pairs = find_duplicate_pairs(records)
    groups = build_duplicate_groups(records, pairs)
    strong_groups = [group for group in groups if group.get("status") == "strong_duplicate"]
    near_groups = [group for group in groups if group.get("status") == "near_duplicate_candidate"]
    duplicate_member_ids = {
        str(member.get("shot_id") or "")
        for group in groups
        for member in group.get("members") or []
        if member.get("role") == "duplicate"
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at": now_text(),
        "method": {
            "sample_count": sample_count,
            "frame_size": [width, height],
            "hashes": ["pHash64", "dHash64"],
            "policy": "mark_only_never_delete",
            "strong_policy": "prefer_canonical",
            "near_policy": "soft_downrank",
        },
        "summary": {
            "physical_shot_count": len(physical_shots),
            "scanned_clip_count": sum(1 for record in records if record.get("status") == "ok"),
            "scan_failed_count": sum(1 for record in records if record.get("status") == "failed"),
            "scan_skipped_count": sum(1 for record in records if record.get("status") == "skipped"),
            "duplicate_pair_count": len(pairs),
            "strong_duplicate_group_count": len(strong_groups),
            "near_duplicate_group_count": len(near_groups),
            "duplicate_group_count": len(groups),
            "duplicate_member_count": len(duplicate_member_ids),
            "elapsed_s": round(time.time() - started, 3),
        },
        "records": [public_record(record) for record in records],
        "duplicate_pairs": pairs,
        "duplicate_groups": groups,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mark duplicate physical shots in a Voah intake run.")
    parser.add_argument("--run-dir", type=Path, help="Intake run directory containing physical_shots.json")
    parser.add_argument("--physical-shots", type=Path, help="Input physical_shots.json")
    parser.add_argument("--trim-dir", type=Path, help="Directory containing trimmed physical mp4 clips")
    parser.add_argument("--output", type=Path, help="Output shot_dedupe.json")
    parser.add_argument("--write-back", action="store_true", help="Write duplicate fields back into physical_shots.json")
    parser.add_argument("--sample-count", type=int, default=DEFAULT_SAMPLE_COUNT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_dir = args.run_dir.resolve() if args.run_dir else None
    physical_path = args.physical_shots or (run_dir / "physical_shots.json" if run_dir else None)
    trim_dir = args.trim_dir or (run_dir / "trimmed_physical" if run_dir else None)
    output = args.output or (run_dir / "shot_dedupe.json" if run_dir else None)
    if physical_path is None or trim_dir is None or output is None:
        raise SystemExit("--run-dir or all of --physical-shots/--trim-dir/--output is required")
    physical_shots = load_json(physical_path)
    if isinstance(physical_shots, dict):
        physical_shots = physical_shots.get("physical_shots") or physical_shots.get("shots") or physical_shots.get("records") or []
    if not isinstance(physical_shots, list):
        raise SystemExit("physical_shots input must be a JSON list or object containing a list")
    report = run_dedupe(physical_shots, trim_dir, sample_count=max(1, int(args.sample_count or DEFAULT_SAMPLE_COUNT)))
    report.setdefault("inputs", {}).update(
        {
            "physical_shots": str(physical_path),
            "trim_dir": str(trim_dir),
        }
    )
    report.setdefault("outputs", {}).update(
        {
            "shot_dedupe": str(output),
            "write_back": bool(args.write_back),
        }
    )
    write_json(output, report)
    if args.write_back:
        write_json(physical_path, annotate_physical_shots(physical_shots, report.get("duplicate_groups") or []))
    print(json.dumps({"output": str(output), "summary": report.get("summary", {})}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
