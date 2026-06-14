#!/usr/bin/env python3
"""Search a local Voah shot index with multi-channel cosine + rule rerank."""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Tuple

MODEL = "qwen3-vl-embedding"
DIMENSION = 2560

DEFAULT_WEIGHTS = {
    "source_meaning": 1.00,
    "visual_summary": 0.85,
    "tags": 0.75,
    "asr": 0.55,
    "ocr": 0.45,
    "video_chunk": 0.35,
}

ROLE_WEIGHTS = {
    "opening": {
        "visual_summary": 1.00,
        "source_meaning": 0.80,
        "tags": 0.70,
        "video_chunk": 0.65,
        "asr": 0.25,
        "ocr": 0.20,
    },
    "product": {
        "visual_summary": 1.00,
        "source_meaning": 0.95,
        "tags": 0.75,
        "video_chunk": 0.55,
        "asr": 0.35,
        "ocr": 0.30,
    },
    "proof": {
        "source_meaning": 1.00,
        "visual_summary": 0.95,
        "tags": 0.85,
        "video_chunk": 0.45,
        "asr": 0.35,
        "ocr": 0.35,
    },
    "cta": {
        "source_meaning": 0.85,
        "visual_summary": 0.75,
        "tags": 0.80,
        "asr": 0.75,
        "ocr": 0.65,
        "video_chunk": 0.25,
    },
    "transition": {
        "visual_summary": 1.00,
        "video_chunk": 0.80,
        "tags": 0.55,
        "source_meaning": 0.45,
        "asr": 0.15,
        "ocr": 0.15,
    },
}

ROLE_KEYWORDS = {
    "opening": ["开头", "吸引", "对比", "痛点", "效果", "冲击", "展示"],
    "proof": ["证明", "防水", "防汗", "遮瑕", "测试", "对比", "验证"],
    "product": ["产品", "质地", "上脸", "涂抹", "展示", "细节"],
    "cta": ["福利", "促销", "下单", "购买", "优惠", "明星", "代言"],
    "transition": ["过渡", "承接", "动作", "切换"],
}


