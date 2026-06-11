#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "voah_intake_desktop_wrapper.py"
SPEC = importlib.util.spec_from_file_location("voah_intake_desktop_wrapper", SCRIPT)
assert SPEC and SPEC.loader
wrapper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wrapper)


class DesktopIntakeWrapperStateTest(unittest.TestCase):
    def test_write_status_creates_job_status_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            config = {
                "job_id": "job-test",
                "workspace": workspace,
                "source_dir": workspace / "source",
                "product_name": "Demo",
                "product_slug": "demo",
                "max_videos": 0,
                "mode": "add",
            }
            status = wrapper.write_status(config, "running", "scan")
            status_path = workspace / "cache" / "voah_video_intake" / "demo" / "_jobs" / "job-test" / "desktop_intake_status.json"
            self.assertTrue(status_path.exists())
            saved = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["status"], "running")
            self.assertEqual(saved["stage_label"], "扫描素材")
            self.assertEqual(status["job_id"], "job-test")

    def test_scan_incremental_skips_ready_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            source = workspace / "source"
            source.mkdir()
            video = source / "demo.mp4"
            video.write_bytes(b"fake-video")
            config = {
                "workspace": workspace,
                "source_dir": source,
                "product_slug": "demo",
                "product_name": "Demo",
                "max_videos": 0,
                "force_reindex": False,
                "include_existing_failed": False,
            }
            fingerprint = wrapper.file_sha256(video)
            registry_path = workspace / "data" / "products" / "demo" / "material_registry.json"
            wrapper.write_json(
                registry_path,
                {
                    "schema_version": "voah.material_registry.v1",
                    "product_slug": "demo",
                    "items": [
                        {
                            "source_fingerprint": fingerprint,
                            "status": "ready",
                            "source_path_history": [str(video)],
                        }
                    ],
                },
            )
            incremental = wrapper.scan_incremental_sources(config)
            self.assertEqual(len(incremental["selected"]), 0)
            self.assertEqual(len(incremental["skipped"]), 1)
            self.assertEqual(len(incremental["retry_failed"]), 0)

    def test_scan_incremental_retries_failed_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            source = workspace / "source"
            source.mkdir()
            ready_video = source / "ready.mp4"
            failed_video = source / "failed.mp4"
            ready_video.write_bytes(b"ready-video")
            failed_video.write_bytes(b"failed-video")
            ready_fp = wrapper.file_sha256(ready_video)
            failed_fp = wrapper.file_sha256(failed_video)
            config = {
                "workspace": workspace,
                "source_dir": source,
                "product_slug": "demo",
                "product_name": "Demo",
                "max_videos": 0,
                "force_reindex": False,
            }
            wrapper.write_json(
                workspace / "data" / "products" / "demo" / "material_registry.json",
                {
                    "schema_version": "voah.material_registry.v1",
                    "product_slug": "demo",
                    "items": [
                        {
                            "source_fingerprint": ready_fp,
                            "filename": ready_video.name,
                            "status": "ready",
                            "source_path_history": [str(ready_video)],
                        },
                        {
                            "source_fingerprint": failed_fp,
                            "filename": failed_video.name,
                            "status": "failed",
                            "source_path_history": [str(failed_video)],
                        },
                    ],
                },
            )

            incremental = wrapper.scan_incremental_sources(config)
            self.assertTrue(incremental["include_existing_failed"])
            self.assertEqual([item["filename"] for item in incremental["selected"]], ["failed.mp4"])
            self.assertEqual([item["filename"] for item in incremental["retry_failed"]], ["failed.mp4"])
            self.assertEqual(len(incremental["skipped"]), 1)
            self.assertEqual(incremental["skipped"][0]["filename"], "ready.mp4")
            self.assertEqual(incremental["skipped"][0]["reason"], "already_ready")

            summary = wrapper.incremental_summary(incremental)
            self.assertEqual(summary["selected_count"], 1)
            self.assertEqual(summary["new_count"], 0)
            self.assertEqual(summary["skipped_count"], 1)
            self.assertEqual(summary["existing_failed_count"], 1)
            self.assertEqual(summary["retry_failed_count"], 1)
            self.assertEqual(summary["retry_failed"][0]["filename"], "failed.mp4")

    def test_scan_incremental_can_defer_failed_when_explicitly_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            source = workspace / "source"
            source.mkdir()
            video = source / "failed.mp4"
            video.write_bytes(b"failed-video")
            fingerprint = wrapper.file_sha256(video)
            config = {
                "workspace": workspace,
                "source_dir": source,
                "product_slug": "demo",
                "product_name": "Demo",
                "max_videos": 0,
                "force_reindex": False,
                "include_existing_failed": False,
            }
            wrapper.write_json(
                workspace / "data" / "products" / "demo" / "material_registry.json",
                {
                    "schema_version": "voah.material_registry.v1",
                    "product_slug": "demo",
                    "items": [
                        {
                            "source_fingerprint": fingerprint,
                            "filename": video.name,
                            "status": "failed",
                            "source_path_history": [str(video)],
                        }
                    ],
                },
            )

            incremental = wrapper.scan_incremental_sources(config)
            self.assertFalse(incremental["include_existing_failed"])
            self.assertEqual(len(incremental["selected"]), 0)
            self.assertEqual(len(incremental["retry_failed"]), 0)
            self.assertEqual(len(incremental["existing_failed"]), 1)
            self.assertEqual(len(incremental["deferred_failed"]), 1)

    def test_status_records_retry_failed_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            config = {
                "job_id": "job-test",
                "workspace": workspace,
                "source_dir": workspace / "source",
                "product_name": "Demo",
                "product_slug": "demo",
                "max_videos": 0,
                "mode": "add",
            }
            incremental = {
                "source_records": [{}, {}],
                "selected": [{"filename": "failed.mp4", "reason": "retry_failed"}],
                "new": [],
                "skipped": [{"filename": "ready.mp4", "reason": "already_ready"}],
                "existing_failed": [{"filename": "failed.mp4"}],
                "retry_failed": [{"filename": "failed.mp4", "reason": "retry_failed"}],
                "deferred_failed": [],
                "force_reindex": False,
                "include_existing_failed": True,
            }

            status = wrapper.write_status(config, "running", "scan", incremental=incremental)
            self.assertEqual(status["incremental"]["source_count"], 2)
            self.assertEqual(status["incremental"]["selected_count"], 1)
            self.assertEqual(status["incremental"]["new_count"], 0)
            self.assertEqual(status["incremental"]["skipped_count"], 1)
            self.assertEqual(status["incremental"]["retry_failed_count"], 1)

    def test_upsert_retry_success_marks_failed_ready_and_leaves_skipped_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            source = workspace / "source"
            run_dir = workspace / "cache" / "voah_video_intake" / "demo" / "run"
            source.mkdir(parents=True)
            run_dir.mkdir(parents=True)
            ready_video = source / "ready.mp4"
            failed_video = source / "failed.mp4"
            ready_video.write_bytes(b"ready-video")
            failed_video.write_bytes(b"failed-video")
            ready_record = wrapper.fingerprint_video(ready_video)
            failed_record = {**wrapper.fingerprint_video(failed_video), "reason": "retry_failed"}
            config = {
                "workspace": workspace,
                "source_dir": source,
                "product_slug": "demo",
                "product_name": "Demo",
                "job_id": "job-test",
            }
            wrapper.write_json(
                wrapper.registry_path(config),
                {
                    "schema_version": "voah.material_registry.v1",
                    "product_slug": "demo",
                    "items": [
                        {
                            "source_fingerprint": ready_record["source_fingerprint"],
                            "filename": ready_record["filename"],
                            "status": "ready",
                            "source_path_history": [ready_record["source_path"]],
                        },
                        {
                            "source_fingerprint": failed_record["source_fingerprint"],
                            "filename": failed_record["filename"],
                            "status": "failed",
                            "source_path_history": [failed_record["source_path"]],
                        },
                    ],
                },
            )
            incremental = {
                "selected": [failed_record],
                "skipped": [{**ready_record, "reason": "already_ready"}],
                "retry_failed": [failed_record],
            }

            registry = wrapper.upsert_registry_items(config, run_dir, incremental, "ready")
            by_fp = {item["source_fingerprint"]: item for item in registry["items"]}
            self.assertEqual(by_fp[failed_record["source_fingerprint"]]["status"], "ready")
            self.assertEqual(by_fp[ready_record["source_fingerprint"]]["status"], "ready")

    def test_upsert_retry_failure_leaves_skipped_ready_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            source = workspace / "source"
            run_dir = workspace / "cache" / "voah_video_intake" / "demo" / "run"
            source.mkdir(parents=True)
            run_dir.mkdir(parents=True)
            ready_video = source / "ready.mp4"
            failed_video = source / "failed.mp4"
            ready_video.write_bytes(b"ready-video")
            failed_video.write_bytes(b"failed-video")
            ready_record = wrapper.fingerprint_video(ready_video)
            failed_record = {**wrapper.fingerprint_video(failed_video), "reason": "retry_failed"}
            config = {
                "workspace": workspace,
                "source_dir": source,
                "product_slug": "demo",
                "product_name": "Demo",
                "job_id": "job-test",
            }
            wrapper.write_json(
                wrapper.registry_path(config),
                {
                    "schema_version": "voah.material_registry.v1",
                    "product_slug": "demo",
                    "items": [
                        {
                            "source_fingerprint": ready_record["source_fingerprint"],
                            "filename": ready_record["filename"],
                            "status": "ready",
                            "source_path_history": [ready_record["source_path"]],
                        },
                        {
                            "source_fingerprint": failed_record["source_fingerprint"],
                            "filename": failed_record["filename"],
                            "status": "failed",
                            "source_path_history": [failed_record["source_path"]],
                        },
                    ],
                },
            )
            incremental = {
                "selected": [failed_record],
                "skipped": [{**ready_record, "reason": "already_ready"}],
                "retry_failed": [failed_record],
            }

            error = wrapper.WorkerError("intake_failed", "failed retry")
            registry = wrapper.upsert_registry_items(config, run_dir, incremental, "failed", error)
            by_fp = {item["source_fingerprint"]: item for item in registry["items"]}
            self.assertEqual(by_fp[failed_record["source_fingerprint"]]["status"], "failed")
            self.assertEqual(by_fp[ready_record["source_fingerprint"]]["status"], "ready")

    def test_resolve_config_accepts_incremental_flags(self):
        args = SimpleNamespace(
            job_input=None,
            workspace=str(ROOT),
            product_slug="demo",
            product_name="Demo",
            source_dir=str(ROOT),
            run_label="test",
            max_videos=0,
            scene_threshold=None,
            candidate_min_duration=None,
            min_physical_duration=None,
            omni_proxy_width=None,
            omni_proxy_fps=None,
            intake_scripts_dir=None,
            no_refine_children=False,
            refine_workers=None,
            refine_limit=None,
            refine_timeout_s=None,
            skip_upload=False,
            skip_vectorize=False,
            mode="add",
            force_reindex=True,
            include_existing_failed=True,
            job_id="job",
        )
        config = wrapper.resolve_config(args)
        self.assertEqual(config["mode"], "add")
        self.assertTrue(config["force_reindex"])
        self.assertTrue(config["include_existing_failed"])

    def test_resolve_config_defaults_to_retry_failed(self):
        args = SimpleNamespace(
            job_input=None,
            workspace=str(ROOT),
            product_slug="demo",
            product_name="Demo",
            source_dir=str(ROOT),
            run_label="test",
            max_videos=0,
            scene_threshold=None,
            candidate_min_duration=None,
            min_physical_duration=None,
            omni_proxy_width=None,
            omni_proxy_fps=None,
            intake_scripts_dir=None,
            no_refine_children=False,
            refine_workers=None,
            refine_limit=None,
            refine_timeout_s=None,
            skip_upload=False,
            skip_vectorize=False,
            mode="add",
            force_reindex=False,
            include_existing_failed=None,
            job_id="job",
        )
        config = wrapper.resolve_config(args)
        self.assertTrue(config["include_existing_failed"])


if __name__ == "__main__":
    unittest.main()
