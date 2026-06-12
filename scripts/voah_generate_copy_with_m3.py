#!/usr/bin/env python3
"""Generate Voah copy_brief.json and voice_script.json with the configured text LLM."""

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


MATERIAL_SIGNAL_TERMS = [
    "卡粉",
    "卡纹",
    "斑驳",
    "脱妆",
    "泛油",
    "油光",
    "地铁",
    "粉扑",
    "轻拍",
    "上脸",
    "开盖",
    "粉芯",
    "镜面",
    "手臂",
    "试色",
    "倒水",
    "泼水",
    "遇水",
    "防水",
    "擦拭",
    "纸巾",
    "礼盒",
    "替换装",
    "小样",
    "陈列",
    "精华",
    "水润",
    "柔焦",
    "毛孔",
    "瑕疵",
    "咖啡",
    "包",
    "奶茶",
]

STRONG_VISUAL_MIN_COUNT = 2
HIGH_EVIDENCE_MIN_COUNT = 3
OPENING_RISK_TERMS = ("卡纹", "泛油", "油光", "地铁", "毛孔", "瑕疵")
PROBLEM_TERMS = ("卡粉", "卡纹", "斑驳", "脱妆", "泛油", "油光", "地铁")


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


def copy_llm_thinking_config(provider: str, model: str) -> dict[str, str] | None:
    raw = os.environ.get("VOAH_COPY_LLM_THINKING", "").strip().lower()
    if raw in {"enabled", "enable", "true", "1", "on"}:
        return {"type": "enabled"}
    if raw in {"disabled", "disable", "false", "0", "off"}:
        return {"type": "disabled"}
    if provider == "deepseek" and model == "deepseek-v4-pro":
        return {"type": "disabled"}
    return None


def call_copy_llm(prompt_payload: dict[str, Any], timeout_s: int) -> tuple[dict[str, Any], dict[str, Any]]:
    provider = (os.environ.get("VOAH_COPY_LLM_PROVIDER") or "deepseek").strip().lower()
    if provider in {"deepseek", "deepseek-official"}:
        return call_openai_compatible_llm(
            prompt_payload,
            timeout_s,
            provider="deepseek",
            api_key_env="DEEPSEEK_API_KEY",
            default_base_url="https://api.deepseek.com",
            default_endpoint="/chat/completions",
            default_model="deepseek-v4-pro",
        )
    return call_minimax_m3(prompt_payload, timeout_s)


def call_openai_compatible_llm(
    prompt_payload: dict[str, Any],
    timeout_s: int,
    provider: str,
    api_key_env: str,
    default_base_url: str,
    default_endpoint: str,
    default_model: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.environ.get(api_key_env, "").strip()
    if not api_key:
        raise RuntimeError(f"{api_key_env} not configured")
    base_url = os.environ.get("VOAH_TEXT_LLM_BASE_URL") or default_base_url
    endpoint = os.environ.get("VOAH_COPY_LLM_ENDPOINT") or default_endpoint
    model = os.environ.get("VOAH_COPY_LLM_MODEL") or default_model
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
        "stream": False,
    }
    thinking_config = copy_llm_thinking_config(provider, model)
    if thinking_config:
        payload["thinking"] = thinking_config
    raw = post_json_with_bearer(url, api_key, payload, timeout_s, f"{provider} copy LLM")
    choices = raw.get("choices") or []
    if not choices:
        raise RuntimeError(f"{provider} response has no choices")
    message = choices[0].get("message") or {}
    content = message.get("content") or choices[0].get("text") or raw.get("reply") or ""
    plan = extract_json_object(content)
    safe_response = {
        "provider": provider,
        "model": model,
        "base_url": base_url,
        "endpoint": endpoint,
        "usage": raw.get("usage") or {},
        "finish_reason": choices[0].get("finish_reason"),
        "thinking": thinking_config or {},
        "content_preview": content[:1200],
    }
    return plan, safe_response


def post_json_with_bearer(url: str, api_key: str, payload: dict[str, Any], timeout_s: int, label: str) -> dict[str, Any]:
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
        raise RuntimeError(f"{label} curl request failed: {stderr[:800]}")
    raw = json.loads(proc.stdout.decode("utf-8", errors="ignore"))
    if raw.get("base_resp", {}).get("status_code") not in (None, 0):
        raise RuntimeError(f"{label} failed: {raw.get('base_resp')}")
    if raw.get("error"):
        raise RuntimeError(f"{label} failed: {raw.get('error')}")
    return raw


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
    raw = post_json_with_bearer(url, api_key, payload, timeout_s, "MiniMax M3")
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


def material_text_blob(record: dict[str, Any]) -> str:
    parts = [
        record.get("label", ""),
        record.get("visual_summary", ""),
        record.get("source_meaning", ""),
        str(record.get("source_asr", "")),
        " ".join(str(item) for item in record.get("source_ocr") or []),
        " ".join(str(item) for item in record.get("selling_points") or []),
        " ".join(str(item) for item in record.get("visual_actions") or []),
        record.get("shot_type", ""),
    ]
    return " ".join(str(part) for part in parts if part)


