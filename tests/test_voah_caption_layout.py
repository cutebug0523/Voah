#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CAPTION_PLAN_SCRIPT = ROOT / "scripts" / "voah_build_caption_plan.py"
HYPERFRAMES_SCRIPT = ROOT / "scripts" / "voah_create_hyperframes_subtitle_project.py"
OVERLAY_SCRIPT = ROOT / "scripts" / "voah_burn_subtitles_overlay.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


caption_plan = load_module("voah_build_caption_plan", CAPTION_PLAN_SCRIPT)
hyperframes = load_module("voah_create_hyperframes_subtitle_project", HYPERFRAMES_SCRIPT)
overlay = load_module("voah_burn_subtitles_overlay", OVERLAY_SCRIPT)


class CaptionLayoutTest(unittest.TestCase):
    def test_long_chinese_caption_splits_to_safe_line_width(self):
        text = "这块防晒气垫刚好对症，防晒和底妆二合一，"

        chunks = caption_plan.split_caption_text(text)

        self.assertGreaterEqual(len(chunks), 2)
        self.assertTrue(all(caption_plan.display_units(chunk) <= 12 for chunk in chunks))
        self.assertEqual("".join(chunks), "这块防晒气垫刚好对症防晒和底妆二合一")

    def test_long_caption_without_punctuation_is_hard_wrapped(self):
        text = "早八通勤临时补妆越是赶时间越要快"

        chunks = caption_plan.split_caption_text(text)

        self.assertGreaterEqual(len(chunks), 2)
        self.assertTrue(all(caption_plan.display_units(chunk) <= 12 for chunk in chunks))
        self.assertEqual("".join(chunks), text)

    def test_caption_text_removes_commas_and_full_stops_but_keeps_emphasis_marks(self):
        text = "这块气垫，真的适合早八通勤。会卡粉吗？不会！《日常底妆》很稳——放心拍。"

        chunks = caption_plan.split_caption_text(text)
        joined = "".join(chunks)

        for char in "，。.,":
            self.assertNotIn(char, joined)
        for char in ["？", "！", "《", "》", "——"]:
            self.assertIn(char, joined)
        self.assertEqual(joined, "这块气垫真的适合早八通勤会卡粉吗？不会！《日常底妆》很稳——放心拍")

    def test_caption_text_removes_enumeration_comma(self):
        self.assertEqual(caption_plan.sanitize_caption_text("又怕底妆一上脸就卡住、"), "又怕底妆一上脸就卡住")

    def test_issue_59_caption_plan_keeps_known_risky_lines_under_12_units(self):
        risky_lines = [
            "尤其是早八通勤或者临时补妆，",
            "防晒和底妆二合一，粉扑轻拍上脸，",
            "做个倒水测试，水流过后，",
        ]

        for text in risky_lines:
            with self.subTest(text=text):
                chunks = caption_plan.split_caption_text(text)
                self.assertTrue(all(caption_plan.display_units(chunk) <= 12 for chunk in chunks))
                self.assertEqual("".join(chunks), caption_plan.sanitize_caption_text(text))

    def test_caption_hard_wrap_does_not_split_known_terms(self):
        cases = [
            ("根本不想一层一层往脸上叠粉底", "叠", "粉底"),
            ("尤其是早八通勤或者临时补妆", "补", "妆"),
        ]

        for text, left, right in cases:
            with self.subTest(text=text):
                chunks = caption_plan.split_caption_chunk(text, 12)
                self.assertTrue(all(caption_plan.display_units(chunk) <= 12 for chunk in chunks))
                self.assertEqual("".join(chunks), text)
                for a, b in zip(chunks, chunks[1:]):
                    self.assertFalse(a.endswith(left) and b.startswith(right))

    def test_songti_caption_css_contains_overflow_guards(self):
        css = hyperframes.style_css_for_preset(
            "songti_white_gold_lower",
            '"VoahSystemSongti", serif',
        )

        self.assertIn("max-width: 652px;", css)
        self.assertIn("word-break: break-word;", css)
        self.assertIn("overflow-wrap: break-word;", css)
        self.assertIn("white-space: normal;", css)
        self.assertIn('font-family: "VoahSystemSongti", serif;', css)
        self.assertNotIn("var(--voah-caption-font)", css)

    def test_songti_caption_css_scales_for_1080p(self):
        css = hyperframes.style_css_for_preset(
            "songti_white_gold_lower",
            '"VoahSystemSongti", serif',
            1080,
        )

        self.assertIn("max-width: 978px;", css)
        self.assertIn("font-size: 81px;", css)
        self.assertIn("bottom: 390px;", css)
        self.assertIn("-webkit-text-stroke: 3.3px", css)

    def test_overlay_fallback_style_scales_for_1080p(self):
        style = overlay.scaled_caption_style("songti_white_gold_lower", 1080)

        self.assertEqual(style["font_size"], 81)
        self.assertEqual(style["stroke"], 4)
        self.assertEqual(style["bottom"], 390)

    def test_overlay_fallback_wraps_by_rendered_pixel_width(self):
        font = overlay.load_font("/System/Library/Fonts/Supplemental/Songti.ttc", 54)
        max_width = overlay.caption_text_max_width(720, "songti_white_gold_lower")
        risky_lines = [
            "尤其是早八通勤或者临时补妆，",
            "防晒和底妆二合一，粉扑轻拍上脸，",
        ]

        for text in risky_lines:
            with self.subTest(text=text):
                wrapped = overlay.wrap_caption(text, font, max_width)
                lines = wrapped.splitlines()
                self.assertGreaterEqual(len(lines), 2)
                self.assertEqual("".join(lines), text)
                self.assertTrue(all(overlay.line_width_px(line, font) <= max_width for line in lines))

    def test_overlay_wrap_does_not_split_known_terms(self):
        font = overlay.load_font("/System/Library/Fonts/Supplemental/Songti.ttc", 54)
        max_width = overlay.caption_text_max_width(720, "songti_white_gold_lower")
        cases = [
            ("根本不想一层一层往脸上叠粉底", "叠", "粉底"),
            ("尤其是早八通勤或者临时补妆", "补", "妆"),
        ]

        for text, left, right in cases:
            with self.subTest(text=text):
                lines = overlay.wrap_caption(text, font, max_width).splitlines()
                self.assertEqual("".join(lines), text)
                for a, b in zip(lines, lines[1:]):
                    self.assertFalse(a.endswith(left) and b.startswith(right))

    def test_overlay_line_start_punctuation_matches_clean_caption_policy(self):
        self.assertFalse(overlay.is_line_start_punctuation("，"))
        self.assertFalse(overlay.is_line_start_punctuation("。"))
        self.assertTrue(overlay.is_line_start_punctuation("？"))
        self.assertTrue(overlay.is_line_start_punctuation("！"))


if __name__ == "__main__":
    unittest.main()
