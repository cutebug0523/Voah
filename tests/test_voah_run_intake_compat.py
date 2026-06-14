#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "voah_run_intake_compat.py"
SPEC = importlib.util.spec_from_file_location("voah_run_intake_compat", SCRIPT)
assert SPEC and SPEC.loader
compat = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compat)


class RunIntakeCompatJsonRepairTest(unittest.TestCase):
    def test_default_skill_runner_uses_repo_runtime_bundle(self):
        expected = ROOT / "runtime" / "skills" / "voah-video-intake" / "scripts" / "run_intake.py"
        self.assertEqual(compat.DEFAULT_SKILL_RUNNER, expected)
        self.assertTrue(compat.DEFAULT_SKILL_RUNNER.exists())
        self.assertNotIn("/Users/noah/.codex", str(compat.DEFAULT_SKILL_RUNNER))

    def test_repairs_missing_tail_braces_from_streamed_json(self):
        parsed = compat.parse_json_with_repairs(
            '{"story_units":[{"id":"u1","scene_segment_ids":["s1"],"visual_summary":"上脸拍打"}]'
        )

        self.assertEqual(parsed["story_units"][0]["id"], "u1")
        self.assertEqual(parsed["story_units"][0]["visual_summary"], "上脸拍打")

    def test_extracts_json_from_markdown_fence(self):
        parsed = compat.parse_json_with_repairs(
            '```json\n{"story_units":[{"id":"u2","visual_actions":["泼水测试"]}]}\n```'
        )

        self.assertEqual(parsed["story_units"][0]["visual_actions"], ["泼水测试"])


if __name__ == "__main__":
    unittest.main()