def compact_material_capabilities(shot_index_path: Path | None) -> dict[str, Any]:
    if not shot_index_path or not shot_index_path.exists():
        return {
            "available": False,
            "note": "没有传入 shot_index.json，文案只能按通用美妆素材能力写，后续召回风险较高。",
        }
    index = load_json(shot_index_path)
    records = [record for record in index.get("records", []) if isinstance(record, dict)]
    term_counts: dict[str, int] = {}
    selling_points: dict[str, int] = {}
    shot_types: dict[str, int] = {}
    examples: list[dict[str, Any]] = []
    for record in records:
        blob = material_text_blob(record)
        for child in record.get("child_physical_shots") or []:
            if isinstance(child, dict):
                blob = f"{blob} {material_text_blob(child)}"
        for term in MATERIAL_SIGNAL_TERMS:
            if term in blob:
                term_counts[term] = term_counts.get(term, 0) + 1
        for point in record.get("selling_points") or []:
            text = str(point).strip()
            if text:
                selling_points[text] = selling_points.get(text, 0) + 1
        shot_type = str(record.get("shot_type") or "").strip()
        if shot_type:
            shot_types[shot_type] = shot_types.get(shot_type, 0) + 1
        if len(examples) < 18:
            examples.append(
                {
                    "id": record.get("shot_id"),
                    "duration_s": record.get("duration_s"),
                    "label": str(record.get("label") or "")[:48],
                    "visual": str(record.get("visual_summary") or "")[:120],
                    "meaning": str(record.get("source_meaning") or "")[:120],
                    "selling_points": [str(item) for item in (record.get("selling_points") or [])[:4]],
                }
            )
    missing_terms = [term for term in MATERIAL_SIGNAL_TERMS if term not in term_counts]
    strong_terms = [term for term, count in term_counts.items() if count >= STRONG_VISUAL_MIN_COUNT]
    high_evidence_terms = [term for term, count in term_counts.items() if count >= HIGH_EVIDENCE_MIN_COUNT]
    weak_problem_terms = [term for term in PROBLEM_TERMS if term_counts.get(term, 0) < STRONG_VISUAL_MIN_COUNT]
    safe_opening_terms = [
        term
        for term in ("补妆", "轻拍", "上脸", "粉扑", "开盖", "粉芯", "柔焦", "精华", "礼盒", "陈列")
        if term_counts.get(term, 0) >= STRONG_VISUAL_MIN_COUNT
    ]
    return {
        "available": True,
        "shot_index": str(shot_index_path),
        "record_count": len(records),
        "available_visual_terms": [
            {"term": term, "count": count}
            for term, count in sorted(term_counts.items(), key=lambda item: (-item[1], item[0]))[:30]
        ],
        "missing_or_weak_visual_terms": missing_terms[:30],
        "strong_visual_terms": sorted(strong_terms, key=lambda term: (-term_counts[term], term))[:30],
        "high_evidence_terms": sorted(high_evidence_terms, key=lambda term: (-term_counts[term], term))[:30],
        "weak_problem_terms": weak_problem_terms,
        "safe_opening_terms": safe_opening_terms,
        "selling_points_observed": [
            {"term": term, "count": count}
            for term, count in sorted(selling_points.items(), key=lambda item: (-item[1], item[0]))[:24]
        ],
        "shot_types": [
            {"term": term, "count": count}
            for term, count in sorted(shot_types.items(), key=lambda item: (-item[1], item[0]))[:18]
        ],
        "representative_examples": examples,
        "copy_policy": [
            "voice_text 可以表达产品卖点，但 required_visual 必须优先使用 available_visual_terms 和 representative_examples 中能看见的画面。",
            "如果素材里没有毛孔/瑕疵/纸巾/前后对比，就不要把它们写成 required_visual。",
            "痛点开场只能写 strong_visual_terms/high_evidence_terms 支撑的可见问题；weak_problem_terms 只能作为泛化需求，不要写成确定视觉证据。",
            "如果强证据痛点不足，开场改写成通勤补妆、妆感厚重、自然气色、轻薄服帖这类可由产品/上脸/补妆画面支撑的泛化问题。",
            "稳定性证明按素材真实动作写，例如倒水、泼水、擦拭；不要改写成不存在的纸巾按压。",
        ],
    }


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
    return [sanitize_section_copy(section) for section in sections]


