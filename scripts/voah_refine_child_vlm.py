#!/usr/bin/env python3
"""Refine physical child-shot metadata with Omni before vectorization."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib import error, request


DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen3.5-omni-plus"
DEFAULT_ENV_PATH = Path.home() / ".voah" / "video_intake" / ".env"


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def load_env(required: bool = True) -> bool:
    if os.environ.get("DASHSCOPE_API_KEY", "").strip():
        return True
    if DEFAULT_ENV_PATH.exists():
        for line in DEFAULT_ENV_PATH.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("DASHSCOPE_API_KEY="):
                os.environ["DASHSCOPE_API_KEY"] = line.split("=", 1)[1].strip()
                return bool(os.environ["DASHSCOPE_API_KEY"])
    if required:
        print("DASHSCOPE_API_KEY not found. Run scripts/save_dashscope_key.py first.", file=sys.stderr)
    return False


def first(record: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return default


def as_list(value: Any) -> list[str]:
    if value in (None, "", []):
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [str(value).strip()]


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def safe_id(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z_.-]+", "_", str(value or "")).strip("_") or "child"


def normalize_rows(data: Any) -> tuple[list[dict[str, Any]], str | None]:
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)], None
    if isinstance(data, dict):
        for key in ("physical_shots", "shots", "records"):
            value = data.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)], key
    raise ValueError("physical shots input must be a JSON list or object with physical_shots/shots/records")


def restore_rows(original: Any, key: str | None, rows: list[dict[str, Any]]) -> Any:
    if key is None:
        return rows
    output = dict(original)
    output[key] = rows
    return output


def shot_id_of(row: dict[str, Any]) -> str:
    return str(first(row, "shot_id", "id", default=""))


def needs_refine(row: dict[str, Any], only_needs_vlm_refine: bool) -> bool:
    if not only_needs_vlm_refine:
        return True
    return as_bool(first(row, "needs_vlm_refine", default=False))


def valid_oss_url(value: str) -> bool:
    return isinstance(value, str) and value.strip().startswith("oss://") and "\n" not in value and "\r" not in value


def parse_sse_line(line: bytes) -> dict[str, Any] | None:
    text = line.decode("utf-8", errors="replace").strip()
    if not text or text.startswith(":") or not text.startswith("data:"):
        return None
    payload = text[len("data:") :].strip()
    if payload == "[DONE]":
        return {"done": True}
    return json.loads(payload)


def extract_json_text(text: str) -> dict[str, Any]:
    cleaned = str(text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned.strip(), flags=re.I).strip()
        cleaned = re.sub(r"```$", "", cleaned.strip()).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise


def build_prompt(row: dict[str, Any]) -> str:
    parent_context = {
        "product": first(row, "product", default={}),
        "parent_shot_id": first(row, "parent_shot_id", "story_unit_id", "semantic_shot_id", default=""),
        "child_shot_id": shot_id_of(row),
        "time_range": first(row, "time_range", default=[row.get("start_s"), row.get("end_s")]),
        "parent_visual_summary": first(row, "parent_visual_summary", default=""),
        "parent_source_meaning": first(row, "parent_source_meaning", default=""),
        "parent_visual_actions": as_list(first(row, "parent_visual_actions", default=[])),
        "parent_selling_points": as_list(first(row, "parent_selling_points", default=[])),
    }
    return f"""你正在为 Voah 短视频混剪素材库做 child 级画面理解。

这是从 story unit 里切出来的一个短 child clip。你必须只描述这个 child clip 里实际看见的画面、动作、字幕和声音，不要根据父级上下文、前后镜头或产品常识脑补。

父级上下文只用于避免命名混乱，不得把父级未出现在本 clip 的动作写进 child 字段：
{json.dumps(parent_context, ensure_ascii=False)}

