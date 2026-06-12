#!/usr/bin/env python3
"""Refine product claims and campaigns from intake artifacts with a text LLM."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_env_files(paths: list[Path]) -> None:
    for path in paths:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def as_abs(path: str | Path, base: Path | None = None) -> Path:
    value = Path(path).expanduser()
    if not value.is_absolute() and base is not None:
        value = base / value
    return value.resolve()


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def read_json_safe(path: Path) -> Any:
    try:
        return load_json(path)
    except Exception:
        return None


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def run_command(command: list[str], input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(command, input=input_bytes, check=False, capture_output=True)


def flatten_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("records", "segments", "shots", "assets"):
        if isinstance(payload.get(key), list):
            return [item for item in payload[key] if isinstance(item, dict)]
    return [payload]


def collect_text_values(value: Any, output: list[str]) -> None:
    if isinstance(value, list):
        for item in value:
            collect_text_values(item, output)
        return
    if isinstance(value, dict):
        collect_text_values(value.get("text") or value.get("claim") or value.get("name") or value.get("term") or value.get("title"), output)
        return
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if text:
        output.append(text)


def compact_text(value: Any, limit: int = 220) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def first_nested_text(item: dict[str, Any], field: str) -> str:
    if item.get(field):
        return str(item.get(field) or "")
    for key in ("full_video_summary", "omni_summary"):
        nested = item.get(key)
        if isinstance(nested, dict) and nested.get(field):
            return str(nested.get(field) or "")
    return ""


def record_summary(item: dict[str, Any]) -> dict[str, Any]:
    selling_points: list[str] = []
    collect_text_values(item.get("selling_points"), selling_points)
    collect_text_values(item.get("full_video_summary", {}).get("selling_points") if isinstance(item.get("full_video_summary"), dict) else None, selling_points)
    collect_text_values(item.get("omni_summary", {}).get("selling_points") if isinstance(item.get("omni_summary"), dict) else None, selling_points)
    child_points: list[str] = []
    child_asr: list[str] = []
    child_meaning: list[str] = []
    for child in item.get("child_physical_shots") or []:
        if not isinstance(child, dict):
            continue
        collect_text_values(child.get("selling_points"), child_points)
        if child.get("source_asr"):
            child_asr.append(compact_text(child.get("source_asr"), 120))
        if child.get("source_meaning"):
            child_meaning.append(compact_text(child.get("source_meaning"), 120))
    return {
        "id": item.get("shot_id") or item.get("asset_id") or item.get("id") or "",
        "visual_summary": compact_text(item.get("visual_summary"), 180),
        "source_meaning": compact_text(first_nested_text(item, "source_meaning"), 180),
        "source_asr": compact_text(first_nested_text(item, "source_asr"), 180),
        "selling_points": unique_text([*selling_points, *child_points])[:8],
        "child_meaning": unique_text(child_meaning)[:6],
        "child_asr": unique_text(child_asr)[:6],
    }


def collect_context(run_dir: Path) -> dict[str, Any]:
    payloads = [read_json_safe(run_dir / name) for name in ("shot_index.json", "segments.json", "assets.json", "shots.json")]
    records: list[dict[str, Any]] = []
    for payload in payloads:
        records.extend(flatten_records(payload))
    compact_records = []
    for item in records:
        summary = record_summary(item)
        if any(summary.get(key) for key in ("visual_summary", "source_meaning", "source_asr", "selling_points", "child_meaning", "child_asr")):
            compact_records.append(summary)
        if len(compact_records) >= 80:
            break
    raw_claims: list[str] = []
    raw_campaigns: list[str] = []
    for item in compact_records:
        collect_text_values(item.get("selling_points"), raw_claims)
        for field in [item.get("source_asr"), item.get("source_meaning"), *(item.get("child_asr") or []), *(item.get("child_meaning") or [])]:
            text = str(field or "")
            if re.search(r"(直播间|活动|下单|拍下|赠|礼盒|套装|优惠|福利|券|价格|自用送人)", text):
                raw_campaigns.append(text)
    return {
        "run_dir": str(run_dir),
        "record_count": len(compact_records),
        "raw_claims": unique_text(raw_claims)[:80],
        "raw_campaign_candidates": unique_text(raw_campaigns)[:40],
        "records": compact_records,
    }


def unique_text(items: list[Any]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for item in items:
        text = re.sub(r"\s+", " ", str(item or "")).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        output.append(text)
    return output


def extract_json_object(text: str) -> dict[str, Any]:
    raw = text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?", "", raw).strip()
        raw = re.sub(r"```$", "", raw).strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        parsed = json.loads(raw[start : end + 1])
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("LLM response is not a JSON object")


def call_deepseek(prompt_payload: dict[str, Any], timeout_s: int) -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY not configured")
    base_url = os.environ.get("VOAH_TEXT_LLM_BASE_URL") or "https://api.deepseek.com"
    endpoint = os.environ.get("VOAH_PRODUCT_CONTEXT_LLM_ENDPOINT") or "/chat/completions"
    model = os.environ.get("VOAH_PRODUCT_CONTEXT_LLM_MODEL") or "deepseek-v4-pro"
    url = f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "你是 Voah 的美妆产品卖点整理员。只基于素材证据归纳，不虚构价格、赠品、品牌或功效，输出严格 JSON。",
            },
            {"role": "user", "content": json.dumps(prompt_payload, ensure_ascii=False)},
        ],
        "temperature": float(os.environ.get("VOAH_PRODUCT_CONTEXT_LLM_TEMPERATURE") or 0.25),
        "max_tokens": int(os.environ.get("VOAH_PRODUCT_CONTEXT_LLM_MAX_TOKENS") or 2600),
        "stream": False,
    }
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as header_file:
        header_file.write(f'header = "Authorization: Bearer {api_key}"\n')
        header_file.write('header = "Content-Type: application/json"\n')
        header_file_path = header_file.name
    try:
        proc = run_command(
            [
                "curl",
                "-sS",
                "--connect-timeout",
                "10",
                "--max-time",
                str(timeout_s),
                "--request",
                "POST",
                url,
                "--config",
                header_file_path,
                "--data-binary",
                "@-",
            ],
            input_bytes=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        )
    finally:
        try:
            Path(header_file_path).unlink()
        except OSError:
            pass
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="ignore")
        raise RuntimeError(f"DeepSeek product context curl request failed: {stderr[:800]}")
    raw = json.loads(proc.stdout.decode("utf-8", errors="ignore"))
    if raw.get("error"):
        raise RuntimeError(f"DeepSeek product context failed: {raw.get('error')}")
    choices = raw.get("choices") or []
    if not choices:
        raise RuntimeError("DeepSeek product context response has no choices")
    content = (choices[0].get("message") or {}).get("content") or choices[0].get("text") or ""
    return extract_json_object(content), {
        "provider": "deepseek",
        "model": model,
        "base_url": base_url,
        "endpoint": endpoint,
        "usage": raw.get("usage") or {},
        "finish_reason": choices[0].get("finish_reason"),
        "content_preview": content[:1200],
    }


def build_prompt(product: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    return {
        "task": "把入库素材中的碎片卖点和活动口播整理成产品页初始值。",
        "product": {
            "slug": product.get("slug") or "",
            "name": product.get("name") or "",
            "brand": product.get("brand") or "",
            "category": product.get("category") or "",
        },
        "context": context,
        "rules": [
            "只归纳素材中有证据的卖点，不要编造品牌、价格、赠品、库存、医学功效。",
            "产品品类的核心属性应作为 core 卖点优先；core 不允许语义重复。",
            "核心卖点只能 1-2 条，必须是成片文案必打的主信息；辅助卖点最多 8 条。",
            "活动优惠只整理明确出现的优惠、礼盒、套装、下单引导；没有就返回空数组。",
            "每条卖点要干净、去重、能直接给写稿模型使用，不要写成 ASR 原句碎片。",
            "输出严格 JSON，不要 Markdown。",
        ],
        "output_schema": {
            "claims": [
                {
                    "text": "卖点文本",
                    "tier": "core|support",
                    "rank": 1,
                    "evidence": "证据摘要",
                }
            ],
            "campaigns": [
                {
                    "text": "活动/优惠/CTA 文本",
                    "rank": 1,
                    "evidence": "证据摘要",
                }
            ],
        },
    }


def normalize_claims(raw: Any) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    items = raw if isinstance(raw, list) else []
    for index, item in enumerate(items, start=1):
        text = str(item.get("text") if isinstance(item, dict) else item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        tier = str(item.get("tier") if isinstance(item, dict) else "").strip()
        if tier not in {"core", "support"}:
            tier = "core" if len([claim for claim in output if claim.get("tier") == "core"]) < 2 else "support"
        output.append(
            {
                "text": text,
                "tier": tier,
                "rank": int(item.get("rank") or index) if isinstance(item, dict) else index,
                "evidence": str(item.get("evidence") or "").strip() if isinstance(item, dict) else "",
            }
        )
        if len(output) >= 10:
            break
    output.sort(key=lambda item: (0 if item["tier"] == "core" else 1, item["rank"]))
    for index, item in enumerate(output, start=1):
        item["rank"] = index
    return output


def normalize_campaigns(raw: Any) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    items = raw if isinstance(raw, list) else []
    for index, item in enumerate(items, start=1):
        text = str(item.get("text") if isinstance(item, dict) else item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        output.append(
            {
                "text": text,
                "rank": int(item.get("rank") or index) if isinstance(item, dict) else index,
                "evidence": str(item.get("evidence") or "").strip() if isinstance(item, dict) else "",
            }
        )
        if len(output) >= 8:
            break
    for index, item in enumerate(output, start=1):
        item["rank"] = index
    return output


def fallback_claims(context: dict[str, Any]) -> list[dict[str, Any]]:
    claims = [{"text": text, "tier": "core" if index < 2 else "support", "rank": index + 1, "evidence": "素材字段自动收集"} for index, text in enumerate(context.get("raw_claims") or [])]
    return claims[:10]


def fallback_campaigns(context: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"text": text, "rank": index + 1, "evidence": "素材 ASR/语义字段自动收集"} for index, text in enumerate(context.get("raw_campaign_candidates") or [])][:8]


def main() -> int:
    parser = argparse.ArgumentParser(description="Refine Voah product claims and campaigns with DeepSeek.")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--product-dir", required=True)
    parser.add_argument("--product-slug", default="")
    parser.add_argument("--product-name", default="")
    parser.add_argument("--brand", default="")
    parser.add_argument("--category", default="")
    parser.add_argument("--timeout-s", type=int, default=180)
    parser.add_argument("--allow-fallback", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()

    workspace = Path(__file__).resolve().parents[1]
    load_env_files([workspace / ".env", Path.home() / ".voah" / "video_intake" / ".env", Path.home() / ".voah" / "secrets.env"])

    run_dir = as_abs(args.run_dir)
    product_dir = as_abs(args.product_dir)
    product = read_json_safe(product_dir / "product.json") or {}
    product.update(
        {
            "slug": args.product_slug or product.get("slug") or product_dir.name,
            "name": args.product_name or product.get("name") or "",
            "brand": args.brand or product.get("brand") or "",
            "category": args.category or product.get("category") or "",
        }
    )
    context = collect_context(run_dir)
    prompt = build_prompt(product, context)
    warnings: list[str] = []
    safe_response: dict[str, Any] = {}
    try:
        refined, safe_response = call_deepseek(prompt, args.timeout_s)
        claims = normalize_claims(refined.get("claims"))
        campaigns = normalize_campaigns(refined.get("campaigns"))
    except Exception as error:
        if not args.allow_fallback:
            raise
        warnings.append(f"LLM 提炼失败，使用规则兜底：{str(error)[:500]}")
        claims = fallback_claims(context)
        campaigns = fallback_campaigns(context)
        safe_response = {"provider": "fallback", "error": str(error)[:500]}

    now = iso_now()
    claims_payload = {
        "schema_version": "voah.product_claims.v2",
        "updated_at": now,
        "source": "llm_refined_from_intake" if safe_response.get("provider") != "fallback" else "rules_fallback_from_intake",
        "provider": safe_response,
        "claims": claims,
        "qa": {"status": "warning" if warnings else "ok", "warnings": warnings},
    }
    campaigns_payload = {
        "schema_version": "voah.product_campaigns.v2",
        "updated_at": now,
        "source": claims_payload["source"],
        "provider": safe_response,
        "campaigns": campaigns,
        "qa": claims_payload["qa"],
    }
    write_json(product_dir / "claims.json", claims_payload)
    write_json(product_dir / "campaigns.json", campaigns_payload)
    write_json(product_dir / "product_context_refinement.safe.json", {"created_at": now, "inputs": {"run_dir": str(run_dir)}, "context_summary": {**context, "records": context.get("records", [])[:12]}, "provider": safe_response, "qa": claims_payload["qa"]})
    print(f"claims={product_dir / 'claims.json'}")
    print(f"campaigns={product_dir / 'campaigns.json'}")
    print(f"claim_count={len(claims)} campaign_count={len(campaigns)}")
    print(f"qa={claims_payload['qa']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