def sanitize_section_copy(section: dict[str, Any]) -> dict[str, Any]:
    output = dict(section)
    voice_text = str(output.get("voice_text") or "")
    required_visual = str(output.get("required_visual") or "")
    role = str(output.get("role") or "")
    if role == "opening":
        weak_visual_markers = ("卡纹", "斑驳", "脱妆", "泛油", "油光", "地铁", "毛孔", "瑕疵")
        if any(term in voice_text or term in required_visual for term in weak_visual_markers):
            voice_text = "早上赶着出门，底妆最怕一上脸就厚重，补两下又怕越补越明显。想要自然气色，又不想粉感太重。"
            output["voice_text"] = voice_text
            output["tts_text"] = pronounce_text(voice_text)
            output["intention_copy"] = "用通勤补妆和粉感厚重的泛化痛点建立共鸣，避免写素材证据不足的具体脱妆场景"
            output["required_meaning"] = "底妆需要自然气色、轻薄服帖，补妆不显厚重"
            output["required_visual"] = "补妆动作、上脸轻拍、自然底妆效果、产品粉扑或粉芯特写"
            output["keywords"] = ["补妆", "轻薄", "自然气色", "底妆"]
        elif "卡粉" in voice_text and "卡纹" in voice_text:
            voice_text = voice_text.replace("卡粉、卡纹", "卡粉")
            voice_text = voice_text.replace("卡粉卡纹", "卡粉")
            output["voice_text"] = voice_text
            output["tts_text"] = pronounce_text(voice_text)
    if role == "proof":
        risky_object_terms = ("粉面", "粉芯", "粉仓")
        water_terms = ("倒水", "遇水", "水珠", "擦")
        precise_light_water_patterns = (
            "往妆面滴上几滴水",
            "往妆面滴几滴水",
            "在妆面上滴上几滴水",
            "在妆面上滴几滴水",
            "滴上几滴水",
            "滴几滴水",
            "少量水",
            "水珠落上去",
            "水滴落上去",
        )
        if any(pattern in voice_text for pattern in precise_light_water_patterns):
            voice_text = re.sub(
                r"(往|在)?妆面(上)?滴上?几滴水",
                "做个倒水测试",
                voice_text,
            )
            voice_text = voice_text.replace("滴上几滴水", "做个倒水测试")
            voice_text = voice_text.replace("滴几滴水", "做个倒水测试")
            voice_text = voice_text.replace("少量水", "水")
            voice_text = voice_text.replace("水珠落上去", "做完遇水测试")
            voice_text = voice_text.replace("水滴落上去", "做完遇水测试")
            voice_text = re.sub(r"做个倒水测试[，,、]?再", "做个倒水测试，再", voice_text)
            voice_text = re.sub(r"做个倒水测试[，,、]?妆面", "做个倒水测试，妆面", voice_text)
            output["voice_text"] = voice_text
            output["tts_text"] = pronounce_text(voice_text)
        if any(term in voice_text for term in risky_object_terms) and any(term in voice_text for term in water_terms):
            replacements = {
                "我还特意在粉面上做了一次遇水测试，水珠落上去会顺着表面滑下来，不会直接渗进粉芯。": "我还特意做了一次遇水测试，水珠落上去后再轻轻擦开，妆面依然稳稳的。",
                "往粉面倒一点水，再用手指轻轻擦开，粉芯结构依然完整，": "做个遇水测试，水倒上去再轻轻擦开，妆面依然稳稳的，",
                "倒水在粉芯上": "做遇水测试",
                "倒水在粉面上": "做遇水测试",
                "往粉面倒一点水": "做个遇水测试",
                "往粉芯倒一点水": "做个遇水测试",
                "粉芯结构依然完整": "妆面依然稳稳的",
                "不会直接渗进粉芯": "不会轻易把妆面带走",
            }
            for old, new in replacements.items():
                voice_text = voice_text.replace(old, new)
            voice_text = re.sub(r"做个遇水测试，再用手指", "做个遇水测试，用手指", voice_text)
            output["voice_text"] = voice_text
            output["tts_text"] = pronounce_text(voice_text)
        proof_replacements = {
            "水直接泼在带妆的手臂上": "做个倒水测试",
            "水泼在带妆的手臂上": "做个倒水测试",
            "泼在带妆的手臂上": "做个倒水测试",
            "倒在带妆的手臂上": "做个倒水测试",
            "倒在脸上": "做个倒水测试",
            "泼在脸上": "做个倒水测试",
        }
        for old, new in proof_replacements.items():
            voice_text = voice_text.replace(old, new)
        voice_text = re.sub(r"我还特意做了遇水测试，做个倒水测试", "我还特意做了个倒水测试", voice_text)
        voice_text = re.sub(r"做了遇水测试，做个倒水测试", "做了个倒水测试", voice_text)
        voice_text = re.sub(r"(做个倒水测试)[，,、]?(妆面)", r"\1，\2", voice_text)
        if len(voice_text) > 46 or any(term in voice_text for term in ("下雨", "小雨", "出汗", "临时", "不会轻易垮", "通勤用着")):
            voice_text = "做个倒水测试，水流过后，妆面依然服帖稳定。"
        voice_text = voice_text.replace("水流过后轻轻擦开，", "水流过后，")
        voice_text = voice_text.replace("擦干后依旧", "水流过后依旧")
        output["voice_text"] = voice_text
        output["tts_text"] = pronounce_text(voice_text)
        output["rough_duration_s"] = min(float(output.get("rough_duration_s") or 6), 6.5)
        output["intention_copy"] = "用短证明段表达遇水后妆面稳定，避免证明素材时长不足"
        output["required_meaning"] = "做倒水或遇水测试后，妆面依然服帖稳定"
        output["keywords"] = ["倒水测试", "遇水", "稳定", "服帖"]
        if any(term in required_visual for term in risky_object_terms) and any(term in required_visual for term in water_terms):
            output["required_visual"] = "遇水测试动作特写、倒水或擦拭后妆面稳定近景"
        if "手臂" in required_visual or "脸上倒水" in required_visual:
            output["required_visual"] = "倒水或泼水测试，擦拭后妆面稳定近景"
        if any(term in required_visual for term in ("滴", "水滴", "水珠", "少量水")):
            output["required_visual"] = "倒水或泼水测试，擦拭后妆面稳定近景"
        if not output.get("required_visual"):
            output["required_visual"] = "倒水或泼水测试，擦拭后妆面稳定近景"
    if role == "cta":
        cta_noise_terms = ("通勤", "补妆", "放包", "出门", "上妆", "粉扑", "妆感")
        if any(term in voice_text for term in cta_noise_terms) or len(voice_text) > 24 or "礼盒装" in voice_text:
            voice_text = "活动套装，多款外壳陈列，喜欢直接拍。"
            output["voice_text"] = voice_text
            output["tts_text"] = pronounce_text(voice_text)
            output["required_meaning"] = "多款外壳、套装陈列与活动价，引导下单"
            output["required_visual"] = "多款气垫外壳、托盘或桌面陈列"
            output["keywords"] = ["套装", "外壳", "陈列", "活动价", "下单"]
    if role == "product":
        product_replacements = {
            "粉芯里加了高浓度精华，一按就有水润感。": "开盖能看到粉芯和粉扑，拿起来补妆很顺手。",
            "高浓度精华": "水润妆感",
            "精华液": "水润妆感",
            "柔焦奶油肌": "自然柔焦妆感",
            "奶油肌": "自然柔焦妆感",
            "像天生好皮": "像本身气色就很好",
            "底妆就被补得服服帖帖": "妆面就更服服帖帖",
            "粉扑拍一拍就能补好": "粉扑拍一拍就能让妆面更服帖",
            "补妆很顺手": "上脸很顺手",
        }
        for old, new in product_replacements.items():
            voice_text = voice_text.replace(old, new)
        output["voice_text"] = voice_text
        output["tts_text"] = pronounce_text(voice_text)
        if "精华液" in required_visual or "高浓度精华" in required_visual:
            output["required_visual"] = "气垫开盖露出粉芯与粉扑、取粉或质地特写"
        effect_terms = ("轻薄", "服帖", "服贴", "柔焦", "粉扑", "轻拍", "上脸", "妆面")
        packaging_terms = ("礼盒", "外壳", "陈列", "多款", "活动价")
        detail_terms = ("粉芯", "开盖", "膏体", "取粉")
        locked_detail_section = False
        if any(term in voice_text for term in detail_terms) and any(term in voice_text for term in effect_terms):
            voice_text = "开盖看粉芯，取粉均匀，质地细润。"
            output["voice_text"] = voice_text
            output["tts_text"] = pronounce_text(voice_text)
            output["rough_duration_s"] = min(float(output.get("rough_duration_s") or 3.5), 4.0)
            output["required_meaning"] = "展示气垫开盖、粉芯和取粉质地"
            output["required_visual"] = "气垫开盖露出粉芯、取粉或膏体质地特写"
            output["keywords"] = ["开盖", "粉芯", "取粉", "质地"]
            locked_detail_section = True
        if (
            not locked_detail_section
            and any(term in voice_text for term in effect_terms)
            and not any(term in voice_text for term in packaging_terms)
        ):
            output["required_meaning"] = "产品轻薄服帖，上脸轻拍后呈现自然柔焦妆效"
            output["required_visual"] = "女性用粉扑轻拍上脸、自然妆效近景"
            output["keywords"] = ["粉扑", "轻拍", "上脸", "柔焦", "服帖"]
        if any(term in voice_text for term in detail_terms):
            output["required_visual"] = "气垫开盖露出粉芯、取粉或膏体质地特写"
            output["keywords"] = ["开盖", "粉芯", "取粉", "质地"]
        if any(term in voice_text for term in packaging_terms):
            output["required_visual"] = "礼盒装、多款气垫外壳、托盘或桌面陈列"
            output["keywords"] = ["礼盒", "外壳", "陈列"]
    return output


