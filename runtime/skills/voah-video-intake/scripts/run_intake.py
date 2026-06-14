#!/usr/bin/env python3
"""Run Voah video intake through story-unit generation.

This runner is intentionally scoped to the inspectable intake layer:

target dir -> ffprobe -> source OSS upload -> Qwen Omni JSON -> normalize
-> story_units.json -> physical_shots.json -> optional local trims.

Vectorization remains a separate explicit step so bad segmentation does not get
embedded again before a human checks the cuts.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib import error, request

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from normalize import normalize  # noqa: E402
from trim_and_upload import load_env, upload_to_dashscope_oss  # noqa: E402

OMNI_MODEL = "qwen3.5-omni-plus"
OMNI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".webm"}
SHOWINFO_TIME_RE = re.compile(r"pts_time:([0-9.]+)")


def slugify_product(name: str) -> str:
    mapping = {
        "防晒": "fangshai",
        "气垫": "qidian",
        "口红": "kouhong",
    }
    slug = name
    for src, dst in mapping.items():
        slug = slug.replace(src, dst)
    slug = re.sub(r"[^A-Za-z0-9]+", "-", slug).strip("-").lower()
    return slug or "product"


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def parse_fps(value: str) -> float:
    if not value:
        return 0.0
    if "/" in str(value):
        num, den = str(value).split("/", 1)
        try:
            den_f = float(den)
            return float(num) / den_f if den_f else 0.0
        except ValueError:
            return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def ffprobe_file(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(result.stdout)
    fmt = data.get("format", {})
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), {})
    duration = float(fmt.get("duration") or video.get("duration") or 0)
    fps_text = video.get("r_frame_rate", "")
    return {
        "local": str(path),
        "local_path": str(path),
        "duration": duration,
        "duration_s": duration,
        "width": video.get("width"),
        "height": video.get("height"),
        "resolution": f"{video.get('width')}x{video.get('height')}" if video else "",
        "fps": fps_text,
        "fps_float": parse_fps(fps_text),
        "vcodec": video.get("codec_name", ""),
        "video_codec": video.get("codec_name", ""),
        "acodec": audio.get("codec_name", ""),
        "audio_codec": audio.get("codec_name", ""),
        "has_audio": bool(audio),
        "size_bytes": int(fmt.get("size") or path.stat().st_size),
        "bit_rate": fmt.get("bit_rate"),
        "rotation": 0,
    }


def ffmpeg_scene_cut_times(video_path: Path, threshold: float, timeout: int = 180) -> list[float]:
    expr = "select='gt(scene,{})',showinfo".format(threshold)
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(video_path),
            "-vf",
            expr,
            "-an",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-1000:])
    return sorted({round(float(m.group(1)), 3) for m in SHOWINFO_TIME_RE.finditer(result.stderr) if float(m.group(1)) > 0.25})


def segments_from_cuts(cuts: list[float], duration_s: float) -> list[dict]:
    bounds = [0.0] + [cut for cut in cuts if 0.0 < cut < duration_s] + [round(duration_s, 3)]
    segments = []
    for idx in range(len(bounds) - 1):
        start = round(bounds[idx], 3)
        end = round(bounds[idx + 1], 3)
        if end - start <= 0.05:
            continue
        segments.append({
            "id": f"S{idx:02d}",
            "index": idx,
            "start_s": start,
            "end_s": end,
            "duration_s": round(end - start, 3),
        })
    return segments


def merge_short_scene_segments(segments: list[dict], min_duration: float) -> list[dict]:
    merged = [dict(seg) for seg in segments]
    changed = True
    while changed and len(merged) > 1:
        changed = False
        for idx, seg in enumerate(list(merged)):
            if float(seg["end_s"]) - float(seg["start_s"]) >= min_duration:
                continue
            if idx == 0:
                merged[1]["start_s"] = seg["start_s"]
                merged[1]["source_segment_ids"] = [seg["id"]] + merged[1].get("source_segment_ids", [merged[1]["id"]])
            elif idx == len(merged) - 1:
                merged[idx - 1]["end_s"] = seg["end_s"]
                merged[idx - 1]["source_segment_ids"] = merged[idx - 1].get("source_segment_ids", [merged[idx - 1]["id"]]) + [seg["id"]]
            else:
                # Directional merge: prefer forward so a clean previous ending is not polluted.
                merged[idx + 1]["start_s"] = seg["start_s"]
                merged[idx + 1]["source_segment_ids"] = [seg["id"]] + merged[idx + 1].get("source_segment_ids", [merged[idx + 1]["id"]])
            merged.pop(idx)
            changed = True
            break

    renumbered = []
    for idx, seg in enumerate(merged):
        start = round(float(seg["start_s"]), 3)
        end = round(float(seg["end_s"]), 3)
        renumbered.append({
            "id": f"S{idx:02d}",
            "index": idx,
            "start_s": start,
            "end_s": end,
            "duration_s": round(end - start, 3),
            "raw_segment_ids": seg.get("source_segment_ids", [seg["id"]]),
        })
    return renumbered


def build_scene_segments(video_path: Path, duration_s: float, threshold: float, min_duration: float) -> tuple[list[dict], list[dict], list[float]]:
    cuts = ffmpeg_scene_cut_times(video_path, threshold)
    raw = segments_from_cuts(cuts, duration_s)
    merged = merge_short_scene_segments(raw, min_duration)
    return raw, merged, cuts


def upload_source_for_omni(path: Path) -> str:
    return upload_to_dashscope_oss(
        str(path),
        model=OMNI_MODEL,
        label=f"omni_source:{path.name}",
        attempts=5,
        certificate_timeout_s=20,
        post_timeout_s=45,
        cli_timeout_s=60,
        cli_attempts=1,
    )


def make_omni_proxy_source(source: Path, output: Path, width: int, fps: int) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    vf = f"scale={width}:-2,fps={fps},format=yuv420p"
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(source),
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "32",
            "-c:a",
            "aac",
            "-b:a",
            "48k",
            "-ac",
            "1",
            "-movflags",
            "+faststart",
            str(output),
        ],
        capture_output=True,
        text=True,
        timeout=240,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-1000:] or result.stdout[-1000:])
    if not output.exists() or output.stat().st_size <= 0:
        raise RuntimeError(f"Omni proxy source is empty: {output}")
    return output


def build_omni_prompt(product: str, duration_s: float, scene_segments: list[dict]) -> str:
    segment_lines = "\n".join(
        "- {id}: {start_s:.3f}-{end_s:.3f}s, {duration_s:.3f}s".format(**seg)
        for seg in scene_segments
    )
    return f"""你是短视频混剪素材库的视频理解模型。请观看这条素材，按 JSON 输出可入库结构，不要输出 Markdown。

