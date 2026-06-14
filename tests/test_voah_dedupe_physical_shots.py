#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "voah_dedupe_physical_shots.py"
SPEC = importlib.util.spec_from_file_location("voah_dedupe", SCRIPT)
assert SPEC and SPEC.loader
dedupe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dedupe)


def record(shot_id: str, asset_id: str, phashes: list[int], dhashes: list[int], duration: float = 1.6) -> dict:
    return {
        "shot_id": shot_id,
        "asset_id": asset_id,
        "duration_s": duration,
        "clip_sha256": f"sha-{shot_id}",
        "phash_values": phashes,
        "dhash_values": dhashes,
        "status": "ok",
    }


class PhysicalShotDedupeTest(unittest.TestCase):
    def test_strong_duplicate_pair_and_group_marks_canonical(self):
        base_p = [0x1111111111111111] * 5
        base_d = [0x2222222222222222] * 5
        records = [
            record("p00", "asset_a", base_p, base_d, 1.2),
            record("p01", "asset_b", base_p, base_d, 2.0),
            record("p02", "asset_c", [0xFFFFFFFFFFFFFFFF] * 5, [0xEEEEEEEEEEEEEEEE] * 5, 1.5),
        ]

        pairs = dedupe.find_duplicate_pairs(records)
        groups = dedupe.build_duplicate_groups(records, pairs)

        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0]["status"], "strong_duplicate")
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["canonical_physical_shot_id"], "p01")
        self.assertEqual(groups[0]["member_count"], 2)

    def test_near_duplicate_candidate_is_not_strong(self):
        left = record("p00", "asset_a", [0] * 5, [0] * 5)
        # Three close frames and two distant frames should be a review candidate.
        right = record(
            "p01",
            "asset_b",
            [0, 0, 0, 0x000000000000FFFF, 0x000000000000FFFF],
            [0, 0, 0, 0x000000000000FFFF, 0x000000000000FFFF],
        )

        pair = dedupe.evaluate_pair(left, right)

        self.assertIsNotNone(pair)
        self.assertEqual(pair["status"], "near_duplicate_candidate")

    def test_annotate_physical_shots_preserves_records_and_marks_duplicates(self):
        shots = [
            {"shot_id": "p00", "duration_s": 1.0},
            {"shot_id": "p01", "duration_s": 2.0},
        ]
        groups = [
            {
                "duplicate_group_id": "dup_001",
                "status": "strong_duplicate",
                "canonical_physical_shot_id": "p01",
                "members": [
                    {"shot_id": "p00", "role": "duplicate"},
                    {"shot_id": "p01", "role": "canonical"},
                ],
            }
        ]

        updated = dedupe.annotate_physical_shots(shots, groups)

        self.assertEqual(updated[0]["duplicate_role"], "duplicate")
        self.assertEqual(updated[0]["canonical_physical_shot_id"], "p01")
        self.assertEqual(updated[1]["duplicate_role"], "canonical")
        self.assertEqual(updated[1]["duplicate_policy"], "prefer_canonical")


if __name__ == "__main__":
    unittest.main()
