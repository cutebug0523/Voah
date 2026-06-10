#!/usr/bin/env python3
"""Retrieve story units for Voah audio sections and render a preview video."""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


SEARCH_SCRIPT = Path("/Users/noah/.codex/skills/voah-shot-retrieval/scripts/search.py")
DEFAULT_MAX_CHILD_CLIPS_PER_STORY_UNIT_PER_SECTION = 2

DOMAIN_TERMS = [
    "SPF50+",
    "SPF",
    "PA+++",
    "PA",
    "紫外线",
    "测试卡",
    "感应卡",
    "防晒值",
    "防晒力",
    "防晒",
    "防水",
    "防汗",
    "出汗",
    "脱妆",
    "卡粉",
    "卡纹",
    "斑驳",
    "油光",
    "泛油",
    "细纹",
    "遇水",
    "倒水",
    "泼水",
    "水流",
    "喷洒",
    "测试",
    "擦拭",
    "纸巾",
    "海边",
    "海滩",
    "海景",
    "沙滩",
    "湿发",
    "水珠",
    "浴巾",
    "户外",
    "持妆",
    "通勤",
    "上班",
    "车里",
    "车内",
    "车内补妆",
    "出去玩",
    "气色",
    "快速",
    "补妆",
    "开盖",
    "蘸粉",
    "粉扑",
    "轻拍",
    "泛红",
    "暗沉",
    "柔焦",
    "干净",
    "四效合一",
    "底妆",
    "定妆",
    "礼盒",
    "赠品",
    "618",
    "直播间",
]

TERM_ALIASES = {
    "SPF50+": ["SPF50", "SPF五十"],
    "PA+++": ["PA三个加"],
    "紫外线": ["UV"],
    "测试卡": ["感应卡"],
    "防晒": ["防晒值", "防晒力"],
    "遇水": ["泼水", "倒水", "水流", "喷洒", "喷水", "水珠", "水滴", "防水"],
    "倒水": ["泼水", "水流", "倾倒", "遇水", "喷水"],
    "泼水": ["倒水", "水流", "遇水", "喷洒", "喷水", "水珠", "水滴"],
    "防水": ["遇水", "泼水", "喷水", "水珠", "水滴", "水流"],
    "出汗": ["汗", "高温"],
    "脱妆": ["斑驳", "花妆", "掉妆"],
    "卡粉": ["卡纹", "细纹"],
    "卡纹": ["卡粉", "细纹"],
    "斑驳": ["脱妆", "花妆"],
    "油光": ["泛油", "出油"],
    "泛油": ["油光", "出油"],
    "海边": ["海滩", "沙滩", "海景"],
    "湿发": ["水珠", "浴巾"],
    "车里": ["车内", "车上", "车内补妆"],
    "车内": ["车里", "车上", "车内补妆"],
    "出去玩": ["户外", "出游"],
    "气色": ["素颜", "带妆"],
    "礼盒": ["套装"],
    "赠品": ["送"],
    "618": ["六一八", "大促"],
}

OPENING_SOLUTION_PROOF_TERMS = [
    "倒水",
    "泼水",
    "遇水",
    "防水",
    "防汗",
    "测试",
    "擦拭",
    "妆容未花",
    "不渗水",
    "吸水",
    "水滴",
    "实证",
    "验证",
]

PRODUCT_TEXTURE_FORBIDDEN_PROOF_TERMS = [
    "礼盒",
    "套装",
    "面膜",
    "手臂",
    "试色",
    "晕染",
    "精华",
    "精华液",
    "灵芝",
    "高浓",
    "高浓度",
    "60倍",
    "六十倍",
    "爆浆",
    "妆养",
    "养肤",
    "护肤级",
    "水珠",
    "水滴",
    "遇水",
    "泼水",
    "倒水",
    "防水",
    "防汗",
    "测试",
    "擦拭",
]

PRODUCT_TEXTURE_SECTION_TERMS = [
    "粉芯",
    "膏体",
    "取粉",
    "贴肤",
    "服帖",
    "质感",
    "开盖",
    "礼盒",
    "外壳",
    "款式",
    "陈列",
    "国风",
]

OPENING_ALLOWED_SOLUTION_TERMS = [
    "遇水",
    "防水",
    "防汗",
    "倒水",
    "泼水",
    "测试",
    "擦拭",
    "稳定",
    "持妆证明",
]

CTA_PRODUCT_USE_TERMS = [
    "上妆",
    "轻拍",
    "粉扑",
    "脸颊",
    "额头",
    "下巴",
    "眼下",
    "鼻翼",
    "妆效",
    "微笑示意",
    "使用效果",
]

FACE_APPLY_TERMS = [
    "粉扑",
    "轻拍",
    "上脸",
    "面部",
    "脸颊",
    "脸上",
    "补妆",
    "妆效",
    "底妆",
    "气色",
    "柔焦",
    "服帖",
    "服贴",
    "清透",
    "清爽",
    "自然",
]

FACE_APPLY_STRONG_TERMS = [
    "粉扑",
    "轻拍",
    "上脸",
    "面部",
    "脸颊",
    "脸上",
    "妆效",
    "底妆",
    "气色",
    "柔焦",
    "服帖",
    "服贴",
    "清透",
]

PRODUCT_DETAIL_TERMS = [
    "开盖",
    "打开",
    "粉芯",
    "膏体",
    "取粉",
    "质地",
    "镜面",
    "气垫盒",
    "粉底液",
    "外观",
    "手持",
]

PRODUCT_CORE_DETAIL_TERMS = [
    "开盖",
    "打开",
    "粉芯",
    "膏体",
    "取粉",
    "质地",
    "镜面",
    "粉底液",
]

PACKAGING_TERMS = [
    "礼盒",
    "陈列",
    "外壳",
    "托盘",
    "多款",
    "套装",
    "替换装",
    "周边",
    "活动价",
    "自用",
    "送人",
]

PACKAGING_FORBIDDEN_FOR_FACE_APPLY = [
    term
    for term in PACKAGING_TERMS
    if term not in {"活动价", "自用", "送人"}
]

PROOF_TEST_TERMS = [
    "遇水",
    "倒水",
    "泼水",
    "防水",
    "防汗",
    "测试",
    "擦拭",
    "水流",
    "水珠",
    "喷洒",
    "纸巾",
    "按压",
    "不脱妆",
    "不渗透",
    "酱汁",
]

PROOF_VISUAL_ACTION_TERMS = [
    "泼水",
    "倒水",
    "倾倒",
    "水流",
    "喷洒",
    "水雾",
    "水珠",
    "水滴",
    "纸巾",
    "按压",
    "擦拭",
    "酱汁",
    "不渗透",
    "不脱妆",
]

