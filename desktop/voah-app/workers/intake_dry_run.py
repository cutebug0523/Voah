#!/usr/bin/env python3
"""Dry-run video intake worker for desktop integration tests.

This worker proves the Electron/Node WorkerRunner contract without calling
DashScope, ffmpeg, or touching media files.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from datetime import datetime, timezone


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    input_path = Path(args.input)
    out_path = Path(args.out)
    payload = json.loads(input_path.read_text(encoding="utf-8"))

    run_dir = Path(payload["scope"]["dir"])
    run_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "schema_version": "1.0.0",
        "stage": "video_intake",
        "mode": "dry_run",
        "inputs": {
            "product_id": payload["inputs"]["product_id"],
            "source_folder_origin": payload["inputs"]["source_folder_origin"],
            "run_label": payload["inputs"]["run_label"],
        },
        "outputs": {
            "run_manifest": "run_manifest.json",
            "assets": "assets.json",
            "story_units": "story_units.json",
            "physical_shots": "physical_shots.json",
            "embedding_results": "embedding_results.json",
            "qa_report": "qa_last_frames.json",
        },
        "qa": {
            "status": "dry_run",
            "warnings": ["dry run worker did not inspect media"],
        },
        "next_consumers": ["ArtifactService.registerMany"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    artifacts = {
        "run_manifest.json": manifest,
        "assets.json": {"assets": []},
        "story_units.json": {"story_units": []},
        "physical_shots.json": {"physical_shots": []},
        "embedding_results.json": {"embedding_results": []},
        "qa_last_frames.json": {"frames": [], "status": "dry_run"},
    }

    for filename, content in artifacts.items():
        (run_dir / filename).write_text(
            json.dumps(content, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    worker_manifest = {
        "schema_version": "1.0.0",
        "stage": "video_intake",
        "status": "succeeded",
        "mode": "dry_run",
        "inputs": payload["inputs"],
        "outputs": {
            "run_dir": str(run_dir),
            "manifest_path": str(run_dir / "run_manifest.json"),
        },
        "qa": {
            "status": "warning",
            "warnings": ["dry run only"],
        },
        "next_consumers": ["ArtifactService.registerMany"],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(worker_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"dry-run intake manifest written: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
