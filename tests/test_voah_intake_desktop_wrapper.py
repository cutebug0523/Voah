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


if __name__ == "__main__":
    unittest.main()
