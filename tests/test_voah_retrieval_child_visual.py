#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "voah_retrieve_fill_from_audio_sections.py"
SPEC = importlib.util.spec_from_file_location("voah_retrieve", SCRIPT)
assert SPEC and SPEC.loader
voah = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(voah)


def child(shot_id: str, start: float, end: float, visual_actions: list[str], summary: str = "") -> dict:
    return {
        "shot_id": shot_id,
        "time_range": [start, end],
        "usable_range": [start, end],
        "duration_s": round(end - start, 3),
        "clip_actual_duration_s": round(end - start, 3),
        "trimmed_clip_path": f"/tmp/{shot_id}.mp4",
        "visual_summary": summary or "普通补妆画面",
        "source_meaning": summary or "展示产品使用",
        "visual_actions": visual_actions,
        "child_metadata_precision": "child_vlm_refined",
        "metadata_source": "child_vlm_refined",
        "text_embedding_policy": "allow_child_text_channels",
        "needs_vlm_refine": False,
    }


def proof_section() -> dict:
    return {
        "section_id": "s_proof",
        "role": "proof",
        "voice_text": "出汗遇水也不怕，妆面依然干净。",
        "required_visual": "泼水测试",
        "required_meaning": "用泼水测试证明持妆",
        "audio_duration_s": 2.0,
        "keywords": ["泼水测试"],
    }


def parent_candidate(children: list[dict]) -> dict:
    return {
        "shot_id": "unit_001",
        "story_unit_id": "unit_001",
        "asset_id": "asset_001",
        "time_range": [0.0, 6.0],
        "usable_range": [0.0, 6.0],
        "duration_s": 6.0,
        "trimmed_clip_path": "/tmp/unit_001.mp4",
        "visual_summary": "先补妆，然后做泼水测试，最后纸巾按压。",
        "source_meaning": "展示气垫持妆证明",
        "visual_actions": ["补妆", "泼水测试", "纸巾按压"],
        "child_physical_shots": children,
        "score": 0.8,
        "adjusted_score": 0.8,
        "fill_reasons": [],
        "fill_risks": [],
    }


class ChildVisualSelectionTest(unittest.TestCase):
    def test_proof_section_selects_child_with_required_visual_and_offsets_parent_clip(self):
        section = proof_section()
        candidate = parent_candidate(
            [
                child("p00", 0.0, 2.0, ["补妆"], "人物用粉扑补妆"),
                child("p01", 2.0, 4.0, ["泼水测试"], "镜头切到脸部和测试区域，展示妆面状态"),
                child("p02", 4.0, 6.0, ["纸巾按压"], "用纸巾按压观察是否脱妆"),
            ]
        )

        self.assertTrue(voah.candidate_has_child_visual_hit(candidate, section))
        selected = voah.select_child_physical_shot(candidate, section)
        self.assertEqual(selected["child_physical_shot_id"], "p01")
        self.assertIn("泼水", selected["child_required_visual_hits"])

        segment = voah.clip_segment_from_parent_story_unit(candidate, section, selected, 1.5)
        self.assertEqual(segment["child_physical_shot_id"], "p01")
        self.assertEqual(segment["source_start_offset_s"], 2.0)
        self.assertFalse(segment["requires_visual_review"])

    def test_llm_preferred_wrong_child_is_ignored_when_hard_visual_child_exists(self):
        section = proof_section()
        candidate = parent_candidate(
            [
                child("p00", 0.0, 2.0, ["补妆"], "人物用粉扑补妆"),
                child("p01", 2.0, 4.0, ["泼水测试"], "镜头切到脸部和测试区域，展示妆面状态"),
                child("p02", 4.0, 6.0, ["纸巾按压"], "用纸巾按压观察妆面"),
            ]
        )
        candidate["llm_preferred_child_physical_shot_ids"] = ["p00"]

        selected = voah.select_child_physical_shot(candidate, section)

        self.assertEqual(selected["child_physical_shot_id"], "p01")
        self.assertIn("泼水", selected["child_required_visual_hits"])

    def test_strong_visual_section_falls_back_without_child_hit_but_marks_review(self):
        section = proof_section()
        candidate = parent_candidate(
            [
                child("p00", 0.0, 2.0, ["补妆"], "人物用粉扑补妆"),
                child("p01", 2.0, 4.0, ["看向镜头"], "人物看向镜头展示妆面"),
                child("p02", 4.0, 6.0, ["纸巾按压"], "用纸巾按压观察妆面"),
            ]
        )

        pool, fallback = voah.hard_visual_candidate_pool([candidate], section)
        self.assertEqual(pool, [candidate])
        self.assertTrue(fallback)

        selected = voah.select_child_physical_shot(candidate, section)
        self.assertTrue(selected["child_physical_shot_id"])
        self.assertTrue(selected["hard_visual_fallback"])
        segment = voah.clip_segment_from_parent_story_unit(candidate, section, selected, 1.5)
        self.assertTrue(segment["requires_visual_review"])

    def test_parent_story_unit_clip_starts_from_first_matching_child_for_long_fill(self):
        section = proof_section()
        candidate = parent_candidate(
            [
                child("p00", 0.0, 1.2, ["补妆"], "人物用粉扑补妆"),
                child("p01", 1.2, 2.5, ["泼水测试"], "镜头切到脸部和测试区域，开始泼水"),
                child("p02", 2.5, 4.2, ["泼水测试", "纸巾按压"], "继续展示遇水后的妆面状态"),
                child("p03", 4.2, 6.0, ["口播看镜头"], "人物看向镜头讲解"),
            ]
        )

        selected = voah.select_child_physical_shot(candidate, section)
        self.assertEqual(selected["child_physical_shot_id"], "p01")

        segments = voah.candidate_clip_segments(candidate, section, 2.4)

        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["intra_clip_selection_mode"], "story_unit_parent_continuous")
        self.assertEqual(segments[0]["child_physical_shot_id"], "p01")
        self.assertEqual(segments[0]["source_start_offset_s"], 1.2)
        self.assertEqual(segments[0]["source_end_offset_s"], 3.6)
        self.assertFalse(segments[0]["allow_loop"])


if __name__ == "__main__":
    unittest.main()
