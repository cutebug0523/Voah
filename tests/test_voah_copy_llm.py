#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "voah_generate_copy_with_m3.py"
SPEC = importlib.util.spec_from_file_location("voah_generate_copy_with_m3", SCRIPT)
assert SPEC and SPEC.loader
copygen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(copygen)


class CopyLlmThinkingConfigTest(unittest.TestCase):
    def test_deepseek_v4_pro_disables_thinking_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                copygen.copy_llm_thinking_config("deepseek", "deepseek-v4-pro"),
                {"type": "disabled"},
            )

    def test_env_can_enable_or_disable_thinking(self):
        with patch.dict(os.environ, {"VOAH_COPY_LLM_THINKING": "enabled"}, clear=True):
            self.assertEqual(
                copygen.copy_llm_thinking_config("deepseek", "deepseek-v4-pro"),
                {"type": "enabled"},
            )
        with patch.dict(os.environ, {"VOAH_COPY_LLM_THINKING": "false"}, clear=True):
            self.assertEqual(
                copygen.copy_llm_thinking_config("deepseek", "deepseek-chat"),
                {"type": "disabled"},
            )

    def test_other_models_do_not_send_thinking_without_env(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(copygen.copy_llm_thinking_config("deepseek", "deepseek-chat"))

    def test_duplicate_sentence_warning_reports_same_sentence(self):
        warnings = copygen.duplicate_sentence_warnings("妆面真的很服帖。妆面真的很服帖。直接看同款。")

        self.assertEqual(warnings, ["同条口播存在重复句：妆面真的很服帖"])

    def test_rebalance_short_script_does_not_insert_fixed_sentences(self):
        sections = [
            {
                "section_id": "sec_opening",
                "role": "opening",
                "voice_text": "轻拍上脸很自然。",
                "tts_text": "轻拍上脸很自然。",
            }
        ]

        output, warnings = copygen.rebalance_short_script(sections, 60)

        self.assertEqual(output, sections)
        joined = "".join(item["voice_text"] for item in output)
        self.assertNotIn("尤其是早八通勤或者临时补妆", joined)
        self.assertNotIn("不用反复叠很多层", joined)
        self.assertTrue(any("fixed sentence padding disabled" in item for item in warnings))

    def test_creative_angle_varies_by_variant(self):
        first = copygen.creative_angle_for_variant("v1")
        second = copygen.creative_angle_for_variant("v2")

        self.assertNotEqual(first["angle_id"], second["angle_id"])
        self.assertIn("同批不同 variant", first["batch_diversity_rule"])


if __name__ == "__main__":
    unittest.main()
