#!/usr/bin/env python3
"""Run Omni alignment QA for a Voah rendered video by audio section."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib import error, request


DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen3.5-omni-plus"


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def as_abs(path: str | Path, base: Path | None = None) -> Path:
    value = Path(path).expanduser()
    if not value.is_absolute() and base is not None:
        value = base / value
    return value.resolve()


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


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        f.write(text)


def run_command(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def probe_duration(path: Path) -> float | None:
    proc = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    if proc.returncode != 0:
        return None
    try:
        return round(float(proc.stdout.strip()), 3)
    except ValueError:
        return None


def cut_clip(video: Path, output: Path, start_s: float, end_s: float) -> None:
    duration = max(0.1, end_s - start_s)
    proc = run_command(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            f"{start_s:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            str(video),
            "-vf",
            "scale=360:-2,fps=12,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "30",
            "-c:a",
            "aac",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "48k",
            "-movflags",
            "+faststart",
            "-avoid_negative_ts",
            "make_zero",
            str(output),
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"failed to cut {video}").strip())


def extract_frame(video: Path, output: Path, seek_s: float) -> str:
    proc = run_command(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            f"{max(0.0, seek_s):.3f}",
            "-i",
            str(video),
            "-frames:v",
            "1",
            str(output),
        ]
    )
    return str(output) if proc.returncode == 0 and output.exists() else ""


def parse_sse_line(line: bytes) -> dict[str, Any] | None:
    text = line.decode("utf-8", errors="replace").strip()
    if not text or text.startswith(":") or not text.startswith("data:"):
        return None
    payload = text[len("data:") :].strip()
    if payload == "[DONE]":
        return {"done": True}
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {"raw": payload}


def dashscope_upload(video_path: Path, model: str, timeout_s: int = 600, retries: int = 2) -> str:
    cli = os.path.expanduser("~/Library/Python/3.9/bin/dashscope")
    last_error = ""
    for attempt in range(1, retries + 2):
        try:
            proc = subprocess.run(
                [cli, "oss", "upload", "-f", str(video_path), "-m", model],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                env={**os.environ},
            )
        except subprocess.TimeoutExpired as exc:
            last_error = f"dashscope upload timeout after {timeout_s}s on attempt {attempt}: {exc}"
            time.sleep(min(2 * attempt, 8))
            continue
        if proc.returncode != 0:
            last_error = proc.stderr[-1000:] or proc.stdout[-1000:]
            time.sleep(min(2 * attempt, 8))
            continue
        oss_url = extract_oss_url(proc.stdout or "", proc.stderr or "")
        if oss_url:
            return oss_url
        last_error = "cannot extract oss url from dashscope upload"
        time.sleep(min(2 * attempt, 8))
    raise RuntimeError(last_error)


def extract_oss_url(stdout: str, stderr: str) -> str:
    text = "\n".join([stdout or "", stderr or ""])
    try:
        parsed = json.loads(stdout)
        candidates = [
            parsed.get("url") if isinstance(parsed, dict) else "",
            parsed.get("data", {}).get("url") if isinstance(parsed, dict) and isinstance(parsed.get("data"), dict) else "",
            parsed.get("oss_url") if isinstance(parsed, dict) else "",
        ]
        for candidate in candidates:
            if candidate and str(candidate).startswith("oss://"):
                return str(candidate)
    except json.JSONDecodeError:
        pass

    marker = "oss://"
    if marker in text:
        tail = text.split(marker, 1)[1]
        parts = []
        for raw_line in tail.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            if any(ch.isspace() for ch in line):
                break
            if parts and not re.match(r"^[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$", line):
                break
            parts.append(line)
            if line.lower().endswith((".mp4", ".mov", ".m4v", ".avi", ".webm")):
                break
        if parts:
            return marker + "".join(parts)

    match = re.search(r"oss://\S+", text)
    return match.group(0) if match else ""


def build_prompt(section: dict[str, Any], timeline_section: dict[str, Any] | None) -> str:
    if isinstance(timeline_section, dict):
        clips = timeline_section.get("clips") or timeline_section.get("selected_clips") or []
    else:
        clips = []
    clip_summary = [
        {
            "shot_id": clip.get("shot_id"),
            "child_physical_shot_id": clip.get("child_physical_shot_id"),
            "visual_summary": clip.get("visual_summary"),
            "source_meaning": clip.get("source_meaning"),
            "target_visual_terms": clip.get("target_visual_terms"),
            "selection_risks": clip.get("selection_risks"),
        }
        for clip in (clips or [])
        if isinstance(clip, dict)
    ]
    return f"""你是 Voah 短视频混剪 QA。请只判断这个小片段的“声音/字幕/画面”是否匹配。

