#!/usr/bin/env python3
"""
参考实现：多通道向量化。

关键要求：
1. video_chunk 使用 {"video": trimmed_oss_url, "factor": 1.0} 做原生视频向量。
2. visual_summary/source_meaning/asr/ocr/tags 使用 {"text": ..., "factor": 1.0}。
3. 每次模型返回的向量数量必须与请求通道数量一致，否则整次失败，禁止错位写入。
4. 兼容两套历史字段：shot_id/id、start_s/start_time、end_s/end_time。
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

MODEL = "qwen3-vl-embedding"
DIMENSION = 2560
VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".avi", ".webm")


def load_env(required: bool = True) -> bool:
    if os.environ.get("DASHSCOPE_API_KEY"):
        set_dashscope_api_key(os.environ["DASHSCOPE_API_KEY"])
        return True

    env_path = os.path.expanduser("~/.voah/video_intake/.env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("DASHSCOPE_API_KEY="):
                    os.environ["DASHSCOPE_API_KEY"] = line.split("=", 1)[1].strip()
                    set_dashscope_api_key(os.environ["DASHSCOPE_API_KEY"])
                    return True

    if required:
        print("DASHSCOPE_API_KEY not found. Run scripts/save_dashscope_key.py first.", file=sys.stderr)
    return False


def set_dashscope_api_key(value: str) -> None:
    if not value:
        return
    try:
        import dashscope
        dashscope.api_key = value
    except Exception:
        return


def load_json(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def first(record: dict, *keys, default=None):
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return default


def as_text(value) -> str:
    if value in (None, "", []):
        return ""
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def as_list(value):
    if value in (None, "", []):
        return []
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    return [str(value)]


def as_float(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def build_upload_map(uploads_file: Optional[str]) -> dict:
    if not uploads_file or not os.path.exists(uploads_file):
        return {}

    uploads = load_json(uploads_file)
    upload_map = {}
    for item in uploads:
        if item.get("status") != "ok":
            continue
        shot_id = first(item, "shot_id", "id")
        oss_url = first(item, "oss_url", "trimmed_oss_url")
        if shot_id and oss_url:
            upload_map[shot_id] = oss_url
    return upload_map


def asset_id_of(asset: dict) -> str:
    return first(asset, "asset_id", "id", default="")


def shot_id_of(shot: dict) -> str:
    return first(shot, "shot_id", "id", default="")


def inherited_child_text_only(shot: dict) -> bool:
    if not bool(first(shot, "is_physical_shot", default=False)):
        return False
    precision = str(first(shot, "child_metadata_precision", "metadata_source", default="")).strip()
    policy = str(first(shot, "text_embedding_policy", default="")).strip()
    if precision in {"child_vlm_refined", "child_verified", "story_unit_exact"}:
        return False
    if policy == "allow_child_text_channels":
        return False
    return (
        bool(first(shot, "needs_vlm_refine", default=False))
        or precision in {"parent_context_only", "parent_story_unit_inherited"}
        or policy == "video_only_until_child_vlm_refine"
    )


def build_inputs_from_shots(
    shots_file: str,
    assets_file: str,
    output_file: str,
    uploads_file: Optional[str] = None,
):
    """从 shots/assets/upload results 生成 vectorization_inputs.json。"""
    shots = load_json(shots_file)
    assets = {asset_id_of(asset): asset for asset in load_json(assets_file)}
    upload_map = build_upload_map(uploads_file)

    inputs = []
    for shot in shots:
        shot_id = shot_id_of(shot)
        if not shot_id:
            raise ValueError(f"shot missing id: {shot}")

        asset_id = first(shot, "asset_id", default="")
        asset = assets.get(asset_id, {})
        asset_summary = first(asset, "omni_summary", "full_video_summary", default={}) or {}
        product = first(shot, "product", default=first(asset, "product", default=""))
        if isinstance(product, dict):
            product = first(product, "name", "slug", default="")

        start = as_float(first(shot, "start_s", "start_time", default=0))
        end = as_float(first(shot, "end_s", "end_time", default=start + as_float(shot.get("duration_s"))))
        usable_start = as_float(first(shot, "usable_start", default=start), start)
        usable_end = as_float(first(shot, "usable_end", default=end), end)

        video_url = first(shot, "trimmed_oss_url", default=upload_map.get(shot_id, ""))
        selling_points = as_list(first(shot, "selling_points", default=[]))
        visual_actions = as_list(first(shot, "visual_actions", default=[]))
        shot_type = first(shot, "shot_type", "shot_type_hint", default="")
        tags_text = "; ".join(
            part for part in [
                f"镜头: {shot_type}" if shot_type else "",
                f"片段: {first(shot, 'label', default='')}" if first(shot, "label", default="") else "",
                f"卖点: {', '.join(selling_points)}" if selling_points else "",
                f"动作: {', '.join(visual_actions)}" if visual_actions else "",
            ]
            if part
        )

        visual_summary = as_text(first(shot, "visual_summary", default=asset_summary.get("visual_summary", "")))
        source_meaning = as_text(first(shot, "source_meaning", default=asset_summary.get("source_meaning", "")))
        source_asr = as_text(first(shot, "source_asr", default=""))
        source_ocr = as_text(first(shot, "source_ocr", default=""))
        text_policy_note = ""
        if inherited_child_text_only(shot):
            visual_summary = ""
            source_meaning = ""
            source_asr = ""
            source_ocr = ""
            tags_text = ""
            text_policy_note = "text channels disabled: child metadata is parent context only"

        channels = {
            "video_chunk": {
                "enabled": True,
                "mode": "video",
                "model": MODEL,
                "dimension": DIMENSION,
                "video_url": video_url,
                "note": "native video embedding from trimmed clip",
            },
            "visual_summary": {
                "enabled": bool(visual_summary),
                "mode": "text",
                "model": MODEL,
                "dimension": DIMENSION,
                "text": visual_summary,
                "note": text_policy_note,
            },
            "source_meaning": {
                "enabled": bool(source_meaning),
                "mode": "text",
                "model": MODEL,
                "dimension": DIMENSION,
                "text": source_meaning,
                "note": text_policy_note,
            },
            "asr": {
                "enabled": bool(source_asr),
                "mode": "text",
                "model": MODEL,
                "dimension": DIMENSION,
                "text": source_asr,
                "note": text_policy_note,
            },
            "ocr": {
                "enabled": bool(source_ocr),
                "mode": "text",
                "model": MODEL,
                "dimension": DIMENSION,
                "text": source_ocr,
                "note": text_policy_note,
            },
            "tags": {
                "enabled": bool(tags_text),
                "mode": "text",
                "model": MODEL,
                "dimension": DIMENSION,
                "text": tags_text,
                "note": text_policy_note,
            },
        }

        inputs.append({
            "shot_id": shot_id,
            "parent_shot_id": first(shot, "parent_shot_id", "semantic_shot_id", default=""),
            "is_physical_shot": bool(first(shot, "is_physical_shot", default=False)),
            "needs_vlm_refine": bool(first(shot, "needs_vlm_refine", default=False)),
            "child_metadata_precision": first(shot, "child_metadata_precision", "metadata_source", default=""),
            "text_embedding_policy": first(shot, "text_embedding_policy", default=""),
            "asset_id": asset_id,
            "product": product,
            "label": first(shot, "label", default=""),
            "time_range": [start, end],
            "usable_range": [usable_start, usable_end],
            "visual_actions": visual_actions,
            "channels": channels,
        })

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(inputs, f, ensure_ascii=False, indent=2)
    print(f"Vectorization inputs written: {output_file} ({len(inputs)} shots)")
    return inputs


def embedding_item(channel_name: str, channel_data: dict) -> dict:
    mode = channel_data.get("mode")
    if mode == "video":
        video_url = channel_data.get("video_url", "")
        if not video_url:
            raise ValueError(f"{channel_name}: missing video_url")
        if not is_valid_oss_video_url(video_url):
            raise ValueError(f"{channel_name}: invalid or truncated oss video_url: {video_url[:120]}")
        return {"video": video_url, "factor": 1.0}

    if mode == "text":
        text = channel_data.get("text", "")
        if not text:
            raise ValueError(f"{channel_name}: missing text")
        return {"text": text, "factor": 1.0}

    raise ValueError(f"{channel_name}: unsupported mode {mode!r}")


def is_valid_oss_video_url(value: str) -> bool:
    if not isinstance(value, str):
        return False
    value = value.strip()
    if "\n" in value or "\r" in value or not value.startswith("oss://"):
        return False
    if len(value) < 80:
        return False
    if not value.lower().endswith(VIDEO_EXTENSIONS):
        return False
    return bool(re.match(r"^oss://\S+$", value))


def call_embedding(items: list[dict], max_attempts: int = 3) -> list[dict]:
    from dashscope import MultiModalEmbedding

    last_error = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = MultiModalEmbedding.call(
                model=MODEL,
                dimension=DIMENSION,
                input=items,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"{resp.code}: {resp.message}")

            embeddings = resp.output.get("embeddings", [])
            if len(embeddings) != len(items):
                raise RuntimeError(f"embedding count mismatch: requested {len(items)}, got {len(embeddings)}")
            return embeddings
        except Exception as exc:
            last_error = exc
            if attempt < max_attempts:
                sleep_s = 2 * attempt
                print(f"  retry {attempt}/{max_attempts - 1} after error: {exc}", flush=True)
                time.sleep(sleep_s)

    raise RuntimeError(str(last_error))


def vectorize_all(inputs_file: str, output_file: str):
    inputs = load_json(inputs_file)
    results = []
    total_channels = 0
    success = 0
    failed = 0

    for shot in inputs:
        shot_id = shot["shot_id"]
        print(f"\n[{shot_id}] Vectorizing...", flush=True)

        requested_items = []
        channel_names = []
        channel_meta = {}
        shot_embeddings = {}

        for ch_name, ch_data in shot.get("channels", {}).items():
            if not ch_data.get("enabled", True):
                continue
            total_channels += 1
            try:
                requested_items.append(embedding_item(ch_name, ch_data))
                channel_names.append(ch_name)
                channel_meta[ch_name] = {"mode": ch_data.get("mode"), "model": MODEL}
            except Exception as exc:
                failed += 1
                shot_embeddings[ch_name] = {
                    "status": "error",
                    "mode": ch_data.get("mode"),
                    "error": str(exc),
                }

        if requested_items:
            try:
                t0 = time.time()
                embeddings = call_embedding(requested_items)
                elapsed = time.time() - t0
                for ch_name, item in zip(channel_names, embeddings):
                    vector = item.get("embedding")
                    if not isinstance(vector, list):
                        raise RuntimeError(f"{ch_name}: embedding missing")
                    if len(vector) != DIMENSION:
                        raise RuntimeError(f"{ch_name}: dimension {len(vector)} != {DIMENSION}")
                    shot_embeddings[ch_name] = {
                        "status": "ok",
                        "mode": channel_meta[ch_name]["mode"],
                        "dim": len(vector),
                        "embedding": vector,
                    }
                    success += 1
                print(f"  {len(embeddings)} channels, {DIMENSION}d ({elapsed:.1f}s)", flush=True)
            except Exception as exc:
                failed += len(channel_names)
                for ch_name in channel_names:
                    shot_embeddings[ch_name] = {
                        "status": "error",
                        "mode": channel_meta[ch_name]["mode"],
                        "error": str(exc),
                    }
                print(f"  ERROR: {exc}", flush=True)

        results.append({
            "shot_id": shot_id,
            "parent_shot_id": shot.get("parent_shot_id", ""),
            "is_physical_shot": bool(shot.get("is_physical_shot", False)),
            "needs_vlm_refine": bool(shot.get("needs_vlm_refine", False)),
            "child_metadata_precision": shot.get("child_metadata_precision", ""),
            "text_embedding_policy": shot.get("text_embedding_policy", ""),
            "asset_id": shot.get("asset_id", ""),
            "product": shot.get("product", ""),
            "time_range": shot.get("time_range", []),
            "usable_range": shot.get("usable_range", []),
            "label": shot.get("label", ""),
            "visual_actions": shot.get("visual_actions", []),
            "embeddings": shot_embeddings,
        })

        time.sleep(0.3)

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False)

    size_mb = Path(output_file).stat().st_size / 1024 / 1024
    print("\n--- Vectorization Complete ---")
    print(f"Shots: {len(results)}")
    print(f"Channels attempted: {total_channels}")
    print(f"Channels succeeded: {success}")
    print(f"Failed: {failed}")
    print(f"Output: {output_file} ({size_mb:.1f} MB)")

    if failed:
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", required=True, help="vectorization_inputs.json")
    parser.add_argument("--output", required=True, help="embedding_results.json")
    parser.add_argument("--build-from-shots", action="store_true",
                        help="Build inputs from shots.json + assets.json")
    parser.add_argument("--build-only", action="store_true",
                        help="Only build vectorization_inputs.json; do not call embedding API")
    parser.add_argument("--shots", help="shots.json (for --build-from-shots)")
    parser.add_argument("--assets", help="assets.json (for --build-from-shots)")
    parser.add_argument("--uploads", help="trim_upload_results.json (optional)")
    args = parser.parse_args()

    if args.build_from_shots:
        if not args.shots or not args.assets:
            print("--build-from-shots requires --shots and --assets", file=sys.stderr)
            sys.exit(1)
        build_inputs_from_shots(args.shots, args.assets, args.inputs, args.uploads)
        if args.build_only:
            return

    if not load_env(required=True):
        sys.exit(1)

    vectorize_all(args.inputs, args.output)


if __name__ == "__main__":
    main()