def target_voice_char_range(target_duration_s: float) -> tuple[int, int]:
    # MiniMax speech-2.8-hd 当前女声 speed=1.1 含停顿实测约 4.6-5.3 字/秒（多任务抽样）。
    # 取保守值 ~4.8 字/秒估算，宁短勿长：短了素材多填一点，长了会整体超时。
    # 不设字数硬底，短视频（15-25s）才能真正控制在目标区间。
    min_voice_chars = max(40, int(target_duration_s * 4.4))
    max_voice_chars = max(min_voice_chars + 16, int(target_duration_s * 4.8))
    return min_voice_chars, max_voice_chars


def has_dangling_short_sentence(text: str) -> bool:
    sentences = [item.strip() for item in re.split(r"(?<=[。！？!?])", str(text or "")) if item.strip()]
    for sentence in sentences:
        body = re.sub(r"[。！？!?]+$", "", sentence).strip()
        if 0 < len(body) <= 2 or re.search(r"(之后|因为|所以|说明|而且|但是|如果|直接|比如)$", body):
            return True
    return False


def trim_text_to_limit(text: str, max_chars: int) -> str:
    value = str(text or "").strip()
    if len(value) <= max_chars:
        return value
    sentences = [item for item in re.split(r"(?<=[。！？!?])", value) if item]
    kept: list[str] = []
    total = 0
    for sentence in sentences:
        if total + len(sentence) > max_chars:
            break
        kept.append(sentence)
        total += len(sentence)
    if kept and total >= max_chars * 0.72:
        return "".join(kept).strip()
    return ""


