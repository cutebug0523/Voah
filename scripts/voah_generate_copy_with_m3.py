#!/usr/bin/env python3
"""Generate Voah copy_brief.json and voice_script.json with MiniMax M3."""

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


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def run_command(command: list[str], input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(command, input=input_bytes, check=False, capture_output=True)


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


def call_minimax_m3(prompt_payload: dict[str, Any], timeout_s: int) -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.environ.get("MINIMAX_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("MINIMAX_API_KEY not configured")
    base_url = os.environ.get("MINIMAX_LLM_BASE_URL") or os.environ.get("VOAH_TEXT_LLM_BASE_URL") or "https://api.minimaxi.com/v1"
    endpoint = os.environ.get("VOAH_COPY_LLM_ENDPOINT") or "/text/chatcompletion_v2"
    model = os.environ.get("VOAH_COPY_LLM_MODEL") or "MiniMax-M3"
    url = f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"
    messages = [
        {
            "role": "system",
            "content": (
                "你是 Voah 的带货短视频文案 planner。你先定全片销售逻辑，再写连续口播。"
                "口播必须自然、顺滑、能直接 TTS；不要绑定具体素材 shot；输出严格 JSON。"
            ),
        },
        {"role": "user", "content": json.dumps(prompt_payload, ensure_ascii=False)},
    ]
    payload = {
        "model": model,
        "messages": messages,
        "temperature": float(os.environ.get("VOAH_COPY_LLM_TEMPERATURE") or 0.45),
        "max_tokens": int(os.environ.get("VOAH_COPY_LLM_MAX_TOKENS") or 3600),
        "thinking": {"type": "disabled"},
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
        raise RuntimeError(f"MiniMax M3 curl request failed: {stderr[:800]}")
    raw = json.loads(proc.stdout.decode("utf-8", errors="ignore"))
    if raw.get("base_resp", {}).get("status_code") not in (None, 0):
        raise RuntimeError(f"MiniMax M3 failed: {raw.get('base_resp')}")
    choices = raw.get("choices") or []
    if not choices:
        raise RuntimeError("MiniMax M3 response has no choices")
    message = choices[0].get("message") or {}
    content = message.get("content") or choices[0].get("text") or raw.get("reply") or ""
    plan = extract_json_object(content)
    safe_response = {
        "provider": "minimax-official",
        "model": model,
        "base_url": base_url,
        "endpoint": endpoint,
        "usage": raw.get("usage") or {},
        "finish_reason": choices[0].get("finish_reason"),
        "content_preview": content[:1200],
    }
    return plan, safe_response


def pronounce_text(text: str) -> str:
    return (
        str(text or "")
        .replace("SPF50+", "SPF五十加")
        .replace("PA+++", "PA三个加")
        .replace("618", "六一八")
    )


def normalize_sections(raw_sections: list[Any]) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_sections, start=1):
        if not isinstance(raw, dict):
            continue
        section_id = str(raw.get("section_id") or f"section_{index:03d}").strip()
        voice_text = str(raw.get("voice_text") or "").strip()
        if not voice_text:
            voice_text = str(raw.get("intention_copy") or "").strip()
        sections.append(
            {
                "timeline_order": index,
                "section_id": section_id,
                "role": str(raw.get("role") or "product"),
                "rough_duration_s": float(raw.get("rough_duration_s") or raw.get("target_duration_s") or 5),
                "intention_copy": str(raw.get("intention_copy") or "").strip(),
                "required_meaning": str(raw.get("required_meaning") or "").strip(),
                "required_visual": str(raw.get("required_visual") or "").strip(),
                "avoid": raw.get("avoid") if isinstance(raw.get("avoid"), list) else [],
                "keywords": raw.get("keywords") if isinstance(raw.get("keywords"), list) else [],
                "voice_text": voice_text,
                "tts_text": pronounce_text(voice_text),
            }
        )
    if not sections:
        raise ValueError("LLM did not return script_sections")
    return sections


def build_prompt(task_brief: dict[str, Any], target_duration_s: float, variant: str) -> dict[str, Any]:
    min_voice_chars = max(120, int(target_duration_s * 4.2))
    max_voice_chars = max(min_voice_chars + 20, int(target_duration_s * 5.35))
    return {
        "task": "为 Voah 美妆带货混剪生成 copy_brief 和 voice_script。",
        "product": task_brief.get("product") or {},
        "target_platform": task_brief.get("task", {}).get("target_platform") or "douyin",
        "target_duration_s": target_duration_s,
        "target_voice_characters": {
            "min": min_voice_chars,
            "max": max_voice_chars,
            "note": "统计 script_sections[].voice_text 拼接后的中文口播字符数，标点也会占 TTS 时长，尽量不要超过 max。",
        },
        "variant": variant,
        "user_brief": task_brief.get("inputs", {}).get("user_brief") or {},
        "product_claims": task_brief.get("product_claims") or [],
        "constraints": task_brief.get("constraints") or [],
        "hard_rules": [
            "先定全片销售逻辑，再写连续口播。",
            "文案不绑定具体 shot，不要写“画面里/这里看到”这类依赖镜头的表达。",
            "每个 section 必须给 required_meaning 和 required_visual，供 TTS 后按语义召回素材。",
            "required_visual 只能写通用可召回画面类型，例如产品特写、上脸轻拍、粉扑取粉、妆效近景、随身携带、福利产品陈列；不要写办公室、咖啡店、海边、车内、上班路、约会等素材库未明确给出的硬场景。",
            "如果想表达日常/通勤/出门，只能写成可由产品画面支撑的泛化需求，例如日常补妆动作、随身携带动作、自然妆效近景。",
            "字幕文本真源是 full_voice_text，不要另写摘要字幕。",
            "不要虚构价格、库存、赠品必然有，不写医疗或绝对化功效。",
            "总口播长度尽量贴近目标时长；中文口播按每秒 4.3-5.2 字估算。",
            f"script_sections[].voice_text 拼接后的总字数必须控制在 {min_voice_chars}-{max_voice_chars} 字之间，宁可少一点也不要超长。",
            "每段 voice_text 保持短句，不要堆叠同义词；证明段只保留一个核心证明，不要把所有卖点重复一遍。",
        ],
        "output_schema": {
            "sales_logic": {
                "hook": "string",
                "positioning": "string",
                "proof_order": ["string"],
                "cta": "string",
            },
            "script_sections": [
                {
                    "section_id": "string",
                    "role": "opening|product|proof|cta|transition",
                    "rough_duration_s": 5,
                    "intention_copy": "本段要表达什么",
                    "required_meaning": "召回素材时必须表达的语义",
                    "required_visual": "通用画面需求，只能写产品/上脸/补妆/携带/陈列等可泛化类型，不能写办公室、咖啡店、海边、车内、上班路、约会等硬场景",
                    "avoid": ["不能写什么"],
                    "keywords": ["关键词"],
                    "voice_text": "连续口播的一段原文",
                }
            ],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Voah copy_brief.json and voice_script.json with MiniMax M3.")
    parser.add_argument("--task-brief", required=True)
    parser.add_argument("--task-dir", default=None)
    parser.add_argument("--target-duration-s", type=float, default=45)
    parser.add_argument("--variant", default="v1")
    parser.add_argument("--timeout-s", type=int, default=120)
    parser.add_argument("--copy-brief-output", default="copy_brief.json")
    parser.add_argument("--voice-script-output", default="voice_script.json")
    args = parser.parse_args()

    workspace = Path(__file__).resolve().parents[1]
    load_env_files([workspace / ".env", Path.home() / ".voah" / "video_intake" / ".env"])

    task_brief_path = as_abs(args.task_brief)
    task_dir = as_abs(args.task_dir) if args.task_dir else task_brief_path.parent
    copy_brief_path = as_abs(args.copy_brief_output, task_dir)
    voice_script_path = as_abs(args.voice_script_output, task_dir)
    task_brief = load_json(task_brief_path)

    prompt = build_prompt(task_brief, args.target_duration_s, args.variant)
    raw_plan, safe_response = call_minimax_m3(prompt, args.timeout_s)
    sections = normalize_sections(raw_plan.get("script_sections") or [])
    full_voice_text = "".join(section["voice_text"] for section in sections)
    pronounce = "".join(section["tts_text"] for section in sections)
    warnings: list[str] = []
    if len(full_voice_text) < int(args.target_duration_s * 3.7):
        warnings.append("voice_text may be short for target duration")
    if len(full_voice_text) > int(args.target_duration_s * 6.2):
        warnings.append("voice_text may be long for target duration")

    copy_brief = {
        "schema_version": "1.0.0",
        "stage": "voah_copy_brief",
        "created_at": iso_now(),
        "product": task_brief.get("product") or {},
        "target_platform": task_brief.get("task", {}).get("target_platform") or "",
        "target_duration_range_s": task_brief.get("task", {}).get("target_duration_range_s") or [args.target_duration_s - 5, args.target_duration_s + 5],
        "inputs": {
            "task_brief": str(task_brief_path),
        },
        "provider": {
            "name": safe_response["provider"],
            "model": safe_response["model"],
            "endpoint": safe_response["endpoint"],
            "usage": safe_response.get("usage") or {},
        },
        "sales_logic": raw_plan.get("sales_logic") or {},
        "product_claims": task_brief.get("product_claims") or [],
        "script_sections": [
            {key: value for key, value in section.items() if key not in {"voice_text", "tts_text"}}
            for section in sections
        ],
        "outputs": {
            "copy_brief": str(copy_brief_path),
            "next_artifact": str(voice_script_path),
        },
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
        "next_consumers": ["voah-copy-final"],
    }
    voice_script = {
        "schema_version": "1.0.0",
        "stage": "voah_copy_final",
        "created_at": iso_now(),
        "product": task_brief.get("product") or {},
        "target_duration_range_s": copy_brief["target_duration_range_s"],
        "inputs": {
            "copy_brief": str(copy_brief_path),
        },
        "provider": copy_brief["provider"],
        "full_voice_text": full_voice_text,
        "pronounce_text": pronounce,
        "subtitle_policy": "verbatim_voice_text_split",
        "script_sections": sections,
        "script_stats": {
            "voice_text_characters": len(full_voice_text),
            "pronounce_text_characters": len(pronounce),
            "section_count": len(sections),
            "target_duration_s": args.target_duration_s,
            "estimated_duration_s": round(len(full_voice_text) / 4.8, 2),
        },
        "outputs": {
            "voice_script": str(voice_script_path),
            "next_artifact": str(task_dir / "voice.wav"),
        },
        "qa": copy_brief["qa"],
        "next_consumers": ["voah-tts"],
    }
    write_json(copy_brief_path, copy_brief)
    write_json(voice_script_path, voice_script)
    write_json(
        task_dir / "copy_llm_response.safe.json",
        {
            "created_at": iso_now(),
            "provider": safe_response,
            "plan": raw_plan,
            "qa": copy_brief["qa"],
        },
    )
    print(f"copy_brief={copy_brief_path}")
    print(f"voice_script={voice_script_path}")
    print(f"chars={len(full_voice_text)} estimated_duration_s={voice_script['script_stats']['estimated_duration_s']}")
    print(f"qa={copy_brief['qa']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