产品身份来自文件夹，不要猜产品：{product}
视频时长约 {duration_s:.1f} 秒。

系统已经用视觉切点把视频切成候选 scene_segments。你不能自造时间戳，只能按这些候选段 ID 做相邻分组：
{segment_lines}

核心任务：
1. 判断哪些相邻候选 scene_segments 属于“同一段 story_unit”。同一段的定义是：同一个人/同一场景/同一动作链/同一卖点表达连续。
2. story_units 是后续混剪召回和时间线规划的主素材单位，但边界必须来自候选段，不要为了语义完整牺牲画面边界。
3. highlights 是 story_unit 内部更细的可用高光/证据点，可用于边界辅助，但不是后续主召回单位。
4. 如果原片有硬字幕/屏幕文字/口播，必须记录它们和对应时间，供后续判断是否冲突。

请严格输出一个 JSON 对象，字段如下：

{{
  "visual_summary": "整条视频的画面概括",
  "source_ocr": ["整条视频可见文字/字幕，按原文列出"],
  "source_asr": "整条视频口播/旁白转写；无人声则为空字符串",
  "source_meaning": "整条视频原本表达的内容本质",
  "selling_points": ["卖点"],
  "visual_actions": ["关键动作"],
  "shot_type": ["镜头/拍法类型"],
  "timeline_roles": ["opening|product|proof|transition|cta 等适合位置"],
  "product_evidence": "产品出现、使用或证明方式",
  "hard_subtitle_risk": "none|low|medium|high",
  "voiceover_fit": "excellent|good|fair|poor",
  "usable_start": 0.0,
  "usable_end": {duration_s:.1f},
  "story_units": [
    {{
      "scene_segment_ids": ["S00"],
      "start": 0.0,
      "end": 0.0,
      "label": "同一段内容的一句话概括",
      "same_segment_reason": "为什么这些连续画面属于同一段",
      "visual_summary": "这一段的画面、人物、场景、动作描述",
      "source_meaning": "这一段原本表达什么",
      "source_asr": "这一段口播；无则为空字符串",
      "source_ocr": ["这一段屏幕文字/硬字幕"],
      "hard_subtitle_risk": "none|low|medium|high",
      "voiceover_fit": "excellent|good|fair|poor",
      "usable_start": 0.0,
      "usable_end": 0.0,
      "can_standalone": true,
      "shot_type": "product_show|face_apply|proof_test|outdoor|cta|transition 等",
      "selling_points": ["这一段涉及的卖点"],
      "visual_actions": ["动作"],
      "timeline_roles": ["适合的成片位置"],
      "editor_role": "opening|product_intro|product_effect|proof|outdoor|trust|cta|transition"
    }}
  ],
  "highlights": [
    {{
      "start": 0.0,
      "end": 0.0,
      "label": "更细的可用高光",
      "visual_summary": "该高光画面描述",
      "source_meaning": "该高光核心信息",
      "source_asr": "该高光口播；无则为空字符串",
      "source_ocr": ["该高光屏幕文字"],
      "hard_subtitle_risk": "none|low|medium|high",
      "voiceover_fit": "excellent|good|fair|poor",
      "usable_start": 0.0,
      "usable_end": 0.0,
      "can_standalone": true,
      "shot_type": "镜头类型",
      "selling_points": ["卖点"],
      "visual_actions": ["动作"]
    }}
  ]
}}