STRONG_PROOF_OR_FORMULA_TERMS = [
    "精华",
    "精华液",
    "灵芝",
    "高浓",
    "高浓度",
    "60倍",
    "六十倍",
    "爆浆",
    "妆养",
    "养肤",
    *PROOF_TEST_TERMS,
]


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_search_module():
    spec = importlib.util.spec_from_file_location("voah_search", SEARCH_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load search module: {SEARCH_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        f.write(text)


def load_env_files(paths: list[Path]) -> None:
    for path in paths:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def run_command(command: list[str], input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    if input_bytes is not None:
        return subprocess.run(command, input=input_bytes, check=False, capture_output=True)
    return subprocess.run(command, check=False, capture_output=True, text=True)


def escape_concat_path(path: Path) -> str:
    return str(path.resolve()).replace("'", "'\\''")


def probe_duration(path: Path) -> float | None:
    if not path.exists():
        return None
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


def probe_media(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"exists": False}
    proc = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
            "-show_entries",
            "format=duration,size,bit_rate",
            "-of",
            "json",
            str(path),
        ]
    )
    if proc.returncode != 0:
        return {"exists": True, "error": (proc.stderr or proc.stdout).strip()}
    data = json.loads(proc.stdout or "{}")
    data["exists"] = True
    return data


def safe_filename(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z_.-]+", "_", value or "").strip("_") or "clip"


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def text_blob(record: dict[str, Any]) -> str:
    parts = [
        record.get("label", ""),
        record.get("visual_summary", ""),
        record.get("source_meaning", ""),
        str(record.get("source_asr", "")),
        " ".join(str(item) for item in record.get("source_ocr") or []),
        " ".join(record.get("selling_points") or []),
        " ".join(record.get("visual_actions") or []),
        " ".join(record.get("timeline_roles") or []),
        record.get("shot_type", ""),
    ]
    return " ".join(str(part) for part in parts if part)


def candidate_full_text_blob(record: dict[str, Any]) -> str:
    parts = [text_blob(record)]
    for child in record.get("child_physical_shots") or []:
        if isinstance(child, dict):
            parts.append(child_text_blob(child))
            parts.append(child_parent_context_blob(child))
    return " ".join(str(part) for part in parts if part)


def normalized(value: str) -> str:
    return str(value or "").lower()


def split_query_terms(value: str) -> list[str]:
    tokens = [
        item
        for item in re.split(r"[\s，。！？、,.!?；;：/]+", value)
        if 2 <= len(item) <= 10
    ]
    return list(dict.fromkeys(tokens))


def section_query(section: dict[str, Any]) -> str:
    parts = [
        section.get("intention_copy", ""),
        section.get("required_meaning", ""),
        section.get("required_visual", ""),
        section.get("voice_text", ""),
        " ".join(section.get("keywords") or []),
    ]
    return " ".join(str(part) for part in parts if part)


def section_terms(section: dict[str, Any]) -> list[tuple[str, float]]:
    weighted: dict[str, float] = {}

    def add(term: str, weight: float) -> None:
        value = str(term or "").strip()
        if len(value) < 2:
            return
        weighted[value] = max(weighted.get(value, 0.0), weight)

    for keyword in section.get("keywords") or []:
        add(str(keyword), 1.05)

    fields = [
        ("required_visual", 1.1),
        ("required_meaning", 1.0),
        ("intention_copy", 0.85),
        ("voice_text", 0.75),
    ]
    for field, weight in fields:
        value = str(section.get(field) or "")
        for term in DOMAIN_TERMS:
            if term in value:
                add(term, weight)
        for token in split_query_terms(value):
            add(token, min(weight, 0.55))

    return sorted(weighted.items(), key=lambda item: item[1], reverse=True)


def term_variants(term: str) -> list[str]:
    return [term, *(TERM_ALIASES.get(term) or [])]


def term_hit_info(record: dict[str, Any], section: dict[str, Any]) -> list[dict[str, Any]]:
    blob = normalized(candidate_full_text_blob(record))
    hits: list[dict[str, Any]] = []
    for term, weight in section_terms(section):
        variants = term_variants(term)
        if any(normalized(variant) in blob for variant in variants):
            hits.append({"term": term, "weight": weight})
    return hits


def source_run_dir_from_index(index: dict[str, Any], index_path: Path) -> Path:
    source = str(index.get("source_run_dir") or "").strip()
    return as_abs(source) if source else index_path.parent


def shot_id_of(record: dict[str, Any]) -> str:
    return str(record.get("shot_id") or record.get("id") or "")


def time_range_of(record: dict[str, Any]) -> list[float]:
    raw = record.get("time_range")
    if isinstance(raw, list) and len(raw) >= 2:
        return [safe_float(raw[0]), safe_float(raw[1])]
    start = safe_float(record.get("start_s") if record.get("start_s") is not None else record.get("start_time"))
    end = safe_float(record.get("end_s") if record.get("end_s") is not None else record.get("end_time"), start)
    return [start, end]


def usable_range_of(record: dict[str, Any]) -> list[float]:
    raw = record.get("usable_range")
    if isinstance(raw, list) and len(raw) >= 2:
        return [safe_float(raw[0]), safe_float(raw[1])]
    start, end = time_range_of(record)
    usable_start = safe_float(record.get("usable_start"), start)
    usable_end = safe_float(record.get("usable_end"), end)
    return [usable_start, usable_end]


def normalize_child_physical_shot(record: dict[str, Any]) -> dict[str, Any]:
    start, end = time_range_of(record)
    usable_start, usable_end = usable_range_of(record)
    return {
        "shot_id": shot_id_of(record),
        "parent_shot_id": str(record.get("parent_shot_id") or record.get("story_unit_id") or record.get("semantic_shot_id") or ""),
        "story_unit_id": str(record.get("story_unit_id") or record.get("parent_shot_id") or record.get("semantic_shot_id") or ""),
        "asset_id": str(record.get("asset_id") or ""),
        "label": str(record.get("label") or ""),
        "time_range": [start, end],
        "usable_range": [usable_start, usable_end],
        "duration_s": round(max(0.0, usable_end - usable_start), 3),
        "clip_actual_duration_s": record.get("clip_actual_duration_s"),
        "clip_frames": record.get("clip_frames"),
        "trim_end_epsilon_s": record.get("trim_end_epsilon_s"),
        "visual_summary": str(record.get("visual_summary") or ""),
        "source_meaning": str(record.get("source_meaning") or ""),
        "source_asr": record.get("source_asr") or "",
        "source_ocr": record.get("source_ocr") or [],
        "parent_visual_summary": str(record.get("parent_visual_summary") or ""),
        "parent_source_meaning": str(record.get("parent_source_meaning") or ""),
        "parent_source_asr": record.get("parent_source_asr") or "",
        "parent_source_ocr": record.get("parent_source_ocr") or [],
        "child_metadata_precision": str(record.get("child_metadata_precision") or record.get("metadata_source") or ""),
        "metadata_source": str(record.get("metadata_source") or record.get("child_metadata_precision") or ""),
        "text_embedding_policy": str(record.get("text_embedding_policy") or ""),
        "needs_vlm_refine": bool(record.get("needs_vlm_refine")),
        "selling_points": record.get("selling_points") or [],
        "parent_selling_points": record.get("parent_selling_points") or [],
        "visual_actions": record.get("visual_actions") or [],
        "parent_visual_actions": record.get("parent_visual_actions") or [],
        "shot_type": str(record.get("shot_type") or record.get("shot_type_hint") or ""),
        "parent_shot_type": str(record.get("parent_shot_type") or ""),
        "hard_subtitle_risk": record.get("hard_subtitle_risk"),
        "voiceover_fit": record.get("voiceover_fit"),
        "can_standalone": bool(record.get("can_standalone")),
        "trimmed_clip_path": str(record.get("trimmed_clip_path") or record.get("source_clip_path") or ""),
        "trimmed_oss_url": str(record.get("trimmed_oss_url") or ""),
    }


def load_physical_rows(source_run_dir: Path) -> list[dict[str, Any]]:
    path = source_run_dir / "physical_shots.json"
    if not path.exists():
        return []
    rows = load_json(path)
    if isinstance(rows, dict):
        rows = rows.get("physical_shots") or rows.get("shots") or rows.get("records") or []
    return [row for row in rows if isinstance(row, dict)]


def ensure_child_physical_shots(index: dict[str, Any], index_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    source_run_dir = source_run_dir_from_index(index, index_path)
    physical_rows = load_physical_rows(source_run_dir)
    physical_by_parent: dict[str, list[dict[str, Any]]] = {}
    physical_by_id: dict[str, dict[str, Any]] = {}
    for row in physical_rows:
        child = normalize_child_physical_shot(row)
        child_id = child.get("shot_id")
        if not child_id:
            continue
        physical_by_id[child_id] = child
        parent_id = str(child.get("parent_shot_id") or child.get("story_unit_id") or "")
        if parent_id:
            physical_by_parent.setdefault(parent_id, []).append(child)
    for children in physical_by_parent.values():
        children.sort(key=lambda item: safe_float((item.get("time_range") or [0, 0])[0]))

    for record in index.get("records", []):
        if not isinstance(record, dict):
            continue
        children = record.get("child_physical_shots") or []
        normalized_children = [normalize_child_physical_shot(item) for item in children if isinstance(item, dict)]
        if not normalized_children:
            child_ids = [str(item) for item in record.get("child_physical_shot_ids") or []]
            normalized_children = [physical_by_id[item] for item in child_ids if item in physical_by_id]
        if not normalized_children:
            normalized_children = physical_by_parent.get(str(record.get("shot_id") or ""), [])
        record["child_physical_shots"] = normalized_children
        if normalized_children:
            record["child_physical_shot_ids"] = [str(item.get("shot_id")) for item in normalized_children if item.get("shot_id")]
            record["child_clip_paths"] = [
                str(item.get("trimmed_clip_path"))
                for item in normalized_children
                if item.get("trimmed_clip_path")
            ]
    contract = boundary_contract(index, source_run_dir, physical_rows)
    return index, contract


def boundary_contract(index: dict[str, Any], source_run_dir: Path, physical_rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(physical_rows)
    with_epsilon = sum(1 for item in physical_rows if item.get("trim_end_epsilon_s") not in (None, ""))
    with_frames = sum(1 for item in physical_rows if item.get("clip_frames") not in (None, ""))
    with_duration = sum(1 for item in physical_rows if item.get("clip_actual_duration_s") not in (None, ""))
    story_records = [item for item in index.get("records", []) if item.get("planning_granularity") == "story_unit"]
    story_with_children = sum(1 for item in story_records if item.get("child_physical_shots"))
    warnings: list[str] = []
    if total == 0:
        warnings.append("intake 缺少 physical_shots.json，无法保证半开裁切和子镜头定位")
    else:
        if with_epsilon < total:
            warnings.append(f"physical_shots 中 {total - with_epsilon}/{total} 条缺少 trim_end_epsilon_s")
        if with_frames < total:
            warnings.append(f"physical_shots 中 {total - with_frames}/{total} 条缺少 clip_frames")
        if with_duration < total:
            warnings.append(f"physical_shots 中 {total - with_duration}/{total} 条缺少 clip_actual_duration_s")
    if story_records and story_with_children < len(story_records):
        warnings.append(f"story unit 中 {len(story_records) - story_with_children}/{len(story_records)} 条缺少 child_physical_shots")
    return {
        "source_run_dir": str(source_run_dir),
        "physical_shot_count": total,
        "physical_with_trim_end_epsilon": with_epsilon,
        "physical_with_clip_frames": with_frames,
        "physical_with_clip_actual_duration": with_duration,
        "story_unit_count": len(story_records),
        "story_units_with_children": story_with_children,
        "trim_interval": "[start,end)",
        "end_epsilon_policy": "1/fps when available",
        "status": "ok" if not warnings else "manual_review",
        "warnings": warnings,
    }


def candidate_ids(candidates: list[dict[str, Any]]) -> list[str]:
    return [str(item.get("shot_id")) for item in candidates if item.get("shot_id")]


def role_for_search(role: str | None) -> str:
    if role in ("opening", "proof", "product", "cta", "transition"):
        return role
    if role in ("product_intro", "product_effect"):
        return "product"
    if role in ("proof_test", "outdoor", "outdoor_scene"):
        return "proof"
    if role in ("trust", "trust_endorsement"):
        return "cta"
    return ""


def duration_score(duration: float, target: float) -> float:
    if duration <= 0 or target <= 0:
        return -0.2
    if duration >= target:
        return 0.18 - min(0.08, (duration - target) * 0.01)
    ratio = duration / target
    return -0.22 * (1 - ratio)


def local_keyword_bonus(record: dict[str, Any], section: dict[str, Any]) -> float:
    hits = keyword_hits(record, section)
    return min(0.12, len(hits) * 0.02)


def keyword_hits(record: dict[str, Any], section: dict[str, Any]) -> list[str]:
    return [item["term"] for item in term_hit_info(record, section)]


def required_visual_terms(section: dict[str, Any]) -> list[str]:
    value = str(section.get("required_visual") or "")
    terms: list[str] = []
    for term in DOMAIN_TERMS:
        if term in value and term not in terms:
            terms.append(term)
    for token in split_query_terms(value):
        if token not in terms:
            terms.append(token)
    return terms


def term_in_blob(term: str, blob: str) -> bool:
    return any(normalized(variant) in blob for variant in term_variants(term))


def hits_for_terms(blob: str, terms: list[str]) -> list[str]:
    return [term for term in terms if term in blob]


def visual_theme_contract(section: dict[str, Any]) -> dict[str, Any]:
    query = section_query(section)
    role = str(section.get("role") or "")
    voice_text = str(section.get("voice_text") or "")
    themes: list[str] = []
    required_any: dict[str, list[str]] = {}
    forbidden: list[str] = []
    strict = False

    def add_theme(name: str, terms: list[str]) -> None:
        if name not in themes:
            themes.append(name)
        required_any[name] = terms

    if role == "cta" or any(term in query for term in PACKAGING_TERMS):
        add_theme("packaging", PACKAGING_TERMS)
        strict = True
    if role == "proof" or any(term in query for term in PROOF_TEST_TERMS):
        add_theme("proof_test", PROOF_TEST_TERMS)
        strict = True
    if any(term in query for term in PRODUCT_DETAIL_TERMS):
        add_theme("product_detail", PRODUCT_DETAIL_TERMS)
        if role == "product":
            strict = True
    if any(term in query for term in FACE_APPLY_TERMS):
        add_theme("face_apply", FACE_APPLY_TERMS)
        if role in ("opening", "product"):
            strict = True

    if role in ("opening", "product") and "face_apply" in themes and "product_detail" in themes:
        primary_text = voice_text if voice_text else query
        face_index = min((primary_text.find(term) for term in FACE_APPLY_TERMS if term in primary_text), default=9999)
        detail_index = min((primary_text.find(term) for term in PRODUCT_DETAIL_TERMS if term in primary_text), default=9999)
        if face_index == detail_index == 9999:
            face_index = min((query.find(term) for term in FACE_APPLY_TERMS if term in query), default=9999)
            detail_index = min((query.find(term) for term in PRODUCT_DETAIL_TERMS if term in query), default=9999)
        keep = "face_apply" if face_index <= detail_index else "product_detail"
        themes = [keep]
        required_any = {keep: required_any[keep]}

    if "packaging" in themes and role == "cta":
        themes = ["packaging"]
        required_any = {"packaging": PACKAGING_TERMS}
        forbidden.extend(CTA_PRODUCT_USE_TERMS)
    elif "packaging" in themes and "product_detail" in themes:
        themes = ["product_detail"]
        required_any = {"product_detail": PRODUCT_CORE_DETAIL_TERMS}
    elif "packaging" in themes and "face_apply" in themes:
        themes = ["face_apply"]
        required_any = {"face_apply": FACE_APPLY_STRONG_TERMS}
        forbidden.extend(term for term in PACKAGING_FORBIDDEN_FOR_FACE_APPLY if term not in forbidden)
    elif "packaging" in themes:
        themes = ["packaging"]
        required_any = {"packaging": PACKAGING_TERMS}
    elif "proof_test" in themes:
        themes = ["proof_test"]
        required_any = {"proof_test": PROOF_TEST_TERMS}
    elif "face_apply" in themes:
        required_any = {"face_apply": FACE_APPLY_STRONG_TERMS}
        forbidden.extend(term for term in PACKAGING_FORBIDDEN_FOR_FACE_APPLY if term not in forbidden)
        forbidden.extend(term for term in STRONG_PROOF_OR_FORMULA_TERMS if term not in forbidden)
    elif "product_detail" in themes:
        required_any = {"product_detail": PRODUCT_CORE_DETAIL_TERMS}
        forbidden.extend(term for term in PROOF_TEST_TERMS if term not in forbidden)
        forbidden.extend(term for term in PACKAGING_TERMS if term not in forbidden)

    forbidden = list(dict.fromkeys(forbidden))
    return {
        "themes": themes,
        "required_any": required_any,
        "forbidden": forbidden,
        "strict": strict,
    }


def visual_theme_eval(candidate: dict[str, Any], section: dict[str, Any]) -> dict[str, Any]:
    contract = visual_theme_contract(section)
    blob = candidate_full_text_blob(candidate)
    theme_hits = {
        theme: hits_for_terms(blob, terms)
        for theme, terms in (contract.get("required_any") or {}).items()
    }
    forbidden_hits = hits_for_terms(blob, contract.get("forbidden") or [])
    required_themes = contract.get("themes") or []
    missing_themes = [theme for theme in required_themes if not theme_hits.get(theme)]
    allowed = not forbidden_hits and (not contract.get("strict") or not missing_themes)
    return {
        "contract": contract,
        "theme_hits": theme_hits,
        "forbidden_hits": forbidden_hits,
        "missing_themes": missing_themes,
        "allowed": allowed,
    }


def visual_theme_allowed(candidate: dict[str, Any], section: dict[str, Any]) -> bool:
    return bool(visual_theme_eval(candidate, section).get("allowed"))


def visual_theme_reason(theme_eval: dict[str, Any]) -> str:
    contract = theme_eval.get("contract") or {}
    missing = theme_eval.get("missing_themes") or []
    forbidden = theme_eval.get("forbidden_hits") or []
    parts: list[str] = []
    if missing:
        parts.append(f"缺少视觉主题命中：{'、'.join(missing)}")
    if forbidden:
        parts.append(f"命中当前段禁用视觉：{'、'.join(forbidden[:8])}")
    if not parts and contract.get("themes"):
        parts.append("视觉主题合同通过")
    return "；".join(parts)


def section_is_opening_without_solution(section: dict[str, Any]) -> bool:
    if str(section.get("role") or "") != "opening":
        return False
    value = " ".join(
        [
            str(section.get("required_visual") or ""),
            str(section.get("required_meaning") or ""),
            str(section.get("voice_text") or ""),
            str(section.get("intention_copy") or ""),
            " ".join(str(item) for item in section.get("keywords") or []),
        ]
    )
    return not any(term in value for term in OPENING_ALLOWED_SOLUTION_TERMS)


def section_is_product_texture_without_proof(section: dict[str, Any]) -> bool:
    if str(section.get("role") or "") != "product":
        return False
    value = section_query(section)
    if any(term in value for term in OPENING_ALLOWED_SOLUTION_TERMS):
        return False
    return any(term in value for term in PRODUCT_TEXTURE_SECTION_TERMS)


def section_forbidden_hits(candidate: dict[str, Any], section: dict[str, Any]) -> list[str]:
    blob = candidate_full_text_blob(candidate)
    theme_eval = visual_theme_eval(candidate, section)
    theme_forbidden_hits = list(theme_eval.get("forbidden_hits") or [])
    if section_is_opening_without_solution(section):
        return list(dict.fromkeys(theme_forbidden_hits + [term for term in OPENING_SOLUTION_PROOF_TERMS if term in blob]))
    if section_is_product_texture_without_proof(section):
        return list(dict.fromkeys(theme_forbidden_hits + [term for term in PRODUCT_TEXTURE_FORBIDDEN_PROOF_TERMS if term in blob]))
    if section_is_cta_packaging(section):
        return list(dict.fromkeys(theme_forbidden_hits + [term for term in CTA_PRODUCT_USE_TERMS if term in blob]))
    return theme_forbidden_hits


def section_forbidden_reason(section: dict[str, Any], forbidden_hits: list[str]) -> str:
    terms = "、".join(forbidden_hits[:8])
    if section_is_opening_without_solution(section):
        return f"opening 痛点段禁止提前使用解决方案/证明素材：{terms}"
    if section_is_product_texture_without_proof(section):
        return f"产品质感/礼盒段禁止混入强功效演示素材：{terms}"
    if section_is_cta_packaging(section):
        return f"CTA 礼盒/活动段禁止混入上脸使用素材：{terms}"
    return f"当前段落禁止使用该候选素材：{terms}"


def candidate_allowed_for_section(candidate: dict[str, Any], section: dict[str, Any]) -> bool:
    return not section_forbidden_hits(candidate, section) and visual_theme_allowed(candidate, section)


def candidate_allowed_for_top_up(candidate: dict[str, Any], section: dict[str, Any]) -> bool:
    if not visual_theme_allowed(candidate, section):
        return False
    forbidden_hits = section_forbidden_hits(candidate, section)
    if not forbidden_hits:
        return True
    if str(section.get("role") or "") == "product" and (
        visual_theme_contract(section).get("themes") or []
    ) == ["product_detail"]:
        hard_forbidden = set(PROOF_TEST_TERMS) | {"礼盒", "套装", "面膜", "精华", "精华液", "灵芝", "60倍", "六十倍", "妆养"}
        return not any(term in hard_forbidden for term in forbidden_hits)
    if section_is_cta_packaging(section):
        return not any(term in CTA_PRODUCT_USE_TERMS for term in forbidden_hits)
    return False


def section_is_cta_packaging(section: dict[str, Any]) -> bool:
    if str(section.get("role") or "") != "cta":
        return False
    value = section_query(section)
    return any(term in value for term in ("礼盒", "陈列", "外壳", "款式", "套装", "活动价"))


def required_visual_hits(record: dict[str, Any], section: dict[str, Any]) -> list[str]:
    terms = required_visual_terms(section)
    blob = normalized(candidate_full_text_blob(record))
    return [term for term in terms if term_in_blob(term, blob)]


def required_visual_score(record: dict[str, Any], section: dict[str, Any]) -> float:
    hits = required_visual_hits(record, section)
    return round(sum(1.25 if term in DOMAIN_TERMS else 0.8 for term in hits), 3)


def section_requires_child_visual_hit(section: dict[str, Any]) -> bool:
    if not (required_visual_terms(section) or hard_visual_terms(section)):
        return False
    if required_visual_terms(section):
        return True
    if str(section.get("role") or "") == "proof":
        return True
    query = section_query(section)
    return any(term in query for term in PRODUCT_DETAIL_TERMS)


def child_required_visual_hits(child: dict[str, Any], section: dict[str, Any]) -> list[str]:
    terms = required_visual_terms(section) or hard_visual_terms(section)
    blob = normalized(child_text_blob(child))
    return [term for term in terms if term_in_blob(term, blob)]


def child_has_hard_visual_hit(child: dict[str, Any], section: dict[str, Any]) -> bool:
    return bool(child_required_visual_hits(child, section))


def candidate_hard_visual_child_hits(candidate: dict[str, Any], section: dict[str, Any]) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    for child in candidate.get("child_physical_shots") or []:
        if not isinstance(child, dict) or not is_child_renderable(child):
            continue
        child_hits = child_required_visual_hits(child, section)
        if child_hits:
            hits.append(
                {
                    "child_physical_shot_id": child.get("shot_id") or "",
                    "hits": child_hits,
                    "metadata_precision": child_metadata_precision(child),
                }
            )
    return hits


def candidate_has_child_visual_hit(candidate: dict[str, Any], section: dict[str, Any]) -> bool:
    return bool(candidate_hard_visual_child_hits(candidate, section))


def hard_visual_candidate_pool(candidates: list[dict[str, Any]], section: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    if not section_requires_child_visual_hit(section):
        return candidates, False
    hard_hit_candidates = [
        candidate
        for candidate in candidates
        if candidate_renderable(candidate) and candidate_has_child_visual_hit(candidate, section)
    ]
    if hard_hit_candidates:
        return hard_hit_candidates, False
    return candidates, True


def semantic_match_bonus(record: dict[str, Any], section: dict[str, Any]) -> tuple[float, list[str]]:
    hits = term_hit_info(record, section)
    if not hits:
        return 0.0, []
    score = min(0.34, sum(float(item["weight"]) for item in hits) * 0.045)
    terms = [str(item["term"]) for item in hits[:8]]
    return score, terms


def semantic_hit_weight(record: dict[str, Any], section: dict[str, Any]) -> float:
    return sum(float(item["weight"]) for item in term_hit_info(record, section))


def candidate_semantic_score(candidate: dict[str, Any]) -> float:
    try:
        return float(candidate.get("semantic_score") or 0)
    except (TypeError, ValueError):
        return 0.0


def qa_status_from(warnings: list[str], manual_reviews: list[str] | None = None, blocks: list[str] | None = None) -> str:
    if blocks:
        return "block"
    if warnings or manual_reviews:
        return "manual_review"
    return "ok"


def candidate_duration(candidate: dict[str, Any]) -> float:
    try:
        return max(0.0, float(candidate.get("duration_s") or candidate.get("source_duration_s") or 0))
    except (TypeError, ValueError):
        return 0.0


def candidate_renderable(candidate: dict[str, Any]) -> bool:
    if candidate.get("trimmed_clip_path") or candidate.get("source_clip_path"):
        return candidate_duration(candidate) > 0
    return any(
        isinstance(child, dict) and is_child_renderable(child)
        for child in candidate.get("child_physical_shots") or []
    )


def candidate_score(candidate: dict[str, Any]) -> float:
    try:
        return float(candidate.get("adjusted_score") if candidate.get("adjusted_score") is not None else candidate.get("score") or 0)
    except (TypeError, ValueError):
        return 0.0


def child_metadata_precision(child: dict[str, Any]) -> str:
    return str(child.get("child_metadata_precision") or child.get("metadata_source") or "").strip()


def child_text_is_verified(child: dict[str, Any]) -> bool:
    precision = child_metadata_precision(child)
    policy = str(child.get("text_embedding_policy") or "").strip()
    if precision in {"parent_context_only", "parent_story_unit_inherited"}:
        return False
    if policy == "video_only_until_child_vlm_refine":
        return False
    if child.get("needs_vlm_refine") and precision not in {
        "child_vlm_refined",
        "child_verified",
        "highlight_overlap",
        "story_unit_exact",
    }:
        return False
    return True


def child_parent_context_blob(child: dict[str, Any]) -> str:
    parts = [
        child.get("parent_visual_summary", ""),
        child.get("parent_source_meaning", ""),
        str(child.get("parent_source_asr", "")),
        " ".join(str(item) for item in child.get("parent_source_ocr") or []),
        " ".join(str(item) for item in child.get("parent_selling_points") or []),
        " ".join(str(item) for item in child.get("parent_visual_actions") or []),
        child.get("parent_shot_type", ""),
    ]
    return " ".join(str(part) for part in parts if part)


def child_text_blob(child: dict[str, Any]) -> str:
    if not child_text_is_verified(child):
        return ""
    parts = [
        child.get("label", ""),
        child.get("visual_summary", ""),
        child.get("source_meaning", ""),
        str(child.get("source_asr", "")),
        " ".join(str(item) for item in child.get("source_ocr") or []),
        " ".join(str(item) for item in child.get("selling_points") or []),
        " ".join(str(item) for item in child.get("visual_actions") or []),
        child.get("shot_type", ""),
    ]
    return " ".join(str(part) for part in parts if part)


def child_term_hit_info(child: dict[str, Any], section: dict[str, Any]) -> list[dict[str, Any]]:
    blob = normalized(child_text_blob(child))
    hits: list[dict[str, Any]] = []
    for term, weight in section_terms(section):
        variants = term_variants(term)
        if any(normalized(variant) in blob for variant in variants):
            hits.append({"term": term, "weight": weight})
    return hits


def child_semantic_weight(child: dict[str, Any], section: dict[str, Any]) -> float:
    return sum(float(item["weight"]) for item in child_term_hit_info(child, section))


def child_parent_context_hits(child: dict[str, Any], section: dict[str, Any]) -> list[str]:
    blob = normalized(child_parent_context_blob(child))
    if not blob:
        return []
    hits: list[str] = []
    for term, _weight in section_terms(section):
        if any(normalized(variant) in blob for variant in term_variants(term)):
            hits.append(term)
    return hits


def term_positions_in_text(text: str, terms: list[str]) -> dict[str, float]:
    if not text:
        return {}
    positions: dict[str, float] = {}
    text_len = max(1, len(text))
    for term in terms:
        candidates = term_variants(term)
        indexes = [text.find(variant) for variant in candidates if variant and text.find(variant) >= 0]
        if indexes:
            positions[term] = min(indexes) / text_len
    return positions


def text_segments_with_positions(text: str) -> list[tuple[float, str]]:
    value = str(text or "")
    if not value:
        return []
    parts = [item for item in re.split(r"([，。！？、,.!?；;：])", value) if item]
    segments: list[tuple[float, str]] = []
    cursor = 0
    current = ""
    current_start = 0
    punctuation = set("，。！？、,.!?；;：")
    for part in parts:
        if not current:
            current_start = cursor
        current += part
        cursor += len(part)
        if part in punctuation:
            body = current.strip()
            if body:
                segments.append((current_start / max(1, len(value)), body))
            current = ""
    if current.strip():
        segments.append((current_start / max(1, len(value)), current.strip()))
    return segments


def proof_action_positions_in_parent(child: dict[str, Any], section: dict[str, Any]) -> list[float]:
    if str(section.get("role") or "") != "proof":
        return []
    parent_text = str(child.get("parent_visual_summary") or "")
    positions: list[float] = []
    for position, segment in text_segments_with_positions(parent_text):
        if any(term in segment for term in PROOF_VISUAL_ACTION_TERMS):
            positions.append(position)
    if positions:
        return positions
    fallback_text = " ".join(
        str(item or "")
        for item in (
            parent_text,
            child.get("parent_source_meaning"),
            " ".join(str(action) for action in child.get("parent_visual_actions") or []),
        )
    )
    return list(term_positions_in_text(fallback_text, PROOF_VISUAL_ACTION_TERMS).values())


def section_term_positions(candidate: dict[str, Any], section: dict[str, Any], terms: list[str]) -> dict[str, float]:
    story_text = text_blob(candidate)
    return term_positions_in_text(story_text, terms)


def child_order_hint_score(child_index: int, child_count: int, term_positions: dict[str, float], hits: list[str]) -> float:
    if child_count <= 1 or not term_positions:
        return 0.0
    center = (child_index + 0.5) / child_count
    target_positions = [pos for term, pos in term_positions.items() if not hits or term in hits or any(alias in hits for alias in TERM_ALIASES.get(term, []))]
    if not target_positions:
        target_positions = list(term_positions.values())
    target = sum(target_positions) / len(target_positions)
    return max(0.0, 0.42 - abs(center - target)) * 0.45


def child_proof_action_order_score(child: dict[str, Any], section: dict[str, Any], child_index: int, child_count: int) -> float:
    positions = proof_action_positions_in_parent(child, section)
    if child_count <= 1 or not positions:
        return 0.0
    center = (child_index + 0.5) / child_count
    target = sum(positions) / len(positions)
    return max(0.0, 0.62 - abs(center - target)) * 0.9


def unverified_proof_child_late_bias(child: dict[str, Any], section: dict[str, Any], child_index: int, child_count: int) -> float:
    if str(section.get("role") or "") != "proof" or child_count <= 1:
        return 0.0
    hits = child_term_hit_info(child, section)
    parent_hits = child_parent_context_hits(child, section)
    if hits or not parent_hits or child_text_is_verified(child):
        return 0.0
    late_ratio = child_index / max(1, child_count - 1)
    return late_ratio * 0.9 - (1.0 - late_ratio) * 0.4


def hard_visual_terms(section: dict[str, Any]) -> list[str]:
    value = " ".join(
        str(section.get(field) or "")
        for field in ("required_visual", "required_meaning", "voice_text", "intention_copy")
    )
    terms: list[str] = []
    for term in DOMAIN_TERMS:
        if term in value and term not in terms:
            terms.append(term)
    for term in PRODUCT_DETAIL_TERMS:
        if term in value and term not in terms:
            terms.append(term)
    for keyword in section.get("keywords") or []:
        text = str(keyword).strip()
        if text and text not in terms:
            terms.append(text)
    return terms


def is_child_renderable(child: dict[str, Any]) -> bool:
    return bool(child.get("trimmed_clip_path") or child.get("source_clip_path")) and child_duration(child) > 0


def child_duration(child: dict[str, Any]) -> float:
    try:
        return max(
            0.0,
            float(
                child.get("clip_actual_duration_s")
                or child.get("duration_s")
                or child.get("source_duration_s")
                or 0
            ),
        )
    except (TypeError, ValueError):
        return 0.0


def ranked_child_physical_shots(candidate: dict[str, Any], section: dict[str, Any]) -> tuple[list[tuple[float, int, dict[str, Any], list[str]]], dict[str, float], list[str]]:
    children = [
        child
        for child in candidate.get("child_physical_shots") or []
        if isinstance(child, dict) and is_child_renderable(child)
    ]
    target_terms = hard_visual_terms(section)
    term_positions = section_term_positions(candidate, section, target_terms)
    hard_required = section_requires_child_visual_hit(section)
    hard_hits_by_child_id = {
        str(child.get("shot_id") or ""): child_required_visual_hits(child, section)
        for child in children
        if child_required_visual_hits(child, section)
    }
    hard_hit_exists = bool(hard_required and hard_hits_by_child_id)
    scored: list[tuple[float, int, dict[str, Any], list[str]]] = []
    target_duration = float(section.get("audio_duration_s") or 0)
    for child_index, child in enumerate(children):
        child_id = str(child.get("shot_id") or "")
        hard_hits = hard_hits_by_child_id.get(child_id, [])
        if hard_hit_exists and not hard_hits:
            continue
        hit_info = child_term_hit_info(child, section)
        hits = list(dict.fromkeys([*hard_hits, *[str(item["term"]) for item in hit_info]]))
        parent_hits = child_parent_context_hits(child, section)
        score = child_semantic_weight(child, section)
        if hard_hits:
            score += 1.8 + min(1.6, len(hard_hits) * 0.42)
        score += child_order_hint_score(child_index, len(children), term_positions, hits)
        proof_order_score = child_proof_action_order_score(child, section, child_index, len(children))
        if proof_order_score:
            score += proof_order_score
        late_bias = unverified_proof_child_late_bias(child, section, child_index, len(children))
        if late_bias:
            score += late_bias
        if parent_hits and not hits:
            score -= 0.28
        if not child_text_is_verified(child):
            score -= 0.08
        duration = child_duration(child)
        if target_duration > 0:
            score += duration_score(duration, min(target_duration, max(duration, 0.1))) * 0.35
        if child.get("hard_subtitle_risk") == "high":
            score -= 0.35
        elif child.get("hard_subtitle_risk") == "medium":
            score -= 0.12
        scored.append((score, child_index, child, hits))
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored, term_positions, target_terms


def select_child_physical_shot(candidate: dict[str, Any], section: dict[str, Any]) -> dict[str, Any]:
    preferred_child_ids = [str(item) for item in candidate.get("llm_preferred_child_physical_shot_ids") or []]
    scored, term_positions, target_terms = ranked_child_physical_shots(candidate, section)
    best_scored_child_id = str(scored[0][2].get("shot_id") or "") if scored else ""
    hard_required = section_requires_child_visual_hit(section)
    candidate_child_hard_hits = candidate_hard_visual_child_hits(candidate, section)
    if preferred_child_ids:
        for child in candidate.get("child_physical_shots") or []:
            if not isinstance(child, dict) or not is_child_renderable(child):
                continue
            if str(child.get("shot_id") or "") in preferred_child_ids:
                hits = [str(item["term"]) for item in child_term_hit_info(child, section)]
                parent_hits = child_parent_context_hits(child, section)
                inherited_only = bool(target_terms and parent_hits and not hits)
                if (
                    hard_required
                    and target_terms
                    and candidate_child_hard_hits
                    and not child_has_hard_visual_hit(child, section)
                    and best_scored_child_id
                    and best_scored_child_id != str(child.get("shot_id") or "")
                ):
                    break
                if (
                    str(section.get("role") or "") == "proof"
                    and inherited_only
                    and best_scored_child_id
                    and best_scored_child_id != str(child.get("shot_id") or "")
                ):
                    break
                base = {
                    "target_visual_terms": target_terms,
                    "semantic_hits": hits,
                    "semantic_score": round(child_semantic_weight(child, section), 3),
                    "parent_context_hits": parent_hits,
                    "inherited_only_hits": inherited_only,
                    "reason": (
                        f"MiniMax M3 指定 child physical shot 起点：{child.get('shot_id')}"
                        + ("；但硬词只在父级上下文命中，需视觉复核" if inherited_only else "")
                    ),
                }
                return select_child_metadata_from_child(candidate, section, child, base)

    if not scored:
        return {
            "mode": "story_unit_clip",
            "child_physical_shot_id": "",
            "target_visual_terms": target_terms,
            "semantic_hits": candidate.get("semantic_hits") or keyword_hits(candidate, section),
            "semantic_score": candidate_semantic_score(candidate),
            "reason": "候选没有可渲染 child physical shot，回退到 story unit 片段",
            "source_clip_path": candidate.get("trimmed_clip_path") or candidate.get("source_clip_path") or "",
            "source_duration_s": candidate_duration(candidate),
            "source_start_offset_s": 0.0,
            "source_end_offset_s": candidate_duration(candidate),
            "visual_summary": candidate.get("visual_summary"),
            "source_meaning": candidate.get("source_meaning"),
            "hard_subtitle_risk": candidate.get("hard_subtitle_risk"),
            "voiceover_fit": candidate.get("voiceover_fit"),
            "requires_review": bool(target_terms),
        }

    best_score, _child_index, best_child, hits = scored[0]
    source_duration = child_duration(best_child)
    source_path = best_child.get("trimmed_clip_path") or best_child.get("source_clip_path") or ""
    if not source_path:
        source_path = candidate.get("trimmed_clip_path") or candidate.get("source_clip_path") or ""
        source_duration = candidate_duration(candidate)
    missing_terms = [
        term
        for term in target_terms
        if term not in hits and not any(alias in hits for alias in TERM_ALIASES.get(term, []))
    ]
    parent_context_hits = child_parent_context_hits(best_child, section)
    inherited_only_hits = bool(target_terms and parent_context_hits and not hits)
    hard_visual_fallback = bool(hard_required and target_terms and not candidate_child_hard_hits)
    requires_review = bool(
        target_terms
        and (not hits or inherited_only_hits or not child_text_is_verified(best_child) or hard_visual_fallback)
    )
    return {
        "mode": "child_physical_shot",
        "child_physical_shot_id": best_child.get("shot_id") or "",
        "target_visual_terms": target_terms,
        "semantic_hits": hits,
        "parent_context_hits": parent_context_hits,
        "child_required_visual_hits": child_required_visual_hits(best_child, section),
        "hard_visual_child_hit_count": len(candidate_child_hard_hits),
        "hard_visual_fallback": hard_visual_fallback,
        "child_metadata_precision": child_metadata_precision(best_child),
        "semantic_score": round(best_score, 3),
        "missing_target_terms": missing_terms,
        "reason": (
            f"story unit 内子镜头匹配：{best_child.get('shot_id')}；命中 "
            f"{'、'.join(hits) if hits else '无硬视觉词'}"
            f"{'；硬词仅见于父级上下文：' + '、'.join(parent_context_hits[:6]) if inherited_only_hits else ''}"
            f"{'；未找到 child 硬画面命中，回退软评分' if hard_visual_fallback else ''}"
            f"{'；按父级证明动作顺序定位' if child_proof_action_order_score(best_child, section, _child_index, len([child for child in candidate.get('child_physical_shots') or [] if isinstance(child, dict) and is_child_renderable(child)])) else ''}"
            f"{'；使用 story 文本顺序定位' if term_positions else ''}"
        ),
        "source_clip_path": source_path,
        "source_duration_s": source_duration,
        "source_start_offset_s": 0.0,
        "source_end_offset_s": source_duration,
        "visual_summary": best_child.get("visual_summary") or candidate.get("visual_summary"),
        "source_meaning": best_child.get("source_meaning") or candidate.get("source_meaning"),
        "hard_subtitle_risk": best_child.get("hard_subtitle_risk") or candidate.get("hard_subtitle_risk"),
        "voiceover_fit": best_child.get("voiceover_fit") or candidate.get("voiceover_fit"),
        "requires_review": requires_review,
    }


def child_selection_start(candidate: dict[str, Any], section: dict[str, Any]) -> dict[str, Any]:
    selected = select_child_physical_shot(candidate, section)
    child_id = str(selected.get("child_physical_shot_id") or "")
    children = [
        child
        for child in candidate.get("child_physical_shots") or []
        if isinstance(child, dict) and is_child_renderable(child)
    ]
    start_index = 0
    for index, child in enumerate(children):
        if str(child.get("shot_id") or "") == child_id:
            start_index = index
            break
    selected["children"] = children
    selected["start_index"] = start_index
    return selected


def candidate_clip_segments(candidate: dict[str, Any], section: dict[str, Any], max_duration: float) -> list[dict[str, Any]]:
    if max_duration <= 0:
        return []
    intra = child_selection_start(candidate, section)
    if section_is_cta_packaging(section) and candidate_duration(candidate) >= 0.3:
        intra = dict(intra)
        intra["child_physical_shot_id"] = ""
        intra["source_start_offset_s"] = 0.0
        intra["start_index"] = 0
        intra["reason"] = (
            f"{intra.get('reason') or ''}；CTA/包装段使用 story unit 从开头连续取片，"
            "避免从中段 child 起点造成结尾短缺"
        ).strip("；")
    children = intra.get("children") or []
    parent_clip = candidate.get("trimmed_clip_path") or candidate.get("source_clip_path") or ""
    parent_duration = candidate_duration(candidate)
    parent_start_offset = parent_start_offset_from_child(candidate, intra)
    if parent_clip and parent_duration > 0 and parent_start_offset < parent_duration - 0.03:
        return [clip_segment_from_parent_story_unit(candidate, section, intra, max_duration)]
    if not children:
        return [clip_segment_from_intra(candidate, intra, max_duration)]
    segments: list[dict[str, Any]] = []
    remaining = max_duration
    start_index = int(intra.get("start_index") or 0)
    ordered_children = children[start_index:]
    max_child_clips = max_child_clips_per_story_unit(section)
    for child in ordered_children:
        if len(segments) >= max_child_clips:
            break
        duration = child_duration(child)
        if duration <= 0:
            continue
        child_intra = select_child_metadata_from_child(candidate, section, child, intra)
        planned = min(duration, remaining)
        segments.append(clip_segment_from_intra(candidate, child_intra, planned))
        remaining = max(0.0, remaining - planned)
        if remaining <= 0.03:
            break
    return segments


def max_child_clips_per_story_unit(section: dict[str, Any]) -> int:
    if section_is_cta_packaging(section):
        return 4
    if str(section.get("role") or "") == "proof":
        return 4
    return DEFAULT_MAX_CHILD_CLIPS_PER_STORY_UNIT_PER_SECTION


def parent_start_offset_from_child(candidate: dict[str, Any], intra: dict[str, Any]) -> float:
    child_id = str(intra.get("child_physical_shot_id") or "")
    if not child_id:
        return 0.0
    parent_usable = usable_range_of(candidate)
    parent_start = float(parent_usable[0] or 0.0)
    for child in candidate.get("child_physical_shots") or []:
        if str(child.get("shot_id") or "") != child_id:
            continue
        child_usable = usable_range_of(child)
        return max(0.0, round(float(child_usable[0] or 0.0) - parent_start, 3))
    return 0.0


def clip_segment_from_parent_story_unit(
    candidate: dict[str, Any],
    section: dict[str, Any],
    intra: dict[str, Any],
    planned_duration: float,
) -> dict[str, Any]:
    source_duration = candidate_duration(candidate)
    source_start_offset = min(parent_start_offset_from_child(candidate, intra), max(0.0, source_duration))
    available_duration = max(0.0, source_duration - source_start_offset)
    planned = min(max(0.0, planned_duration), available_duration) if available_duration > 0 else 0.0
    target_terms = hard_visual_terms(section)
    parent_hits = required_visual_hits(candidate, section)
    semantic_hits = keyword_hits(candidate, section)
    missing_terms = [
        term
        for term in target_terms
        if term not in parent_hits and not any(alias in parent_hits for alias in TERM_ALIASES.get(term, []))
    ]
    hard_visual_fallback = bool(intra.get("hard_visual_fallback"))
    requires_review = bool(target_terms and (not parent_hits or hard_visual_fallback))
    selection_reasons = list(candidate.get("fill_reasons", []))
    selection_reasons.append(
        "使用 story unit 父级连续片段裁切，避免同一父素材拆成过多 child clip 连续铺开"
    )
    if intra.get("reason"):
        selection_reasons.append(str(intra.get("reason")))
    selection_risks = list(candidate.get("fill_risks", []))
    if requires_review:
        if hard_visual_fallback:
            selection_risks.append("目标视觉词只在父级 story unit 命中，未找到 child 级硬画面命中，需抽帧或 Omni 复核")
        else:
            selection_risks.append("目标视觉词未能在 story unit 父级文本中明确命中，需抽帧或 Omni 复核")
    return {
        "shot_id": candidate.get("shot_id"),
        "story_unit_id": candidate.get("story_unit_id") or candidate.get("shot_id"),
        "child_physical_shot_id": intra.get("child_physical_shot_id", ""),
        "intra_clip_selection_mode": "story_unit_parent_continuous",
        "intra_clip_selection_reason": "优先使用 story unit 父级连续片段；child 仅作为定位证据",
        "target_visual_terms": target_terms,
        "missing_target_terms": missing_terms,
        "asset_id": candidate.get("asset_id"),
        "label": candidate.get("label"),
        "score": candidate.get("score"),
        "adjusted_score": candidate.get("adjusted_score"),
        "source_clip_path": candidate.get("trimmed_clip_path") or candidate.get("source_clip_path") or "",
        "source_duration_s": round(source_duration, 3),
        "source_start_offset_s": round(source_start_offset, 3),
        "source_end_offset_s": round(source_start_offset + planned, 3),
        "planned_duration_s": round(planned, 3),
        "allow_loop": False,
        "loop_policy": "disabled_by_default",
        "visual_summary": candidate.get("visual_summary") or intra.get("visual_summary"),
        "source_meaning": candidate.get("source_meaning") or intra.get("source_meaning"),
        "selling_points": candidate.get("selling_points", []),
        "hard_subtitle_risk": candidate.get("hard_subtitle_risk"),
        "voiceover_fit": candidate.get("voiceover_fit"),
        "selection_reasons": selection_reasons,
        "selection_risks": selection_risks,
        "semantic_hits": semantic_hits,
        "parent_context_hits": intra.get("parent_context_hits", []),
        "child_required_visual_hits": intra.get("child_required_visual_hits", []),
        "hard_visual_fallback": hard_visual_fallback,
        "child_metadata_precision": intra.get("child_metadata_precision", ""),
        "semantic_score": candidate.get("semantic_score"),
        "requires_visual_review": requires_review,
    }


def select_child_metadata_from_child(
    candidate: dict[str, Any],
    section: dict[str, Any],
    child: dict[str, Any],
    base_intra: dict[str, Any],
) -> dict[str, Any]:
    hit_info = child_term_hit_info(child, section)
    hits = [str(item["term"]) for item in hit_info]
    parent_context_hits = child_parent_context_hits(child, section)
    score = child_semantic_weight(child, section)
    target_terms = base_intra.get("target_visual_terms") or hard_visual_terms(section)
    child_hard_hits = child_required_visual_hits(child, section)
    missing_terms = [
        term
        for term in target_terms
        if term not in hits and not any(alias in hits for alias in TERM_ALIASES.get(term, []))
    ]
    duration = child_duration(child)
    inherited_only_hits = bool(
        base_intra.get("inherited_only_hits")
        or (target_terms and parent_context_hits and not hits)
    )
    hard_visual_fallback = bool(base_intra.get("hard_visual_fallback"))
    requires_review = bool(
        target_terms and (not hits or inherited_only_hits or not child_text_is_verified(child) or hard_visual_fallback)
    )
    return {
        "mode": "child_physical_shot",
        "child_physical_shot_id": child.get("shot_id") or "",
        "target_visual_terms": target_terms,
        "semantic_hits": hits,
        "parent_context_hits": parent_context_hits,
        "child_required_visual_hits": child_hard_hits,
        "hard_visual_fallback": hard_visual_fallback,
        "child_metadata_precision": child_metadata_precision(child),
        "semantic_score": round(score, 3),
        "missing_target_terms": missing_terms,
        "reason": (
            f"story unit 内连续子镜头：{child.get('shot_id')}；命中 "
            f"{'、'.join(hits) if hits else '无硬视觉词'}"
            f"{'；硬词仅见于父级上下文：' + '、'.join(parent_context_hits[:6]) if inherited_only_hits else ''}"
            f"{'；未找到 child 硬画面命中，回退软评分' if hard_visual_fallback else ''}"
        ),
        "source_clip_path": child.get("trimmed_clip_path") or child.get("source_clip_path") or "",
        "source_duration_s": duration,
        "source_start_offset_s": 0.0,
        "source_end_offset_s": duration,
        "visual_summary": child.get("visual_summary") or candidate.get("visual_summary"),
        "source_meaning": child.get("source_meaning") or candidate.get("source_meaning"),
        "hard_subtitle_risk": child.get("hard_subtitle_risk") or candidate.get("hard_subtitle_risk"),
        "voiceover_fit": child.get("voiceover_fit") or candidate.get("voiceover_fit"),
        "requires_review": requires_review,
    }


def clip_segment_from_intra(candidate: dict[str, Any], intra: dict[str, Any], planned_duration: float) -> dict[str, Any]:
    source_duration = float(intra.get("source_duration_s") or candidate_duration(candidate))
    planned = min(max(0.0, planned_duration), source_duration) if source_duration > 0 else max(0.0, planned_duration)
    source_start_offset = float(intra.get("source_start_offset_s") or 0.0)
    source_end_offset = source_start_offset + planned
    selection_reasons = list(candidate.get("fill_reasons", []))
    if intra.get("reason"):
        selection_reasons.append(str(intra.get("reason")))
    selection_risks = list(candidate.get("fill_risks", []))
    if intra.get("requires_review"):
        if intra.get("parent_context_hits") and not intra.get("semantic_hits"):
            selection_risks.append("目标视觉词只在父级 story unit 上下文命中，child 未验证，需抽帧或 Omni 复核")
        else:
            selection_risks.append("目标视觉词未能在 child physical shot 文本中明确命中，需抽帧或 Omni 复核")
    return {
        "shot_id": candidate.get("shot_id"),
        "story_unit_id": candidate.get("story_unit_id") or candidate.get("shot_id"),
        "child_physical_shot_id": intra.get("child_physical_shot_id", ""),
        "intra_clip_selection_mode": intra.get("mode"),
        "intra_clip_selection_reason": intra.get("reason"),
        "target_visual_terms": intra.get("target_visual_terms", []),
        "missing_target_terms": intra.get("missing_target_terms", []),
        "asset_id": candidate.get("asset_id"),
        "label": candidate.get("label"),
        "score": candidate.get("score"),
        "adjusted_score": candidate.get("adjusted_score"),
        "source_clip_path": intra.get("source_clip_path") or candidate.get("trimmed_clip_path") or candidate.get("source_clip_path") or "",
        "source_duration_s": round(source_duration, 3),
        "source_start_offset_s": round(source_start_offset, 3),
        "source_end_offset_s": round(source_end_offset, 3),
        "planned_duration_s": round(planned, 3),
        "allow_loop": False,
        "loop_policy": "disabled_by_default",
        "visual_summary": intra.get("visual_summary") or candidate.get("visual_summary"),
        "source_meaning": intra.get("source_meaning") or candidate.get("source_meaning"),
        "selling_points": candidate.get("selling_points", []),
        "hard_subtitle_risk": intra.get("hard_subtitle_risk") or candidate.get("hard_subtitle_risk"),
        "voiceover_fit": intra.get("voiceover_fit") or candidate.get("voiceover_fit"),
        "selection_reasons": selection_reasons,
        "selection_risks": selection_risks,
        "semantic_hits": intra.get("semantic_hits") or candidate.get("semantic_hits", []),
        "parent_context_hits": intra.get("parent_context_hits", []),
        "child_required_visual_hits": intra.get("child_required_visual_hits", []),
        "hard_visual_fallback": bool(intra.get("hard_visual_fallback")),
        "child_metadata_precision": intra.get("child_metadata_precision", ""),
        "semantic_score": intra.get("semantic_score") if intra.get("semantic_score") is not None else candidate.get("semantic_score"),
        "requires_visual_review": bool(intra.get("requires_review")),
    }


def adjusted_candidate(candidate: dict[str, Any], section: dict[str, Any], used_counts: dict[str, int]) -> dict[str, Any]:
    target = float(section.get("audio_duration_s") or 0)
    duration = float(candidate.get("duration_s") or 0)
    asset_id = str(candidate.get("asset_id") or "")
    shot_id = str(candidate.get("shot_id") or "")
    score = float(candidate.get("score") or 0)
    reasons = list(candidate.get("rerank_reasons") or [])
    risks = list(candidate.get("risks") or [])
    score += duration_score(duration, target)
    if duration >= target:
        reasons.append("单段素材足够覆盖口播段，可裁切")
    else:
        risks.append(f"素材短于口播段 {duration:.3f}s < {target:.3f}s")
    bonus, semantic_terms = semantic_match_bonus(candidate, section)
    semantic_score = semantic_hit_weight(candidate, section)
    visual_hits = required_visual_hits(candidate, section)
    visual_score = required_visual_score(candidate, section)
    child_visual_hits = candidate_hard_visual_child_hits(candidate, section)
    if visual_hits:
        visual_bonus = min(0.42, visual_score * 0.075)
        score += visual_bonus
        reasons.append(f"required_visual 硬词命中：{'、'.join(visual_hits[:8])}")
    if child_visual_hits:
        child_terms = list(dict.fromkeys(term for item in child_visual_hits for term in item.get("hits", [])))
        score += min(0.72, 0.28 + len(child_terms) * 0.12)
        reasons.append(f"child visual_actions/文本硬词命中：{'、'.join(child_terms[:8])}")
    elif section_requires_child_visual_hit(section) and hard_visual_terms(section):
        score -= 0.22
        risks.append("强画面段未找到 child 级硬词命中，需 fallback/复核")
    if bonus > 0:
        score += bonus
        reasons.append(f"口播/意图与素材字段命中：{'、'.join(semantic_terms)}")
    elif section.get("role") in ("proof", "product", "cta"):
        score -= 0.08
        risks.append("未命中本段必要语义/视觉术语")
    reuse_scale = 0.35 if visual_score >= 3.0 else 0.65 if visual_score >= 1.25 else 1.0
    reuse_penalty = (used_counts.get(shot_id, 0) * 0.42 + used_counts.get(asset_id, 0) * 0.035) * reuse_scale
    if reuse_penalty:
        score -= reuse_penalty
        risks.append(f"复用惩罚 {reuse_penalty:.3f}")
    subtitle = candidate.get("hard_subtitle_risk")
    if subtitle in ("medium", "high"):
        if subtitle == "medium":
            score -= 0.035 if len(semantic_terms) >= 2 else 0.06
        else:
            score -= 0.14
    forbidden_hits = section_forbidden_hits(candidate, section)
    if forbidden_hits:
        score -= 1.4
        risks.append(section_forbidden_reason(section, forbidden_hits))
    theme_eval = visual_theme_eval(candidate, section)
    if theme_eval.get("allowed"):
        if (theme_eval.get("contract") or {}).get("themes"):
            score += 0.18
            reasons.append(visual_theme_reason(theme_eval))
    else:
        score -= 1.6
        risks.append(f"视觉主题合同不通过：{visual_theme_reason(theme_eval)}")
    output = dict(candidate)
    output["adjusted_score"] = round(score, 6)
    output["fill_reasons"] = reasons
    output["fill_risks"] = risks
    output["semantic_hits"] = semantic_terms
    output["semantic_score"] = round(semantic_score, 3)
    output["required_visual_hits"] = visual_hits
    output["required_visual_score"] = visual_score
    output["child_required_visual_hits"] = child_visual_hits
    output["hard_visual_child_hit_count"] = len(child_visual_hits)
    output["hard_visual_child_filter_required"] = section_requires_child_visual_hit(section)
    output["section_forbidden_hits"] = forbidden_hits
    output["visual_theme_contract"] = theme_eval.get("contract")
    output["visual_theme_hits"] = theme_eval.get("theme_hits")
    output["visual_theme_forbidden_hits"] = theme_eval.get("forbidden_hits")
    output["visual_theme_missing"] = theme_eval.get("missing_themes")
    output["visual_theme_allowed"] = bool(theme_eval.get("allowed"))
    return output


def candidate_from_index_record(record: dict[str, Any], section: dict[str, Any]) -> dict[str, Any]:
    return {
        "rank": 0,
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
        "score": None,
        "base_similarity": None,
        "channel_scores": {},
        "rerank_reasons": ["selection_overrides.json 指定：用于验证/修正当前 rerank 的画面匹配"],
        "risks": [],
        "retrieval_role": section.get("role"),
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
        "adjusted_score": None,
        "fill_reasons": ["final selection override: semantic/visual fit is better than raw top score"],
        "fill_risks": [],
    }


def expand_with_theme_candidates(
    candidates: list[dict[str, Any]],
    records: list[dict[str, Any]],
    section: dict[str, Any],
    used_counts: dict[str, int] | None = None,
    limit: int = 18,
) -> list[dict[str, Any]]:
    selected = list(candidates)
    seen = {str(item.get("shot_id") or "") for item in selected}
    extras: list[dict[str, Any]] = []
    for record in records:
        shot_id = str(record.get("shot_id") or "")
        if not shot_id or shot_id in seen:
            continue
        if record.get("planning_granularity") not in (None, "", "story_unit"):
            continue
        candidate = adjusted_candidate(candidate_from_index_record(record, section), section, used_counts or {})
        if not candidate_renderable(candidate):
            continue
        if not visual_theme_allowed(candidate, section):
            continue
        if not candidate_allowed_for_top_up(candidate, section):
            continue
        extras.append(candidate)
    extras.sort(
        key=lambda item: (
            float(item.get("required_visual_score") or 0),
            candidate_semantic_score(item),
            candidate_duration(item),
            candidate_score(item),
        ),
        reverse=True,
    )
    for item in extras[:limit]:
        shot_id = str(item.get("shot_id") or "")
        if shot_id in seen:
            continue
        item["fill_reasons"] = list(item.get("fill_reasons") or []) + ["全量素材库同主题候选补入 embedding pool"]
        selected.append(item)
        seen.add(shot_id)
    return selected


def apply_selection_overrides(
    section: dict[str, Any],
    candidates: list[dict[str, Any]],
    records_by_id: dict[str, dict[str, Any]],
    overrides: dict[str, Any],
) -> list[dict[str, Any]] | None:
    section_id = str(section.get("section_id") or "")
    override_ids = overrides.get(section_id)
    if not override_ids:
        return None
    if isinstance(override_ids, str):
        override_ids = [override_ids]
    candidate_by_id = {str(item.get("shot_id")): item for item in candidates}
    selected: list[dict[str, Any]] = []
    missing: list[str] = []
    for shot_id in override_ids:
        sid = str(shot_id)
        if sid in candidate_by_id:
            item = dict(candidate_by_id[sid])
            item.setdefault("fill_reasons", [])
            item["fill_reasons"] = list(item.get("fill_reasons") or []) + [
                "selection_overrides.json 指定：语义/画面复核后优先"
            ]
            selected.append(item)
        elif sid in records_by_id:
            selected.append(candidate_from_index_record(records_by_id[sid], section))
        else:
            missing.append(sid)
    if missing:
        raise KeyError(f"{section_id}: selection override shot ids not found: {missing}")
    return selected


def allocate_clip_plan(selected: list[dict[str, Any]], section: dict[str, Any]) -> tuple[list[dict[str, Any]], float, float]:
    target = float(section.get("audio_duration_s") or 0)
    remaining = target
    plans: list[dict[str, Any]] = []
    total_source = 0.0
    clip_order = 1
    for item in selected:
        if remaining <= 0.03:
            break
        segments = candidate_clip_segments(item, section, remaining)
        if not segments:
            continue
        for segment in segments:
            source_duration = float(segment.get("source_duration_s") or 0)
            planned_duration = float(segment.get("planned_duration_s") or 0)
            if planned_duration <= 0:
                continue
            total_source += source_duration
            segment["clip_order"] = clip_order
            plans.append(segment)
            clip_order += 1
            remaining = max(0.0, remaining - planned_duration)
            if remaining <= 0.03:
                break
    return plans, round(total_source, 3), round(max(0.0, remaining), 3)


def candidates_compatible(seed: dict[str, Any] | None, item: dict[str, Any], section: dict[str, Any]) -> bool:
    if not visual_theme_allowed(item, section):
        return False
    if section_is_cta_packaging(section):
        required_hits = set(required_visual_hits(item, section))
        packaging_hits = {
            term
            for term in required_hits
            if term in {"礼盒", "陈列", "外壳", "款式", "套装", "活动价"}
        }
        return bool(packaging_hits)
    if seed is None:
        return True
    seed_hits = set(keyword_hits(seed, section))
    item_hits = set(keyword_hits(item, section))
    if seed_hits and item_hits and seed_hits.intersection(item_hits):
        return True
    required_hits = set(required_visual_hits(item, section))
    if required_hits:
        return True
    item_theme_hits = visual_theme_eval(item, section).get("theme_hits") or {}
    if any(item_theme_hits.values()):
        return True
    if str(seed.get("asset_id") or "") == str(item.get("asset_id") or ""):
        return True
    return False


def top_up_selection(
    selected: list[dict[str, Any]],
    adjusted: list[dict[str, Any]],
    section: dict[str, Any],
    max_clips_per_section: int,
) -> tuple[list[dict[str, Any]], str]:
    selected = list(selected)
    note = ""
    adjusted_pool, hard_visual_fallback = hard_visual_candidate_pool(adjusted, section)
    if section_requires_child_visual_hit(section) and not hard_visual_fallback:
        adjusted = adjusted_pool
    elif section_requires_child_visual_hit(section) and hard_visual_fallback:
        note = "；强画面段没有 child 硬词命中，补齐阶段回退软评分并标记复核"
    effective_max = max(max_clips_per_section, len(selected) + max_clips_per_section)
    selected_ids = {str(item.get("shot_id") or "") for item in selected}
    selected_clips, _selected_duration_s, missing_duration_s = allocate_clip_plan(selected, section)
    seed = selected[0] if selected else None
    while missing_duration_s > 0.08 and len(selected) < effective_max:
        next_item = None
        compatibility_modes = (True,) if section_is_cta_packaging(section) else (True, False)
        for require_compatible in compatibility_modes:
            for item in adjusted:
                shot_id = str(item.get("shot_id") or "")
                if not shot_id or shot_id in selected_ids:
                    continue
                if not candidate_renderable(item):
                    continue
                if not candidate_allowed_for_top_up(item, section):
                    continue
                if require_compatible and not candidates_compatible(seed, item, section):
                    continue
                next_item = item
                break
            if next_item is not None:
                if not require_compatible:
                    note = "；严格同语义补齐不足时，使用候选池中可渲染素材补齐短缺时长"
                break
        if next_item is None:
            break
        selected.append(next_item)
        selected_ids.add(str(next_item.get("shot_id") or ""))
        selected_clips, _selected_duration_s, missing_duration_s = allocate_clip_plan(selected, section)
        if not note:
            note = "；命中 story unit 内连续 child 不足时，追加同语义候选补齐"
    return selected, note


def reject_reason(candidate: dict[str, Any], section: dict[str, Any], selected_ids: set[str], target: float) -> str:
    shot_id = str(candidate.get("shot_id") or "")
    if shot_id in selected_ids:
        return "已被选中"
    if not candidate_renderable(candidate):
        return "缺少可渲染素材路径"
    if not visual_theme_allowed(candidate, section):
        return f"视觉主题合同不通过：{visual_theme_reason(visual_theme_eval(candidate, section))}"
    duration = candidate_duration(candidate)
    hits = keyword_hits(candidate, section)
    risks = candidate.get("fill_risks") or candidate.get("risks") or []
    if duration < target and not hits:
        return "时长不足且文本语义命中弱"
    if candidate.get("hard_subtitle_risk") == "high":
        return "硬字幕风险高"
    if risks:
        return str(risks[0])
    if duration < target:
        return "时长不足，优先使用更长或更匹配候选"
    return "综合分低于已选候选"


def build_rejected_candidates(
    candidates: list[dict[str, Any]],
    section: dict[str, Any],
    selected: list[dict[str, Any]],
    limit: int = 8,
) -> list[dict[str, Any]]:
    target = float(section.get("audio_duration_s") or 0)
    selected_ids = {str(item.get("shot_id") or "") for item in selected}
    rejected: list[dict[str, Any]] = []
    for item in candidates:
        if str(item.get("shot_id") or "") in selected_ids:
            continue
        rejected.append(
            {
                "rank": item.get("rank"),
                "shot_id": item.get("shot_id"),
                "asset_id": item.get("asset_id"),
                "label": item.get("label"),
                "score": item.get("score"),
                "adjusted_score": item.get("adjusted_score"),
                "duration_s": item.get("duration_s"),
                "rejected_reason": reject_reason(item, section, selected_ids, target),
            }
        )
        if len(rejected) >= limit:
            break
    return rejected


def compact_child_for_llm(child: dict[str, Any], index: int, section: dict[str, Any]) -> dict[str, Any]:
    verified = child_text_is_verified(child)
    parent_hits = child_parent_context_hits(child, section)
    return {
        "order": index + 1,
        "id": child.get("shot_id") or "",
        "duration_s": round(child_duration(child), 3),
        "visual": str(child.get("visual_summary") or "")[:72] if verified else "",
        "meaning": str(child.get("source_meaning") or "")[:72] if verified else "",
        "hits": [str(item["term"]) for item in child_term_hit_info(child, section)[:8]],
        "parent_context_hits": parent_hits[:8],
        "metadata_precision": child_metadata_precision(child),
        "needs_visual_review": bool(parent_hits and not verified),
        "subtitle_risk": child.get("hard_subtitle_risk"),
        "renderable": is_child_renderable(child),
    }


def compact_candidate_for_llm(candidate: dict[str, Any], rank: int, section: dict[str, Any]) -> dict[str, Any]:
    children = [
        compact_child_for_llm(child, index, section)
        for index, child in enumerate(candidate.get("child_physical_shots") or [])
        if isinstance(child, dict)
    ]
    return {
        "rank": rank,
        "id": candidate.get("shot_id"),
        "asset_id": candidate.get("asset_id"),
        "duration_s": round(candidate_duration(candidate), 3),
        "adjusted_score": candidate.get("adjusted_score"),
        "semantic_score": candidate.get("semantic_score"),
        "semantic_hits": candidate.get("semantic_hits") or [],
        "visual_hits": candidate.get("required_visual_hits") or [],
        "child_visual_hits": candidate.get("child_required_visual_hits") or [],
        "hard_visual_child_hit_count": candidate.get("hard_visual_child_hit_count") or 0,
        "visual_theme": {
            "contract": candidate.get("visual_theme_contract") or visual_theme_contract(section),
            "hits": candidate.get("visual_theme_hits") or {},
            "allowed": bool(candidate.get("visual_theme_allowed")),
        },
        "visual": str(candidate.get("visual_summary") or "")[:110],
        "meaning": str(candidate.get("source_meaning") or "")[:110],
        "subtitle_risk": candidate.get("hard_subtitle_risk"),
        "renderable": candidate_renderable(candidate),
        "children": children[:3],
    }


def compact_section_for_llm(section: dict[str, Any], candidate_section: dict[str, Any], candidates: list[dict[str, Any]]) -> dict[str, Any]:
    llm_candidates = candidates_for_llm(candidates, section)
    return {
        "section_id": section.get("section_id"),
        "timeline_order": section.get("timeline_order"),
        "role": section.get("role"),
        "audio_duration_s": float(section.get("audio_duration_s") or candidate_section.get("audio_duration_s") or 0),
        "voice_text": str(section.get("voice_text") or "")[:120],
        "required_meaning": str(section.get("required_meaning") or "")[:100],
        "required_visual": str(section.get("required_visual") or "")[:100],
        "keywords": section.get("keywords") or [],
        "candidates": [compact_candidate_for_llm(candidate, rank + 1, section) for rank, candidate in enumerate(llm_candidates)],
    }


def candidates_for_llm(candidates: list[dict[str, Any]], section: dict[str, Any], limit: int = 8) -> list[dict[str, Any]]:
    pool, fallback_soft = hard_visual_candidate_pool(candidates, section)
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(item: dict[str, Any]) -> None:
        shot_id = str(item.get("shot_id") or "")
        if not shot_id or shot_id in seen:
            return
        if not candidate_renderable(item):
            return
        if not candidate_allowed_for_section(item, section):
            return
        if not fallback_soft and section_requires_child_visual_hit(section) and not candidate_has_child_visual_hit(item, section):
            return
        selected.append(item)
        seen.add(shot_id)

    for item in sorted(
        pool,
        key=lambda candidate: (
            int(candidate.get("hard_visual_child_hit_count") or 0),
            float(candidate.get("required_visual_score") or 0),
            candidate_semantic_score(candidate),
            candidate_score(candidate),
        ),
        reverse=True,
    ):
        add(item)
        if len(selected) >= 3:
            break

    for item in pool:
        add(item)
        if len(selected) >= limit:
            break

    return selected[:limit]


def compact_previous_selection_for_llm(raw_section: dict[str, Any], candidate_section: dict[str, Any]) -> dict[str, Any]:
    selected_ids = raw_section.get("selected_shot_ids") or raw_section.get("selected_story_unit_ids") or []
    if isinstance(selected_ids, str):
        selected_ids = [selected_ids]
    child_ids = raw_section.get("preferred_child_physical_shot_ids") or raw_section.get("selected_child_physical_shot_ids") or []
    if isinstance(child_ids, str):
        child_ids = [child_ids]
    candidates_by_id: dict[str, dict[str, Any]] = {}
    for candidate in candidate_section.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        for key in (candidate.get("shot_id"), candidate.get("story_unit_id"), candidate.get("parent_shot_id")):
            if key:
                candidates_by_id[str(key)] = candidate
    selected_candidates = []
    for selected_id in selected_ids:
        candidate = candidates_by_id.get(str(selected_id))
        if not candidate:
            continue
        selected_candidates.append(
            {
                "id": candidate.get("shot_id") or selected_id,
                "asset_id": candidate.get("asset_id"),
                "visual": str(candidate.get("visual_summary") or "")[:72],
                "meaning": str(candidate.get("source_meaning") or "")[:72],
            }
        )
    return {
        "section_id": raw_section.get("section_id") or candidate_section.get("section_id"),
        "selected_shot_ids": [str(item) for item in selected_ids if str(item or "").strip()],
        "preferred_child_physical_shot_ids": [str(item) for item in child_ids if str(item or "").strip()],
        "selected_candidates": selected_candidates,
    }


def build_llm_planner_prompt(
    audio_sections: dict[str, Any],
    candidate_payload: dict[str, Any],
    sections_by_id: dict[str, dict[str, Any]],
    max_clips_per_section: int,
) -> dict[str, Any]:
    sections = []
    for candidate_section in candidate_payload.get("sections") or []:
        section = sections_by_id.get(str(candidate_section.get("section_id") or ""))
        if not section:
            continue
        candidates = candidate_section.get("candidates") or []
        sections.append(compact_section_for_llm(section, candidate_section, candidates))
    return {
        "task": "Voah 带货混剪选片。embedding 已经给出候选池，你只在候选池内选择，避免纯 topK 每次都选同一素材。",
        "product": audio_sections.get("product") or {},
        "global_rules": [
            "必须优先满足 required_visual 和 required_meaning；海边、车内、测试卡、泼水等硬画面词不能错配。",
            "child 的 parent_context_hits 只代表父 story unit 上下文，不代表该 child 画面真的包含这些词；不要仅凭 parent_context_hits 指定 child。",
            "素材宜长不宜短；优先选单个足够长的 story unit，短素材才拼同语义候选。",
            "同一条成片内避免反复使用同一个 shot 或 asset；除非同一语义段内连续 child 能自然承接。",
            "不要为了凑时长选择语义完全不相关的素材。",
            "不要选择 renderable=false 的候选。",
            "如果选择 story unit，尽量给出从哪个 child_physical_shot_id 开始；代码会从该 child 起连续取后续 child 并裁切。",
            "不要输出候选池以外的 id。"
        ],
        "output_schema": {
            "sections": [
                {
                    "section_id": "string",
                    "selected_shot_ids": ["story_unit_or_shot_id"],
                    "preferred_child_physical_shot_ids": ["child_id"],
                    "strategy": "single_story_unit_trim_to_audio | multi_story_unit_semantic_fill | manual_review",
                    "selection_reason": "中文简述",
                    "diversity_reason": "中文简述",
                    "manual_review_reason": "可空"
                }
            ]
        },
        "max_clips_per_section": max_clips_per_section,
        "sections": sections,
    }


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


def minimax_m3_enabled(mode: str) -> bool:
    if mode == "off":
        return False
    if mode == "minimax-m3":
        return True
    return bool(os.environ.get("MINIMAX_API_KEY"))


def call_minimax_m3(prompt_payload: dict[str, Any], timeout_s: int = 90) -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.environ.get("MINIMAX_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("MINIMAX_API_KEY not configured")
    base_url = os.environ.get("MINIMAX_LLM_BASE_URL") or os.environ.get("VOAH_TEXT_LLM_BASE_URL") or "https://api.minimaxi.com/v1"
    endpoint = os.environ.get("VOAH_SELECTION_LLM_ENDPOINT") or "/text/chatcompletion_v2"
    model = os.environ.get("VOAH_SELECTION_LLM_MODEL") or "MiniMax-M3"
    url = f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"
    messages = [
        {
            "role": "system",
            "content": (
                "你是 Voah 的带货混剪选片 planner。你只能从用户给出的候选池里选择素材，"
                "输出严格 JSON，不要输出 Markdown。你不负责生成文案，不负责裁切；代码会校验你的选择。"
            ),
        },
        {
            "role": "user",
            "content": json.dumps(prompt_payload, ensure_ascii=False),
        },
    ]
    thinking_enabled = os.environ.get("VOAH_SELECTION_LLM_THINKING", "false").lower() == "true"
    thinking_config = {"type": "enabled"} if thinking_enabled else {"type": "disabled"}
    if endpoint.rstrip("/").endswith("/chat/completions"):
        payload = {
            "model": model,
            "messages": messages,
            "temperature": float(os.environ.get("VOAH_SELECTION_LLM_TEMPERATURE") or 0.25),
            "max_tokens": int(os.environ.get("VOAH_SELECTION_LLM_MAX_TOKENS") or 1200),
            "thinking": thinking_config,
        }
    else:
        payload = {
            "model": model,
            "messages": messages,
            "temperature": float(os.environ.get("VOAH_SELECTION_LLM_TEMPERATURE") or 0.25),
            "max_tokens": int(os.environ.get("VOAH_SELECTION_LLM_MAX_TOKENS") or 1200),
            "thinking": thinking_config,
            "stream": False,
        }
    payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as header_file:
        header_file.write(f'header = "Authorization: Bearer {api_key}"\n')
        header_file.write('header = "Content-Type: application/json"\n')
        header_file_path = header_file.name
    try:
        curl_proc = run_command(
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
            input_bytes=payload_bytes,
        )
    finally:
        try:
            Path(header_file_path).unlink()
        except OSError:
            pass
    if curl_proc.returncode != 0:
        curl_error = curl_proc.stderr.decode("utf-8", errors="ignore") if isinstance(curl_proc.stderr, bytes) else str(curl_proc.stderr)
        raise RuntimeError(f"MiniMax M3 curl request failed: {curl_error[:800]}")
    response_body = curl_proc.stdout.decode("utf-8", errors="ignore") if isinstance(curl_proc.stdout, bytes) else str(curl_proc.stdout)

    raw = json.loads(response_body)
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
        "plan": plan,
    }
    return plan, safe_response


def call_minimax_m3_for_sections(
    audio_sections: dict[str, Any],
    candidate_payload: dict[str, Any],
    sections_by_id: dict[str, dict[str, Any]],
    max_clips_per_section: int,
    timeout_s: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    section_plans: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    previous_selections: list[dict[str, Any]] = []

    def normalize_current_section_plan(raw_sections: list[Any], expected_section_id: str) -> dict[str, Any] | None:
        current_plan = next(
            (
                item
                for item in raw_sections
                if isinstance(item, dict) and str(item.get("section_id") or "") == expected_section_id
            ),
            None,
        )
        if current_plan is None and raw_sections and isinstance(raw_sections[0], dict):
            current_plan = raw_sections[0]
        if current_plan is None:
            return None
        output = dict(current_plan)
        output["section_id"] = expected_section_id
        return output

    for candidate_section in candidate_payload.get("sections") or []:
        section_id = str(candidate_section.get("section_id") or "")
        section = sections_by_id.get(section_id)
        if not section:
            continue
        prompt_payload = {
            "task": "Voah 带货混剪单段选片。embedding 已经给出候选池，你只在候选池内选择，避免纯 topK 每次都选同一素材。",
            "product": audio_sections.get("product") or {},
            "previous_selections": previous_selections[-8:],
            "global_rules": [
                "必须优先满足 required_visual 和 required_meaning；硬画面词不能错配。",
                "素材宜长不宜短；优先选单个足够长的 story unit，短素材才拼同语义候选。",
                "如果第一条素材足够覆盖本段音频，不要为了多样性再选择第二条。",
                "previous_selections 是本条成片前面段落已经选过的素材；不要复用相同 story unit，除非当前 required_visual 明确需要同一场景承接。",
                "尽量分散 asset，但硬画面词命中优先于分散 asset。",
                "不要选择 renderable=false 的候选。",
                "如果选择 story unit，尽量给出从哪个 child_physical_shot_id 开始。",
                "selection_reason 和 diversity_reason 各不超过 40 个中文字符。",
                "不要输出候选池以外的 id。"
            ],
            "output_schema": {
                "sections": [
                    {
                        "section_id": section_id,
                        "selected_shot_ids": ["story_unit_or_shot_id"],
                        "preferred_child_physical_shot_ids": ["child_id"],
                        "strategy": "single_story_unit_trim_to_audio | multi_story_unit_semantic_fill | manual_review",
                        "selection_reason": "中文简述",
                        "diversity_reason": "中文简述",
                        "manual_review_reason": "可空"
                    }
                ]
            },
            "max_clips_per_section": max_clips_per_section,
            "sections": [
                compact_section_for_llm(section, candidate_section, candidate_section.get("candidates") or [])
            ],
        }
        try:
            raw_plan, safe_response = call_minimax_m3(prompt_payload, timeout_s=timeout_s)
            raw_sections = raw_plan.get("sections") or []
            if not raw_sections:
                raise ValueError("MiniMax M3 section plan is empty")
            current_plan = normalize_current_section_plan(raw_sections, section_id)
            if current_plan is None:
                raise ValueError("MiniMax M3 section plan has no object")
            section_plans.append(current_plan)
            previous_selections.append(compact_previous_selection_for_llm(current_plan, candidate_section))
            calls.append(
                {
                    "section_id": section_id,
                    "status": "ok",
                    "previous_selection_count": len(previous_selections) - 1,
                    "usage": safe_response.get("usage") or {},
                    "finish_reason": safe_response.get("finish_reason"),
                    "content_preview": safe_response.get("content_preview", "")[:500],
                }
            )
        except Exception as exc:
            retry_error = ""
            try:
                retry_payload = dict(prompt_payload)
                retry_payload["task"] = "重试：只输出合法 JSON，不要解释。每个 reason 不超过 20 字。"
                retry_payload["strict_output"] = "必须是一个 JSON object，形如 {\"sections\":[...]}。"
                raw_plan, safe_response = call_minimax_m3(retry_payload, timeout_s=timeout_s)
                raw_sections = raw_plan.get("sections") or []
                if not raw_sections:
                    raise ValueError("MiniMax M3 retry section plan is empty")
                current_plan = normalize_current_section_plan(raw_sections, section_id)
                if current_plan is None:
                    raise ValueError("MiniMax M3 retry section plan has no object")
                section_plans.append(current_plan)
                previous_selections.append(compact_previous_selection_for_llm(current_plan, candidate_section))
                calls.append(
                    {
                        "section_id": section_id,
                        "status": "ok_after_retry",
                        "first_error": str(exc),
                        "previous_selection_count": len(previous_selections) - 1,
                        "usage": safe_response.get("usage") or {},
                        "finish_reason": safe_response.get("finish_reason"),
                        "content_preview": safe_response.get("content_preview", "")[:500],
                    }
                )
                continue
            except Exception as retry_exc:
                retry_error = str(retry_exc)
            errors.append({"section_id": section_id, "error": str(exc), "retry_error": retry_error})
            calls.append({"section_id": section_id, "status": "fallback", "error": str(exc), "retry_error": retry_error})
    plan = {"sections": section_plans}
    safe_response = {
        "provider": "minimax-official",
        "model": os.environ.get("VOAH_SELECTION_LLM_MODEL") or "MiniMax-M3",
        "base_url": os.environ.get("MINIMAX_LLM_BASE_URL") or os.environ.get("VOAH_TEXT_LLM_BASE_URL") or "https://api.minimaxi.com/v1",
        "endpoint": os.environ.get("VOAH_SELECTION_LLM_ENDPOINT") or "/text/chatcompletion_v2",
        "calls": calls,
        "errors": errors,
        "usage": {
            "total_tokens": sum(int((call.get("usage") or {}).get("total_tokens") or 0) for call in calls),
            "prompt_tokens": sum(int((call.get("usage") or {}).get("prompt_tokens") or 0) for call in calls),
            "completion_tokens": sum(int((call.get("usage") or {}).get("completion_tokens") or 0) for call in calls),
        },
        "finish_reason": "partial_fallback" if errors else "stop",
        "plan": plan,
    }
    if not section_plans:
        raise RuntimeError(f"MiniMax M3 produced no valid section plans: {errors}")
    return plan, safe_response


def normalize_llm_plan(plan: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_sections = plan.get("sections") or []
    if not isinstance(raw_sections, list):
        raise ValueError("LLM plan.sections must be a list")
    by_id: dict[str, dict[str, Any]] = {}
    for raw in raw_sections:
        if not isinstance(raw, dict):
            continue
        section_id = str(raw.get("section_id") or "").strip()
        if not section_id:
            continue
        selected = raw.get("selected_shot_ids") or raw.get("selected_story_unit_ids") or []
        if isinstance(selected, str):
            selected = [selected]
        child_ids = raw.get("preferred_child_physical_shot_ids") or raw.get("selected_child_physical_shot_ids") or []
        if isinstance(child_ids, str):
            child_ids = [child_ids]
        by_id[section_id] = {
            "selected_shot_ids": [str(item) for item in selected if str(item or "").strip()],
            "preferred_child_physical_shot_ids": [str(item) for item in child_ids if str(item or "").strip()],
            "strategy": str(raw.get("strategy") or "llm_candidate_pool_selection"),
            "selection_reason": str(raw.get("selection_reason") or ""),
            "diversity_reason": str(raw.get("diversity_reason") or ""),
            "manual_review_reason": str(raw.get("manual_review_reason") or ""),
        }
    return by_id


def apply_llm_child_preference(candidate: dict[str, Any], preferred_child_ids: list[str]) -> dict[str, Any]:
    if not preferred_child_ids:
        return candidate
    preferred_set = set(preferred_child_ids)
    existing_ids = {
        str(child.get("shot_id") or "")
        for child in candidate.get("child_physical_shots") or []
        if isinstance(child, dict)
    }
    matched = [child_id for child_id in preferred_child_ids if child_id in existing_ids]
    if not matched:
        return candidate
    output = dict(candidate)
    output["llm_preferred_child_physical_shot_ids"] = matched
    output.setdefault("fill_reasons", [])
    output["fill_reasons"] = list(output.get("fill_reasons") or []) + [
        f"MiniMax M3 指定从 child physical shot 开始：{matched[0]}"
    ]
    return output


def apply_llm_selection(
    section: dict[str, Any],
    adjusted: list[dict[str, Any]],
    llm_decision: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]] | None, str, str, list[str]]:
    if not llm_decision:
        return None, "", "", ["LLM 未返回本 section 决策"]
    requested_ids = llm_decision.get("selected_shot_ids") or []
    if not requested_ids:
        return None, "", "", ["LLM 未选择候选"]
    by_id: dict[str, dict[str, Any]] = {}
    for item in adjusted:
        for key in (item.get("shot_id"), item.get("story_unit_id"), item.get("parent_shot_id")):
            if key:
                by_id[str(key)] = item
    _, hard_visual_fallback = hard_visual_candidate_pool(adjusted, section)
    selected: list[dict[str, Any]] = []
    invalid: list[str] = []
    seen: set[str] = set()
    preferred_child_ids = llm_decision.get("preferred_child_physical_shot_ids") or []
    for requested_id in requested_ids:
        item = by_id.get(str(requested_id))
        if not item:
            invalid.append(str(requested_id))
            continue
        shot_id = str(item.get("shot_id") or "")
        if shot_id in seen:
            continue
        if not candidate_renderable(item):
            invalid.append(f"{requested_id}: not renderable")
            continue
        if not candidate_allowed_for_section(item, section):
            invalid.append(f"{requested_id}: forbidden or visual theme mismatch for section role")
            continue
        if section_requires_child_visual_hit(section) and not hard_visual_fallback and not candidate_has_child_visual_hit(item, section):
            invalid.append(f"{requested_id}: no child hard visual hit")
            continue
        selected.append(apply_llm_child_preference(item, preferred_child_ids))
        seen.add(shot_id)
    if invalid:
        return None, "", "", [f"LLM 选择了无效候选：{', '.join(invalid)}"]
    if not selected:
        return None, "", "", ["LLM 选择结果为空"]
    reason = llm_decision.get("selection_reason") or "MiniMax M3 在 embedding 候选池内选择素材。"
    diversity = llm_decision.get("diversity_reason") or ""
    strategy = llm_decision.get("strategy") or "llm_candidate_pool_selection"
    if diversity:
        reason = f"{reason} 多样性考虑：{diversity}"
    manual_reason = llm_decision.get("manual_review_reason") or ""
    notes = [manual_reason] if manual_reason else []
    return selected, strategy, reason, notes


def confidence_for_selection(
    selected: list[dict[str, Any]],
    section: dict[str, Any],
    missing_duration_s: float,
    strategy: str,
    has_override: bool,
) -> float:
    if not selected:
        return 0.0
    scores = [candidate_score(item) for item in selected]
    avg_score = sum(scores) / len(scores) if scores else 0.0
    keyword_ratio = sum(1 for item in selected if keyword_hits(item, section)) / len(selected)
    confidence = 0.52 + min(0.24, max(0.0, avg_score) * 0.18) + keyword_ratio * 0.12
    if strategy == "single_story_unit_trim_to_audio":
        confidence += 0.08
    if has_override:
        confidence = max(confidence, 0.78)
    if any(item.get("hard_subtitle_risk") == "medium" for item in selected):
        confidence -= 0.08
    if any(item.get("hard_subtitle_risk") == "high" for item in selected):
        confidence -= 0.2
    if missing_duration_s > 0:
        confidence -= min(0.35, missing_duration_s * 0.06 + 0.12)
    return round(max(0.0, min(0.98, confidence)), 3)


def build_selection_section(
    section: dict[str, Any],
    candidates: list[dict[str, Any]],
    used_counts: dict[str, int],
    max_clips_per_section: int,
    records_by_id: dict[str, dict[str, Any]],
    selection_overrides: dict[str, Any],
    llm_decision: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str], list[str]]:
    warnings: list[str] = []
    manual_reviews: list[str] = []
    target = float(section.get("audio_duration_s") or 0)
    adjusted = [adjusted_candidate(item, section, used_counts) for item in candidates]
    adjusted.sort(key=lambda item: candidate_score(item), reverse=True)
    hard_visual_fallback = False

    selected_override = apply_selection_overrides(section, adjusted, records_by_id, selection_overrides)
    has_override = selected_override is not None
    llm_selected: list[dict[str, Any]] | None = None
    if selected_override is not None:
        selected = [adjusted_candidate(item, section, used_counts) for item in selected_override]
        strategy = "manual_selection_override"
        selection_reason = "使用人工锁片 selection_overrides.json，脚本只校验时长和风险。"
    else:
        llm_selected, llm_strategy, llm_reason, llm_notes = apply_llm_selection(section, adjusted, llm_decision)
        if llm_selected is not None:
            selected = llm_selected
            strategy = llm_strategy or "llm_candidate_pool_selection"
            selection_reason = llm_reason
            manual_reviews.extend(llm_notes)
        else:
            if llm_decision:
                warnings.extend(llm_notes)
            usable = [
                item
                for item in adjusted
                if candidate_renderable(item) and candidate_allowed_for_section(item, section)
            ]
            hard_pool, hard_visual_fallback = hard_visual_candidate_pool(usable, section)
            if section_requires_child_visual_hit(section) and hard_visual_fallback:
                message = (
                    f"{section.get('section_id')}: 强画面段没有 child 级硬词命中，"
                    "回退软评分并标记复核"
                )
                warnings.append(message)
                manual_reviews.append(message)
            usable = hard_pool
            long_enough = [item for item in usable if candidate_duration(item) >= target - 0.03]
            strong_semantic = [item for item in usable if candidate_semantic_score(item) >= 1.6]
            if long_enough:
                long_enough.sort(
                    key=lambda item: (
                        int(item.get("hard_visual_child_hit_count") or 0),
                        float(item.get("required_visual_score") or 0),
                        candidate_semantic_score(item),
                        candidate_score(item),
                    ),
                    reverse=True,
                )
            best_long = long_enough[0] if long_enough else None
            best_long_is_semantic = best_long is not None and candidate_semantic_score(best_long) >= 1.6
            best_long_visual_score = float(best_long.get("required_visual_score") or 0) if best_long else 0.0
            if best_long and (best_long_visual_score >= 2.5 or best_long_is_semantic or not strong_semantic):
                selected = [best_long]
                strategy = "single_story_unit_trim_to_audio"
                selection_reason = "优先选择 required_visual/语义命中且足够长的 story unit，并在内部 child physical shots 连续裁切。"
            else:
                selected = []
                selected_assets: set[str] = set()
                total = 0.0
                first_hits: set[str] = set()
                semantic_pool = strong_semantic or usable
                for item in semantic_pool:
                    if len(selected) >= max_clips_per_section:
                        break
                    shot_id = str(item.get("shot_id") or "")
                    if any(str(existing.get("shot_id") or "") == shot_id for existing in selected):
                        continue
                    hits = set(keyword_hits(item, section))
                    asset_id = str(item.get("asset_id") or "")
                    if selected:
                        same_asset = asset_id in selected_assets
                        same_semantic = bool(hits and first_hits and hits.intersection(first_hits))
                        same_dimension = bool(hits) and len(hits.intersection(set(split_query_terms(section_query(section))))) > 0
                        if not (same_semantic or same_dimension or same_asset):
                            continue
                    selected.append(item)
                    selected_assets.add(asset_id)
                    if not first_hits:
                        first_hits = hits
                    total += candidate_duration(item)
                    if total >= target - 0.03:
                        break
                strategy = "multi_story_unit_semantic_fill"
                selection_reason = f"单条长素材语义命中不足或不存在，改用最多 {max_clips_per_section} 条同语义候选拼接。"

    if selected_override is None:
        selected, top_up_note = top_up_selection(selected, adjusted, section, max_clips_per_section)
        if top_up_note and top_up_note not in selection_reason:
            selection_reason += top_up_note

    selected_clips, selected_duration_s, missing_duration_s = allocate_clip_plan(selected, section)
    if not selected_clips:
        message = f"{section.get('section_id')}: 没有可用候选，缺口 {target:.3f}s"
        warnings.append(message)
        manual_reviews.append(message)
        strategy = "no_usable_candidate_manual_review"
        selection_reason = "候选池没有可渲染素材，需重新召回、改文案或人工锁片。"
    elif missing_duration_s > 0.08:
        message = (
            f"{section.get('section_id')}: 已选素材总时长 {selected_duration_s:.3f}s "
            f"短于口播 {target:.3f}s，缺口 {missing_duration_s:.3f}s；默认不 loop"
        )
        warnings.append(message)
        manual_reviews.append(message)
    if any(item.get("hard_subtitle_risk") == "high" for item in selected):
        message = f"{section.get('section_id')}: 已选素材存在 hard_subtitle_risk=high"
        warnings.append(message)
        manual_reviews.append(message)
    if any(item.get("hard_subtitle_risk") == "medium" for item in selected):
        message = f"{section.get('section_id')}: 已选素材存在 hard_subtitle_risk=medium，建议人工复核"
        warnings.append(message)
        manual_reviews.append(message)
    visual_review_messages: set[str] = set()
    for item in selected_clips:
        if item.get("requires_visual_review"):
            message = (
                f"{section.get('section_id')}/{item.get('shot_id')}: "
                "child physical shot 未明确命中目标视觉词，需抽帧或 Omni 复核"
            )
            if message in visual_review_messages:
                continue
            visual_review_messages.add(message)
            warnings.append(message)
            manual_reviews.append(message)

    requires_review = bool(manual_reviews)
    confidence = confidence_for_selection(selected, section, missing_duration_s, strategy, has_override)
    selection_section = {
        "section_id": section.get("section_id"),
        "timeline_order": section.get("timeline_order"),
        "role": section.get("role"),
        "audio_duration_s": target,
        "query": section_query(section),
        "selection_strategy": strategy,
        "selection_source": "manual_override" if has_override else "llm_planner" if llm_decision and llm_selected is not None else "rules_fallback",
        "selection_reason": selection_reason,
        "llm_decision": llm_decision or {},
        "selected_shot_ids": candidate_ids(selected),
        "selected_clips": selected_clips,
        "selected_duration_s": selected_duration_s,
        "missing_duration_s": missing_duration_s,
        "rejected_candidates": build_rejected_candidates(adjusted, section, selected),
        "confidence": confidence,
        "requires_review": requires_review,
        "qa": {
            "status": "manual_review" if requires_review else "ok",
            "warnings": warnings,
        },
    }
    return selection_section, warnings, manual_reviews


def render_clip(
    source: Path,
    output: Path,
    duration: float,
    width: int,
    height: int,
    fps: int,
    preset: str,
    start_offset: float = 0.0,
) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    source_duration = probe_duration(source)
    if source_duration is None:
        raise RuntimeError(f"cannot probe source duration: {source}")
    start_offset = max(0.0, min(float(start_offset or 0.0), source_duration))
    available_duration = max(0.0, source_duration - start_offset)
    if available_duration + 0.04 < duration:
        duration = available_duration
        warnings.append(f"source shorter than requested after offset; rendered natural length {available_duration:.3f}s; loop disabled")

    frames = max(1, int(math.ceil(duration * fps)))
    vf = (
        "setpts=PTS-STARTPTS,"
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,fps={fps},format=yuv420p"
    )
    command = [
        "ffmpeg",
        "-y",
        "-ss",
        str(start_offset),
        "-i",
        str(source),
        "-an",
        "-vf",
        vf,
        "-frames:v",
        str(frames),
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        str(output),
    ]
    proc = run_command(command)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"failed to render {source}").strip())
    rendered_duration = probe_duration(output)
    return {
        "source_duration_s": source_duration,
        "source_start_offset_s": round(start_offset, 3),
        "source_end_offset_s": round(start_offset + duration, 3),
        "requested_duration_s": round(duration, 3),
        "rendered_duration_s": rendered_duration,
        "rendered_clip_path": str(output),
    }, warnings


def concat_video(parts: list[Path], output: Path, concat_file: Path) -> None:
    write_text(concat_file, "\n".join(f"file '{escape_concat_path(path)}'" for path in parts) + "\n")
    proc = run_command(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(output)])
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "failed to concat video").strip())