def enforce_complete_sentences(sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for section in sections:
        item = dict(section)
        text = str(item.get("voice_text") or "").strip()
        if has_dangling_short_sentence(text):
            sentences = [part for part in re.split(r"(?<=[。！？!?])", text) if part.strip()]
            while sentences and has_dangling_short_sentence("".join(sentences)):
                sentences.pop()
            if sentences:
                text = "".join(sentences).strip()
        item["voice_text"] = text
        item["tts_text"] = pronounce_text(text)
        cleaned.append(item)
    return cleaned


def enforce_voice_char_limit(sections: list[dict[str, Any]], max_chars: int) -> tuple[list[dict[str, Any]], list[str]]:
    full_text = "".join(section["voice_text"] for section in sections)
    if len(full_text) <= max_chars:
        return sections, []
    trimmed_sections = [dict(section) for section in sections]
    overflow = len(full_text) - max_chars
    warnings = [f"voice_text exceeded target max by {overflow} chars; auto-dropped complete tail sentences"]
    for index in range(len(trimmed_sections) - 1, -1, -1):
        current_full = "".join(section["voice_text"] for section in trimmed_sections)
        if len(current_full) <= max_chars:
            break
        section = trimmed_sections[index]
        current = str(section.get("voice_text") or "")
        sentences = [part for part in re.split(r"(?<=[。！？!?])", current) if part.strip()]
        if len(sentences) <= 1:
            continue
        sentences.pop()
        section["voice_text"] = "".join(sentences).strip()
        section["tts_text"] = pronounce_text(section["voice_text"])
    final_full = "".join(section["voice_text"] for section in trimmed_sections)
    if len(final_full) > max_chars:
        warnings.append("auto-drop could not fit target without damaging sentence integrity; keeping complete over-limit copy for QA warning")
    return enforce_complete_sentences(trimmed_sections), warnings


def rebalance_short_script(sections: list[dict[str, Any]], min_chars: int) -> tuple[list[dict[str, Any]], list[str]]:
    full_text = "".join(section["voice_text"] for section in sections)
    if len(full_text) >= min_chars:
        return sections, []
    output = [dict(section) for section in sections]
    warnings = [f"voice_text below target min by {min_chars - len(full_text)} chars; inserted deterministic apply/effect section"]
    has_apply_section = any(
        str(section.get("role") or "") == "product"
        and any(term in str(section.get("required_visual") or "") for term in ("上脸", "轻拍", "妆效"))
        for section in output
    )
    if not has_apply_section:
        insert_index = next(
            (
                index + 1
                for index, section in enumerate(output)
                if str(section.get("role") or "") == "product"
            ),
            min(2, len(output)),
        )
        output.insert(
            insert_index,
            {
                "timeline_order": insert_index + 1,
                "section_id": "sec_apply_effect",
                "role": "product",
                "rough_duration_s": 9.0,
                "intention_copy": "独立展示粉扑轻拍上脸和自然柔焦妆效，承接产品质地段",
                "required_meaning": "女性用粉扑轻拍上脸，妆效自然服帖、不厚重",
                "required_visual": "女性用粉扑轻拍上脸、自然妆效近景",
                "avoid": ["不要混入礼盒、精华液、遇水测试或手臂试色"],
                "keywords": ["粉扑", "轻拍", "上脸", "柔焦", "服帖"],
                "voice_text": "上脸的时候用粉扑轻轻拍开，妆面会很快贴住皮肤，不会一下子变厚。脸上的气色是自然提起来的，近看也不会有明显粉感。",
                "tts_text": pronounce_text("上脸的时候用粉扑轻轻拍开，妆面会很快贴住皮肤，不会一下子变厚。脸上的气色是自然提起来的，近看也不会有明显粉感。"),
            },
        )
    full_text = "".join(section["voice_text"] for section in output)
    if len(full_text) < min_chars:
        for section in output:
            if str(section.get("role") or "") == "opening":
                extra = "尤其是早八通勤或者临时补妆，越是赶时间，越需要这种不费手的底妆。"
                if extra not in str(section.get("voice_text") or ""):
                    section["voice_text"] = f"{section['voice_text']}{extra}"
                    section["tts_text"] = pronounce_text(section["voice_text"])
                break
    full_text = "".join(section["voice_text"] for section in output)
    if len(full_text) < min_chars:
        for section in output:
            if str(section.get("section_id") or "") == "sec_apply_effect":
                extra = "不用反复叠很多层，镜头近一点看也会更干净。"
                if extra not in str(section.get("voice_text") or ""):
                    section["voice_text"] = f"{section['voice_text']}{extra}"
                    section["tts_text"] = pronounce_text(section["voice_text"])
                break
    full_text = "".join(section["voice_text"] for section in output)
    if len(full_text) < min_chars:
        for section in output:
            if str(section.get("role") or "") == "product" and any(
                term in str(section.get("required_visual") or "") + str(section.get("voice_text") or "")
                for term in ("上脸", "轻拍", "妆效", "粉扑")
            ):
                extra = "不用反复叠很多层，镜头近一点看也会更干净。"
                if extra not in str(section.get("voice_text") or ""):
                    section["voice_text"] = f"{section['voice_text']}{extra}"
                    section["tts_text"] = pronounce_text(section["voice_text"])
                break
    for index, section in enumerate(output, start=1):
        section["timeline_order"] = index
        section_id = str(section.get("section_id") or "")
        if section_id.startswith("section_") or section_id == "sec_apply_effect":
            section["section_id"] = f"sec_{index}_{section.get('role') or 'product'}"
    return output, warnings


def build_revision_prompt(
    task_brief: dict[str, Any],
    raw_plan: dict[str, Any],
    material_capabilities: dict[str, Any],
    target_duration_s: float,
    variant: str,
    min_voice_chars: int,
    max_voice_chars: int,
    reason: str,
) -> dict[str, Any]:
    return {
        "task": "重写压缩 Voah 美妆带货混剪口播，修正文案长度和断句问题。",
        "product": safe_product_for_prompt(task_brief),
        "target_platform": task_brief.get("task", {}).get("target_platform") or "douyin",
        "target_duration_s": target_duration_s,
        "target_voice_characters": {
            "min": min_voice_chars,
            "max": max_voice_chars,
            "note": "必须统计 script_sections[].voice_text 拼接后的总字数；标点也计入。",
        },
        "variant": f"{variant}_rewrite",
        "rewrite_reason": reason,
        "user_brief": task_brief.get("inputs", {}).get("user_brief") or {},
        "product_claims": task_brief.get("product_claims") or [],
        "product_campaigns": task_brief.get("product_campaigns") or [],
        "copy_parameters": task_brief.get("copy_parameters") or {},
        "material_capabilities": material_capabilities,
        "constraints": task_brief.get("constraints") or [],
        "original_plan": raw_plan,
        "hard_rules": [
            "保留原销售逻辑：痛点 -> 产品/妆效 -> 稳定性证明 -> 便携/礼盒 -> 活动 CTA。",
            "product_claims 中 tier=core 的核心卖点必须作为主线重点表达；tier=support 只能点缀，不要平均用力。",
            "必须重新写 script_sections[].voice_text，不要简单截断原文。",
            f"full_voice_text 必须落在 {min_voice_chars}-{max_voice_chars} 字之间。",
            "每一句都必须是完整自然中文，不允许出现“整。”“补。”“很。”这类残句。",
            "proof 段禁止写测试部位，也不要写滴几滴水、少量水、水珠等动作力度；只能泛化为倒水测试/遇水测试后妆面稳定。",
            "cta 段只写礼盒装、活动价、多款外壳/陈列、自用送人和下单，25-38 字。",
            "重写时必须贴合 material_capabilities；required_visual 不要写素材库没有的硬画面词。",
            "不要虚构具体价格、库存数字或赠品细节。",
            *product_naming_rules(task_brief),
            "required_meaning/required_visual 要和新的 voice_text 一致，供后续素材召回使用。",
            "输出严格 JSON，不要 Markdown。",
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
                    "required_visual": "通用画面需求，只能写产品/上脸/补妆/携带/陈列等可泛化类型",
                    "avoid": ["不能写什么"],
                    "keywords": ["关键词"],
                    "voice_text": "完整自然的一段口播原文",
                }
            ],
        },
    }


