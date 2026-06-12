#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, script_name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / script_name)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


refine = load_module("voah_refine_product_context", "voah_refine_product_context.py")
copygen = load_module("voah_generate_copy_with_m3", "voah_generate_copy_with_m3.py")


class ProductCategoryPromptTest(unittest.TestCase):
    def test_refine_prompt_carries_category_and_generic_rule(self):
        prompt = refine.build_prompt(
            {"slug": "demo", "name": "Demo", "brand": "DemoBrand", "category": "代餐奶昔"},
            {"records": [], "raw_claims": [], "raw_campaign_candidates": []},
        )

        self.assertEqual(prompt["product"]["category"], "代餐奶昔")
        self.assertTrue(any("产品品类的核心属性" in rule for rule in prompt["rules"]))

    def test_copy_prompt_carries_category_without_slug_category_guessing(self):
        prompt = copygen.build_prompt(
            {
                "product": {"slug": "fangshai-qidian", "name": "", "brand": "", "category": "代餐奶昔"},
                "product_claims": [{"text": "饱腹方便", "tier": "core", "rank": 1}],
                "task": {"target_platform": "抖音"},
            },
            {"available": False},
            30,
            "unit",
        )

        self.assertEqual(prompt["product"]["category"], "代餐奶昔")
        self.assertEqual(prompt["product"]["generic_name"], "这款代餐奶昔")
        self.assertTrue(any("product.category" in rule and "品类核心属性" in rule for rule in prompt["hard_rules"]))
        self.assertFalse(any("防晒第一" in rule or "口红" in rule for rule in prompt["hard_rules"]))


if __name__ == "__main__":
    unittest.main()
