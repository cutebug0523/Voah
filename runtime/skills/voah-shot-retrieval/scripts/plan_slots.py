#!/usr/bin/env python3
"""Build a rough slot-based shot plan from a local Voah shot index."""

import argparse
import json
import sys
from pathlib import Path

from search import embed_query, load_env, load_json, parse_weights, product_matches, search_ranked, write_json


DEFAULT_SLOTS = [
    {
        "slot_id": "opening",
        "label": "开头",
        "role": "opening",
        "count": 1,
        "target_duration": 2.0,
        "query": "开头强视觉，产品或妆效快速进入，能制造防晒焦虑、效果对比或注意力冲击",
    },
    {
        "slot_id": "product",
        "label": "产品介绍",
        "role": "product",
        "count": 2,
        "target_duration": 2.0,
        "query": "产品质地展示，上脸前后对比，遮瑕提亮，自然妆效，适合说明产品是什么",
    },
    {
        "slot_id": "proof",
        "label": "卖点证明",
        "role": "proof",
        "count": 2,
        "target_duration": 2.0,
        "query": "防水防汗，防晒遮瑕卖点证明，最好看到测试、对比、喷雾、水珠或实测动作",
    },
    {
        "slot_id": "cta",
        "label": "转化收口",
        "role": "cta",
        "count": 1,
        "target_duration": 2.0,
        "query": "福利礼盒，明星代言，直播间促销转化，适合结尾CTA引导下单",
    },
]


def load_slots(path: str) -> list:
    if not path:
        return DEFAULT_SLOTS
    data = load_json(Path(path).expanduser().resolve())
    if not isinstance(data, list):
        raise ValueError("slots file must be a JSON list")
    return data


def validate_product_pool(index: dict, product: str, allow_cross_product: bool) -> int:
    return sum(1 for record in index.get("records", []) if product_matches(record, product, allow_cross_product))


def as_text(value) -> str:
    if value in (None, "", []):
        return ""
    if isinstance(value, list):
        return " ".join(str(item) for item in value if item not in (None, ""))
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def candidate_blob(item: dict) -> str:
    parts = [
        item.get("label", ""),
        item.get("visual_summary", ""),
        item.get("source_meaning", ""),
        as_text(item.get("source_asr", "")),
        as_text(item.get("source_ocr", "")),
        as_text(item.get("selling_points", [])),
        item.get("shot_type", ""),
    ]
    return " ".join(part for part in parts if part)


def list_value(value) -> list:
    if value in (None, "", []):
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item)]
    return [str(value)]


def passes_slot_filters(item: dict, slot: dict) -> bool:
    blob = candidate_blob(item)
    must_include_any = list_value(slot.get("must_include_any"))
    exclude_any = list_value(slot.get("exclude_any"))
    min_score = slot.get("min_score")

    if min_score not in (None, "") and float(item.get("score") or 0) < float(min_score):
        return False
    if must_include_any and not any(term in blob for term in must_include_any):
        return False
    if exclude_any and any(term in blob for term in exclude_any):
        return False
    return True


def pick_for_slot(
    candidates: list,
    count: int,
    used_parent_ids: set,
    asset_counts: dict,
    max_per_asset: int,
    allow_repeat_parent: bool,
    relax_parent_fallback: bool,
) -> tuple:
    selected = []
    selected_ids = set()

    def can_pick(item, enforce_parent=True, enforce_asset=True):
        shot_id = item.get("shot_id")
        parent_id = item.get("parent_shot_id") or item.get("semantic_shot_id") or shot_id
        asset_id = item.get("asset_id", "")
        if shot_id in selected_ids:
            return False
        if enforce_parent and not allow_repeat_parent and parent_id in used_parent_ids:
            return False
        if enforce_asset and max_per_asset > 0 and asset_id and asset_counts.get(asset_id, 0) >= max_per_asset:
            return False
        return True

    def add(item):
        shot_id = item.get("shot_id")
        parent_id = item.get("parent_shot_id") or item.get("semantic_shot_id") or shot_id
        asset_id = item.get("asset_id", "")
        selected.append(item)
        selected_ids.add(shot_id)
        if parent_id:
            used_parent_ids.add(parent_id)
        if asset_id:
            asset_counts[asset_id] = asset_counts.get(asset_id, 0) + 1

    for item in candidates:
        if len(selected) >= count:
            break
        if can_pick(item):
            add(item)

    if len(selected) < count and max_per_asset > 0:
        for item in candidates:
            if len(selected) >= count:
                break
            if can_pick(item, enforce_asset=False):
                add(item)

    if len(selected) < count and not allow_repeat_parent and relax_parent_fallback:
        for item in candidates:
            if len(selected) >= count:
                break
            if can_pick(item, enforce_parent=False, enforce_asset=False):
                add(item)

    alternates = [item for item in candidates if item.get("shot_id") not in selected_ids][:3]
    return selected, alternates


def add_slot_fields(candidate: dict, slot: dict, timeline_order: int) -> dict:
    item = dict(candidate)
    item["timeline_order"] = timeline_order
    item["slot_id"] = slot.get("slot_id", slot.get("role", ""))
    item["slot_label"] = slot.get("label", "")
    item["slot_role"] = slot.get("role", "")
    return item


