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


if __name__ == "__main__":
    unittest.main()