def build_prompt(
    task_brief: dict[str, Any],
    material_capabilities: dict[str, Any],
    target_duration_s: float,
    variant: str,
) -> dict[str, Any]:
    min_voice_chars, max_voice_chars = target_voice_char_range(target_duration_s)
    return {
        "task": "为 Voah 美妆带货混剪生成 copy_brief 和 voice_script。",
        "product": safe_product_for_prompt(task_brief),
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
        "product_campaigns": task_brief.get("product_campaigns") or [],
        "copy_parameters": task_brief.get("copy_parameters") or {},
        "material_capabilities": material_capabilities,
        "constraints": task_brief.get("constraints") or [],
        "hard_rules": [
            "先定全片销售逻辑，再写连续口播。",
            "product_claims 中 tier=core 的核心卖点必须作为主线重点表达；tier=support 只能点缀，不要平均用力。",
            "产品卖点、活动优惠、CTA 和禁忌以 product_claims、product_campaigns、copy_parameters 为准；素材 ASR 只作为画面能力参考，不要另写一套冲突卖点或活动。",
            "文案不绑定具体 shot，不要写“画面里/这里看到”这类依赖镜头的表达。",
            "每个 section 必须给 required_meaning 和 required_visual，供 TTS 后按语义召回素材。",
            "必须参考 material_capabilities：required_visual 优先使用素材库真实出现的画面词和动作，不要写库存里没有的硬画面。",
            "required_visual 只能写可召回画面类型，例如产品特写、开盖粉芯、上脸轻拍、补妆动作、倒水/泼水/擦拭测试、礼盒陈列；不要写办公室、海边、车内、上班路、约会等素材库未明确给出的硬场景。",
            "卡粉/卡纹/斑驳/脱妆/泛油/油光/地铁这类具体痛点，只有出现在 material_capabilities.strong_visual_terms 或 high_evidence_terms 时才能写成明确视觉诉求。",
            "material_capabilities.weak_problem_terms 里的词不要写进 opening 的 voice_text 和 required_visual；改写成通勤补妆、自然气色、轻薄服帖、粉感不厚重等泛化需求。",
            "如果素材能力里没有毛孔、瑕疵、纸巾、前后对比，就不要把这些词写进 required_visual；可以把口播改成更泛化的自然妆感、服帖、不容易斑驳。",
            "产品段不要写高浓度精华、精华液、奶油肌、天生好皮等肉眼难证明或需要特写证据的词；优先写开盖粉芯、粉扑轻拍、自然柔焦、轻薄服帖、上脸顺手。",
            "同一个 product 段只能围绕一个视觉主题：讲上脸妆效就只写粉扑轻拍/自然妆效；讲产品细节就只写开盖粉芯/取粉质地；讲礼盒 CTA 才写礼盒/外壳/陈列，不能把三类画面塞进同一段 required_visual。",
            "痛点开场优先围绕 safe_opening_terms 写；如果 safe_opening_terms 只有补妆/轻拍/上脸/产品，就不要写脱妆、油光、地铁等需要强视觉证据的痛点。",
            "稳定性证明如果素材是倒水、泼水、擦拭，就按这些动作写；不要改写成纸巾按压。",
            "不要把不同素材里的动作对象拼成一句硬描述；例如素材既有粉芯吸水又有人脸倒水时，voice_text 只能写“做个遇水测试/倒水测试”，不要写“往粉芯倒水”或“用纸巾擦粉芯”。",
            "证明段禁止写具体测试部位，例如手臂、脸、粉芯、粉面；也禁止写滴几滴水、少量水、水珠等动作力度；只写“做个倒水测试/遇水测试，妆面依然稳定”。",
            "required_visual 可以列多个可选画面，但 voice_text 只能说这些画面都能支撑的泛化语义，避免音画对象错配。",
            "如果想表达日常/通勤/出门，只能写成可由产品画面支撑的泛化需求，例如自然妆效近景；不要在 CTA 段写通勤补妆、放包、出门等需要额外画面的内容。",
            "CTA 段只允许写礼盒装、活动价、多款外壳/陈列、自用送人、下单；控制在 25-38 字，避免素材时长不够。",
            "如果 product_campaigns 或 copy_parameters.offer 为空，CTA 只能写通用下单引导，不要虚构具体活动。",
            "字幕文本真源是 full_voice_text，不要另写摘要字幕。",
            "不要虚构价格、库存、赠品必然有，不写医疗或绝对化功效。",
            *product_naming_rules(task_brief),
            "总口播长度尽量贴近目标时长；本项目当前女声 speed=1.1，中文口播按每秒 5.8-6.2 字估算。",
            f"script_sections[].voice_text 拼接后的总字数必须控制在 {min_voice_chars}-{max_voice_chars} 字之间，宁可少一点也不要超长。",
            "如果目标 45 秒，full_voice_text 控制在 230-270 字附近，避免 TTS 后短到 30 多秒或长到 55 秒。",
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


def safe_product_for_prompt(task_brief: dict[str, Any]) -> dict[str, Any]:
    product = dict(task_brief.get("product") or {})
    slug = str(product.get("slug") or "").strip()
    name = str(product.get("name") or "").strip()
    brand = str(product.get("brand") or "").strip()
    if is_invalid_product_name(name, slug):
        name = ""
    output = {"slug": slug, "name": name, "brand": brand}
    if not name and not brand:
        output["generic_name"] = generic_product_name(slug)
    return output


def product_naming_rules(task_brief: dict[str, Any]) -> list[str]:
    product = safe_product_for_prompt(task_brief)
    rules = [
        "产品 slug 只是内部文件标识，绝不能当品牌名或产品名写入口播。",
        "品牌字段有明确值时才允许提品牌；品牌为空时不要提任何品牌名。",
    ]
    if not product.get("name") and not product.get("brand"):
        generic = product.get("generic_name") or "这款产品"
        rules.append(f"当前没有有效品牌/产品名，口播只能使用“{generic}”“这款产品”等泛称，禁止脑补 Voah 或 slug 音译。")
    return rules


def generic_product_name(slug: str) -> str:
    text = str(slug or "")
    if "qidian" in text or "cushion" in text:
        return "这盒气垫"
    if "kouhong" in text or "lip" in text:
        return "这支口红"
    return "这款产品"


def is_invalid_product_name(name: str, slug: str) -> bool:
    value = str(name or "").strip()
    if not value:
        return True
    if slug and value == slug:
        return True
    if re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,}", value, flags=re.I):
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Voah copy_brief.json and voice_script.json with the configured text LLM.")
    parser.add_argument("--task-brief", required=True)
    parser.add_argument("--task-dir", default=None)
    parser.add_argument("--target-duration-s", type=float, default=45)
    parser.add_argument("--variant", default="v1")
    parser.add_argument("--timeout-s", type=int, default=240)
    parser.add_argument("--copy-brief-output", default="copy_brief.json")
    parser.add_argument("--voice-script-output", default="voice_script.json")
    parser.add_argument("--shot-index", default="")
    args = parser.parse_args()

    workspace = Path(__file__).resolve().parents[1]
    load_env_files([workspace / ".env", Path.home() / ".voah" / "video_intake" / ".env"])

    task_brief_path = as_abs(args.task_brief)
    task_dir = as_abs(args.task_dir) if args.task_dir else task_brief_path.parent
    copy_brief_path = as_abs(args.copy_brief_output, task_dir)
    voice_script_path = as_abs(args.voice_script_output, task_dir)
    shot_index_path = as_abs(args.shot_index) if args.shot_index else None
    task_brief = load_json(task_brief_path)
    material_capabilities = compact_material_capabilities(shot_index_path)

    prompt = build_prompt(task_brief, material_capabilities, args.target_duration_s, args.variant)
    raw_plan, safe_response = call_copy_llm(prompt, args.timeout_s)
    sections = normalize_sections(raw_plan.get("script_sections") or [])
    min_voice_chars, max_voice_chars = target_voice_char_range(args.target_duration_s)
    revision_responses: list[dict[str, Any]] = []
    full_voice_text = "".join(section["voice_text"] for section in sections)
    for attempt in range(1, 4):
        if min_voice_chars <= len(full_voice_text) <= max_voice_chars and not has_dangling_short_sentence(full_voice_text):
            break
        reason = (
            f"attempt {attempt}: full_voice_text chars={len(full_voice_text)}, "
            f"target={min_voice_chars}-{max_voice_chars}, dangling_sentence={has_dangling_short_sentence(full_voice_text)}"
        )
        revision_prompt = build_revision_prompt(
            task_brief,
            raw_plan,
            material_capabilities,
            args.target_duration_s,
            args.variant,
            min_voice_chars,
            max_voice_chars,
            reason,
        )
        revised_plan, revised_safe_response = call_copy_llm(revision_prompt, args.timeout_s)
        revised_sections = normalize_sections(revised_plan.get("script_sections") or [])
        revised_full_text = "".join(section["voice_text"] for section in revised_sections)
        revision_responses.append({**revised_safe_response, "revision_reason": reason})
        raw_plan = revised_plan
        safe_response = revised_safe_response
        sections = revised_sections
        full_voice_text = revised_full_text

    auto_trim_warnings: list[str] = []
    if len(full_voice_text) > max_voice_chars:
        sections, auto_trim_warnings = enforce_voice_char_limit(sections, max_voice_chars)
        full_voice_text = "".join(section["voice_text"] for section in sections)
    rebalance_warnings: list[str] = []
    if len(full_voice_text) < min_voice_chars:
        sections, rebalance_warnings = rebalance_short_script(sections, min_voice_chars)
        full_voice_text = "".join(section["voice_text"] for section in sections)
    pronounce = "".join(section["tts_text"] for section in sections)
    warnings: list[str] = [*auto_trim_warnings, *rebalance_warnings]
    if len(full_voice_text) < min_voice_chars:
        warnings.append("voice_text may be short for target duration")
    if len(full_voice_text) > max_voice_chars:
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
            "shot_index": str(shot_index_path) if shot_index_path else "",
            "material_capabilities_available": bool(material_capabilities.get("available")),
        },
        "provider": {
            "name": safe_response["provider"],
            "model": safe_response["model"],
            "endpoint": safe_response["endpoint"],
            "usage": safe_response.get("usage") or {},
        },
        "sales_logic": raw_plan.get("sales_logic") or {},
        "product_claims": task_brief.get("product_claims") or [],
        "material_capabilities_summary": material_capabilities,
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
            "estimated_duration_s": round(len(full_voice_text) / 6.0, 2),
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
            "revision_responses": revision_responses,
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