def load_env(required: bool = True) -> bool:
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if api_key:
        try:
            import dashscope

            dashscope.api_key = api_key
        except Exception:
            pass
        return True
    env_path = os.path.expanduser("~/.voah/video_intake/.env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("DASHSCOPE_API_KEY="):
                    api_key = line.split("=", 1)[1].strip()
                    os.environ["DASHSCOPE_API_KEY"] = api_key
                    try:
                        import dashscope

                        dashscope.api_key = api_key
                    except Exception:
                        pass
                    return True
    if required:
        print("DASHSCOPE_API_KEY not found. Run voah-video-intake/scripts/save_dashscope_key.py first.", file=sys.stderr)
    return False


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def as_text(value) -> str:
    if value in (None, "", []):
        return ""
    if isinstance(value, list):
        return " ".join(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def parse_weights(text: str, role: str = "") -> dict:
    weights = dict(ROLE_WEIGHTS.get(role, DEFAULT_WEIGHTS))
    if not text:
        return weights
    for part in text.split(","):
        if not part.strip() or "=" not in part:
            continue
        key, value = part.split("=", 1)
        try:
            weights[key.strip()] = float(value)
        except ValueError:
            pass
    return weights


def embed_query(text: str, max_attempts: int = 3) -> list:
    from dashscope import MultiModalEmbedding

    last_error = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = MultiModalEmbedding.call(
                model=MODEL,
                dimension=DIMENSION,
                input=[{"text": text, "factor": 1.0}],
            )
            if resp.status_code != 200:
                raise RuntimeError(f"{resp.code}: {resp.message}")
            embeddings = resp.output.get("embeddings", [])
            if len(embeddings) != 1:
                raise RuntimeError(f"query embedding count mismatch: {len(embeddings)}")
            vector = embeddings[0].get("embedding")
            if not isinstance(vector, list) or len(vector) != DIMENSION:
                raise RuntimeError("query embedding dimension mismatch")
            return vector
        except Exception as exc:
            last_error = exc
            if attempt < max_attempts:
                print(f"query embedding retry {attempt}/{max_attempts - 1}: {exc}", flush=True)
                time.sleep(2 * attempt)
    raise RuntimeError(str(last_error))


def dot(a: list, b: list) -> float:
    return sum(x * y for x, y in zip(a, b))


def norm(a: list) -> float:
    return math.sqrt(sum(x * x for x in a))


def cosine(a: list, b: list) -> float:
    if len(a) != len(b):
        return -1.0
    denom = norm(a) * norm(b)
    if denom <= 0:
        return -1.0
    return dot(a, b) / denom


def product_matches(record: dict, product: str, allow_cross_product: bool) -> bool:
    if allow_cross_product or not product:
        return True
    product_meta = record.get("product", {})
    name = product_meta.get("name", "") if isinstance(product_meta, dict) else str(product_meta)
    slug = product_meta.get("slug", "") if isinstance(product_meta, dict) else ""
    return product in name or product in slug or name in product


def text_blob(record: dict) -> str:
    parts = [
        record.get("label", ""),
        record.get("visual_summary", ""),
        record.get("source_meaning", ""),
        as_text(record.get("source_asr", "")),
        as_text(record.get("source_ocr", "")),
        as_text(record.get("selling_points", [])),
        record.get("shot_type", ""),
    ]
    return " ".join(part for part in parts if part)


def role_bonus(record: dict, role: str, query: str, reasons: list) -> float:
    if not role:
        return 0.0
    keywords = ROLE_KEYWORDS.get(role, [])
    blob = text_blob(record) + " " + query
    hits = [kw for kw in keywords if kw and kw in blob]
    if not hits:
        return 0.0
    bonus = min(0.12, 0.035 * len(hits))
    reasons.append(f"角色 {role} 命中: {', '.join(hits[:4])}")
    return bonus


def risk_adjustment(record: dict, reasons: list, risks: list) -> float:
    score = 0.0
    subtitle = record.get("hard_subtitle_risk", "unknown")
    voice = record.get("voiceover_fit", "unknown")

    if subtitle in ("none", "low"):
        score += 0.04
        reasons.append(f"硬字幕风险 {subtitle}")
    elif subtitle in ("medium", "high"):
        penalty = -0.08 if subtitle == "medium" else -0.16
        score += penalty
        risks.append(f"硬字幕风险 {subtitle}")

    if voice in ("excellent", "good"):
        score += 0.05 if voice == "excellent" else 0.03
        reasons.append(f"配音适配 {voice}")
    elif voice in ("fair", "poor"):
        penalty = -0.06 if voice == "fair" else -0.14
        score += penalty
        risks.append(f"配音适配 {voice}")

    return score


def duration_adjustment(record: dict, target_duration: float, reasons: list, risks: list) -> float:
    if target_duration <= 0:
        return 0.0
    duration = float(record.get("duration_s") or 0)
    if duration <= 0:
        risks.append("缺少有效时长")
        return -0.08
    diff = abs(duration - target_duration)
    if diff <= 0.8:
        reasons.append(f"时长接近目标 {target_duration:g}s")
        return 0.06
    if duration > target_duration * 2.2:
        risks.append(f"时长偏长 {duration:g}s")
        return -0.04
    return 0.0


def standalone_adjustment(record: dict, role: str, reasons: list) -> float:
    if record.get("can_standalone") and role in ("opening", "proof", "product"):
        reasons.append("可独立成段")
        return 0.04
    return 0.0


def keyword_adjustment(record: dict, query: str, reasons: list) -> float:
    blob = text_blob(record)
    query_terms = [term for term in query.replace("，", " ").replace(",", " ").split() if len(term) >= 2]
    hits = [term for term in query_terms if term in blob]
    if not hits:
        return 0.0
    reasons.append(f"关键词命中: {', '.join(hits[:4])}")
    return min(0.08, 0.025 * len(hits))


def channel_scores(record: dict, query_vector: list, weights: dict) -> Tuple[float, dict]:
    weighted_sum = 0.0
    weight_sum = 0.0
    scores = {}
    for channel, item in record.get("channels", {}).items():
        vector = item.get("embedding")
        if not isinstance(vector, list):
            continue
        sim = cosine(query_vector, vector)
        weight = weights.get(channel, 0.0)
        scores[channel] = {
            "similarity": round(sim, 6),
            "weight": weight,
            "mode": item.get("mode", ""),
        }
        if weight > 0:
            weighted_sum += sim * weight
            weight_sum += weight
    base = weighted_sum / weight_sum if weight_sum else -1.0
    return base, scores


def select_ranked_items(items: list, top_k: int, pool_k: int, dedupe_parent: bool, max_per_parent: int, max_per_asset: int) -> list:
    pool = items[:pool_k] if pool_k and pool_k > 0 else items
    if not dedupe_parent and max_per_asset <= 0:
        return pool[:top_k]

    selected = []
    selected_ids = set()
    parent_counts = {}
    asset_counts = {}
    parent_limit = max(1, max_per_parent)

    def try_add(item, enforce_parent=True, enforce_asset=True):
        record = item[-1]
        shot_id = record.get("shot_id")
        if shot_id in selected_ids:
            return False

        parent_id = record.get("parent_shot_id") or record.get("semantic_shot_id") or shot_id
        asset_id = record.get("asset_id", "")
        if enforce_parent and dedupe_parent and parent_id and parent_counts.get(parent_id, 0) >= parent_limit:
            return False
        if enforce_asset and max_per_asset > 0 and asset_id and asset_counts.get(asset_id, 0) >= max_per_asset:
            return False

        selected.append(item)
        selected_ids.add(shot_id)
        if parent_id:
            parent_counts[parent_id] = parent_counts.get(parent_id, 0) + 1
        if asset_id:
            asset_counts[asset_id] = asset_counts.get(asset_id, 0) + 1
        return True

    for item in pool:
        if len(selected) >= top_k:
            break
        try_add(item)

    if len(selected) < top_k and max_per_asset > 0:
        for item in pool:
            if len(selected) >= top_k:
                break
            try_add(item, enforce_asset=False)

    if len(selected) < top_k and dedupe_parent:
        for item in pool:
            if len(selected) >= top_k:
                break
            try_add(item, enforce_parent=False, enforce_asset=False)

    return selected


def candidate_from_record(record: dict, rank: int, score: float, base_score: float, scores: dict, role: str, reasons: list, risks: list) -> dict:
    return {
        "rank": rank,
        "shot_id": record.get("shot_id"),
        "parent_shot_id": record.get("parent_shot_id", ""),
        "semantic_shot_id": record.get("semantic_shot_id", ""),
        "is_physical_shot": record.get("is_physical_shot", False),
        "boundary_source": record.get("boundary_source", ""),
        "asset_id": record.get("asset_id"),
        "segment_id": record.get("segment_id", ""),
        "label": record.get("label", ""),
        "product": record.get("product", {}),
        "time_range": record.get("time_range", []),
        "usable_range": record.get("usable_range", []),
        "duration_s": record.get("duration_s"),
        "score": round(score, 6),
        "base_similarity": round(base_score, 6),
        "channel_scores": scores,
        "rerank_reasons": reasons,
        "risks": risks,
        "retrieval_role": role,
        "hard_subtitle_risk": record.get("hard_subtitle_risk"),
        "voiceover_fit": record.get("voiceover_fit"),
        "can_standalone": record.get("can_standalone"),
        "shot_type": record.get("shot_type", ""),
        "selling_points": record.get("selling_points", []),
        "visual_summary": record.get("visual_summary", ""),
        "source_meaning": record.get("source_meaning", ""),
        "source_asr": record.get("source_asr", ""),
        "source_ocr": record.get("source_ocr", []),
        "trimmed_clip_path": record.get("trimmed_clip_path", ""),
        "trimmed_oss_url": record.get("trimmed_oss_url", ""),
        "child_physical_shot_ids": record.get("child_physical_shot_ids", []),
        "child_physical_shots": record.get("child_physical_shots", []),
        "child_clip_paths": record.get("child_clip_paths", []),
    }


def search(index: dict, query: str, query_vector: list, product: str, role: str, top_k: int, weights: dict, target_duration: float, allow_cross_product: bool) -> list:
    return search_ranked(
        index=index,
        query=query,
        query_vector=query_vector,
        product=product,
        role=role,
        top_k=top_k,
        weights=weights,
        target_duration=target_duration,
        allow_cross_product=allow_cross_product,
        dedupe_parent=False,
        max_per_parent=1,
        max_per_asset=0,
        pool_k=0,
    )


def search_ranked(
    index: dict,
    query: str,
    query_vector: list,
    product: str,
    role: str,
    top_k: int,
    weights: dict,
    target_duration: float,
    allow_cross_product: bool,
    dedupe_parent: bool = False,
    max_per_parent: int = 1,
    max_per_asset: int = 0,
    pool_k: int = 0,
) -> list:
    candidates = []
    for record in index.get("records", []):
        if not product_matches(record, product, allow_cross_product):
            continue

        reasons = []
        risks = []
        base_score, scores = channel_scores(record, query_vector, weights)
        if base_score < -0.5:
            continue

        score = base_score
        score += role_bonus(record, role, query, reasons)
        score += risk_adjustment(record, reasons, risks)
        score += duration_adjustment(record, target_duration, reasons, risks)
        score += standalone_adjustment(record, role, reasons)
        score += keyword_adjustment(record, query, reasons)

        candidates.append((score, base_score, scores, reasons, risks, record))

    candidates.sort(key=lambda item: item[0], reverse=True)
    candidates = select_ranked_items(
        items=candidates,
        top_k=top_k,
        pool_k=pool_k,
        dedupe_parent=dedupe_parent,
        max_per_parent=max_per_parent,
        max_per_asset=max_per_asset,
    )
    return [
        candidate_from_record(record, rank, score, base_score, scores, role, reasons, risks)
        for rank, (score, base_score, scores, reasons, risks, record)
        in enumerate(candidates, start=1)
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", required=True, help="shot_index.json")
    parser.add_argument("--query", required=True, help="Chinese retrieval query")
    parser.add_argument("--product", default="", help="metadata product filter")
    parser.add_argument("--role", default="", choices=["", "opening", "proof", "product", "cta", "transition"])
    parser.add_argument("--top-k", type=int, default=12)
    parser.add_argument("--target-duration", type=float, default=0.0)
    parser.add_argument("--allow-cross-product", action="store_true")
    parser.add_argument("--weights", default="", help="channel weights, e.g. source_meaning=1,video_chunk=0.5")
    parser.add_argument("--dedupe-parent", action="store_true", help="prefer one physical shot per parent semantic shot")
    parser.add_argument("--max-per-parent", type=int, default=1)
    parser.add_argument("--max-per-asset", type=int, default=0, help="0 means no asset-level cap")
    parser.add_argument("--pool-k", type=int, default=0, help="candidate pool size before dedupe; 0 means all")
    parser.add_argument("--output", help="candidate_shots.json")
    args = parser.parse_args()

    if not load_env():
        return 1

    index_path = Path(args.index).expanduser().resolve()
    index = load_json(index_path)
    query_vector = embed_query(args.query)
    weights = parse_weights(args.weights, args.role)
    candidates = search_ranked(
        index=index,
        query=args.query,
        query_vector=query_vector,
        product=args.product,
        role=args.role,
        top_k=args.top_k,
        weights=weights,
        target_duration=args.target_duration,
        allow_cross_product=args.allow_cross_product,
        dedupe_parent=args.dedupe_parent,
        max_per_parent=args.max_per_parent,
        max_per_asset=args.max_per_asset,
        pool_k=args.pool_k,
    )

    output = Path(args.output).expanduser().resolve() if args.output else index_path.parent / "candidate_shots.json"
    payload = {
        "schema_version": "1.0.0",
        "query": args.query,
        "product_filter": args.product,
        "role": args.role,
        "top_k": args.top_k,
        "weights": weights,
        "target_duration": args.target_duration,
        "dedupe_parent": args.dedupe_parent,
        "max_per_parent": args.max_per_parent,
        "max_per_asset": args.max_per_asset,
        "pool_k": args.pool_k,
        "source_index": str(index_path),
        "candidate_count": len(candidates),
        "candidates": candidates,
    }
    write_json(output, payload)

    print(f"Candidate shots written: {output}")
    print(f"Candidates: {len(candidates)}")
    for item in candidates[: min(5, len(candidates))]:
        print(f"  #{item['rank']} {item['shot_id']} score={item['score']} {item['label']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