def mux_audio(video: Path, audio: Path, output: Path) -> None:
    proc = run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video),
            "-i",
            str(audio),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            str(output),
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "failed to mux audio").strip())


def main() -> int:
    parser = argparse.ArgumentParser(description="Retrieve story units by audio section and render preview.")
    parser.add_argument("--audio-sections", required=True)
    parser.add_argument("--index", required=True)
    parser.add_argument("--voice-wav", required=True)
    parser.add_argument("--task-dir", default=None)
    parser.add_argument("--product", default="防晒气垫")
    parser.add_argument("--top-k", type=int, default=14)
    parser.add_argument("--pool-k", type=int, default=36)
    parser.add_argument("--max-clips-per-section", type=int, default=6)
    parser.add_argument("--timeline-selection", default="timeline_selection.json")
    parser.add_argument("--selection-overrides", default="")
    parser.add_argument("--selection-planner", default="auto", choices=["auto", "off", "minimax-m3"])
    parser.add_argument("--llm-timeout-s", type=int, default=90)
    parser.add_argument("--width", type=int, default=720)
    parser.add_argument("--height", type=int, default=1280)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--preset", default="veryfast")
    parser.add_argument("--output", default="preview_no_subtitles.mp4")
    args = parser.parse_args()

    workspace = Path(__file__).resolve().parents[1]
    load_env_files([workspace / ".env", Path.home() / ".voah" / "video_intake" / ".env"])

    search_module = load_search_module()
    if not search_module.load_env():
        return 1

    audio_sections_path = as_abs(args.audio_sections)
    index_path = as_abs(args.index)
    voice_wav = as_abs(args.voice_wav)
    task_dir = as_abs(args.task_dir) if args.task_dir else audio_sections_path.parent
    output = as_abs(args.output, task_dir) if args.output == "preview_no_subtitles.mp4" else as_abs(args.output)
    timeline_selection_path = as_abs(args.timeline_selection, task_dir)
    candidate_sections_path = task_dir / "candidate_sections.json"
    timeline_fill_path = task_dir / "timeline_fill.json"
    work_dir = task_dir / "timeline_fill_clips"
    work_dir.mkdir(parents=True, exist_ok=True)

    audio_sections = load_json(audio_sections_path)
    index = load_json(index_path)
    index, intake_boundary_contract = ensure_child_physical_shots(index, index_path)
    records_by_id = {str(record.get("shot_id")): record for record in index.get("records", [])}
    selection_overrides = load_json(as_abs(args.selection_overrides)) if args.selection_overrides else {}
    sections = audio_sections.get("sections") or []
    if not sections:
        raise ValueError("audio_sections has no sections")

    candidate_sections: list[dict[str, Any]] = []

    for section in sections:
        query = section_query(section)
        role = role_for_search(section.get("role"))
        query_vector = search_module.embed_query(query)
        weights = search_module.parse_weights("", role)
        candidates = search_module.search_ranked(
            index=index,
            query=query,
            query_vector=query_vector,
            product=args.product,
            role=role,
            top_k=args.top_k,
            weights=weights,
            target_duration=float(section.get("audio_duration_s") or 0),
            allow_cross_product=False,
            dedupe_parent=True,
            max_per_parent=1,
            max_per_asset=0,
            pool_k=args.pool_k,
        )
        adjusted = [adjusted_candidate(item, section, {}) for item in candidates]
        adjusted = expand_with_theme_candidates(adjusted, index.get("records", []), section, {})
        adjusted.sort(key=lambda item: candidate_score(item), reverse=True)
        candidate_sections.append(
            {
                "section_id": section.get("section_id"),
                "timeline_order": section.get("timeline_order"),
                "role": section.get("role"),
                "query": query,
                "search_role": role,
                "audio_duration_s": float(section.get("audio_duration_s") or 0),
                "candidate_count": len(adjusted),
                "candidates": adjusted,
            }
        )

    candidate_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_audio_section_retrieval_candidates",
        "created_at": iso_now(),
        "product": audio_sections.get("product") or {},
        "inputs": {
            "audio_sections": str(audio_sections_path),
            "index": str(index_path),
        },
        "outputs": {
            "candidate_sections": str(candidate_sections_path),
            "next_artifact": str(timeline_selection_path),
        },
        "policy": {
            "script_first": True,
            "tts_after_script": True,
            "retrieval_unit": index.get("planning_granularity", "story_unit"),
            "prefer_long_material": True,
            "loop_default": False,
            "intra_story_unit_selection": "child_physical_shot_text_and_order_v1",
        },
        "sections": candidate_sections,
        "qa": {
            "status": intake_boundary_contract.get("status", "ok"),
            "warnings": intake_boundary_contract.get("warnings", []),
            "intake_boundary_contract": intake_boundary_contract,
        },
        "next_consumers": ["voah-timeline-selection"],
    }
    write_json(candidate_sections_path, candidate_payload)

    sections_by_id = {str(item.get("section_id") or ""): item for item in sections}
    selection_sections: list[dict[str, Any]] = []
    selection_warnings: list[str] = list(intake_boundary_contract.get("warnings") or [])
    selection_manual_reviews: list[str] = list(intake_boundary_contract.get("warnings") or [])
    used_counts: dict[str, int] = {}
    llm_plan_by_section: dict[str, dict[str, Any]] = {}
    llm_safe_response: dict[str, Any] = {}
    llm_planner_status = "disabled"
    llm_fallback_reason = ""
    llm_plan_path = task_dir / "llm_selection_plan.safe.json"

    if minimax_m3_enabled(args.selection_planner):
        llm_planner_status = "requested"
        try:
            raw_llm_plan, llm_safe_response = call_minimax_m3_for_sections(
                audio_sections=audio_sections,
                candidate_payload=candidate_payload,
                sections_by_id=sections_by_id,
                max_clips_per_section=args.max_clips_per_section,
                timeout_s=args.llm_timeout_s,
            )
            llm_plan_by_section = normalize_llm_plan(raw_llm_plan)
            llm_planner_status = "partial_fallback" if llm_safe_response.get("errors") else "ok"
            if llm_safe_response.get("errors"):
                llm_fallback_reason = f"{len(llm_safe_response.get('errors') or [])} section planner calls failed"
                selection_warnings.append(f"MiniMax M3 planner partial fallback: {llm_fallback_reason}")
            write_json(
                llm_plan_path,
                {
                    "schema_version": "1.0.0",
                    "stage": "voah_minimax_m3_selection_plan",
                    "created_at": iso_now(),
                    "inputs": {
                        "candidate_sections": str(candidate_sections_path),
                        "section_count": len(candidate_payload.get("sections") or []),
                    },
                    "provider": llm_safe_response.get("provider"),
                    "model": llm_safe_response.get("model"),
                    "base_url": llm_safe_response.get("base_url"),
                    "endpoint": llm_safe_response.get("endpoint"),
                    "usage": llm_safe_response.get("usage") or {},
                    "finish_reason": llm_safe_response.get("finish_reason"),
                    "calls": llm_safe_response.get("calls") or [],
                    "errors": llm_safe_response.get("errors") or [],
                    "plan": raw_llm_plan,
                    "qa": {
                        "status": "manual_review" if llm_safe_response.get("errors") else "ok",
                        "warnings": [str(item) for item in (llm_safe_response.get("errors") or [])],
                    },
                },
            )
        except Exception as exc:
            llm_fallback_reason = str(exc)
            llm_planner_status = "fallback"
            selection_warnings.append(f"MiniMax M3 planner fallback: {llm_fallback_reason}")
            write_json(
                llm_plan_path,
                {
                    "schema_version": "1.0.0",
                    "stage": "voah_minimax_m3_selection_plan",
                    "created_at": iso_now(),
                    "inputs": {
                        "candidate_sections": str(candidate_sections_path),
                    },
                    "provider": "minimax-official",
                    "model": os.environ.get("VOAH_SELECTION_LLM_MODEL") or "MiniMax-M3",
                    "status": "fallback",
                    "fallback_reason": llm_fallback_reason,
                    "qa": {
                        "status": "manual_review",
                        "warnings": [llm_fallback_reason],
                    },
                },
            )

    for candidate_section in candidate_payload.get("sections") or []:
        section = sections_by_id.get(str(candidate_section.get("section_id") or ""))
        if section is None:
            raise RuntimeError(f"candidate section has no matching audio section: {candidate_section.get('section_id')}")
        section_id = str(candidate_section.get("section_id") or "")
        selection_section, select_warnings, select_manual_reviews = build_selection_section(
            section=section,
            candidates=candidate_section.get("candidates") or [],
            used_counts=used_counts,
            max_clips_per_section=args.max_clips_per_section,
            records_by_id=records_by_id,
            selection_overrides=selection_overrides,
            llm_decision=llm_plan_by_section.get(section_id),
        )
        selection_warnings.extend(select_warnings)
        selection_manual_reviews.extend(select_manual_reviews)
        selection_sections.append(selection_section)
        for selected_item in selection_section.get("selected_clips") or []:
            used_counts[str(selected_item.get("shot_id") or "")] = used_counts.get(str(selected_item.get("shot_id") or ""), 0) + 1
            used_counts[str(selected_item.get("asset_id") or "")] = used_counts.get(str(selected_item.get("asset_id") or ""), 0) + 1

    selection_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_timeline_selection_from_candidates",
        "created_at": iso_now(),
        "product": audio_sections.get("product") or {},
        "inputs": {
            "audio_sections": str(audio_sections_path),
            "candidate_sections": str(candidate_sections_path),
            "selection_overrides": {
                "path": str(as_abs(args.selection_overrides)) if args.selection_overrides else "",
                "source": "manual" if args.selection_overrides else "",
                "enabled": bool(args.selection_overrides),
            },
        },
        "outputs": {
            "timeline_selection": str(timeline_selection_path),
            "next_artifact": str(timeline_fill_path),
        },
        "policy": {
            "planner": "minimax_m3_llm_planner_v1" if llm_planner_status in ("ok", "partial_fallback") else "rules_text_planner_v1",
            "planner_status": llm_planner_status,
            "llm_provider": "minimax-official" if llm_planner_status in ("ok", "partial_fallback", "fallback", "requested") else None,
            "llm_model": os.environ.get("VOAH_SELECTION_LLM_MODEL") or "MiniMax-M3",
            "llm_plan_safe_path": str(llm_plan_path) if llm_plan_path.exists() else "",
            "llm_fallback_reason": llm_fallback_reason,
            "embedding_candidate_pool": {
                "enabled": True,
                "model": "qwen3-vl-embedding",
                "top_k": args.top_k,
                "pool_k": args.pool_k,
                "candidate_sections": str(candidate_sections_path),
            },
            "multimodal_llm_default": False,
            "prefer_single_long_story_unit": True,
            "max_clips_per_section": args.max_clips_per_section,
            "loop_default": False,
            "material_shortage_action": "manual_review",
            "intra_story_unit_selection": "child_physical_shot_text_and_order_v1",
        },
        "sections": selection_sections,
        "summary": {
            "section_count": len(selection_sections),
            "selected_clip_count": sum(len(item.get("selected_clips") or []) for item in selection_sections),
            "selected_child_physical_clip_count": sum(
                1
                for section in selection_sections
                for item in section.get("selected_clips") or []
                if item.get("child_physical_shot_id")
            ),
            "requires_review_count": sum(1 for item in selection_sections if item.get("requires_review")),
            "missing_duration_s": round(sum(float(item.get("missing_duration_s") or 0) for item in selection_sections), 3),
        },
        "qa": {
            "status": qa_status_from(selection_warnings, selection_manual_reviews),
            "warnings": selection_warnings,
            "manual_review": selection_manual_reviews,
            "intake_boundary_contract": intake_boundary_contract,
        },
        "next_consumers": ["voah-video-fill"],
    }
    write_json(timeline_selection_path, selection_payload)

    timeline_sections: list[dict[str, Any]] = []
    rendered_parts: list[Path] = []
    fill_warnings = list(selection_warnings)
    fill_manual_reviews = list(selection_manual_reviews)
    selection_by_id = {str(item.get("section_id") or ""): item for item in selection_sections}

    for section_index, section in enumerate(sections, start=1):
        selection_section = selection_by_id.get(str(section.get("section_id") or ""))
        if selection_section is None:
            raise RuntimeError(f"missing timeline_selection section: {section.get('section_id')}")

        clip_items: list[dict[str, Any]] = []
        section_rendered_duration = 0.0
        for clip_index, selected_item in enumerate(selection_section.get("selected_clips") or [], start=1):
            source = as_abs(selected_item.get("source_clip_path") or "")
            render_duration = float(selected_item.get("planned_duration_s") or 0)
            if render_duration <= 0:
                fill_warnings.append(f"{section.get('section_id')}/{selected_item.get('shot_id')}: planned duration is 0; skipped")
                fill_manual_reviews.append(f"{section.get('section_id')}/{selected_item.get('shot_id')}: planned duration is 0")
                continue
            out_clip = work_dir / f"{section_index:03d}_{clip_index:02d}_{safe_filename(str(selected_item.get('shot_id') or 'shot'))}.mp4"
            source_start_offset = float(selected_item.get("source_start_offset_s") or 0.0)
            probe, render_item_warnings = render_clip(
                source=source,
                output=out_clip,
                duration=render_duration,
                width=args.width,
                height=args.height,
                fps=args.fps,
                preset=args.preset,
                start_offset=source_start_offset,
            )
            fill_warnings.extend([f"{section.get('section_id')}/{selected_item.get('shot_id')}: {warning}" for warning in render_item_warnings])
            if render_item_warnings:
                fill_manual_reviews.extend(
                    [f"{section.get('section_id')}/{selected_item.get('shot_id')}: {warning}" for warning in render_item_warnings]
                )
            rendered_parts.append(out_clip)
            section_rendered_duration += float(probe.get("rendered_duration_s") or render_duration)
            clip_items.append(
                {
                    "clip_order": clip_index,
                    "shot_id": selected_item.get("shot_id"),
                    "story_unit_id": selected_item.get("story_unit_id"),
                    "child_physical_shot_id": selected_item.get("child_physical_shot_id"),
                    "intra_clip_selection_mode": selected_item.get("intra_clip_selection_mode"),
                    "intra_clip_selection_reason": selected_item.get("intra_clip_selection_reason"),
                    "target_visual_terms": selected_item.get("target_visual_terms", []),
                    "missing_target_terms": selected_item.get("missing_target_terms", []),
                    "asset_id": selected_item.get("asset_id"),
                    "label": selected_item.get("label"),
                    "score": selected_item.get("score"),
                    "adjusted_score": selected_item.get("adjusted_score"),
                    "source_clip_path": str(source),
                    "planned_source_start_offset_s": selected_item.get("source_start_offset_s"),
                    "planned_source_end_offset_s": selected_item.get("source_end_offset_s"),
                    "planned_duration_s": selected_item.get("planned_duration_s"),
                    "visual_summary": selected_item.get("visual_summary"),
                    "source_meaning": selected_item.get("source_meaning"),
                    "selling_points": selected_item.get("selling_points", []),
                    "hard_subtitle_risk": selected_item.get("hard_subtitle_risk"),
                    "voiceover_fit": selected_item.get("voiceover_fit"),
                    "selection_reasons": selected_item.get("selection_reasons", []),
                    "selection_risks": selected_item.get("selection_risks", []),
                    "semantic_hits": selected_item.get("semantic_hits", []),
                    "semantic_score": selected_item.get("semantic_score"),
                    "requires_visual_review": bool(selected_item.get("requires_visual_review")),
                    "allow_loop": False,
                    "loop_policy": "disabled_by_default",
                    **probe,
                }
            )

        missing_duration_s = float(selection_section.get("missing_duration_s") or 0)
        if missing_duration_s > 0.08:
            fill_warnings.append(f"{section.get('section_id')}: rendered video is {missing_duration_s:.3f}s short; loop disabled")
            fill_manual_reviews.append(f"{section.get('section_id')}: missing_duration_s={missing_duration_s:.3f}")

        timeline_sections.append(
            {
                **section,
                "fill_policy": "execute_timeline_selection_no_loop",
                "selection_strategy": selection_section.get("selection_strategy"),
                "selection_reason": selection_section.get("selection_reason"),
                "selected_shot_ids": selection_section.get("selected_shot_ids"),
                "requires_review": selection_section.get("requires_review"),
                "missing_duration_s": missing_duration_s,
                "clips": clip_items,
                "rendered_duration_s": round(section_rendered_duration, 3),
            }
        )

    if not rendered_parts:
        raise RuntimeError("timeline_selection has no renderable clips")

    video_no_audio = task_dir / "preview_no_audio.mp4"
    concat_video(rendered_parts, video_no_audio, task_dir / "timeline_fill_video_concat.txt")
    mux_audio(video_no_audio, voice_wav, output)

    voice_duration = probe_duration(voice_wav)
    preview_duration = probe_duration(output)
    if voice_duration is not None and preview_duration is not None and abs(voice_duration - preview_duration) > 0.15:
        fill_warnings.append(f"preview duration {preview_duration}s differs from voice duration {voice_duration}s")
        fill_manual_reviews.append(f"preview_duration_s={preview_duration} differs from voice_duration_s={voice_duration}")

    timeline_payload = {
        "schema_version": "1.0.0",
        "stage": "voah_video_fill_from_audio_section_retrieval",
        "created_at": iso_now(),
        "product": audio_sections.get("product") or {},
        "inputs": {
            "audio_sections": str(audio_sections_path),
            "candidate_sections": str(candidate_sections_path),
            "timeline_selection": str(timeline_selection_path),
            "voice_wav": str(voice_wav),
        },
        "outputs": {
            "timeline_fill": str(timeline_fill_path),
            "preview_no_audio": str(video_no_audio),
            "preview_no_subtitles": str(output),
            "next_artifact": str(task_dir / "caption_plan.json"),
        },
        "canvas": {
            "width": args.width,
            "height": args.height,
            "fps": args.fps,
        },
        "summary": {
            "section_count": len(timeline_sections),
            "voice_duration_s": voice_duration,
            "preview_duration_s": preview_duration,
            "render_policy": "execute_timeline_selection_trim_or_concat_no_loop",
            "selected_clip_count": sum(len(item.get("clips") or []) for item in timeline_sections),
            "selected_child_physical_clip_count": sum(
                1
                for section in timeline_sections
                for item in section.get("clips") or []
                if item.get("child_physical_shot_id")
            ),
            "missing_duration_s": round(sum(float(item.get("missing_duration_s") or 0) for item in timeline_sections), 3),
        },
        "timeline": timeline_sections,
        "media_probe": probe_media(output),
        "qa": {
            "status": qa_status_from(fill_warnings, fill_manual_reviews),
            "warnings": fill_warnings,
            "manual_review": fill_manual_reviews,
            "intake_boundary_contract": intake_boundary_contract,
        },
        "next_consumers": ["voah-caption-plan", "hyperframes-subtitle-burn"],
    }
    write_json(timeline_fill_path, timeline_payload)

    print(f"candidate_sections={candidate_sections_path}")
    print(f"timeline_selection={timeline_selection_path}")
    print(f"timeline_fill={timeline_fill_path}")
    print(f"preview_no_subtitles={output}")
    print(f"duration_s={preview_duration}")
    print(f"qa={timeline_payload['qa']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
