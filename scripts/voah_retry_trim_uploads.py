#!/usr/bin/env python3
"""Retry DashScope OSS uploads for already-trimmed physical clips."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


DASHSCOPE_CLI = os.path.expanduser("~/Library/Python/3.9/bin/dashscope")
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INTAKE_SCRIPTS_DIR = Path(
    os.environ.get(
        "VOAH_VIDEO_INTAKE_SCRIPTS_DIR",
        str(REPO_ROOT / "runtime" / "skills" / "voah-video-intake" / "scripts"),
    )
)
UPLOAD_MODEL = "qwen3-vl-embedding"
VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".avi", ".webm")


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_env(required: bool = True) -> bool:
    if os.environ.get("DASHSCOPE_API_KEY", "").strip():
        return True
    env_path = Path.home() / ".voah" / "video_intake" / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("DASHSCOPE_API_KEY="):
                os.environ["DASHSCOPE_API_KEY"] = line.split("=", 1)[1].strip()
                return bool(os.environ["DASHSCOPE_API_KEY"])
    if required:
        print("DASHSCOPE_API_KEY not found. Run scripts/save_dashscope_key.py first.", file=sys.stderr)
    return False


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


def shot_id_of(record: dict[str, Any]) -> str:
    return str(first(record, "shot_id", "id", default=""))


def extract_oss_url(stdout: str, stderr: str) -> str:
    text = "\n".join([stdout or "", stderr or ""])
    try:
        parsed = json.loads(stdout)
        candidates = [
            parsed.get("url") if isinstance(parsed, dict) else "",
            parsed.get("data", {}).get("url") if isinstance(parsed, dict) and isinstance(parsed.get("data"), dict) else "",
            parsed.get("oss_url") if isinstance(parsed, dict) else "",
        ]
        for candidate in candidates:
            if candidate and str(candidate).startswith("oss://"):
                return str(candidate)
    except json.JSONDecodeError:
        pass

    marker = "oss://"
    if marker in text:
        tail = text.split(marker, 1)[1]
        parts: list[str] = []
        for raw_line in tail.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            if any(ch.isspace() for ch in line):
                break
            if parts and not re.match(r"^[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$", line):
                break
            parts.append(line)
            if line.lower().endswith(VIDEO_EXTENSIONS):
                break
        if parts:
            return marker + "".join(parts)

    match = re.search(r"oss://\S+", text)
    return match.group(0) if match else ""


def valid_oss_url(value: str) -> bool:
    return isinstance(value, str) and value.startswith("oss://") and "\n" not in value and "\r" not in value


def load_skill_upload_helper():
    helper_path = DEFAULT_INTAKE_SCRIPTS_DIR / "trim_and_upload.py"
    if not helper_path.exists():
        return None
    spec = importlib.util.spec_from_file_location("voah_skill_trim_and_upload", helper_path)
    if not spec or not spec.loader:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, "upload_to_dashscope_oss", None)


def probe_clip(path: Path) -> dict[str, Any]:
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return {}
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return {}
    video_stream = next(
        (stream for stream in data.get("streams", []) if stream.get("codec_type") == "video"),
        {},
    )
    duration = as_float(first(data.get("format") or {}, "duration", default=0))
    frames = first(video_stream, "nb_frames", default="")
    try:
        frames_value: int | None = int(frames) if frames not in (None, "") else None
    except (TypeError, ValueError):
        frames_value = None
    return {
        "clip_actual_duration_s": round(duration, 6) if duration else None,
        "clip_frames": frames_value,
        "clip_fps": str(first(video_stream, "r_frame_rate", "avg_frame_rate", default="")),
    }


def upload_clip(path: Path, timeout_s: int, max_attempts: int) -> str:
    helper = load_skill_upload_helper()
    if helper:
        return helper(
            str(path),
            model=UPLOAD_MODEL,
            label=f"retry:{path.stem}",
            attempts=max_attempts,
            certificate_timeout_s=min(timeout_s, 20),
            post_timeout_s=min(timeout_s, 45),
            cli_timeout_s=min(timeout_s, 60),
            cli_attempts=1,
        )

    last_error = ""
    for attempt in range(1, max_attempts + 1):
        proc = subprocess.run(
            [DASHSCOPE_CLI, "oss", "upload", "-f", str(path), "-m", UPLOAD_MODEL],
            capture_output=True,
            text=True,
            timeout=min(timeout_s, 60),
            env={**os.environ},
        )
        if proc.returncode == 0:
            oss_url = extract_oss_url(proc.stdout, proc.stderr)
            if valid_oss_url(oss_url):
                return oss_url
            last_error = "could not extract oss:// URL from dashscope output"
        else:
            last_error = (proc.stderr or proc.stdout or f"dashscope exited {proc.returncode}")[:800]
        if attempt < max_attempts:
            time.sleep(2 * attempt)
    raise RuntimeError(last_error or "upload failed")


def clip_path_for(shot_id: str, shot: dict[str, Any], result: dict[str, Any], clips_dir: Path) -> Path:
    for value in (
        result.get("trimmed_path"),
        result.get("trimmed_clip_path"),
        shot.get("trimmed_clip_path"),
    ):
        if value:
            return Path(str(value)).expanduser().resolve()
    return (clips_dir / f"{shot_id}.mp4").resolve()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Retry failed DashScope uploads for trimmed physical clips.")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--shots", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--clips-dir", required=True)
    parser.add_argument("--retry-results", default="")
    parser.add_argument("--timeout-s", type=int, default=300)
    parser.add_argument("--max-attempts", type=int, default=3)
    args = parser.parse_args(argv)

    if not load_env(required=True):
        return 1

    run_dir = Path(args.run_dir).expanduser().resolve()
    shots_path = Path(args.shots).expanduser().resolve()
    results_path = Path(args.results).expanduser().resolve()
    clips_dir = Path(args.clips_dir).expanduser().resolve()
    retry_results_path = Path(args.retry_results).expanduser().resolve() if args.retry_results else run_dir / "trim_upload_retry_results.json"

    shots = load_json(shots_path)
    results = load_json(results_path)
    if not isinstance(shots, list) or not isinstance(results, list):
        raise ValueError("shots and results must both be JSON lists")
    shots_by_id = {shot_id_of(shot): shot for shot in shots if isinstance(shot, dict)}
    result_by_id = {str(item.get("shot_id") or ""): item for item in results if isinstance(item, dict)}

    retry_items: list[dict[str, Any]] = []
    for shot_id, shot in shots_by_id.items():
        result = result_by_id.get(shot_id) or {"shot_id": shot_id, "status": "missing_result"}
        if valid_oss_url(str(first(shot, "trimmed_oss_url", default=""))) and result.get("status") == "ok":
            continue
        retry_items.append({"shot_id": shot_id, "shot": shot, "result": result})

    retry_records: list[dict[str, Any]] = []
    print(f"Retrying trim uploads: {len(retry_items)} targets", flush=True)
    for item in retry_items:
        shot_id = item["shot_id"]
        shot = item["shot"]
        result = item["result"]
        clip_path = clip_path_for(shot_id, shot, result, clips_dir)
        if not clip_path.exists() or clip_path.stat().st_size <= 0:
            retry_records.append(
                {
                    "shot_id": shot_id,
                    "status": "error",
                    "error": f"trimmed clip not found: {clip_path}",
                    "trimmed_path": str(clip_path),
                }
            )
            continue
        try:
            print(f"  upload retry: {shot_id}", flush=True)
            oss_url = upload_clip(clip_path, timeout_s=args.timeout_s, max_attempts=args.max_attempts)
            probe = probe_clip(clip_path)
            shot["trimmed_clip_path"] = str(clip_path)
            shot["trimmed_oss_url"] = oss_url
            if probe.get("clip_actual_duration_s") is not None:
                shot["clip_actual_duration_s"] = probe.get("clip_actual_duration_s")
            if probe.get("clip_frames") is not None:
                shot["clip_frames"] = probe.get("clip_frames")
            updated_result = {
                **result,
                "shot_id": shot_id,
                "asset_id": first(shot, "asset_id", default=result.get("asset_id", "")),
                "status": "ok",
                "trimmed_path": str(clip_path),
                "oss_url": oss_url,
                "upload_model": UPLOAD_MODEL,
                "uploaded": True,
                "retry_uploaded": True,
                "retried_at": iso_now(),
                "size_bytes": clip_path.stat().st_size,
                **{k: v for k, v in probe.items() if v is not None},
            }
            result_by_id[shot_id] = updated_result
            retry_records.append({"shot_id": shot_id, "status": "ok", "oss_url": oss_url})
        except Exception as exc:  # noqa: BLE001
            retry_records.append(
                {
                    "shot_id": shot_id,
                    "status": "error",
                    "error": str(exc),
                    "trimmed_path": str(clip_path),
                }
            )

    updated_results = []
    for result in results:
        shot_id = str(result.get("shot_id") or "")
        updated_results.append(result_by_id.get(shot_id, result))
    existing = {str(item.get("shot_id") or "") for item in updated_results if isinstance(item, dict)}
    for shot_id, result in result_by_id.items():
        if shot_id and shot_id not in existing:
            updated_results.append(result)

    ok_count = sum(1 for item in updated_results if isinstance(item, dict) and item.get("status") == "ok" and item.get("uploaded"))
    failed = [item for item in updated_results if not (isinstance(item, dict) and item.get("status") == "ok" and item.get("uploaded"))]
    summary = {
        "schema_version": "1.0.0",
        "stage": "voah_trim_upload_retry",
        "created_at": iso_now(),
        "inputs": {
            "shots": str(shots_path),
            "results": str(results_path),
            "clips_dir": str(clips_dir),
        },
        "summary": {
            "retry_target_count": len(retry_items),
            "retry_success_count": sum(1 for item in retry_records if item.get("status") == "ok"),
            "retry_failed_count": sum(1 for item in retry_records if item.get("status") != "ok"),
            "uploaded_count": ok_count,
            "total_count": len(shots),
        },
        "results": retry_records,
        "qa": {
            "status": "ok" if not failed else "manual_review",
            "warnings": [f"{len(failed)} physical clips still missing upload"] if failed else [],
        },
    }

    write_json(shots_path, shots)
    write_json(results_path, updated_results)
    write_json(retry_results_path, summary)
    print(json.dumps(summary["summary"], ensure_ascii=False), flush=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
