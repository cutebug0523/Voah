#!/usr/bin/env python3
"""Desktop-callable wrapper for Voah video intake.

This script intentionally keeps model/media logic in the existing
voah-video-intake scripts. It only orchestrates the full intake job, writes a
desktop-friendly result JSON, and builds the local shot_index.json expected by
downstream retrieval workers.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_WORKSPACE = Path("/Users/noah/混剪")
DEFAULT_INTAKE_SCRIPTS_DIR = Path(
    os.environ.get(
        "VOAH_VIDEO_INTAKE_SCRIPTS_DIR",
        "/Users/noah/.codex/skills/voah-video-intake/scripts",
    )
)
DIMENSION = 2560
EMBEDDING_MODEL = "qwen3-vl-embedding"
STAGE = "material_intake"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".webm"}


class WorkerError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        run_dir: Path | None = None,
        stdout_path: Path | None = None,
        stderr_path: Path | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.run_dir = run_dir
        self.stdout_path = stdout_path
        self.stderr_path = stderr_path


def now_text() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def read_text_if_exists(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def validate_slug(value: str, field_name: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise WorkerError("invalid_input", f"{field_name} is required")
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$", text):
        raise WorkerError(
            "invalid_input",
            f"{field_name} may only contain letters, numbers, dot, underscore, and dash",
        )
    return text


def validate_run_label(value: str) -> str:
    return validate_slug(value or "desktop_intake_v1", "run_label")


def as_abs(path_value: str | Path, base: Path | None = None) -> Path:
    path = Path(str(path_value)).expanduser()
    if not path.is_absolute() and base:
        path = base / path
    return path.resolve()


def first(record: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return default


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


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def shot_id_of(record: dict[str, Any]) -> str:
    return str(first(record, "shot_id", "id", default=""))


def time_range_of(record: dict[str, Any]) -> list[float]:
    raw = record.get("time_range")
    if isinstance(raw, list) and len(raw) >= 2:
        return [as_float(raw[0]), as_float(raw[1])]
    start = as_float(first(record, "start_s", "start_time", "usable_start", default=0))
    end = as_float(first(record, "end_s", "end_time", "usable_end", default=start))
    return [start, end]


def usable_range_of(record: dict[str, Any]) -> list[float]:
    raw = record.get("usable_range")
    if isinstance(raw, list) and len(raw) >= 2:
        return [as_float(raw[0]), as_float(raw[1])]
    start, end = time_range_of(record)
    return [
        as_float(record.get("usable_start"), start),
        as_float(record.get("usable_end"), end),
    ]


def normalize_product(value: Any, fallback_name: str, fallback_slug: str) -> dict[str, str]:
    if isinstance(value, dict):
        name = str(value.get("name") or fallback_name)
        slug = str(value.get("slug") or fallback_slug)
    else:
        name = str(value or fallback_name)
        slug = fallback_slug
    return {"name": name, "slug": slug}


def load_job_input(path: Path | None) -> dict[str, Any]:
    if not path:
        return {}
    data = load_json(path)
    if not isinstance(data, dict):
        raise WorkerError("invalid_job_input", "job input must be a JSON object")
    return data


def nested_get(data: dict[str, Any], *keys: str) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def arg_or_job(args: argparse.Namespace, job: dict[str, Any], attr: str, *paths: tuple[str, ...]) -> Any:
    value = getattr(args, attr)
    if value not in (None, ""):
        return value
    for path in paths:
        candidate = nested_get(job, *path)
        if candidate not in (None, ""):
            return candidate
    return value


def resolve_config(args: argparse.Namespace) -> dict[str, Any]:
    job = load_job_input(as_abs(args.job_input) if args.job_input else None)
    workspace_value = arg_or_job(args, job, "workspace", ("workspace", "root"), ("workspace_root",))
    workspace = as_abs(workspace_value or DEFAULT_WORKSPACE)
    product_slug = validate_slug(
        arg_or_job(args, job, "product_slug", ("product", "slug"), ("inputs", "product_slug")),
        "product_slug",
    )
    product_name = str(
        arg_or_job(args, job, "product_name", ("product", "name"), ("inputs", "product_name"))
        or product_slug
    ).strip()
    source_dir_value = arg_or_job(
        args,
        job,
        "source_dir",
        ("inputs", "source_dir"),
        ("inputs", "target_dir"),
        ("inputs", "source_folder"),
    )
    if source_dir_value in (None, ""):
        raise WorkerError("invalid_input", "source_dir is required")
    source_dir = as_abs(source_dir_value, workspace)
    run_label = validate_run_label(
        arg_or_job(args, job, "run_label", ("options", "run_label")) or "desktop_intake_v1"
    )
    max_videos = int(arg_or_job(args, job, "max_videos", ("options", "max_videos")) or 0)
    if max_videos < 0:
        raise WorkerError("invalid_input", "max_videos must be >= 0")

    config = {
        "job_input": job,
        "job_id": str(arg_or_job(args, job, "job_id", ("job_id",)) or uuid.uuid4()),
        "workspace": workspace,
        "source_dir": source_dir,
        "product_name": product_name,
        "product_slug": product_slug,
        "run_label": run_label,
        "max_videos": max_videos,
        "scene_threshold": float(
            arg_or_job(args, job, "scene_threshold", ("options", "scene_threshold")) or 0.36
        ),
        "candidate_min_duration": float(
            arg_or_job(args, job, "candidate_min_duration", ("options", "candidate_min_duration")) or 1.2
        ),
        "min_physical_duration": float(
            arg_or_job(args, job, "min_physical_duration", ("options", "min_physical_duration")) or 1.2
        ),
        "omni_proxy_width": int(
            arg_or_job(args, job, "omni_proxy_width", ("options", "omni_proxy_width")) or 540
        ),
        "omni_proxy_fps": int(
            arg_or_job(args, job, "omni_proxy_fps", ("options", "omni_proxy_fps")) or 15
        ),
        "intake_scripts_dir": as_abs(
            arg_or_job(args, job, "intake_scripts_dir", ("options", "intake_scripts_dir"))
            or DEFAULT_INTAKE_SCRIPTS_DIR
        ),
        "skip_upload": bool(args.skip_upload) or as_bool(nested_get(job, "options", "skip_upload")),
        "skip_vectorize": bool(args.skip_vectorize) or as_bool(nested_get(job, "options", "skip_vectorize")),
    }
    if config["skip_upload"]:
        config["skip_vectorize"] = True
    return config


def validate_preflight(config: dict[str, Any]) -> None:
    workspace = config["workspace"]
    source_dir = config["source_dir"]
    scripts_dir = config["intake_scripts_dir"]
    if not workspace.exists():
        raise WorkerError("workspace_not_found", f"workspace not found: {workspace}")
    if not source_dir.exists() or not source_dir.is_dir():
        raise WorkerError("source_dir_not_found", f"source dir not found: {source_dir}")
    video_count = sum(
        1 for path in source_dir.iterdir()
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
    )
    if video_count <= 0:
        raise WorkerError("no_source_videos", f"no supported videos found in: {source_dir}")
    required_scripts = [
        "run_intake.py",
        "trim_and_upload.py",
        "vectorize.py",
    ]
    missing = [name for name in required_scripts if not (scripts_dir / name).exists()]
    if missing:
        raise WorkerError(
            "intake_scripts_missing",
            f"missing voah-video-intake scripts in {scripts_dir}: {', '.join(missing)}",
        )


def run_command(
    cmd: list[str],
    stdout_path: Path,
    stderr_path: Path,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> None:
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    with stdout_path.open("a", encoding="utf-8") as out, stderr_path.open("a", encoding="utf-8") as err:
        out.write("$ " + " ".join(cmd) + "\n")
        out.flush()
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            stdout=out,
            stderr=err,
            text=True,
            env=env or os.environ.copy(),
        )
    if proc.returncode != 0:
        raise WorkerError(
            "worker_exit_nonzero",
            f"command failed with exit code {proc.returncode}: {' '.join(cmd[:3])}",
        )


def parse_run_dir(stdout_text: str) -> Path | None:
    match = re.search(r"Run dir:\s*(.+)", stdout_text)
    if not match:
        return None
    return Path(match.group(1).strip()).expanduser().resolve()


def newest_run_dir(output_root: Path, run_label: str, started_at_s: float) -> Path | None:
    if not output_root.exists():
        return None
    candidates = [
        path for path in output_root.iterdir()
        if path.is_dir() and path.name.endswith("_" + run_label)
    ]
    candidates = [path for path in candidates if path.stat().st_mtime >= started_at_s - 2]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def move_temp_logs(temp_dir: Path, run_dir: Path, job_id: str) -> tuple[Path, Path]:
    log_dir = run_dir / "logs" / job_id
    log_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = log_dir / "stdout.log"
    stderr_path = log_dir / "stderr.log"
    stdout_path.write_text(read_text_if_exists(temp_dir / "stdout.log"), encoding="utf-8")
    stderr_path.write_text(read_text_if_exists(temp_dir / "stderr.log"), encoding="utf-8")
    return stdout_path, stderr_path


def append_step(
    run_manifest: dict[str, Any],
    name: str,
    status: str,
    outputs: dict[str, str] | None = None,
    qa: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    step = {
        "name": name,
        "status": status,
        "finished_at": now_text(),
    }
    if outputs:
        step["outputs"] = outputs
    if qa:
        step["qa"] = qa
    if extra:
        step.update(extra)
    run_manifest.setdefault("steps", []).append(step)


def normalize_child_record(physical: dict[str, Any]) -> dict[str, Any]:
    product = normalize_product(first(physical, "product", default={}), "", "")
    start, end = time_range_of(physical)
    usable_start, usable_end = usable_range_of(physical)
    return {
        "shot_id": shot_id_of(physical),
        "parent_shot_id": str(first(physical, "parent_shot_id", "semantic_shot_id", default="")),
        "story_unit_id": str(first(physical, "story_unit_id", "parent_shot_id", default="")),
        "asset_id": str(first(physical, "asset_id", default="")),
        "product": product,
        "product_name": product.get("name", ""),
        "product_slug": product.get("slug", ""),
        "label": str(first(physical, "label", default="")),
        "time_range": [start, end],
        "usable_range": [usable_start, usable_end],
        "duration_s": round(max(0.0, usable_end - usable_start), 3),
        "clip_actual_duration_s": physical.get("clip_actual_duration_s"),
        "clip_frames": physical.get("clip_frames"),
        "trim_end_epsilon_s": physical.get("trim_end_epsilon_s"),
        "visual_summary": str(first(physical, "visual_summary", default="")),
        "source_meaning": str(first(physical, "source_meaning", default="")),
        "source_asr": first(physical, "source_asr", default=""),
        "source_ocr": first(physical, "source_ocr", default=[]),
        "parent_visual_summary": str(first(physical, "parent_visual_summary", default="")),
        "parent_source_meaning": str(first(physical, "parent_source_meaning", default="")),
        "parent_source_asr": first(physical, "parent_source_asr", default=""),
        "parent_source_ocr": first(physical, "parent_source_ocr", default=[]),
        "child_metadata_precision": str(first(physical, "child_metadata_precision", "metadata_source", default="")),
        "metadata_source": str(first(physical, "metadata_source", "child_metadata_precision", default="")),
        "text_embedding_policy": str(first(physical, "text_embedding_policy", default="")),
        "needs_vlm_refine": bool(first(physical, "needs_vlm_refine", default=False)),
        "selling_points": as_list(first(physical, "selling_points", default=[])),
        "parent_selling_points": as_list(first(physical, "parent_selling_points", default=[])),
        "visual_actions": as_list(first(physical, "visual_actions", default=[])),
        "parent_visual_actions": as_list(first(physical, "parent_visual_actions", default=[])),
        "shot_type": str(first(physical, "shot_type", "shot_type_hint", default="")),
        "parent_shot_type": str(first(physical, "parent_shot_type", default="")),
        "hard_subtitle_risk": first(physical, "hard_subtitle_risk", default="unknown"),
        "voiceover_fit": first(physical, "voiceover_fit", default="unknown"),
        "can_standalone": bool(first(physical, "can_standalone", default=False)),
        "trimmed_clip_path": str(first(physical, "trimmed_clip_path", default="")),
        "trimmed_oss_url": str(first(physical, "trimmed_oss_url", default="")),
    }


def mean_vectors(vectors: list[list[float]]) -> list[float]:
    if not vectors:
        return []
    size = len(vectors[0])
    sums = [0.0] * size
    for vector in vectors:
        for index, value in enumerate(vector):
            sums[index] += float(value)
    count = float(len(vectors))
    return [value / count for value in sums]


def aggregate_channels(child_ids: list[str], embeddings_by_shot: dict[str, dict[str, Any]]) -> dict[str, Any]:
    channel_vectors: dict[str, list[list[float]]] = {}
    channel_modes: dict[str, str] = {}
    for child_id in child_ids:
        result = embeddings_by_shot.get(child_id) or {}
        for channel_name, channel_data in (result.get("embeddings") or {}).items():
            if channel_data.get("status") != "ok":
                continue
            vector = channel_data.get("embedding")
            if not isinstance(vector, list) or len(vector) != DIMENSION:
                continue
            channel_vectors.setdefault(channel_name, []).append(vector)
            channel_modes[channel_name] = str(channel_data.get("mode") or "")

    channels: dict[str, Any] = {}
    for channel_name, vectors in sorted(channel_vectors.items()):
        channels[channel_name] = {
            "mode": channel_modes.get(channel_name, ""),
            "dim": DIMENSION,
            "status": "ok",
            "aggregation": "mean_child_physical",
            "child_count": len(vectors),
            "embedding": mean_vectors(vectors),
        }
    return channels


def build_shot_index(run_dir: Path, product_name: str, product_slug: str) -> tuple[Path, dict[str, Any]]:
    story_units = load_json(run_dir / "story_units.json")
    physical_shots = load_json(run_dir / "physical_shots.json")
    embedding_results = load_json(run_dir / "embedding_results.json")
    uploads_path = run_dir / "trim_upload_results_physical.json"
    embeddings_by_shot = {
        str(item.get("shot_id")): item
        for item in embedding_results
        if isinstance(item, dict) and item.get("shot_id")
    }

    physical_by_parent: dict[str, list[dict[str, Any]]] = {}
    physical_by_id: dict[str, dict[str, Any]] = {}
    for physical in physical_shots:
        if not isinstance(physical, dict):
            continue
        child = normalize_child_record(physical)
        child["product"] = normalize_product(child.get("product"), product_name, product_slug)
        child["product_name"] = child["product"]["name"]
        child["product_slug"] = child["product"]["slug"]
        child_id = child["shot_id"]
        if not child_id:
            continue
        physical_by_id[child_id] = child
        parent_id = child.get("parent_shot_id") or child.get("story_unit_id")
        if parent_id:
            physical_by_parent.setdefault(str(parent_id), []).append(child)

    for children in physical_by_parent.values():
        children.sort(key=lambda item: as_float((item.get("time_range") or [0, 0])[0]))

    records: list[dict[str, Any]] = []
    warnings: list[str] = []
    for unit in story_units:
        if not isinstance(unit, dict):
            continue
        unit_id = shot_id_of(unit)
        if not unit_id:
            warnings.append("story unit without shot_id skipped")
            continue
        child_ids = [str(item) for item in as_list(unit.get("child_physical_shot_ids")) if item]
        children = [physical_by_id[item] for item in child_ids if item in physical_by_id]
        if not children:
            children = physical_by_parent.get(unit_id, [])
            child_ids = [child["shot_id"] for child in children]
        start, end = time_range_of(unit)
        usable_start, usable_end = usable_range_of(unit)
        record = {
            "shot_id": unit_id,
            "story_unit_id": str(first(unit, "story_unit_id", default=unit_id)),
            "parent_shot_id": str(first(unit, "parent_shot_id", default="")),
            "semantic_shot_id": str(first(unit, "semantic_shot_id", default="")),
            "is_physical_shot": False,
            "is_story_unit": True,
            "planning_granularity": "story_unit",
            "boundary_source": str(first(unit, "boundary_source", default="")),
            "asset_id": str(first(unit, "asset_id", default="")),
            "segment_id": str(first(unit, "segment_id", default="")),
            "product": normalize_product(first(unit, "product", default={}), product_name, product_slug),
            "product_name": normalize_product(first(unit, "product", default={}), product_name, product_slug)["name"],
            "product_slug": normalize_product(first(unit, "product", default={}), product_name, product_slug)["slug"],
            "label": str(first(unit, "label", default="")),
            "time_range": [start, end],
            "usable_range": [usable_start, usable_end],
            "duration_s": round(max(0.0, usable_end - usable_start), 3),
            "visual_summary": str(first(unit, "visual_summary", default="")),
            "source_meaning": str(first(unit, "source_meaning", default="")),
            "source_asr": first(unit, "source_asr", default=""),
            "source_ocr": first(unit, "source_ocr", default=[]),
            "selling_points": as_list(first(unit, "selling_points", default=[])),
            "shot_type": str(first(unit, "shot_type", "shot_type_hint", default="")),
            "hard_subtitle_risk": first(unit, "hard_subtitle_risk", default="unknown"),
            "voiceover_fit": first(unit, "voiceover_fit", default="unknown"),
            "can_standalone": bool(first(unit, "can_standalone", default=False)),
            "same_segment_reason": str(first(unit, "same_segment_reason", default="")),
            "source_highlight_count": len(as_list(unit.get("child_shot_ids"))),
            "child_shot_ids": as_list(unit.get("child_shot_ids")),
            "child_physical_shot_ids": child_ids,
            "child_physical_shots": children,
            "child_clip_paths": [
                child["trimmed_clip_path"]
                for child in children
                if child.get("trimmed_clip_path")
            ],
            "trimmed_clip_path": "",
            "trimmed_oss_url": "",
            "physical_shot_count": len(children),
            "channels": aggregate_channels(child_ids, embeddings_by_shot),
        }
        if not children:
            warnings.append(f"{unit_id} has no child physical shots")
        if not record["channels"]:
            warnings.append(f"{unit_id} has no embedding channels")
        records.append(record)

    index = {
        "schema_version": "1.3.0",
        "source_run_dir": str(run_dir),
        "records_source_file": "story_units.json",
        "planning_granularity": "story_unit",
        "uploads_source_file": uploads_path.name if uploads_path.exists() else "",
        "model": EMBEDDING_MODEL,
        "dimension": DIMENSION,
        "embedding_model": EMBEDDING_MODEL,
        "embedding_dimension": DIMENSION,
        "product_name": product_name,
        "product_slug": product_slug,
        "total_shots": len(records),
        "records": records,
        "warnings": warnings,
    }
    output = run_dir / "shot_index.json"
    write_json(output, index)
    return output, index


def count_embedding_channels(embedding_results: list[Any]) -> tuple[int, int]:
    ok = 0
    failed = 0
    for item in embedding_results:
        if not isinstance(item, dict):
            continue
        for channel in (item.get("embeddings") or {}).values():
            if channel.get("status") == "ok":
                ok += 1
            else:
                failed += 1
    return ok, failed


def update_run_manifest(
    run_dir: Path,
    config: dict[str, Any],
    shot_index: dict[str, Any],
    stdout_path: Path,
    stderr_path: Path,
) -> dict[str, Any]:
    manifest_path = run_dir / "run_manifest.json"
    manifest = load_json(manifest_path) if manifest_path.exists() else {}
    physical_shots = load_json(run_dir / "physical_shots.json") if (run_dir / "physical_shots.json").exists() else []
    embedding_results = (
        load_json(run_dir / "embedding_results.json")
        if (run_dir / "embedding_results.json").exists()
        else []
    )
    ok_channels, failed_channels = count_embedding_channels(embedding_results)
    trim_results = (
        load_json(run_dir / "trim_upload_results_physical.json")
        if (run_dir / "trim_upload_results_physical.json").exists()
        else []
    )
    uploaded_count = sum(1 for item in trim_results if isinstance(item, dict) and item.get("uploaded"))
    trim_ok = sum(1 for item in trim_results if isinstance(item, dict) and item.get("status") == "ok")
    qa_warnings = list(shot_index.get("warnings") or [])
    if failed_channels:
        qa_warnings.append(f"{failed_channels} embedding channels failed")
    if trim_ok < len(physical_shots):
        qa_warnings.append(f"{len(physical_shots) - trim_ok} physical shots failed trim/upload")

    manifest.setdefault("schema_version", "1.3.0")
    manifest["desktop_wrapper"] = {
        "schema_version": "1.0.0",
        "job_id": config["job_id"],
        "stage": STAGE,
        "script": str(Path(__file__).resolve()),
        "finished_at": now_text(),
    }
    outputs = manifest.setdefault("outputs", {})
    outputs.update(
        {
            "assets": "assets.json",
            "segments": "segments.json",
            "story_units": "story_units.json",
            "semantic_shots": "shots.json",
            "physical_shots": "physical_shots.json",
            "scene_cuts": "scene_cuts.json",
            "trimmed_physical": "trimmed_physical/",
            "trim_upload_results_physical": "trim_upload_results_physical.json",
            "vectorization_inputs": "vectorization_inputs.json",
            "embedding_results": "embedding_results.json",
            "shot_index": "shot_index.json",
            "desktop_result": "desktop_intake_result.json",
        }
    )
    manifest["logs"] = {
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
    }
    qa = manifest.setdefault("qa", {})
    qa.update(
        {
            "status": "ok" if not qa_warnings else "manual_review",
            "warnings": qa_warnings,
            "physical_shot_count": len(physical_shots),
            "trimmed_physical_count": trim_ok,
            "uploaded_physical_count": uploaded_count,
            "embedding_result_count": len(embedding_results),
            "embedding_channel_ok_count": ok_channels,
            "embedding_channel_failed_count": failed_channels,
            "shot_index_record_count": shot_index.get("total_shots", 0),
            "story_units_are_planning_granularity": True,
            "vectorization_done": bool(embedding_results) and failed_channels == 0,
            "trim_interval": "[start,end)",
        }
    )
    write_json(manifest_path, manifest)
    return manifest


def artifact(kind: str, path: Path, schema_version: str = "1.0.0") -> dict[str, str]:
    return {
        "kind": kind,
        "path": str(path),
        "schema_version": schema_version,
    }


def build_success_result(
    config: dict[str, Any],
    run_dir: Path,
    manifest: dict[str, Any],
    stdout_path: Path,
    stderr_path: Path,
) -> dict[str, Any]:
    qa = manifest.get("qa") or {}
    outputs = {
        "run_dir": str(run_dir),
        "run_manifest": str(run_dir / "run_manifest.json"),
        "assets": str(run_dir / "assets.json"),
        "story_units": str(run_dir / "story_units.json"),
        "physical_shots": str(run_dir / "physical_shots.json"),
        "trimmed_physical_dir": str(run_dir / "trimmed_physical"),
        "trim_upload_results": str(run_dir / "trim_upload_results_physical.json"),
        "vectorization_inputs": str(run_dir / "vectorization_inputs.json"),
        "embedding_results": str(run_dir / "embedding_results.json"),
        "shot_index": str(run_dir / "shot_index.json"),
        "desktop_result": str(run_dir / "desktop_intake_result.json"),
    }
    result = {
        "schema_version": "1.0.0",
        "job_id": config["job_id"],
        "stage": STAGE,
        "status": "succeeded",
        "created_at": manifest.get("created_at", ""),
        "finished_at": now_text(),
        "product": {
            "name": config["product_name"],
            "slug": config["product_slug"],
        },
        "inputs": {
            "workspace_root": str(config["workspace"]),
            "source_dir": str(config["source_dir"]),
            "max_videos": config["max_videos"],
        },
        "options": {
            "run_label": config["run_label"],
            "scene_threshold": config["scene_threshold"],
            "candidate_min_duration": config["candidate_min_duration"],
            "min_physical_duration": config["min_physical_duration"],
            "skip_upload": config["skip_upload"],
            "skip_vectorize": config["skip_vectorize"],
        },
        "outputs": outputs,
        "artifacts": [
            artifact("intake_manifest", run_dir / "run_manifest.json", str(manifest.get("schema_version", "1.3.0"))),
            artifact("assets", run_dir / "assets.json"),
            artifact("story_units", run_dir / "story_units.json"),
            artifact("physical_shots", run_dir / "physical_shots.json"),
            artifact("trim_upload_results", run_dir / "trim_upload_results_physical.json"),
            artifact("vectorization_inputs", run_dir / "vectorization_inputs.json"),
            artifact("embedding_results", run_dir / "embedding_results.json"),
            artifact("shot_index", run_dir / "shot_index.json", "1.3.0"),
        ],
        "qa": {
            "status": qa.get("status", "ok"),
            "warnings": qa.get("warnings", []),
            "asset_count": qa.get("asset_count"),
            "story_unit_count": qa.get("story_unit_count"),
            "physical_shot_count": qa.get("physical_shot_count"),
            "trimmed_physical_count": qa.get("trimmed_physical_count"),
            "uploaded_physical_count": qa.get("uploaded_physical_count"),
            "embedding_channel_ok_count": qa.get("embedding_channel_ok_count"),
            "embedding_channel_failed_count": qa.get("embedding_channel_failed_count"),
            "shot_index_record_count": qa.get("shot_index_record_count"),
        },
        "logs": {
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
        },
        "next_consumers": [
            "intake:importRun",
            "copy:createBrief",
            "assembly:createCandidates",
        ],
    }
    return result


def build_failure_result(
    config: dict[str, Any] | None,
    error: WorkerError,
    stdout_path: Path | None = None,
    stderr_path: Path | None = None,
    run_dir: Path | None = None,
) -> dict[str, Any]:
    config = config or {
        "job_id": str(uuid.uuid4()),
        "product_name": "",
        "product_slug": "",
        "workspace": "",
        "source_dir": "",
        "max_videos": 0,
    }
    outputs: dict[str, str] = {}
    if run_dir:
        outputs["run_dir"] = str(run_dir)
        outputs["desktop_result"] = str(run_dir / "desktop_intake_result.json")
    result = {
        "schema_version": "1.0.0",
        "job_id": config.get("job_id", ""),
        "stage": STAGE,
        "status": "failed",
        "finished_at": now_text(),
        "product": {
            "name": config.get("product_name", ""),
            "slug": config.get("product_slug", ""),
        },
        "inputs": {
            "workspace_root": str(config.get("workspace", "")),
            "source_dir": str(config.get("source_dir", "")),
            "max_videos": config.get("max_videos", 0),
        },
        "outputs": outputs,
        "error": {
            "code": error.code,
            "message": error.message,
        },
        "qa": {
            "status": "failed",
            "warnings": [],
        },
        "logs": {
            "stdout_path": str(stdout_path) if stdout_path else "",
            "stderr_path": str(stderr_path) if stderr_path else "",
        },
        "next_consumers": [],
    }
    return result


def run_intake_job(config: dict[str, Any]) -> dict[str, Any]:
    validate_preflight(config)
    workspace = config["workspace"]
    product_slug = config["product_slug"]
    output_root = workspace / "cache" / "voah_video_intake" / product_slug
    scripts_dir = config["intake_scripts_dir"]
    output_root.mkdir(parents=True, exist_ok=True)
    started_at_s = time.time()
    run_dir: Path | None = None
    stdout_path: Path | None = None
    stderr_path: Path | None = None

    try:
        with tempfile.TemporaryDirectory(prefix="voah-intake-") as temp_name:
            temp_dir = Path(temp_name)
            temp_stdout = temp_dir / "stdout.log"
            temp_stderr = temp_dir / "stderr.log"
            run_cmd = [
                sys.executable,
                str(scripts_dir / "run_intake.py"),
                "--target-dir",
                str(config["source_dir"]),
                "--product",
                config["product_name"],
                "--product-slug",
                product_slug,
                "--workspace",
                str(workspace),
                "--output-root",
                str(output_root),
                "--run-label",
                config["run_label"],
                "--max-videos",
                str(config["max_videos"]),
                "--scene-threshold",
                str(config["scene_threshold"]),
                "--candidate-min-duration",
                str(config["candidate_min_duration"]),
                "--min-physical-duration",
                str(config["min_physical_duration"]),
                "--omni-proxy-width",
                str(config["omni_proxy_width"]),
                "--omni-proxy-fps",
                str(config["omni_proxy_fps"]),
            ]
            try:
                run_command(run_cmd, temp_stdout, temp_stderr, workspace)
            except WorkerError as exc:
                run_dir = newest_run_dir(
                    output_root,
                    config["run_label"],
                    started_at_s,
                )
                if run_dir:
                    stdout_path, stderr_path = move_temp_logs(temp_dir, run_dir, config["job_id"])
                    exc.run_dir = run_dir
                    exc.stdout_path = stdout_path
                    exc.stderr_path = stderr_path
                raise exc
            run_dir = parse_run_dir(read_text_if_exists(temp_stdout)) or newest_run_dir(
                output_root,
                config["run_label"],
                started_at_s,
            )
            if not run_dir:
                raise WorkerError("run_dir_not_found", "intake run completed but run dir could not be found")

            stdout_path, stderr_path = move_temp_logs(temp_dir, run_dir, config["job_id"])
            write_json(
                run_dir / "logs" / config["job_id"] / "command.safe.json",
                {
                    "schema_version": "1.0.0",
                    "commands": [
                        {
                            "name": "run_intake",
                            "argv": run_cmd,
                        }
                    ],
                    "secret_policy": "secrets are loaded by child workers from env/private config only",
                },
            )
            write_json(
                run_dir / "logs" / config["job_id"] / "job_input.json",
                {
                    "schema_version": "1.0.0",
                    "job_id": config["job_id"],
                    "stage": STAGE,
                    "workspace": {"root": str(workspace), "cache_root": str(workspace / "cache")},
                    "product": {"name": config["product_name"], "slug": product_slug},
                    "inputs": {"source_dir": str(config["source_dir"])},
                    "options": {
                        "run_label": config["run_label"],
                        "max_videos": config["max_videos"],
                        "scene_threshold": config["scene_threshold"],
                        "candidate_min_duration": config["candidate_min_duration"],
                        "min_physical_duration": config["min_physical_duration"],
                    },
                    "env": {"required_keys": ["DASHSCOPE_API_KEY"]},
                },
            )

        commands_for_log = [
            {
                "name": "run_intake",
                "argv": run_cmd,
            }
        ]
        run_manifest = load_json(run_dir / "run_manifest.json")

        if not config["skip_upload"]:
            trim_cmd = [
                sys.executable,
                str(scripts_dir / "trim_and_upload.py"),
                str(run_dir / "assets.json"),
                str(run_dir / "physical_shots.json"),
                str(run_dir / "trimmed_physical"),
                str(run_dir / "trim_upload_results_physical.json"),
            ]
            run_command(trim_cmd, stdout_path, stderr_path, workspace)
            commands_for_log.append({"name": "trim_and_upload_physical", "argv": trim_cmd})
            append_step(
                run_manifest,
                "trim_physical_shots",
                "ok",
                outputs={
                    "physical_shots": "physical_shots.json",
                    "trimmed_physical": "trimmed_physical/",
                    "trim_upload_results": "trim_upload_results_physical.json",
                    "qa_last_frames": "qa_last_frames.json",
                    "contact_sheet": "contact_sheet.jpg",
                },
            )
            write_json(run_dir / "run_manifest.json", run_manifest)
        else:
            append_step(
                run_manifest,
                "trim_physical_shots",
                "skipped",
                extra={"reason": "skip_upload option set"},
            )
            write_json(run_dir / "run_manifest.json", run_manifest)

        if not config["skip_vectorize"]:
            vector_cmd = [
                sys.executable,
                str(scripts_dir / "vectorize.py"),
                "--inputs",
                str(run_dir / "vectorization_inputs.json"),
                "--output",
                str(run_dir / "embedding_results.json"),
                "--build-from-shots",
                "--shots",
                str(run_dir / "physical_shots.json"),
                "--assets",
                str(run_dir / "assets.json"),
                "--uploads",
                str(run_dir / "trim_upload_results_physical.json"),
            ]
            run_command(vector_cmd, stdout_path, stderr_path, workspace)
            commands_for_log.append({"name": "vectorize_physical_shots", "argv": vector_cmd})
            append_step(
                run_manifest,
                "vectorize_physical_shots",
                "ok",
                outputs={
                    "vectorization_inputs": "vectorization_inputs.json",
                    "embedding_results": "embedding_results.json",
                },
            )
            write_json(run_dir / "run_manifest.json", run_manifest)
        else:
            append_step(
                run_manifest,
                "vectorize_physical_shots",
                "skipped",
                extra={"reason": "skip_vectorize option set"},
            )
            write_json(run_dir / "run_manifest.json", run_manifest)

        if config["skip_vectorize"]:
            raise WorkerError("vectorization_skipped", "shot_index requires embedding_results.json")

        shot_index_path, shot_index = build_shot_index(
            run_dir,
            config["product_name"],
            product_slug,
        )
        append_step(
            run_manifest,
            "build_shot_index",
            "ok",
            outputs={"shot_index": shot_index_path.name},
            qa={
                "status": "ok" if not shot_index.get("warnings") else "manual_review",
                "warnings": shot_index.get("warnings", []),
                "record_count": shot_index.get("total_shots", 0),
            },
        )
        write_json(
            run_dir / "logs" / config["job_id"] / "command.safe.json",
            {
                "schema_version": "1.0.0",
                "commands": commands_for_log,
                "secret_policy": "secrets are loaded by child workers from env/private config only",
            },
        )
        write_json(run_dir / "run_manifest.json", run_manifest)
        manifest = update_run_manifest(run_dir, config, shot_index, stdout_path, stderr_path)
        result = build_success_result(config, run_dir, manifest, stdout_path, stderr_path)
        write_json(run_dir / "desktop_intake_result.json", result)
        return result
    except WorkerError as exc:
        if run_dir:
            exc.run_dir = run_dir
            exc.stdout_path = stdout_path
            exc.stderr_path = stderr_path
            failure = build_failure_result(config, exc, stdout_path, stderr_path, run_dir)
            write_json(run_dir / "desktop_intake_result.json", failure)
        raise


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Voah video intake for the desktop app.")
    parser.add_argument("--job-input", help="Optional desktop worker job input JSON.")
    parser.add_argument("--job-id", help="Worker job id; defaults to a UUID.")
    parser.add_argument("--workspace", help="Workspace root; defaults to /Users/noah/混剪.")
    parser.add_argument("--product-slug", help="Product slug, e.g. fangshai-qidian.")
    parser.add_argument("--product-name", help="Product display name.")
    parser.add_argument("--source-dir", help="Directory containing source videos.")
    parser.add_argument("--max-videos", type=int, default=None, help="Maximum direct-child videos to ingest; 0 means all.")
    parser.add_argument("--run-label", default=None, help="Suffix for the intake run directory.")
    parser.add_argument("--scene-threshold", type=float, default=None)
    parser.add_argument("--candidate-min-duration", type=float, default=None)
    parser.add_argument("--min-physical-duration", type=float, default=None)
    parser.add_argument("--omni-proxy-width", type=int, default=None)
    parser.add_argument("--omni-proxy-fps", type=int, default=None)
    parser.add_argument("--intake-scripts-dir", help="Path to voah-video-intake/scripts.")
    parser.add_argument("--skip-upload", action="store_true", help="For debugging only; final shot_index will not be built.")
    parser.add_argument("--skip-vectorize", action="store_true", help="For debugging only; final shot_index will not be built.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    config: dict[str, Any] | None = None
    try:
        args = parse_args(argv or sys.argv[1:])
        config = resolve_config(args)
        result = run_intake_job(config)
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0
    except WorkerError as exc:
        result = build_failure_result(config, exc, exc.stdout_path, exc.stderr_path, exc.run_dir)
        if result.get("outputs", {}).get("desktop_result"):
            write_json(Path(result["outputs"]["desktop_result"]), result)
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 1
    except Exception as exc:  # noqa: BLE001
        error = WorkerError("unexpected_error", str(exc))
        result = build_failure_result(config, error)
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