def build_plan(
    index: dict,
    product: str,
    slots: list,
    pool_k: int,
    max_per_asset: int,
    allow_cross_product: bool,
    allow_repeat_parent: bool,
    relax_parent_fallback: bool,
) -> dict:
    used_parent_ids = set()
    asset_counts = {}
    selected_timeline = []
    slot_outputs = []
    order = 1

    for slot in slots:
        role = slot.get("role", "")
        query = slot.get("query", "")
        count = int(slot.get("count", 1) or 1)
        target_duration = float(slot.get("target_duration", 0) or 0)
        weights = parse_weights(slot.get("weights", ""), role)
        query_vector = embed_query(query)
        candidates = search_ranked(
            index=index,
            query=query,
            query_vector=query_vector,
            product=product,
            role=role,
            top_k=pool_k,
            weights=weights,
            target_duration=target_duration,
            allow_cross_product=allow_cross_product,
            dedupe_parent=True,
            max_per_parent=1,
            max_per_asset=0,
            pool_k=0,
        )
        candidates_before_filter = len(candidates)
        candidates = [item for item in candidates if passes_slot_filters(item, slot)]
        selected, alternates = pick_for_slot(
            candidates=candidates,
            count=count,
            used_parent_ids=used_parent_ids,
            asset_counts=asset_counts,
            max_per_asset=max_per_asset,
            allow_repeat_parent=allow_repeat_parent,
            relax_parent_fallback=relax_parent_fallback,
        )
        selected_with_slot = []
        for item in selected:
            enriched = add_slot_fields(item, slot, order)
            selected_with_slot.append(enriched)
            selected_timeline.append(enriched)
            order += 1

        slot_outputs.append(
            {
                "slot_id": slot.get("slot_id", role),
                "label": slot.get("label", ""),
                "role": role,
                "query": query,
                "target_duration": target_duration,
                "requested_count": count,
                "candidate_pool_before_filter": candidates_before_filter,
                "candidate_pool_count": len(candidates),
                "filters": {
                    "min_score": slot.get("min_score"),
                    "must_include_any": list_value(slot.get("must_include_any")),
                    "exclude_any": list_value(slot.get("exclude_any")),
                },
                "selected": selected_with_slot,
                "alternates": [add_slot_fields(item, slot, 0) for item in alternates],
            }
        )

    parent_ids = [item.get("parent_shot_id") or item.get("semantic_shot_id") or item.get("shot_id") for item in selected_timeline]
    repeated_parents = sorted({pid for pid in parent_ids if pid and parent_ids.count(pid) > 1})
    role_order = [item.get("slot_role", "") for item in selected_timeline]
    cta_positions = [idx for idx, role in enumerate(role_order) if role == "cta"]
    product_positions = [idx for idx, role in enumerate(role_order) if role == "product"]
    cta_after_product = not cta_positions or (product_positions and min(cta_positions) > min(product_positions))

    return {
        "schema_version": "1.0.0",
        "strategy": {
            "mode": "slot_plan",
            "fixed_slot_order": [slot.get("slot_id", slot.get("role", "")) for slot in slots],
            "product_filter": product,
            "allow_cross_product": allow_cross_product,
            "allow_repeat_parent": allow_repeat_parent,
            "relax_parent_fallback": relax_parent_fallback,
            "max_per_asset": max_per_asset,
            "notes": "这是粗时间线候选，不是最终剪辑；后续可交给 LLM 改文案和时间线。",
        },
        "slots": slot_outputs,
        "selected_timeline": selected_timeline,
        "qa": {
            "product_pool_count": validate_product_pool(index, product, allow_cross_product),
            "selected_count": len(selected_timeline),
            "repeated_parent_ids": repeated_parents,
            "cta_after_product": bool(cta_after_product),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", required=True, help="shot_index.json")
    parser.add_argument("--product", default="", help="metadata product filter")
    parser.add_argument("--slots-file", default="", help="optional JSON slot config")
    parser.add_argument("--pool-k", type=int, default=12, help="per-slot candidate pool size")
    parser.add_argument("--max-per-asset", type=int, default=2)
    parser.add_argument("--allow-cross-product", action="store_true")
    parser.add_argument("--allow-repeat-parent", action="store_true")
    parser.add_argument("--strict-parent-dedupe", action="store_true", help="do not relax parent dedupe when a slot underfills")
    parser.add_argument("--output", help="slot_plan.json")
    args = parser.parse_args()

    if not load_env():
        return 1

    index_path = Path(args.index).expanduser().resolve()
    index = load_json(index_path)
    slots = load_slots(args.slots_file)
    plan = build_plan(
        index=index,
        product=args.product,
        slots=slots,
        pool_k=args.pool_k,
        max_per_asset=args.max_per_asset,
        allow_cross_product=args.allow_cross_product,
        allow_repeat_parent=args.allow_repeat_parent,
        relax_parent_fallback=not args.strict_parent_dedupe,
    )
    plan["source_index"] = str(index_path)

    output = Path(args.output).expanduser().resolve() if args.output else index_path.parent / "slot_plan.json"
    write_json(output, plan)

    print(f"Slot plan written: {output}")
    print(f"Selected: {plan['qa']['selected_count']}")
    for item in plan["selected_timeline"]:
        print(f"  {item['timeline_order']}. {item['slot_id']} {item['shot_id']} score={item['score']} {item['label']}")
    if plan["qa"]["repeated_parent_ids"]:
        print(f"Repeated parents: {len(plan['qa']['repeated_parent_ids'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
