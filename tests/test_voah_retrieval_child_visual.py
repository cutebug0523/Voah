#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import tempfile
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


def opening_section(duration: float = 6.0) -> dict:
    return {
        "section_id": "s_opening",
        "role": "opening",
        "voice_text": "通勤补妆想要自然气色，轻拍几下就干净。",
        "required_visual": "粉扑轻拍上脸",
        "required_meaning": "展示补妆后气色自然",
        "audio_duration_s": duration,
        "keywords": ["粉扑", "轻拍", "上脸"],
    }


def opening_candidate(unit_id: str, child_id: str, score: float = 0.8, asset_id: str | None = None) -> dict:
    return {
        "shot_id": unit_id,
        "story_unit_id": unit_id,
        "asset_id": asset_id or f"asset_{unit_id}",
        "time_range": [0.0, 6.0],
        "usable_range": [0.0, 6.0],
        "duration_s": 6.0,
        "trimmed_clip_path": f"/tmp/{unit_id}.mp4",
        "visual_summary": "人物拿粉扑轻拍上脸，妆面自然有气色。",
        "source_meaning": "展示气垫补妆和上脸效果",
        "visual_actions": ["粉扑", "轻拍", "上脸"],
        "child_physical_shots": [
            child(child_id, 0.0, 3.0, ["粉扑", "轻拍", "上脸"], "粉扑轻拍脸颊，上脸自然"),
        ],
        "score": score,
        "adjusted_score": score,
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

    def test_long_child_offsets_to_internal_late_proof_action(self):
        section = {
            **proof_section(),
            "audio_duration_s": 2.0,
            "voice_text": "做个倒水测试，水流过后妆面服帖。",
            "required_visual": "倒水测试",
            "keywords": ["倒水测试", "水流"],
        }
        candidate = parent_candidate(
            [
                child(
                    "p00",
                    0.0,
                    4.5,
                    [],
                    "先涂抹脸颊，再展示妆面，最后拿粉色杯子向脸上倒水并轻拍确认",
                ),
            ]
        )

        selected = voah.select_child_physical_shot(candidate, section)
        self.assertEqual(selected["child_physical_shot_id"], "p00")
        self.assertGreater(selected["child_internal_start_offset_s"], 1.0)
        segment = voah.clip_segment_from_parent_story_unit(candidate, section, selected, 2.0)
        self.assertGreater(segment["source_start_offset_s"], 1.0)
        self.assertEqual(segment["source_offset_strategy"], "child_action_anchor")

    def test_short_child_keeps_start_offset_for_proof_action(self):
        section = proof_section()
        candidate = parent_candidate(
            [
                child("p00", 0.0, 1.8, ["泼水测试"], "一开始就泼水测试"),
            ]
        )

        selected = voah.select_child_physical_shot(candidate, section)

        self.assertEqual(selected["source_start_offset_s"], 0.0)
        self.assertEqual(selected["source_offset_strategy"], "child_start")

    def test_opening_batch_state_penalizes_reused_first_unit(self):
        section = opening_section()
        reused = opening_candidate("unit_reused", "unit_reused_p00", score=0.95, asset_id="asset_a")
        fresh = opening_candidate("unit_fresh", "unit_fresh_p00", score=0.86, asset_id="asset_b")
        diversity_state = {
            "opening_story_unit_counts": {"unit_reused": 2},
            "opening_asset_counts": {"asset_a": 2},
            "story_unit_counts": {},
            "asset_counts": {},
        }

        adjusted_reused = voah.adjusted_candidate(reused, section, {}, diversity_state)
        adjusted_fresh = voah.adjusted_candidate(fresh, section, {}, diversity_state)

        self.assertLess(adjusted_reused["adjusted_score"], adjusted_fresh["adjusted_score"])
        self.assertIn("opening_story_unit", adjusted_reused["batch_usage_counts"])
        self.assertTrue(any("批次多样性降权" in item for item in adjusted_reused["fill_risks"]))

    def test_opening_ignores_llm_reused_child_when_fresh_child_exists(self):
        section = opening_section()
        candidate = opening_candidate("unit_a", "p00")
        candidate["child_physical_shots"].append(
            child("p01", 3.0, 6.0, ["粉扑", "轻拍", "上脸"], "另一个粉扑轻拍上脸起点")
        )
        candidate["llm_preferred_child_physical_shot_ids"] = ["p00"]
        candidate["batch_opening_child_counts"] = {"p00": 1}

        selected = voah.select_child_physical_shot(candidate, section)

        self.assertEqual(selected["child_physical_shot_id"], "p01")

    def test_allocate_clip_plan_respects_min_clip_duration_and_leaves_short_gap(self):
        section = {
            "section_id": "s_product",
            "role": "product",
            "voice_text": "轻拍补妆，妆面自然。",
            "required_visual": "粉扑轻拍上脸",
            "required_meaning": "展示补妆效果",
            "audio_duration_s": 5.2,
            "keywords": ["粉扑", "轻拍"],
        }
        first = parent_candidate([child("p00", 0.0, 3.0, ["粉扑", "轻拍"], "粉扑轻拍上脸")])
        first.update({"shot_id": "unit_a", "story_unit_id": "unit_a", "asset_id": "asset_a", "duration_s": 3.0, "trimmed_clip_path": ""})
        second = parent_candidate([child("p10", 0.0, 2.2, ["粉扑", "轻拍"], "继续轻拍补妆")])
        second.update({"shot_id": "unit_b", "story_unit_id": "unit_b", "asset_id": "asset_b", "duration_s": 2.2, "trimmed_clip_path": ""})

        plans, selected_duration, missing = voah.allocate_clip_plan([first, second], section, min_clip_duration_s=2.5)

        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]["shot_id"], "unit_a")
        self.assertGreaterEqual(plans[0]["planned_duration_s"], 2.5)
        self.assertAlmostEqual(missing, 2.2, places=3)
        self.assertAlmostEqual(selected_duration, 3.0, places=3)

    def test_reused_unit_summary_and_state_are_recorded_without_double_count_on_rerun(self):
        section = opening_section(duration=3.0)
        clip = {
            "section_id": section["section_id"],
            "role": "opening",
            "selected_clips": [
                {
                    "shot_id": "unit_a",
                    "story_unit_id": "unit_a",
                    "asset_id": "asset_a",
                    "child_physical_shot_id": "child_a",
                    "source_start_offset_s": 0.0,
                    "planned_duration_s": 3.0,
                    "min_clip_duration_s": 2.5,
                }
            ],
        }
        summary = voah.clip_usage_summary([clip])
        state = voah.update_diversity_state_with_selection(
            voah.empty_diversity_state(),
            task_id="task_001",
            task_dir=ROOT,
            selection_sections=[clip],
            usage_summary=summary,
        )
        state = voah.update_diversity_state_with_selection(
            state,
            task_id="task_001",
            task_dir=ROOT,
            selection_sections=[clip],
            usage_summary=summary,
        )

        self.assertEqual(state["opening_story_unit_counts"], {"unit_a": 1})
        self.assertEqual(state["opening_child_counts"], {"child_a": 1})
        self.assertEqual(state["story_unit_counts"], {"unit_a": 1})

    def test_locked_diversity_state_write_creates_summary_file(self):
        clip = {
            "section_id": "s_opening",
            "role": "opening",
            "selected_clips": [
                {
                    "shot_id": "unit_lock",
                    "story_unit_id": "unit_lock",
                    "asset_id": "asset_lock",
                    "child_physical_shot_id": "child_lock",
                    "source_start_offset_s": 0.0,
                    "planned_duration_s": 3.0,
                    "min_clip_duration_s": 2.5,
                }
            ],
        }
        summary = voah.clip_usage_summary([clip])
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "retrieval_diversity_state.json"
            state = voah.locked_update_diversity_state(
                path,
                task_id="task_lock",
                task_dir=ROOT,
                selection_sections=[clip],
                usage_summary=summary,
            )
            state = voah.locked_update_diversity_state(
                path,
                task_id="task_lock",
                task_dir=ROOT,
                selection_sections=[clip],
                usage_summary=summary,
            )

        self.assertEqual(state["task_count"], 1)
        self.assertEqual(state["opening_first_clip_counts"], {"unit_lock|child_lock|0.000": 1})

    def test_scoring_diversity_state_excludes_current_task_previous_run(self):
        current_clip = {
            "section_id": "s_opening",
            "role": "opening",
            "selected_clips": [
                {
                    "shot_id": "unit_current",
                    "story_unit_id": "unit_current",
                    "asset_id": "asset_current",
                    "child_physical_shot_id": "child_current",
                    "source_start_offset_s": 0.0,
                    "planned_duration_s": 3.0,
                    "min_clip_duration_s": 2.5,
                }
            ],
        }
        other_clip = {
            "section_id": "s_opening",
            "role": "opening",
            "selected_clips": [
                {
                    "shot_id": "unit_other",
                    "story_unit_id": "unit_other",
                    "asset_id": "asset_other",
                    "child_physical_shot_id": "child_other",
                    "source_start_offset_s": 0.0,
                    "planned_duration_s": 3.0,
                    "min_clip_duration_s": 2.5,
                }
            ],
        }
        state = voah.empty_diversity_state()
        state = voah.update_diversity_state_with_selection(
            state,
            task_id="task_current",
            task_dir=ROOT,
            selection_sections=[current_clip],
            usage_summary=voah.clip_usage_summary([current_clip]),
        )
        state = voah.update_diversity_state_with_selection(
            state,
            task_id="task_other",
            task_dir=ROOT,
            selection_sections=[other_clip],
            usage_summary=voah.clip_usage_summary([other_clip]),
        )

        scoring_state = voah.diversity_state_without_task(state, "task_current")

        self.assertNotIn("unit_current", scoring_state["opening_story_unit_counts"])
        self.assertEqual(scoring_state["opening_story_unit_counts"], {"unit_other": 1})

    def test_duplicate_child_prefers_canonical_over_duplicate(self):
        section = opening_section(duration=1.5)
        candidate = parent_candidate(
            [
                {
                    **child("dup_child", 0.0, 1.5, ["粉扑", "轻拍", "上脸"], "粉扑轻拍脸颊"),
                    "duplicate_group_id": "dup_001",
                    "duplicate_status": "strong_duplicate",
                    "duplicate_role": "duplicate",
                    "canonical_physical_shot_id": "canonical_child",
                },
                {
                    **child("canonical_child", 1.5, 3.0, ["粉扑", "轻拍", "上脸"], "粉扑轻拍脸颊"),
                    "duplicate_group_id": "dup_001",
                    "duplicate_status": "strong_duplicate",
                    "duplicate_role": "canonical",
                    "canonical_physical_shot_id": "canonical_child",
                },
            ]
        )

        selected = voah.select_child_physical_shot(candidate, section)

        self.assertEqual(selected["child_physical_shot_id"], "canonical_child")
        self.assertEqual(selected["duplicate_group_id"], "dup_001")
        self.assertEqual(selected["duplicate_role"], "canonical")

    def test_llm_preferred_duplicate_child_yields_to_canonical(self):
        section = opening_section(duration=1.5)
        candidate = parent_candidate(
            [
                {
                    **child("dup_child", 0.0, 1.5, ["粉扑", "轻拍", "上脸"], "粉扑轻拍脸颊"),
                    "duplicate_group_id": "dup_001",
                    "duplicate_status": "strong_duplicate",
                    "duplicate_role": "duplicate",
                    "canonical_physical_shot_id": "canonical_child",
                },
                {
                    **child("canonical_child", 1.5, 3.0, ["粉扑", "轻拍", "上脸"], "粉扑轻拍脸颊"),
                    "duplicate_group_id": "dup_001",
                    "duplicate_status": "strong_duplicate",
                    "duplicate_role": "canonical",
                    "canonical_physical_shot_id": "canonical_child",
                },
            ]
        )
        candidate["llm_preferred_child_physical_shot_ids"] = ["dup_child"]

        selected = voah.select_child_physical_shot(candidate, section)

        self.assertEqual(selected["child_physical_shot_id"], "canonical_child")

    def test_duplicate_child_metadata_reaches_timeline_segment(self):
        section = opening_section(duration=1.5)
        candidate = parent_candidate(
            [
                {
                    **child("dup_child", 0.0, 1.5, ["粉扑", "轻拍", "上脸"], "粉扑轻拍脸颊"),
                    "duplicate_group_id": "dup_001",
                    "duplicate_status": "strong_duplicate",
                    "duplicate_role": "duplicate",
                    "canonical_physical_shot_id": "canonical_child",
                }
            ]
        )

        segment = voah.candidate_clip_segments(candidate, section, 1.2)[0]

        self.assertEqual(segment["child_physical_shot_id"], "dup_child")
        self.assertEqual(segment["duplicate_group_id"], "dup_001")
        self.assertEqual(segment["duplicate_role"], "duplicate")
        self.assertTrue(any("重复片段" in item for item in segment["selection_risks"]))


if __name__ == "__main__":
    unittest.main()