请输出严格 JSON，不要 Markdown，不要解释：
{{
  "visual_summary": "只写本 child clip 实际画面，包含人物/场景/产品/镜头景别/关键动作",
  "visual_actions": ["只列本 clip 实际发生的动作，不能继承父级动作"],
  "source_meaning": "本 clip 原本表达的内容；无明确语义则写画面可支持的用途",
  "source_asr": "本 clip 可听见的人声口播；没有则空字符串",
  "source_ocr": ["本 clip 屏幕文字/硬字幕；没有则空数组"],
  "selling_points": ["本 clip 能支撑的产品卖点；没有则空数组"],
  "shot_type": "face_apply|product_closeup|proof_test|outdoor_scene|packaging|cta|transition|other",
  "hard_subtitle_risk": "none|low|medium|high",
  "voiceover_fit": "excellent|good|fair|poor",
  "can_standalone": true
}}"""


def call_omni(
    oss_url: str,
    prompt: str,
    output_dir: Path,
    model: str,
    base_url: str,
    timeout_s: int,
    max_attempts: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("DASHSCOPE_API_KEY missing")
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "video_url", "video_url": {"url": oss_url}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "modalities": ["text"],
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": 0.1,
        "top_p": 0.8,
    }
    write_json(
        output_dir / "request.safe.json",
        {
            "created_at": iso_now(),
            "model": model,
            "base_url": base_url,
            "prompt": prompt,
            "headers": {"X-DashScope-OssResourceResolve": "enable"},
            "body_without_video_payload": {
                **body,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "video_url", "video_url": {"url": "<oss://redacted>"}},
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
            },
        },
    )

    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        raw_events: list[dict[str, Any]] = []
        content_parts: list[str] = []
        usage: dict[str, Any] | None = None
        req = request.Request(
            f"{base_url.rstrip('/')}/chat/completions",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "X-DashScope-OssResourceResolve": "enable",
            },
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=timeout_s) as response:
                for line in response:
                    event = parse_sse_line(line)
                    if not event:
                        continue
                    raw_events.append(event)
                    if event.get("error"):
                        raise RuntimeError(json.dumps(event.get("error"), ensure_ascii=False))
                    if event.get("done"):
                        break
                    if event.get("usage"):
                        usage = event["usage"]
                    for choice in event.get("choices", []) or []:
                        delta = choice.get("delta") or {}
                        text = delta.get("content")
                        if text:
                            content_parts.append(text)
            raw_text = "".join(content_parts)
            write_text(output_dir / "raw_response.txt", raw_text)
            write_text(
                output_dir / "events.jsonl",
                "\n".join(json.dumps(event, ensure_ascii=False) for event in raw_events) + "\n",
            )
            if usage:
                write_json(output_dir / "usage.json", usage)
            parsed = extract_json_text(raw_text)
            return parsed, {"usage": usage or {}, "raw_text_len": len(raw_text), "attempt": attempt}
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            write_text(output_dir / f"error_attempt_{attempt}.txt", detail)
            last_error = RuntimeError(f"HTTP {exc.code}: {detail[:800]}")
        except Exception as exc:  # noqa: BLE001
            write_text(output_dir / f"error_attempt_{attempt}.txt", str(exc))
            last_error = exc
        if attempt < max_attempts:
            time.sleep(2 * attempt)
    raise RuntimeError(str(last_error or "unknown Omni error"))


def normalized_refine_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "visual_summary": str(payload.get("visual_summary") or "").strip(),
        "visual_actions": as_list(payload.get("visual_actions")),
        "source_meaning": str(payload.get("source_meaning") or "").strip(),
        "source_asr": str(payload.get("source_asr") or "").strip(),
        "source_ocr": as_list(payload.get("source_ocr")),
        "selling_points": as_list(payload.get("selling_points")),
        "shot_type": str(payload.get("shot_type") or "other").strip() or "other",
        "hard_subtitle_risk": str(payload.get("hard_subtitle_risk") or "unknown").strip() or "unknown",
        "voiceover_fit": str(payload.get("voiceover_fit") or "good").strip() or "good",
        "can_standalone": as_bool(payload.get("can_standalone")),
    }


def apply_refine(row: dict[str, Any], payload: dict[str, Any], model: str) -> dict[str, Any]:
    refined = normalized_refine_payload(payload)
    updated = dict(row)
    updated.update(refined)
    updated["needs_vlm_refine"] = False
    updated["child_metadata_precision"] = "child_vlm_refined"
    updated["metadata_source"] = "child_vlm_refined"
    updated["text_embedding_policy"] = "allow_child_text_channels"
    updated["child_vlm_refined_at"] = iso_now()
    updated["child_vlm_model"] = model
    return updated


def refine_one(
    row: dict[str, Any],
    output_root: Path,
    model: str,
    base_url: str,
    timeout_s: int,
    max_attempts: int,
) -> tuple[str, dict[str, Any] | None, dict[str, Any]]:
    shot_id = shot_id_of(row)
    output_dir = output_root / safe_id(shot_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    oss_url = str(first(row, "trimmed_oss_url", default="")).strip()
    if not valid_oss_url(oss_url):
        return shot_id, None, {
            "shot_id": shot_id,
            "status": "error",
            "error": "missing or invalid trimmed_oss_url",
            "needs_vlm_refine": True,
        }
    prompt = build_prompt(row)
    started = time.time()
    try:
        payload, meta = call_omni(
            oss_url=oss_url,
            prompt=prompt,
            output_dir=output_dir,
            model=model,
            base_url=base_url,
            timeout_s=timeout_s,
            max_attempts=max_attempts,
        )
        refined = apply_refine(row, payload, model)
        write_json(output_dir / "parsed.json", payload)
        return shot_id, refined, {
            "shot_id": shot_id,
            "status": "ok",
            "elapsed_s": round(time.time() - started, 3),
            "usage": meta.get("usage") or {},
            "visual_actions": refined.get("visual_actions", []),
            "visual_summary": refined.get("visual_summary", ""),
            "child_metadata_precision": "child_vlm_refined",
            "text_embedding_policy": "allow_child_text_channels",
            "needs_vlm_refine": False,
        }
    except Exception as exc:  # noqa: BLE001
        return shot_id, None, {
            "shot_id": shot_id,
            "status": "error",
            "elapsed_s": round(time.time() - started, 3),
            "error": str(exc),
            "needs_vlm_refine": True,
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refine child physical shot metadata with Qwen Omni.")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--inputs", required=True, help="physical_shots.json")
    parser.add_argument("--output", required=True, help="updated physical_shots.json")
    parser.add_argument("--results", default="", help="child_vlm_refine_results.json")
    parser.add_argument("--only-needs-vlm-refine", action="store_true")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--timeout-s", type=int, default=600)
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args(argv)

    if not load_env(required=True):
        return 1

    run_dir = Path(args.run_dir).expanduser().resolve()
    input_path = Path(args.inputs).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    results_path = Path(args.results).expanduser().resolve() if args.results else run_dir / "child_vlm_refine_results.json"
    output_root = run_dir / "child_vlm_refine"

    original = load_json(input_path)
    rows, container_key = normalize_rows(original)
    targets = [
        (index, row)
        for index, row in enumerate(rows)
        if needs_refine(row, args.only_needs_vlm_refine)
    ]
    if args.limit and args.limit > 0:
        targets = targets[: args.limit]

    updated_by_index: dict[int, dict[str, Any]] = {}
    results: list[dict[str, Any]] = []
    started = time.time()

    print(f"Refining child VLM metadata: {len(targets)} targets", flush=True)
    if targets:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            future_map = {
                executor.submit(
                    refine_one,
                    row,
                    output_root,
                    args.model,
                    args.base_url,
                    args.timeout_s,
                    args.max_attempts,
                ): index
                for index, row in targets
            }
            for future in concurrent.futures.as_completed(future_map):
                index = future_map[future]
                shot_id, refined, result = future.result()
                results.append(result)
                if refined is not None:
                    updated_by_index[index] = refined
                print(f"  {result.get('status')}: {shot_id}", flush=True)

    for index, updated in updated_by_index.items():
        rows[index] = updated

    remaining_needs_refine = sum(1 for row in rows if as_bool(first(row, "needs_vlm_refine", default=False)))
    ok_count = sum(1 for item in results if item.get("status") == "ok")
    error_count = sum(1 for item in results if item.get("status") != "ok")
    results.sort(key=lambda item: str(item.get("shot_id") or ""))
    summary = {
        "schema_version": "1.0.0",
        "stage": "voah_child_vlm_refine",
        "created_at": iso_now(),
        "model": args.model,
        "base_url": args.base_url,
        "inputs": {
            "physical_shots": str(input_path),
            "only_needs_vlm_refine": args.only_needs_vlm_refine,
            "limit": args.limit,
        },
        "outputs": {
            "physical_shots": str(output_path),
            "child_vlm_refine_dir": str(output_root),
        },
        "summary": {
            "total_physical_shots": len(rows),
            "target_count": len(targets),
            "refined_count": ok_count,
            "failed_count": error_count,
            "remaining_needs_vlm_refine": remaining_needs_refine,
            "elapsed_s": round(time.time() - started, 3),
        },
        "results": results,
        "qa": {
            "status": "ok" if error_count == 0 and remaining_needs_refine == 0 else "manual_review",
            "warnings": [
                warning
                for warning in [
                    f"{error_count} child VLM refine calls failed" if error_count else "",
                    f"{remaining_needs_refine} physical shots still need VLM refine" if remaining_needs_refine else "",
                ]
                if warning
            ],
        },
    }

    write_json(output_path, restore_rows(original, container_key, rows))
    write_json(results_path, summary)
    print(json.dumps(summary["summary"], ensure_ascii=False), flush=True)

    if (error_count or remaining_needs_refine) and not args.allow_partial:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