约束：
- story_units 按时间顺序输出，覆盖主要可用内容即可，不必覆盖废镜头。
- 每个 story_unit 必须给出 scene_segment_ids，且只能包含相邻候选段。
- start 必须等于第一个 scene_segment 的 start_s；end 必须等于最后一个 scene_segment 的 end_s。
- 换人、换场、换对象、空镜到人物、真人到产品特写，一般不要合并。
- highlights 可以比 story_units 更细，但也必须有清晰时间戳。
- 时间单位是秒，精确到 0.1 秒。
- 只输出 JSON，不要解释。"""


def apply_scene_segment_boundaries(omni_json: dict, scene_segments: list[dict]) -> dict:
    by_id = {seg["id"]: seg for seg in scene_segments}
    max_index = len(scene_segments) - 1
    normalized_units = []
    for idx, unit in enumerate(omni_json.get("story_units", []) or []):
        ids = unit.get("scene_segment_ids") or []
        if isinstance(ids, str):
            ids = [ids]
        ids = [sid for sid in ids if sid in by_id]
        if not ids:
            raw_start = float(unit.get("start", unit.get("start_s", unit.get("usable_start", 0))) or 0)
            raw_end = float(unit.get("end", unit.get("end_s", unit.get("usable_end", raw_start))) or raw_start)
            ids = [
                seg["id"]
                for seg in scene_segments
                if min(raw_end, seg["end_s"]) - max(raw_start, seg["start_s"]) > 0.05
            ]
        if not ids:
            raise RuntimeError(f"Omni story_unit #{idx} has no valid scene_segment_ids")

        indexes = sorted(by_id[sid]["index"] for sid in ids)
        expected = list(range(indexes[0], indexes[-1] + 1))
        if indexes != expected:
            raise RuntimeError(f"Omni story_unit #{idx} uses non-adjacent scene segments: {ids}")
        if indexes[0] < 0 or indexes[-1] > max_index:
            raise RuntimeError(f"Omni story_unit #{idx} scene segment out of range: {ids}")

        canonical_ids = [scene_segments[i]["id"] for i in expected]
        start = scene_segments[indexes[0]]["start_s"]
        end = scene_segments[indexes[-1]]["end_s"]
        unit["scene_segment_ids"] = canonical_ids
        unit["raw_omni_start"] = unit.get("start", unit.get("start_s"))
        unit["raw_omni_end"] = unit.get("end", unit.get("end_s"))
        unit["start"] = start
        unit["end"] = end
        unit["start_s"] = start
        unit["end_s"] = end
        unit["usable_start"] = start
        unit["usable_end"] = end
        unit["duration_s"] = round(end - start, 3)
        unit["boundary_source"] = "scene_segments_grouped_by_omni"
        normalized_units.append(unit)

    omni_json["story_units"] = normalized_units
    return omni_json


def parse_sse_line(line: bytes):
    text = line.decode("utf-8", errors="replace").strip()
    if not text or text.startswith(":") or not text.startswith("data:"):
        return None
    payload = text[len("data:") :].strip()
    if payload == "[DONE]":
        return {"done": True}
    return json.loads(payload)


def extract_json_text(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned.strip(), flags=re.I).strip()
        cleaned = re.sub(r"```$", "", cleaned.strip()).strip()
    cleaned = re.sub(r'(:\s*)“', r'\1"', cleaned)
    def parse_with_model_json_fixes(value: str) -> dict:
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            # Omni occasionally drops the opening quote for a string item inside
            # an array, e.g. ["UV灯照射",翻转产品", "放置UV卡对比"].
            fixed = re.sub(r'([,\[]\s*)([\u4e00-\u9fff][^,\]\n]*?)"', r'\1"\2"', value)
            return json.loads(fixed)

    try:
        return parse_with_model_json_fixes(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            return parse_with_model_json_fixes(cleaned[start : end + 1])
        raise


def call_omni(oss_url: str, prompt: str, output_dir: Path) -> tuple[dict, dict]:
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError("DASHSCOPE_API_KEY missing")

    body = {
        "model": OMNI_MODEL,
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
        output_dir / "request.json",
        {
            "model": OMNI_MODEL,
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

    req = request.Request(
        OMNI_BASE_URL.rstrip("/") + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-DashScope-OssResourceResolve": "enable",
        },
        method="POST",
    )

    events = []
    parts = []
    usage = None
    try:
        with request.urlopen(req, timeout=600) as resp:
            for line in resp:
                event = parse_sse_line(line)
                if not event:
                    continue
                events.append(event)
                if event.get("done"):
                    break
                if event.get("usage"):
                    usage = event["usage"]
                for choice in event.get("choices", []) or []:
                    delta = choice.get("delta") or {}
                    content = delta.get("content")
                    if content:
                        parts.append(content)
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        (output_dir / "error.txt").write_text(detail, encoding="utf-8")
        raise RuntimeError(f"HTTP {exc.code}: {detail[:1000]}") from exc

    raw_text = "".join(parts)
    (output_dir / "raw_response.txt").write_text(raw_text, encoding="utf-8")
    (output_dir / "events.jsonl").write_text(
        "\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n",
        encoding="utf-8",
    )
    if usage:
        write_json(output_dir / "usage.json", usage)
    return extract_json_text(raw_text), {"usage": usage, "raw_text_len": len(raw_text)}


def run_detect_cuts(run_dir: Path, min_duration: float, threshold: float) -> None:
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "detect_cuts.py"),
        "--run-dir",
        str(run_dir),
        "--min-duration",
        str(min_duration),
        "--threshold",
        str(threshold),
    ]
    subprocess.run(cmd, check=True)


def trim_local(run_dir: Path, source_file: str, output_dir_name: str) -> None:
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "trim_and_upload.py"),
        str(run_dir / "assets.json"),
        str(run_dir / source_file),
        str(run_dir / output_dir_name),
        str(run_dir / f"trim_upload_results_{Path(source_file).stem}.json"),
        "--no-upload",
    ]
    subprocess.run(cmd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-dir", required=True, help="directory containing source videos")
    parser.add_argument("--product", help="product name; defaults to target directory name")
    parser.add_argument("--product-slug", help="product slug; defaults from product name")
    parser.add_argument("--workspace", default=str(SCRIPT_DIR.parents[3]))
    parser.add_argument("--run-label", default="intake")
    parser.add_argument("--output-root", default="")
    parser.add_argument("--max-videos", type=int, default=0)
    parser.add_argument("--min-physical-duration", type=float, default=1.2)
    parser.add_argument("--scene-threshold", type=float, default=0.36)
    parser.add_argument("--candidate-min-duration", type=float, default=1.2)
    parser.add_argument("--trim-story-units", action="store_true")
    parser.add_argument("--trim-physical-shots", action="store_true")
    parser.add_argument("--omni-proxy-width", type=int, default=540)
    parser.add_argument("--omni-proxy-fps", type=int, default=15)
    args = parser.parse_args()

    if not load_env():
        print("DASHSCOPE_API_KEY not found. Run scripts/save_dashscope_key.py first.", file=sys.stderr)
        return 1

    target_dir = Path(args.target_dir).expanduser().resolve()
    if not target_dir.exists():
        print(f"target dir not found: {target_dir}", file=sys.stderr)
        return 1

    product = args.product or target_dir.name
    product_slug = args.product_slug or slugify_product(product)
    output_root = Path(args.output_root).expanduser().resolve() if args.output_root else Path(args.workspace) / "cache" / "voah_video_intake" / product_slug
    run_id = time.strftime("%Y%m%d_%H%M%S") + f"_{args.run_label}"
    run_dir = output_root / run_id
    omni_dir = run_dir / "omni"
    omni_dir.mkdir(parents=True, exist_ok=True)

    videos = [p for p in sorted(target_dir.iterdir()) if p.suffix.lower() in VIDEO_EXTENSIONS and p.is_file()]
    if args.max_videos > 0:
        videos = videos[: args.max_videos]
    if not videos:
        print(f"no videos found in {target_dir}", file=sys.stderr)
        return 1

    manifest = {
        "schema_version": "1.3.0",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "run_dir": str(run_dir),
        "target_dir": str(target_dir),
        "product": {"name": product, "slug": product_slug},
        "stage": "story_unit_intake",
        "model_config": {
            "understanding": {"provider": "dashscope", "model": OMNI_MODEL},
            "embedding": {"provider": "dashscope", "model": "qwen3-vl-embedding", "dimension": 2560},
            "scene_detection": {
                "threshold": args.scene_threshold,
                "candidate_min_duration": args.candidate_min_duration,
                "min_physical_duration": args.min_physical_duration,
                "story_unit_boundary_source": "scene_segments_grouped_by_omni",
            },
        },
        "steps": [],
    }
    write_json(run_dir / "run_manifest.json", manifest)
    write_json(
        run_dir / "model_config_snapshot.json",
        {
            "understanding": {"provider": "dashscope", "model": OMNI_MODEL, "temperature": 0.1, "top_p": 0.8},
            "embedding": {"provider": "dashscope", "model": "qwen3-vl-embedding", "dimension": 2560},
            "temp_oss": {"enabled": True, "secret_source": "env:DASHSCOPE_API_KEY or ~/.voah/video_intake/.env"},
        },
    )

    probes = {}
    raw_scene_segments = {}
    merged_scene_segments = {}
    scene_cut_meta = []
    source_uploads = []
    omni_outputs = []
    proxy_dir = run_dir / "omni_proxy_sources"
    for idx, video in enumerate(videos, start=1):
        vid = video.stem
        print(f"[{idx}/{len(videos)}] probe {video.name}", flush=True)
        probe = ffprobe_file(video)
        probes[vid] = probe

        print(f"[{idx}/{len(videos)}] visual scene candidates {video.name}", flush=True)
        raw_segments, merged_segments, cut_times = build_scene_segments(
            video,
            probe["duration_s"],
            threshold=args.scene_threshold,
            min_duration=args.candidate_min_duration,
        )
        raw_scene_segments[vid] = raw_segments
        merged_scene_segments[vid] = merged_segments
        scene_cut_meta.append({
            "video_id": vid,
            "local_path": str(video),
            "duration_s": probe["duration_s"],
            "threshold": args.scene_threshold,
            "candidate_min_duration": args.candidate_min_duration,
            "cut_count": len(cut_times),
            "raw_segment_count": len(raw_segments),
            "merged_segment_count": len(merged_segments),
            "cuts": cut_times,
        })

        proxy_path = proxy_dir / f"{vid}_omni_proxy.mp4"
        print(f"[{idx}/{len(videos)}] build Omni proxy {video.name}", flush=True)
        make_omni_proxy_source(video, proxy_path, width=args.omni_proxy_width, fps=args.omni_proxy_fps)

        print(f"[{idx}/{len(videos)}] upload proxy for Omni {video.name}", flush=True)
        oss_url = upload_source_for_omni(proxy_path)
        source_uploads.append({
            "video_id": vid,
            "local_path": str(video),
            "proxy_path": str(proxy_path),
            "proxy_size_bytes": proxy_path.stat().st_size,
            "oss_url": oss_url,
            "upload_model": OMNI_MODEL,
            "status": "ok",
        })

        item_dir = omni_dir / vid
        item_dir.mkdir(parents=True, exist_ok=True)
        prompt = build_omni_prompt(product, probe["duration_s"], merged_segments)
        print(f"[{idx}/{len(videos)}] Omni understand {video.name}", flush=True)
        omni_json, call_meta = call_omni(oss_url, prompt, item_dir)
        omni_json = apply_scene_segment_boundaries(omni_json, merged_segments)
        omni_json.update({
            "video_id": vid,
            "local_path": str(video),
            "oss_url": oss_url,
            "product": product,
            "product_slug": product_slug,
            "scene_segments": merged_segments,
        })
        write_json(omni_dir / f"omni_{vid}.json", omni_json)
        omni_outputs.append({
            "video_id": vid,
            "story_units": len(omni_json.get("story_units", []) or []),
            "highlights": len(omni_json.get("highlights", []) or []),
            "usage": call_meta.get("usage"),
        })

    write_json(run_dir / "probes.json", probes)
    write_json(run_dir / "scene_segments_raw.json", raw_scene_segments)
    write_json(run_dir / f"scene_segments_merged_{str(args.candidate_min_duration).replace('.', 'p')}.json", merged_scene_segments)
    write_json(run_dir / "scene_cut_meta.json", scene_cut_meta)
    write_json(run_dir / "source_upload_results_omni.json", source_uploads)

    print("[normalize] writing layered records", flush=True)
    normalize(str(omni_dir), str(run_dir), probes, product, product_slug)

    print("[detect_cuts] story units -> physical shots", flush=True)
    run_detect_cuts(run_dir, min_duration=args.min_physical_duration, threshold=args.scene_threshold)

    if args.trim_story_units:
        print("[trim] story units local preview", flush=True)
        trim_local(run_dir, "story_units.json", "trimmed_story_units")
    if args.trim_physical_shots:
        print("[trim] physical shots local preview", flush=True)
        trim_local(run_dir, "physical_shots.json", "trimmed_physical")

    story_units = load_json(run_dir / "story_units.json")
    physical_shots = load_json(run_dir / "physical_shots.json")
    shots = load_json(run_dir / "shots.json")
    manifest["steps"] = [
        {"name": "probe", "status": "ok", "count": len(probes)},
        {"name": "visual_scene_candidates", "status": "ok", "items": scene_cut_meta},
        {"name": "source_upload_for_omni", "status": "ok", "count": len(source_uploads)},
        {"name": "omni_understand", "status": "ok", "items": omni_outputs},
        {"name": "normalize", "status": "ok", "story_units": len(story_units), "shots": len(shots)},
        {"name": "detect_cuts", "status": "ok", "physical_shots": len(physical_shots)},
    ]
    manifest["outputs"] = {
        "assets": "assets.json",
        "segments": "segments.json",
        "story_units": "story_units.json",
        "semantic_shots": "shots.json",
        "physical_shots": "physical_shots.json",
        "scene_cuts": "scene_cuts.json",
        "scene_segments_raw": "scene_segments_raw.json",
        "scene_segments_merged": f"scene_segments_merged_{str(args.candidate_min_duration).replace('.', 'p')}.json",
    }
    manifest["qa"] = {
        "asset_count": len(videos),
        "story_unit_count": len(story_units),
        "semantic_shot_count": len(shots),
        "physical_shot_count": len(physical_shots),
        "story_units_are_planning_granularity": True,
        "vectorization_done": False,
    }
    write_json(run_dir / "run_manifest.json", manifest)

    print("\n--- Voah Intake Story Units Ready ---")
    print(f"Run dir: {run_dir}")
    print(f"Assets: {len(videos)}")
    print(f"Story units: {len(story_units)}")
    print(f"Semantic highlights: {len(shots)}")
    print(f"Physical shots: {len(physical_shots)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
