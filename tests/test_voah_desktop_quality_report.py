#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
QUALITY_SCRIPT = ROOT / "scripts" / "voah_build_desktop_quality_report.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


quality = load_module("voah_build_desktop_quality_report", QUALITY_SCRIPT)


class DesktopQualityReportTest(unittest.TestCase):
    def test_caption_text_match_ignores_punctuation(self):
        payloads = {
            "audio_sections": {
                "sections": [
                    {
                        "section_id": "s1",
                        "voice_text": "这块气垫，真的适合早八通勤。",
                        "subtitle_text": "这块气垫，真的适合早八通勤。",
                        "audio_start_s": 0,
                        "audio_end_s": 2,
                    }
                ],
                "summary": {"total_duration_s": 2},
            },
            "caption_plan": {
                "captions": [
                    {
                        "section_id": "s1",
                        "caption_order": 1,
                        "text": "这块气垫真的适合早八通勤",
                        "start_s": 0,
                        "end_s": 2,
                        "text_source": "voice_script/audio_sections",
                    }
                ],
                "summary": {"total_duration_s": 2},
            },
            "voice_script": {"full_voice_text": "这块气垫，真的适合早八通勤。"},
            "tts_audio": {"provider": {"name": "minimax-official"}},
        }
        check = quality.build_voice_caption_check(payloads, {})

        self.assertEqual(check["status"], "pass")
        self.assertEqual(check["metrics"]["text_mismatch_section_count"], 0)
        self.assertTrue(check["metrics"]["voice_script_matches_audio_sections"])

    def test_missing_final_omni_is_optional(self):
        check = quality.build_omni_check(Path("/tmp/task"), {}, {"exists": False}, [])

        self.assertEqual(check["status"], "pass")
        self.assertEqual(check["metrics"]["final_status"], "not_run")
        self.assertEqual(check["warnings"], [])
        self.assertEqual(check["blocks"], [])

    def test_final_video_shorter_than_audio_axis_blocks(self):
        with patch.object(quality, "ffprobe_media") as ffprobe_mock:
            ffprobe_mock.side_effect = [
                {"exists": True, "format": {"duration": "39.933"}},
                {"exists": True, "format": {"duration": "39.933"}},
                {"exists": True, "format": {"duration": "41.256"}},
            ]
            check = quality.build_render_check(
                Path("/tmp/task"),
                {
                    "final_subtitled": Path("/tmp/task/final.mp4"),
                    "preview_no_subtitles": Path("/tmp/task/preview.mp4"),
                    "voice_wav": Path("/tmp/task/voice.wav"),
                    "hyperframes_manifest": Path("/tmp/task/hyperframes.json"),
                },
                {
                    "timeline_fill": {"summary": {"voice_duration_s": 41.339}},
                    "audio_sections": {"summary": {"total_duration_s": 41.339}},
                    "hyperframes_manifest": {"qa": {"status": "ok"}},
                },
                {},
            )

        self.assertEqual(check["status"], "block")
        self.assertTrue(any("短于音频主轴" in item["message"] for item in check["blocks"]))


if __name__ == "__main__":
    unittest.main()