本段口播原文：
{section.get('voice_text') or ''}

本段要求表达：
{section.get('required_meaning') or ''}

本段期待画面：
{section.get('required_visual') or ''}

系统选片记录：
{json.dumps(clip_summary, ensure_ascii=False)}

请输出严格 JSON，不要 Markdown：
{{
  "section_id": "{section.get('section_id')}",
  "audio_caption_match": "pass|minor_review|major_review|fail",
  "visual_match": "pass|minor_review|major_review|fail",
  "overall": "pass|minor_review|major_review|fail",
  "visual_observation": "你实际看到的画面",
  "mismatch": "如有错配，写清楚错在哪里",
  "recommended_action": "pass|rerank_material|rewrite_copy|manual_review"
}}
"""


def call_omni(video_url: str, prompt: str, output_dir: Path, model: str, base_url: str, timeout_s: int) -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("DASHSCOPE_API_KEY is missing")
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "video_url", "video_url": {"url": video_url}},
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
    request_record = {
        "created_at": iso_now(),
        "model": model,
        "base_url": base_url,
        "prompt": prompt,
        "body_without_video_payload": {
            **body,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "video_url", "video_url": {"url": "<redacted>"}},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        },
    }
    write_json(output_dir / "request.json", request_record)
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
    raw_events: list[dict[str, Any]] = []
    content_parts: list[str] = []
    usage = None
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
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        write_text(output_dir / "error.txt", detail)
        raise RuntimeError(f"HTTP {exc.code}: {detail[:800]}")
    raw_response = "".join(content_parts)
    write_text(output_dir / "raw_response.md", raw_response)
    write_text(output_dir / "events.jsonl", "\n".join(json.dumps(event, ensure_ascii=False) for event in raw_events) + "\n")
    try:
        parsed = extract_json_object(raw_response)
    except Exception as exc:
        parsed = {
            "overall": "manual_review",
            "visual_match": "manual_review",
            "audio_caption_match": "manual_review",
            "mismatch": f"Omni response parse failed: {exc}",
            "raw_response_preview": raw_response[:800],
        }
    if usage is not None:
        write_json(output_dir / "usage.json", usage)
    return parsed, {"usage": usage or {}, "raw_response_chars": len(raw_response)}


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
    if start >= 0:
        candidate = raw[start:]
        missing_braces = candidate.count("{") - candidate.count("}")
        repaired = candidate + ("}" * max(1, missing_braces))
        parsed = json.loads(repaired)
        if isinstance(parsed, dict):
            parsed["_json_repair"] = "appended_missing_closing_brace"
            return parsed
    raise ValueError("response is not JSON object")


def status_rank(status: str) -> int:
    return {"pass": 0, "minor_review": 1, "manual_review": 2, "major_review": 3, "fail": 4}.get(str(status or ""), 2)


def report_markdown(results: list[dict[str, Any]], output_video: Path, task_dir: Path) -> str:
    lines = [
        "# Voah Omni Alignment QA",
        "",
        f"- task_dir: `{task_dir}`",
        f"- video: `{output_video}`",
        "",
        "| Section | Audio/Caption | Visual | Overall | Observation | Action |",
        "|---|---|---|---|---|---|",
    ]
    for item in results:
        lines.append(
            "| {section} | {audio} | {visual} | {overall} | {obs} | {action} |".format(
                section=item.get("section_id", ""),
                audio=item.get("audio_caption_match", ""),
                visual=item.get("visual_match", ""),
                overall=item.get("overall", ""),
                obs=str(item.get("visual_observation") or item.get("mismatch") or "").replace("|", "/")[:120],
                action=item.get("recommended_action", ""),
            )
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Omni alignment QA for a Voah rendered video.")
    parser.add_argument("--task-dir", required=True)
    parser.add_argument("--video", default="preview_no_subtitles.mp4")
    parser.add_argument("--audio-sections", default="audio_sections.json")
    parser.add_argument("--timeline-fill", default="timeline_fill.json")
    parser.add_argument("--output-dir", default="qa_omni_alignment")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--max-sections", type=int, default=0)
    parser.add_argument("--timeout-s", type=int, default=600)
    parser.add_argument("--upload-timeout-s", type=int, default=600)
    parser.add_argument("--upload-retries", type=int, default=2)
    parser.add_argument("--skip-upload", action="store_true")
    args = parser.parse_args()

    workspace = Path(__file__).resolve().parents[1]
    load_env_files([workspace / ".env", Path.home() / ".voah" / "video_intake" / ".env"])

    task_dir = as_abs(args.task_dir)
    video = as_abs(args.video, task_dir)
    audio_sections_path = as_abs(args.audio_sections, task_dir)
    timeline_fill_path = as_abs(args.timeline_fill, task_dir)
    output_dir = as_abs(args.output_dir, task_dir)
    clips_dir = output_dir / "section_clips"
    frames_dir = output_dir / "section_frames"
    omni_dir = output_dir / "omni_sections"
    if output_dir.exists():
        for child in (clips_dir, frames_dir, omni_dir):
            if child.exists():
                shutil.rmtree(child)
        for stale_file in [
            "alignment_inputs.json",
            "omni_alignment_results.json",
            "OMNI_ALIGNMENT_QA_REPORT.md",
        ]:
            stale_path = output_dir / stale_file
            if stale_path.exists():
                stale_path.unlink()
    clips_dir.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)
    omni_dir.mkdir(parents=True, exist_ok=True)

    audio_sections = load_json(audio_sections_path)
    timeline_fill = load_json(timeline_fill_path) if timeline_fill_path.exists() else {}
    timeline_by_id: dict[str, dict[str, Any]] = {}
    for item in timeline_fill.get("timeline", []):
        if not isinstance(item, dict):
            continue
        section_id = str(item.get("section_id") or "")
        if not section_id:
            continue
        timeline_by_id.setdefault(section_id, {"section_id": section_id, "clips": []})
        timeline_by_id[section_id]["clips"].extend(item.get("clips") or [])
        for key in ("timeline_start_s", "timeline_end_s", "audio_duration_s", "filled_duration_s"):
            if key in item and key not in timeline_by_id[section_id]:
                timeline_by_id[section_id][key] = item[key]
    sections = audio_sections.get("sections") or []
    if args.max_sections > 0:
        sections = sections[: args.max_sections]
    results: list[dict[str, Any]] = []
    alignment_inputs: list[dict[str, Any]] = []
    for index, section in enumerate(sections, start=1):
        section_id = str(section.get("section_id") or f"section_{index:03d}")
        start_s = float(section.get("timeline_start_s") or section.get("audio_start_s") or 0)
        end_s = float(section.get("timeline_end_s") or section.get("audio_end_s") or start_s)
        clip_path = clips_dir / f"{index:02d}_{section_id}.mp4"
        frame_path = frames_dir / f"{index:02d}_{section_id}.jpg"
        print(f"[{index}/{len(sections)}] QA {section_id} {start_s:.3f}-{end_s:.3f}", flush=True)
        cut_clip(video, clip_path, start_s, end_s)
        clip_duration = probe_duration(clip_path) or max(0.1, end_s - start_s)
        extract_frame(clip_path, frame_path, min(clip_duration / 2.0, max(0.0, clip_duration - 0.05)))
        section_omni_dir = omni_dir / f"{index:02d}_{section_id}"
        section_omni_dir.mkdir(parents=True, exist_ok=True)
        video_url = str(clip_path)
        if not args.skip_upload:
            video_url = dashscope_upload(clip_path, args.model, args.upload_timeout_s, args.upload_retries)
        prompt = build_prompt(section, timeline_by_id.get(section_id))
        try:
            parsed, meta = call_omni(video_url, prompt, section_omni_dir, args.model, args.base_url, args.timeout_s)
        except Exception as exc:
            parsed = {
                "section_id": section_id,
                "audio_caption_match": "manual_review",
                "visual_match": "manual_review",
                "overall": "manual_review",
                "visual_observation": "",
                "mismatch": str(exc),
                "recommended_action": "manual_review",
            }
            meta = {"error": str(exc)}
            write_text(section_omni_dir / "error.txt", str(exc))
        parsed["section_id"] = section_id
        parsed["clip_path"] = str(clip_path)
        parsed["frame_path"] = str(frame_path)
        parsed["usage"] = meta.get("usage") or {}
        results.append(parsed)
        alignment_inputs.append(
            {
                "section_id": section_id,
                "start_s": start_s,
                "end_s": end_s,
                "voice_text": section.get("voice_text"),
                "required_meaning": section.get("required_meaning"),
                "required_visual": section.get("required_visual"),
                "clip_path": str(clip_path),
                "frame_path": str(frame_path),
            }
        )
        time.sleep(0.4)

    worst = max((status_rank(item.get("overall")) for item in results), default=0)
    status = "ok" if worst == 0 else "manual_review" if worst <= 2 else "block"
    summary = {
        "schema_version": "1.0.0",
        "stage": "voah_omni_alignment_qa",
        "created_at": iso_now(),
        "model": args.model,
        "inputs": {
            "task_dir": str(task_dir),
            "video": str(video),
            "audio_sections": str(audio_sections_path),
            "timeline_fill": str(timeline_fill_path),
        },
        "outputs": {
            "output_dir": str(output_dir),
            "results": str(output_dir / "omni_alignment_results.json"),
            "report": str(output_dir / "OMNI_ALIGNMENT_QA_REPORT.md"),
        },
        "results": results,
        "summary": {
            "section_count": len(results),
            "pass_count": sum(1 for item in results if item.get("overall") == "pass"),
            "minor_review_count": sum(1 for item in results if item.get("overall") == "minor_review"),
            "major_review_count": sum(1 for item in results if item.get("overall") == "major_review"),
            "fail_count": sum(1 for item in results if item.get("overall") == "fail"),
        },
        "qa": {
            "status": status,
            "warnings": [str(item.get("mismatch") or item.get("recommended_action") or "") for item in results if item.get("overall") != "pass"],
        },
        "next_consumers": ["voah-qa-gate", "rerank-material"],
    }
    write_json(output_dir / "alignment_inputs.json", alignment_inputs)
    write_json(output_dir / "omni_alignment_results.json", summary)
    write_text(output_dir / "OMNI_ALIGNMENT_QA_REPORT.md", report_markdown(results, video, task_dir))
    print(f"qa_status={status}")
    print(f"results={output_dir / 'omni_alignment_results.json'}")
    print(f"report={output_dir / 'OMNI_ALIGNMENT_QA_REPORT.md'}")
    return 0 if status != "block" else 2


if __name__ == "__main__":
    raise SystemExit(main())
