#!/usr/bin/env python3
"""Build desktop-facing production quality reports for a Voah task run."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "1.0.0"
TEXT_SOURCE_MARKERS = ("voice_script", "audio_sections")
CHILD_VISUAL_REVIEW_MARKERS = (
    "child physical shot 未明确命中目标视觉词",
    "目标视觉词只在父级 story unit 上下文命中",
    "child 未验证",
)


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def as_output_path(value: str, task_dir: Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        if len(path.parts) > 1:
            path = Path.cwd() / path
        else:
            path = task_dir / path
    return path.resolve()


def resolve_path(value: Any, task_dir: Path, fallback: Path | None = None) -> Path:
    if isinstance(value, str) and value.strip():
        path = Path(value).expanduser()
        if not path.is_absolute():
            path = task_dir / path
        return path.resolve()
    if fallback is not None:
        return fallback.resolve()
    return task_dir.resolve()


def load_json_state(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    state: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "valid_json": False,
    }
    if not path.exists():
        return {}, state
    try:
        state["size_bytes"] = path.stat().st_size
        with path.open(encoding="utf-8") as f:
            payload = json.load(f)
        if isinstance(payload, dict):
            state["valid_json"] = True
            return payload, state
        state["error"] = f"expected JSON object, got {type(payload).__name__}"
    except Exception as exc:  # noqa: BLE001 - report generation must not die on broken QA JSON.
        state["error"] = str(exc)
    return {}, state


def load_json_any_state(path: Path) -> tuple[Any, dict[str, Any]]:
    state: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "valid_json": False,
    }
    if not path.exists():
        return None, state
    try:
        state["size_bytes"] = path.stat().st_size
        with path.open(encoding="utf-8") as f:
            payload = json.load(f)
        state["valid_json"] = True
        return payload, state
    except Exception as exc:  # noqa: BLE001
        state["error"] = str(exc)
        return None, state


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def file_info(path: Path) -> dict[str, Any]:
    info: dict[str, Any] = {"path": str(path), "exists": path.exists()}
    if path.exists():
        try:
            info["size_bytes"] = path.stat().st_size
        except OSError as exc:
            info["error"] = str(exc)
    return info


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or ""))


def safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def round_or_none(value: Any, digits: int = 3) -> float | None:
    number = safe_float(value)
    if number is None:
        return None
    return round(number, digits)


def dedupe(values: list[Any]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def counted_messages(values: list[Any]) -> list[dict[str, Any]]:
    counter = Counter(str(value or "").strip() for value in values if str(value or "").strip())
    return [{"message": message, "count": count} for message, count in counter.most_common()]


def is_child_visual_review_warning(value: Any) -> bool:
    text = str(value or "")
    return any(marker in text for marker in CHILD_VISUAL_REVIEW_MARKERS)


def worker_status_to_check(status: Any) -> str:
    normalized = str(status or "").strip().lower()
    if normalized in {"ok", "pass", "passed"}:
        return "pass"
    if normalized in {"warning", "warn"}:
        return "warning"
    if normalized in {"manual_review", "minor_review", "review", "missing"}:
        return "manual_review"
    if normalized in {"block", "blocked", "fail", "failed", "major_review", "error"}:
        return "block"
    return "warning" if normalized else "warning"


def check_rank(status: str) -> int:
    return {"pass": 0, "warning": 1, "manual_review": 2, "block": 3}.get(status, 1)


def combine_check_status(statuses: list[str]) -> str:
    if not statuses:
        return "warning"
    return max(statuses, key=check_rank)


def qa_status_from_checks(checks: list[dict[str, Any]]) -> str:
    status = combine_check_status([str(check.get("status") or "warning") for check in checks])
    return {"pass": "ok", "warning": "warning", "manual_review": "manual_review", "block": "block"}[status]


def make_check(
    check_id: str,
    label: str,
    status: str,
    detail: str,
    *,
    metrics: dict[str, Any] | None = None,
    evidence: dict[str, Any] | None = None,
    warnings: list[Any] | None = None,
    blocks: list[Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": check_id,
        "label": label,
        "status": status,
        "detail": detail,
        "metrics": metrics or {},
        "evidence": evidence or {},
        "warnings": counted_messages(warnings or []),
        "blocks": counted_messages(blocks or []),
    }


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def ffprobe_media(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"exists": False}
    if shutil.which("ffprobe") is None:
        return {"exists": True, "warning": "ffprobe not found"}
    proc = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
            "-show_entries",
            "format=duration,size,bit_rate",
            "-of",
            "json",
            str(path),
        ]
    )
    if proc.returncode != 0:
        return {"exists": True, "error": (proc.stderr or proc.stdout).strip()}
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        return {"exists": True, "error": f"ffprobe JSON parse failed: {exc}"}
    data["exists"] = True
    return data


def media_duration(probe: dict[str, Any]) -> float | None:
    return safe_float((probe.get("format") or {}).get("duration"))


def parse_freezedetect(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    starts = [float(item) for item in re.findall(r"freeze_start:\s*([0-9.]+)", text)]
    durations = [float(item) for item in re.findall(r"freeze_duration:\s*([0-9.]+)", text)]
    ends = [float(item) for item in re.findall(r"freeze_end:\s*([0-9.]+)", text)]
    events: list[dict[str, Any]] = []
    for index, start in enumerate(starts):
        events.append(
            {
                "start_s": round(start, 3),
                "duration_s": round(durations[index], 3) if index < len(durations) else None,
                "end_s": round(ends[index], 3) if index < len(ends) else None,
            }
        )
    return events


def collect_worker_warnings(
    payloads: dict[str, dict[str, Any]], *, omni_final_passed: bool
) -> tuple[list[str], list[str]]:
    active: list[str] = []
    resolved: list[str] = []
    for label, payload in payloads.items():
        qa = payload.get("qa") or {}
        for key in ("warnings", "manual_review"):
            for warning in qa.get(key) or []:
                message = f"{label}: {warning}"
                if omni_final_passed and is_child_visual_review_warning(message):
                    resolved.append(message)
                else:
                    active.append(message)
    return dedupe(active), dedupe(resolved)


def find_omni_runs(task_dir: Path) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for directory in sorted(task_dir.glob("qa_omni_alignment*")):
        if not directory.is_dir():
            continue
        results_path = directory / "omni_alignment_results.json"
        report_path = directory / "OMNI_ALIGNMENT_QA_REPORT.md"
        payload, state = load_json_state(results_path)
        qa = payload.get("qa") or {}
        summary = payload.get("summary") or {}
        runs.append(
            {
                "name": directory.name,
                "dir": str(directory),
                "results": str(results_path),
                "report": str(report_path),
                "exists": results_path.exists(),
                "valid_json": state.get("valid_json", False),
                "status": qa.get("status") or "missing",
                "summary": summary,
                "is_final": directory.name.endswith("_final") or directory.name == "qa_omni_alignment_final",
                "mtime": results_path.stat().st_mtime if results_path.exists() else directory.stat().st_mtime,
            }
        )
    return runs


def pick_final_omni(omni_runs: list[dict[str, Any]], task_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    final_path = task_dir / "qa_omni_alignment_final" / "omni_alignment_results.json"
    final_payload, final_state = load_json_state(final_path)
    if final_state.get("exists"):
        return final_payload, final_state
    for run in omni_runs:
        if run.get("is_final"):
            payload, state = load_json_state(Path(str(run.get("results"))))
            return payload, state
    return {}, final_state


def omni_final_passed(payload: dict[str, Any]) -> bool:
    qa_status = (payload.get("qa") or {}).get("status")
    summary = payload.get("summary") or {}
    section_count = safe_float(summary.get("section_count")) or 0
    pass_count = safe_float(summary.get("pass_count")) or 0
    fail_count = safe_float(summary.get("fail_count")) or 0
    major_count = safe_float(summary.get("major_review_count")) or 0
    if qa_status == "ok" and section_count and pass_count >= section_count and fail_count == 0 and major_count == 0:
        return True
    return qa_status == "ok" and not summary


def build_paths(task_dir: Path, full_manifest: dict[str, Any]) -> dict[str, Path]:
    stage_artifacts = full_manifest.get("stage_artifacts") or {}
    media_artifacts = full_manifest.get("media_artifacts") or {}
    paths = {
        "full_pipeline_manifest": task_dir / "full_pipeline_manifest.json",
        "qa_gate_report": task_dir / "qa_gate_report.json",
        "export_record": task_dir / "export_record.json",
        "voice_script": resolve_path(stage_artifacts.get("voice_script"), task_dir, task_dir / "voice_script.json"),
        "tts_audio": resolve_path(stage_artifacts.get("tts_audio"), task_dir, task_dir / "tts_audio.json"),
        "audio_sections": resolve_path(stage_artifacts.get("audio_sections"), task_dir, task_dir / "audio_sections.json"),
        "candidate_sections": resolve_path(stage_artifacts.get("candidate_sections"), task_dir, task_dir / "candidate_sections.json"),
        "timeline_selection": resolve_path(stage_artifacts.get("timeline_selection"), task_dir, task_dir / "timeline_selection.json"),
        "timeline_fill": resolve_path(stage_artifacts.get("timeline_fill"), task_dir, task_dir / "timeline_fill.json"),
        "caption_plan": resolve_path(stage_artifacts.get("caption_plan"), task_dir, task_dir / "caption_plan.json"),
        "hyperframes_manifest": resolve_path(
            stage_artifacts.get("hyperframes_manifest"),
            task_dir,
            task_dir / "hyperframes_subtitle_burn" / "hyperframes_subtitle_burn_manifest.json",
        ),
        "voice_wav": resolve_path(media_artifacts.get("voice_wav"), task_dir, task_dir / "voice.wav"),
        "preview_no_subtitles": resolve_path(
            media_artifacts.get("preview_no_subtitles"),
            task_dir,
            task_dir / "preview_no_subtitles.mp4",
        ),
        "final_subtitled": resolve_path(
            media_artifacts.get("final_subtitled"),
            task_dir,
            task_dir / "hyperframes_subtitle_burn" / "final_subtitled.mp4",
        ),
        "omni_final_results": task_dir / "qa_omni_alignment_final" / "omni_alignment_results.json",
        "omni_final_report": task_dir / "qa_omni_alignment_final" / "OMNI_ALIGNMENT_QA_REPORT.md",
    }
    return {label: path.resolve() for label, path in paths.items()}


def find_intake_contract(payloads: dict[str, dict[str, Any]]) -> dict[str, Any]:
    for label in ("timeline_fill", "timeline_selection", "candidate_sections"):
        qa = payloads.get(label, {}).get("qa") or {}
        contract = qa.get("intake_boundary_contract")
        if isinstance(contract, dict) and contract:
            return contract
    return {}


def build_segmentation_check(
    task_dir: Path,
    payloads: dict[str, dict[str, Any]],
    input_states: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    warnings: list[str] = []
    blocks: list[str] = []
    contract = find_intake_contract(payloads)
    if not contract:
        warnings.append("未找到 intake_boundary_contract，无法完整判断素材切分 QA。")

    source_run_dir = resolve_path(contract.get("source_run_dir"), task_dir) if contract.get("source_run_dir") else None
    run_manifest: dict[str, Any] = {}
    physical_payload: Any = None
    story_payload: Any = None
    qa_last_frames_payload: Any = None
    source_artifacts: dict[str, Any] = {}

    if source_run_dir:
        run_manifest, run_state = load_json_state(source_run_dir / "run_manifest.json")
        physical_payload, physical_state = load_json_any_state(source_run_dir / "physical_shots.json")
        story_payload, story_state = load_json_any_state(source_run_dir / "story_units.json")
        qa_last_frames_payload, qa_last_state = load_json_any_state(source_run_dir / "qa_last_frames.json")
        source_artifacts = {
            "run_manifest": run_state,
            "physical_shots": physical_state,
            "story_units": story_state,
            "qa_last_frames": qa_last_state,
            "qa_last_frames_dir": file_info(source_run_dir / "qa_last_frames"),
            "qa_preview_frames_dir": file_info(source_run_dir / "qa_preview_frames"),
        }
    elif contract:
        warnings.append("intake_boundary_contract 缺少 source_run_dir。")

    physical_shots = physical_payload if isinstance(physical_payload, list) else []
    story_units = story_payload if isinstance(story_payload, list) else []
    qa_last_frames = qa_last_frames_payload if isinstance(qa_last_frames_payload, list) else []
    short_physical = [
        item
        for item in physical_shots
        if (safe_float(item.get("clip_actual_duration_s")) or safe_float(item.get("duration_s")) or 0) < 0.5
    ]
    missing_last_frame = [item for item in physical_shots if not item.get("qa_last_frame")]
    missing_preview_frame = [item for item in physical_shots if not item.get("qa_preview_frame")]

    physical_count = int(contract.get("physical_shot_count") or len(physical_shots) or 0)
    story_count = int(contract.get("story_unit_count") or len(story_units) or 0)
    trim_interval_ok = contract.get("trim_interval") == "[start,end)"
    with_epsilon = int(contract.get("physical_with_trim_end_epsilon") or 0)
    with_frames = int(contract.get("physical_with_clip_frames") or 0)
    with_duration = int(contract.get("physical_with_clip_actual_duration") or 0)

    if contract.get("status") and contract.get("status") != "ok":
        warnings.append(f"intake boundary contract status={contract.get('status')}")
    if physical_count and with_epsilon and with_epsilon < physical_count:
        warnings.append(f"有 {physical_count - with_epsilon} 个 physical shot 缺少 trim_end_epsilon。")
    if physical_count and with_frames and with_frames < physical_count:
        warnings.append(f"有 {physical_count - with_frames} 个 physical shot 缺少 clip_frames。")
    if physical_count and with_duration and with_duration < physical_count:
        warnings.append(f"有 {physical_count - with_duration} 个 physical shot 缺少 clip_actual_duration_s。")
    if contract and not trim_interval_ok:
        warnings.append("trim_interval 不是 [start,end)，需要确认末帧粘连风险。")
    if short_physical:
        warnings.append(f"素材库中存在 {len(short_physical)} 个短于 0.5s 的 physical shot。")
    if source_run_dir and not qa_last_frames:
        warnings.append("未找到 qa_last_frames.json，首尾帧污染只能人工确认。")
    if source_run_dir and physical_count and len(qa_last_frames) and len(qa_last_frames) < physical_count:
        warnings.append(f"qa_last_frames 数量 {len(qa_last_frames)} 少于 physical shot 数量 {physical_count}。")
    for label in ("candidate_sections", "timeline_selection", "timeline_fill"):
        if not input_states.get(label, {}).get("exists"):
            warnings.append(f"缺少 {label}，切分合同只能做部分汇总。")

    status_parts = ["pass"]
    if warnings:
        status_parts.append("warning")
    if blocks:
        status_parts.append("block")
    status = combine_check_status(status_parts)
    if not contract:
        status = "warning"

    metrics = {
        "source_run_dir": str(source_run_dir) if source_run_dir else "",
        "asset_count": (run_manifest.get("qa") or {}).get("asset_count") or contract.get("asset_count"),
        "story_unit_count": story_count or None,
        "physical_shot_count": physical_count or None,
        "physical_with_trim_end_epsilon": with_epsilon or None,
        "physical_with_clip_frames": with_frames or None,
        "physical_with_clip_actual_duration": with_duration or None,
        "qa_last_frame_count": len(qa_last_frames) or None,
        "missing_last_frame_count": len(missing_last_frame) if physical_shots else None,
        "missing_preview_frame_count": len(missing_preview_frame) if physical_shots else None,
        "short_physical_under_0_5s_count": len(short_physical) if physical_shots else None,
        "trim_interval": contract.get("trim_interval"),
        "contract_status": contract.get("status") or "",
    }
    detail = "切分合同可追溯，半开区间和末帧 QA 产物已汇总。"
    if warnings:
        detail = "切分可追溯，但存在需要复核的边界或 QA 产物缺口。"
    check = make_check(
        "segmentation",
        "切分与边界 QA",
        status,
        detail,
        metrics=metrics,
        evidence={"intake_boundary_contract": contract, "source_artifacts": source_artifacts},
        warnings=warnings,
        blocks=blocks,
    )
    return check, {"contract": contract, "source_artifacts": source_artifacts}


def timeline_sections(payload: dict[str, Any]) -> list[dict[str, Any]]:
    items = payload.get("timeline") or payload.get("sections") or []
    return items if isinstance(items, list) else []


def build_retrieval_check(
    payloads: dict[str, dict[str, Any]],
    input_states: dict[str, dict[str, Any]],
    *,
    omni_passed: bool,
) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    blocks: list[str] = []
    resolved_warnings: list[str] = []
    audio_sections = payloads.get("audio_sections", {}).get("sections") or []
    timeline_fill = payloads.get("timeline_fill") or {}
    timeline_selection = payloads.get("timeline_selection") or {}
    candidate_sections = payloads.get("candidate_sections") or {}
    timeline_items = timeline_sections(timeline_fill)
    selection_items = timeline_sections(timeline_selection)
    candidate_items = timeline_sections(candidate_sections)

    if not input_states.get("timeline_fill", {}).get("exists"):
        blocks.append("缺少 timeline_fill.json，无法判断最终素材填充。")
    if not timeline_items:
        blocks.append("timeline_fill 中没有 timeline/sections。")

    audio_ids = {str(item.get("section_id") or "") for item in audio_sections if isinstance(item, dict)}
    timeline_ids = {str(item.get("section_id") or "") for item in timeline_items if isinstance(item, dict)}
    missing_timeline_ids = sorted(section_id for section_id in audio_ids if section_id and section_id not in timeline_ids)
    if missing_timeline_ids:
        blocks.append(f"有 {len(missing_timeline_ids)} 个 audio section 没有对应 timeline 填充。")

    all_clips = [
        clip
        for section in timeline_items
        for clip in (section.get("clips") or section.get("selected_clips") or [])
        if isinstance(clip, dict)
    ]
    section_rows: list[dict[str, Any]] = []
    for section in timeline_items:
        clips = [clip for clip in (section.get("clips") or section.get("selected_clips") or []) if isinstance(clip, dict)]
        review_clip_count = sum(1 for clip in clips if clip.get("requires_visual_review"))
        section_missing = safe_float(section.get("missing_duration_s")) or 0.0
        if section_missing > 0.08:
            warnings.append(f"{section.get('section_id')}: missing_duration_s={section_missing:.3f}")
        if not clips:
            blocks.append(f"{section.get('section_id')}: 没有选中素材片段。")
        section_rows.append(
            {
                "section_id": section.get("section_id"),
                "role": section.get("role"),
                "audio_duration_s": round_or_none(section.get("audio_duration_s")),
                "rendered_duration_s": round_or_none(section.get("rendered_duration_s")),
                "selected_clip_count": len(clips),
                "requires_review": bool(section.get("requires_review")),
                "requires_visual_review_clip_count": review_clip_count,
                "missing_duration_s": round(section_missing, 3),
                "selected_shot_ids": section.get("selected_shot_ids") or [],
            }
        )

    worker_active, worker_resolved = collect_worker_warnings(
        {
            "candidate_sections": candidate_sections,
            "timeline_selection": timeline_selection,
            "timeline_fill": timeline_fill,
        },
        omni_final_passed=omni_passed,
    )
    warnings.extend(worker_active)
    resolved_warnings.extend(worker_resolved)

    requires_review_count = (
        (timeline_selection.get("summary") or {}).get("requires_review_count")
        or sum(1 for item in selection_items if item.get("requires_review"))
        or sum(1 for item in timeline_items if item.get("requires_review"))
    )
    visual_review_clip_count = sum(1 for clip in all_clips if clip.get("requires_visual_review"))
    if requires_review_count and not omni_passed:
        warnings.append(f"timeline_selection requires_review_count={requires_review_count}，缺少最终 Omni 通过证据。")
    if visual_review_clip_count and not omni_passed:
        warnings.append(f"{visual_review_clip_count} 个 clip 需要视觉复核，缺少最终 Omni 通过证据。")

    summary = timeline_fill.get("summary") or {}
    candidate_summary = {
        "section_count": len(candidate_items) or None,
        "candidate_count_total": sum(len(item.get("candidates") or []) for item in candidate_items if isinstance(item, dict)) or None,
    }
    status = "pass"
    if warnings:
        status = "manual_review" if any("requires_review" in item or "复核" in item for item in warnings) else "warning"
    if omni_passed and not blocks:
        non_resolved = [warning for warning in warnings if not is_child_visual_review_warning(warning)]
        warnings = non_resolved
        status = "warning" if non_resolved else "pass"
    if blocks:
        status = "block"

    detail = "最终时间线按 audio_sections 填满，召回风险已由最终 Omni QA 兜底。"
    if not omni_passed:
        detail = "时间线已汇总，但召回准确性仍需要 Omni 或人工复核。"
    if blocks:
        detail = "时间线填充缺失或不完整，不能作为生产成片通过。"

    check = make_check(
        "retrieval",
        "召回与素材语义匹配",
        status,
        detail,
        metrics={
            "audio_section_count": len(audio_sections) or None,
            "timeline_section_count": len(timeline_items) or None,
            "timeline_selection_section_count": len(selection_items) or None,
            "selected_clip_count": summary.get("selected_clip_count")
            or (timeline_selection.get("summary") or {}).get("selected_clip_count")
            or len(all_clips),
            "selected_child_physical_clip_count": summary.get("selected_child_physical_clip_count"),
            "requires_review_count": requires_review_count or 0,
            "requires_visual_review_clip_count": visual_review_clip_count,
            "missing_duration_s": round_or_none(summary.get("missing_duration_s") or 0),
            "resolved_by_final_omni": omni_passed,
            **candidate_summary,
        },
        evidence={"sections": section_rows},
        warnings=warnings,
        blocks=blocks,
    )
    return check, resolved_warnings


def is_loop_enabled(clip: dict[str, Any]) -> bool:
    if clip.get("allow_loop") is True:
        return True
    policy = str(clip.get("loop_policy") or clip.get("render_policy") or "").lower()
    if not policy:
        return False
    disabled_markers = ("disabled", "no_loop", "without_loop", "loop disabled")
    if any(marker in policy for marker in disabled_markers):
        return False
    return "loop" in policy


def build_loop_check(payloads: dict[str, dict[str, Any]]) -> dict[str, Any]:
    warnings: list[str] = []
    blocks: list[str] = []
    timeline_fill = payloads.get("timeline_fill") or {}
    timeline_items = timeline_sections(timeline_fill)
    all_clips = [
        clip
        for section in timeline_items
        for clip in (section.get("clips") or section.get("selected_clips") or [])
        if isinstance(clip, dict)
    ]
    loop_enabled_clips = [clip for clip in all_clips if is_loop_enabled(clip)]
    unknown_policy_count = sum(1 for clip in all_clips if not clip.get("loop_policy") and "allow_loop" not in clip)
    loop_policy_counts = Counter(str(clip.get("loop_policy") or "missing") for clip in all_clips)
    render_policy = (timeline_fill.get("summary") or {}).get("render_policy") or (timeline_fill.get("policy") or {}).get("render_policy")
    missing_duration_s = safe_float((timeline_fill.get("summary") or {}).get("missing_duration_s")) or sum(
        safe_float(section.get("missing_duration_s")) or 0.0 for section in timeline_items
    )
    if loop_enabled_clips:
        blocks.append(f"检测到 {len(loop_enabled_clips)} 个 clip 允许 loop。")
    if missing_duration_s > 0.08:
        warnings.append(f"素材总缺口 {missing_duration_s:.3f}s，当前策略不应用 loop 硬凑。")
    if unknown_policy_count:
        warnings.append(f"{unknown_policy_count} 个 clip 缺少 loop_policy/allow_loop 字段。")
    if not timeline_items:
        blocks.append("没有 timeline 数据，无法判断 loop 策略。")

    status = "pass"
    if warnings:
        status = "warning"
    if blocks:
        status = "block"
    detail = "所有已选 clip 均禁用 loop，短素材通过裁剪或语义拼接补齐。"
    if warnings:
        detail = "未发现启用 loop，但存在素材缺口或策略字段缺失。"
    if blocks:
        detail = "存在启用 loop 的片段，需复查是否为无意义循环或强行凑时长。"
    return make_check(
        "loop_policy",
        "Loop 与素材补齐策略",
        status,
        detail,
        metrics={
            "clip_count": len(all_clips),
            "loop_enabled_clip_count": len(loop_enabled_clips),
            "unknown_policy_clip_count": unknown_policy_count,
            "missing_duration_s": round(missing_duration_s, 3),
            "render_policy": render_policy,
            "loop_policy_counts": dict(loop_policy_counts),
        },
        evidence={
            "loop_enabled_clips": [
                {
                    "section_or_clip": clip.get("section_id") or clip.get("clip_order"),
                    "shot_id": clip.get("shot_id"),
                    "loop_policy": clip.get("loop_policy"),
                    "allow_loop": clip.get("allow_loop"),
                }
                for clip in loop_enabled_clips[:20]
            ]
        },
        warnings=warnings,
        blocks=blocks,
    )


def group_captions_by_section(caption_plan: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for caption in caption_plan.get("captions") or []:
        if not isinstance(caption, dict):
            continue
        section_id = str(caption.get("section_id") or "")
        grouped[section_id].append(caption)
    for captions in grouped.values():
        captions.sort(key=lambda item: (safe_float(item.get("start_s")) or 0, safe_float(item.get("caption_order")) or 0))
    return dict(grouped)


def source_is_voice_text(value: Any) -> bool:
    text = str(value or "").lower()
    return all(marker in text for marker in TEXT_SOURCE_MARKERS)


def build_voice_caption_check(payloads: dict[str, dict[str, Any]], paths: dict[str, Path]) -> dict[str, Any]:
    warnings: list[str] = []
    blocks: list[str] = []
    audio_sections = payloads.get("audio_sections") or {}
    caption_plan = payloads.get("caption_plan") or {}
    voice_script = payloads.get("voice_script") or {}
    tts_audio = payloads.get("tts_audio") or {}
    sections = [item for item in (audio_sections.get("sections") or []) if isinstance(item, dict)]
    captions = [item for item in (caption_plan.get("captions") or []) if isinstance(item, dict)]
    captions_by_section = group_captions_by_section(caption_plan)
    section_rows: list[dict[str, Any]] = []
    text_mismatches: list[str] = []
    timing_warnings: list[str] = []
    source_warnings: list[str] = []

    if not sections:
        blocks.append("audio_sections.json 缺少 sections。")
    if not captions:
        blocks.append("caption_plan.json 缺少 captions。")

    for section in sections:
        section_id = str(section.get("section_id") or "")
        section_captions = captions_by_section.get(section_id, [])
        caption_text = "".join(str(item.get("text") or "") for item in section_captions)
        reference_text = section.get("subtitle_text") or section.get("voice_text") or section.get("tts_text") or ""
        text_match = normalize_text(caption_text) == normalize_text(reference_text)
        if not text_match:
            text_mismatches.append(section_id or "(unknown)")
        section_start = safe_float(section.get("caption_start_s") or section.get("audio_start_s"))
        section_end = safe_float(section.get("caption_end_s") or section.get("audio_end_s"))
        caption_start = min((safe_float(item.get("start_s")) for item in section_captions), default=None)
        caption_end = max((safe_float(item.get("end_s")) for item in section_captions), default=None)
        start_delta = abs((caption_start or 0) - (section_start or 0)) if caption_start is not None and section_start is not None else None
        end_delta = abs((caption_end or 0) - (section_end or 0)) if caption_end is not None and section_end is not None else None
        if start_delta is not None and start_delta > 0.18:
            timing_warnings.append(f"{section_id}: caption start delta {start_delta:.3f}s")
        if end_delta is not None and end_delta > 0.18:
            timing_warnings.append(f"{section_id}: caption end delta {end_delta:.3f}s")
        section_rows.append(
            {
                "section_id": section_id,
                "caption_count": len(section_captions),
                "text_match": text_match,
                "timing_source": section.get("timing_source"),
                "caption_start_s": round_or_none(caption_start),
                "caption_end_s": round_or_none(caption_end),
                "section_start_s": round_or_none(section_start),
                "section_end_s": round_or_none(section_end),
                "start_delta_s": round_or_none(start_delta),
                "end_delta_s": round_or_none(end_delta),
            }
        )

    for caption in captions:
        if not source_is_voice_text(caption.get("text_source")):
            source_warnings.append(
                f"caption {caption.get('caption_order')}: text_source={caption.get('text_source') or 'missing'}"
            )
    overlap_warnings: list[str] = []
    all_captions_sorted = sorted(captions, key=lambda item: safe_float(item.get("start_s")) or 0)
    previous_end: float | None = None
    for caption in all_captions_sorted:
        start = safe_float(caption.get("start_s"))
        end = safe_float(caption.get("end_s"))
        if start is None or end is None:
            timing_warnings.append(f"caption {caption.get('caption_order')}: 缺少 start_s/end_s")
            continue
        if end <= start:
            timing_warnings.append(f"caption {caption.get('caption_order')}: end_s <= start_s")
        if previous_end is not None and start < previous_end - 0.04:
            overlap_warnings.append(f"caption {caption.get('caption_order')}: 与上一条字幕重叠")
        previous_end = max(previous_end or end, end)

    full_voice_text = voice_script.get("full_voice_text") or voice_script.get("pronounce_text") or ""
    audio_voice_text = "".join(str(item.get("voice_text") or item.get("tts_text") or "") for item in sections)
    voice_script_matches_audio_sections = None
    if full_voice_text and audio_voice_text:
        voice_script_matches_audio_sections = normalize_text(full_voice_text) == normalize_text(audio_voice_text)
        if not voice_script_matches_audio_sections:
            warnings.append("voice_script.full_voice_text 与 audio_sections voice_text 拼接不一致。")
    elif not full_voice_text:
        warnings.append("缺少 voice_script.full_voice_text，无法确认 TTS 真源文本。")

    warnings.extend(timing_warnings)
    warnings.extend(overlap_warnings)
    if source_warnings:
        blocks.append(f"有 {len(source_warnings)} 条字幕 text_source 不是 voice_script/audio_sections。")
    if text_mismatches:
        blocks.append(f"有 {len(text_mismatches)} 个 section 的字幕文本与口播文本不一致。")

    audio_total = safe_float((audio_sections.get("summary") or {}).get("total_duration_s"))
    caption_total = safe_float((caption_plan.get("summary") or {}).get("total_duration_s"))
    if audio_total is not None and caption_total is not None and abs(audio_total - caption_total) > 0.2:
        warnings.append(f"caption total_duration_s 与 audio_sections 相差 {abs(audio_total - caption_total):.3f}s。")

    voice_wav = paths.get("voice_wav")
    if voice_wav and not voice_wav.exists():
        blocks.append("缺少 voice.wav，无法确认 TTS 音频主轴。")
    if not tts_audio:
        warnings.append("缺少 tts_audio.json，无法汇总 TTS provider/model/voice_id。")

    status = "pass"
    if warnings:
        status = "warning"
    if blocks:
        status = "block"
    detail = "字幕文本按 section 与口播同源，时间来自 audio_sections。"
    if warnings:
        detail = "字幕与口播主体同源，但存在时间或 TTS 元数据复核项。"
    if blocks:
        detail = "字幕文本或音频主轴存在硬性不一致。"
    tts_provider = tts_audio.get("provider") or {}
    return make_check(
        "voice_caption_alignment",
        "字幕与语音对齐",
        status,
        detail,
        metrics={
            "audio_section_count": len(sections) or None,
            "caption_count": len(captions) or None,
            "audio_total_duration_s": round_or_none(audio_total),
            "caption_total_duration_s": round_or_none(caption_total),
            "text_mismatch_section_count": len(text_mismatches),
            "bad_text_source_caption_count": len(source_warnings),
            "voice_script_matches_audio_sections": voice_script_matches_audio_sections,
            "tts_provider": tts_provider.get("name") or tts_audio.get("provider_name"),
            "tts_model": tts_provider.get("model"),
            "tts_voice_id": tts_provider.get("voice_id"),
            "tts_actual_duration_s": round_or_none((tts_audio.get("timing") or {}).get("actual_audio_duration_s")),
        },
        evidence={
            "sections": section_rows,
            "bad_text_sources_sample": source_warnings[:20],
            "text_mismatch_sections": text_mismatches,
            "caption_style": caption_plan.get("style") or {},
        },
        warnings=warnings,
        blocks=blocks,
    )


def build_omni_check(
    task_dir: Path,
    final_omni: dict[str, Any],
    final_omni_state: dict[str, Any],
    omni_runs: list[dict[str, Any]],
) -> dict[str, Any]:
    warnings: list[str] = []
    blocks: list[str] = []
    qa = final_omni.get("qa") or {}
    summary = final_omni.get("summary") or {}
    results = [item for item in (final_omni.get("results") or []) if isinstance(item, dict)]
    if not final_omni_state.get("exists"):
        warnings.append("缺少 qa_omni_alignment_final/omni_alignment_results.json，最终音画字幕匹配需要人工复核。")
    elif not final_omni_state.get("valid_json"):
        warnings.append(f"最终 Omni QA JSON 无法解析：{final_omni_state.get('error')}")
    else:
        status = qa.get("status") or "missing"
        if status != "ok":
            if status in {"block", "fail"}:
                blocks.append(f"最终 Omni QA status={status}")
            else:
                warnings.append(f"最终 Omni QA status={status}")
        fail_count = int(summary.get("fail_count") or 0)
        major_review_count = int(summary.get("major_review_count") or 0)
        minor_review_count = int(summary.get("minor_review_count") or 0)
        if fail_count or major_review_count:
            blocks.append(f"最终 Omni QA fail={fail_count}, major_review={major_review_count}")
        if minor_review_count:
            warnings.append(f"最终 Omni QA minor_review_count={minor_review_count}")
        for item in results:
            if item.get("overall") != "pass":
                message = f"{item.get('section_id')}: overall={item.get('overall')}, action={item.get('recommended_action')}"
                if item.get("overall") in {"fail", "major_review"}:
                    blocks.append(message)
                else:
                    warnings.append(message)

    status = "pass"
    if warnings:
        status = "manual_review"
    if blocks:
        status = "block"
    detail = "最终 Omni QA 全段通过。"
    if warnings:
        detail = "最终 Omni QA 缺失或有复核项，桌面端应提示人工审核。"
    if blocks:
        detail = "最终 Omni QA 未通过，不能直接发布。"
    latest_preview = next((run for run in sorted(omni_runs, key=lambda item: item.get("mtime", 0), reverse=True) if not run.get("is_final")), None)
    return make_check(
        "omni_alignment",
        "Omni 音画字幕 QA",
        status,
        detail,
        metrics={
            "final_status": qa.get("status") or ("missing" if not final_omni_state.get("exists") else ""),
            "section_count": summary.get("section_count"),
            "pass_count": summary.get("pass_count"),
            "minor_review_count": summary.get("minor_review_count"),
            "major_review_count": summary.get("major_review_count"),
            "fail_count": summary.get("fail_count"),
            "omni_run_count": len(omni_runs),
            "latest_preview_status": latest_preview.get("status") if latest_preview else None,
        },
        evidence={
            "final_results": str(task_dir / "qa_omni_alignment_final" / "omni_alignment_results.json"),
            "final_report": str(task_dir / "qa_omni_alignment_final" / "OMNI_ALIGNMENT_QA_REPORT.md"),
            "runs": omni_runs,
            "section_results": [
                {
                    "section_id": item.get("section_id"),
                    "audio_caption_match": item.get("audio_caption_match"),
                    "visual_match": item.get("visual_match"),
                    "overall": item.get("overall"),
                    "recommended_action": item.get("recommended_action"),
                    "mismatch": item.get("mismatch"),
                }
                for item in results
            ],
        },
        warnings=warnings,
        blocks=blocks,
    )


def collect_freeze_logs(task_dir: Path, full_manifest: dict[str, Any]) -> dict[str, Any]:
    logs: dict[str, Any] = {}
    for path in sorted(task_dir.glob("qa_freezedetect*.log")):
        logs[path.name] = {"path": str(path), "exists": True, "events": parse_freezedetect(path)}
    manifest_freeze = ((full_manifest.get("qa") or {}).get("freezedetect") or {}) if isinstance(full_manifest, dict) else {}
    if manifest_freeze:
        logs["full_pipeline_manifest.qa.freezedetect"] = manifest_freeze
    return logs


def build_render_check(
    task_dir: Path,
    paths: dict[str, Path],
    payloads: dict[str, dict[str, Any]],
    full_manifest: dict[str, Any],
) -> dict[str, Any]:
    warnings: list[str] = []
    blocks: list[str] = []
    final_video = paths["final_subtitled"]
    preview_video = paths["preview_no_subtitles"]
    voice_wav = paths["voice_wav"]
    final_probe = ffprobe_media(final_video)
    preview_probe = ffprobe_media(preview_video)
    voice_probe = ffprobe_media(voice_wav)
    final_duration = media_duration(final_probe)
    preview_duration = media_duration(preview_probe)
    voice_duration = media_duration(voice_probe)
    timeline_summary = (payloads.get("timeline_fill") or {}).get("summary") or {}
    audio_summary = (payloads.get("audio_sections") or {}).get("summary") or {}
    audio_duration = safe_float(timeline_summary.get("voice_duration_s")) or safe_float(audio_summary.get("total_duration_s"))

    if not final_video.exists():
        blocks.append("缺少最终字幕成片 final_subtitled.mp4。")
    if final_probe.get("error"):
        warnings.append(f"ffprobe final_subtitled 失败：{final_probe.get('error')}")
    if final_probe.get("warning"):
        warnings.append(str(final_probe.get("warning")))
    if final_duration is not None and audio_duration is not None and abs(final_duration - audio_duration) > 0.35:
        warnings.append(f"最终视频时长与音频主轴相差 {abs(final_duration - audio_duration):.3f}s。")
    if preview_duration is not None and voice_duration is not None and abs(preview_duration - voice_duration) > 0.25:
        warnings.append(f"无字幕预览时长与 voice.wav 相差 {abs(preview_duration - voice_duration):.3f}s。")

    hyperframes_manifest = payloads.get("hyperframes_manifest") or {}
    hyperframes_qa = hyperframes_manifest.get("qa") or {}
    if hyperframes_manifest and hyperframes_qa.get("status") not in (None, "ok", "pass"):
        warnings.append(f"HyperFrames manifest qa.status={hyperframes_qa.get('status')}")
    if not hyperframes_manifest:
        warnings.append("缺少 hyperframes_subtitle_burn_manifest.json，无法汇总字幕烧录 worker QA。")

    freeze_logs = collect_freeze_logs(task_dir, full_manifest)
    final_freeze_events: list[dict[str, Any]] = []
    for name, info in freeze_logs.items():
        events = info.get("events") if isinstance(info, dict) else None
        if not isinstance(events, list):
            continue
        if "final" in name or name == "qa_freezedetect.log":
            final_freeze_events.extend(events)
    if final_freeze_events:
        warnings.append(f"最终视频 freezedetect 检出 {len(final_freeze_events)} 个静帧事件。")
    if not freeze_logs:
        warnings.append("缺少 qa_freezedetect*.log，无法自动判断最终视频静帧。")

    qa_frame_dirs = [task_dir / "qa_frames", task_dir / "qa_final_frames", task_dir / "qa_preview_contact"]
    qa_frame_counts = {
        path.name: len([item for item in path.iterdir() if item.is_file()]) if path.exists() and path.is_dir() else 0
        for path in qa_frame_dirs
    }
    manifest_screenshots = ((full_manifest.get("qa") or {}).get("screenshots") or []) if isinstance(full_manifest, dict) else []
    if not any(qa_frame_counts.values()) and not manifest_screenshots:
        warnings.append("缺少 QA 抽帧截图目录，字幕遮挡与首尾帧需人工打开视频检查。")

    status = "pass"
    if warnings:
        status = "warning"
    if blocks:
        status = "block"
    detail = "最终视频存在，渲染探测和静帧 QA 未发现阻断问题。"
    if warnings:
        detail = "最终视频存在，但渲染 QA 有复核或证据缺口。"
    if blocks:
        detail = "最终视频缺失或无法作为生产成片。"
    return make_check(
        "render_qa",
        "渲染与成片 QA",
        status,
        detail,
        metrics={
            "final_video_exists": final_video.exists(),
            "final_duration_s": round_or_none(final_duration),
            "preview_duration_s": round_or_none(preview_duration),
            "voice_duration_s": round_or_none(voice_duration),
            "audio_axis_duration_s": round_or_none(audio_duration),
            "final_audio_duration_delta_s": round_or_none(abs(final_duration - audio_duration)) if final_duration is not None and audio_duration is not None else None,
            "preview_voice_duration_delta_s": round_or_none(abs(preview_duration - voice_duration)) if preview_duration is not None and voice_duration is not None else None,
            "freezedetect_log_count": len(freeze_logs),
            "final_freeze_event_count": len(final_freeze_events),
            "qa_frame_counts": qa_frame_counts,
        },
        evidence={
            "media": {
                "final_subtitled": {"path": str(final_video), "probe": final_probe},
                "preview_no_subtitles": {"path": str(preview_video), "probe": preview_probe},
                "voice_wav": {"path": str(voice_wav), "probe": voice_probe},
            },
            "hyperframes_manifest": str(paths["hyperframes_manifest"]),
            "hyperframes_qa": hyperframes_qa,
            "freezedetect": freeze_logs,
            "manifest_screenshots": manifest_screenshots,
        },
        warnings=warnings,
        blocks=blocks,
    )


def build_artifact_check(paths: dict[str, Path], input_states: dict[str, dict[str, Any]]) -> dict[str, Any]:
    required = ("audio_sections", "timeline_fill", "caption_plan", "voice_wav", "final_subtitled")
    optional = (
        "full_pipeline_manifest",
        "voice_script",
        "tts_audio",
        "candidate_sections",
        "timeline_selection",
        "hyperframes_manifest",
        "omni_final_results",
        "qa_gate_report",
    )
    warnings: list[str] = []
    blocks: list[str] = []
    for label in required:
        if not paths[label].exists():
            blocks.append(f"缺少必需产物 {label}: {paths[label]}")
    for label in optional:
        if not paths[label].exists():
            warnings.append(f"缺少可选 QA/manifest 产物 {label}: {paths[label]}")
        elif label in input_states and not input_states[label].get("valid_json", True):
            warnings.append(f"{label} JSON 无法解析：{input_states[label].get('error')}")
    status = "pass"
    if warnings:
        status = "warning"
    if blocks:
        status = "block"
    return make_check(
        "artifacts",
        "关键产物完整性",
        status,
        "关键产物已落盘，缺失的 QA 文件会进入 warning 而不是中断脚本。" if not blocks else "存在缺失的生产必需产物。",
        metrics={
            "required_count": len(required),
            "missing_required_count": len(blocks),
            "missing_optional_count": sum(1 for label in optional if not paths[label].exists()),
        },
        evidence={"artifacts": {label: file_info(path) for label, path in paths.items()}},
        warnings=warnings,
        blocks=blocks,
    )


def markdown_status(status: Any) -> str:
    mapping = {
        "ok": "通过",
        "pass": "通过",
        "warning": "有警告",
        "manual_review": "需人工复核",
        "block": "阻断",
    }
    return mapping.get(str(status or ""), str(status or "unknown"))


def md_escape(value: Any) -> str:
    return str(value or "").replace("|", "/").replace("\n", " ").strip()


def render_markdown(report: dict[str, Any]) -> str:
    qa = report.get("qa") or {}
    summary = report.get("summary") or {}
    outputs = report.get("outputs") or {}
    artifacts = report.get("artifacts") or {}
    checks = report.get("checks") or []
    lines = [
        "# Voah 生产质检汇总",
        "",
        f"- 结论: **{markdown_status(qa.get('status'))}**",
        f"- task_dir: `{report.get('task_dir')}`",
        f"- final_video: `{outputs.get('final_video') or ''}`",
        f"- JSON: `{outputs.get('quality_report') or ''}`",
        "",
        "## 摘要",
        "",
        f"- 产品: {md_escape((report.get('product') or {}).get('name') or (report.get('product') or {}).get('slug') or '')}",
        f"- 段落数: {summary.get('audio_section_count') or ''}",
        f"- 字幕数: {summary.get('caption_count') or ''}",
        f"- 已选 clip 数: {summary.get('selected_clip_count') or ''}",
        f"- 最终视频时长: {summary.get('final_duration_s') or ''}s",
        "",
        "## 检查项",
        "",
        "| ID | 检查 | 状态 | 说明 |",
        "|---|---|---|---|",
    ]
    for check in checks:
        lines.append(
            "| {id} | {label} | {status} | {detail} |".format(
                id=md_escape(check.get("id")),
                label=md_escape(check.get("label")),
                status=markdown_status(check.get("status")),
                detail=md_escape(check.get("detail")),
            )
        )
    active_warnings = qa.get("warnings") or []
    active_blocks = qa.get("blocks") or []
    resolved = qa.get("resolved_warnings") or []
    lines.extend(["", "## 风险与复核", ""])
    if active_blocks:
        lines.append("### 阻断")
        for item in active_blocks[:20]:
            lines.append(f"- {md_escape(item.get('message'))} x{item.get('count')}")
    if active_warnings:
        lines.append("### 警告")
        for item in active_warnings[:30]:
            lines.append(f"- {md_escape(item.get('message'))} x{item.get('count')}")
    if resolved:
        lines.append("### 已被最终 QA 兜底的 warning")
        for item in resolved[:20]:
            lines.append(f"- {md_escape(item)}")
        if len(resolved) > 20:
            lines.append(f"- 其余 {len(resolved) - 20} 条见 JSON。")
    if not active_blocks and not active_warnings:
        lines.append("- 无未解决阻断或警告。")

    quality = report.get("quality") or {}
    retrieval_sections = ((quality.get("retrieval") or {}).get("evidence") or {}).get("sections") or []
    omni_sections = ((quality.get("omni_alignment") or {}).get("evidence") or {}).get("section_results") or []
    omni_by_id = {str(item.get("section_id") or ""): item for item in omni_sections if isinstance(item, dict)}
    if retrieval_sections:
        lines.extend(["", "## 分段与召回摘要", "", "| Section | Clip 数 | 需复核 Clip | 缺口 | Omni |", "|---|---:|---:|---:|---|"])
        for section in retrieval_sections:
            section_id = str(section.get("section_id") or "")
            omni = omni_by_id.get(section_id) or {}
            lines.append(
                "| {sid} | {clips} | {review} | {missing} | {omni} |".format(
                    sid=md_escape(section_id),
                    clips=section.get("selected_clip_count") or 0,
                    review=section.get("requires_visual_review_clip_count") or 0,
                    missing=section.get("missing_duration_s") or 0,
                    omni=md_escape(omni.get("overall") or ""),
                )
            )

    lines.extend(["", "## 关键路径", ""])
    for label in (
        "full_pipeline_manifest",
        "audio_sections",
        "timeline_fill",
        "caption_plan",
        "omni_final_report",
        "final_subtitled",
    ):
        info = artifacts.get(label) or {}
        lines.append(f"- {label}: `{info.get('path') or ''}`")
    lines.append("")
    return "\n".join(lines)


def build_report(task_dir: Path, output: Path, markdown_output: Path) -> dict[str, Any]:
    full_manifest_path = task_dir / "full_pipeline_manifest.json"
    full_manifest, full_manifest_state = load_json_state(full_manifest_path)
    paths = build_paths(task_dir, full_manifest)
    payload_labels = (
        "voice_script",
        "tts_audio",
        "audio_sections",
        "candidate_sections",
        "timeline_selection",
        "timeline_fill",
        "caption_plan",
        "hyperframes_manifest",
        "qa_gate_report",
        "export_record",
    )
    payloads: dict[str, dict[str, Any]] = {"full_pipeline_manifest": full_manifest}
    input_states: dict[str, dict[str, Any]] = {"full_pipeline_manifest": full_manifest_state}
    for label in payload_labels:
        payload, state = load_json_state(paths[label])
        payloads[label] = payload
        input_states[label] = state

    omni_runs = find_omni_runs(task_dir)
    final_omni, final_omni_state = pick_final_omni(omni_runs, task_dir)
    input_states["omni_final_results"] = final_omni_state
    final_omni_ok = omni_final_passed(final_omni)

    artifact_check = build_artifact_check(paths, input_states)
    segmentation_check, segmentation_extra = build_segmentation_check(task_dir, payloads, input_states)
    retrieval_check, retrieval_resolved = build_retrieval_check(payloads, input_states, omni_passed=final_omni_ok)
    loop_check = build_loop_check(payloads)
    voice_caption_check = build_voice_caption_check(payloads, paths)
    omni_check = build_omni_check(task_dir, final_omni, final_omni_state, omni_runs)
    render_check = build_render_check(task_dir, paths, payloads, full_manifest)
    checks = [
        artifact_check,
        segmentation_check,
        retrieval_check,
        loop_check,
        voice_caption_check,
        omni_check,
        render_check,
    ]

    warnings: list[str] = []
    blocks: list[str] = []
    for check in checks:
        for warning in check.get("warnings") or []:
            warnings.extend([warning.get("message")] * int(warning.get("count") or 1))
        for block in check.get("blocks") or []:
            blocks.extend([block.get("message")] * int(block.get("count") or 1))
    resolved_warnings = dedupe(retrieval_resolved + ((full_manifest.get("qa") or {}).get("resolved_warnings") or []))
    qa_status = qa_status_from_checks(checks)

    audio_sections = payloads.get("audio_sections") or {}
    timeline_fill = payloads.get("timeline_fill") or {}
    caption_plan = payloads.get("caption_plan") or {}
    tts_audio = payloads.get("tts_audio") or {}
    final_probe = ffprobe_media(paths["final_subtitled"])
    product = (
        full_manifest.get("product")
        or audio_sections.get("product")
        or timeline_fill.get("product")
        or caption_plan.get("product")
        or {}
    )

    report = {
        "schema_version": SCHEMA_VERSION,
        "stage": "voah_desktop_quality_report",
        "created_at": iso_now(),
        "task_dir": str(task_dir),
        "product": product,
        "inputs": {
            "task_dir": str(task_dir),
            "artifacts": {label: state for label, state in input_states.items()},
        },
        "outputs": {
            "quality_report": str(output),
            "markdown_report": str(markdown_output),
            "final_video": str(paths["final_subtitled"]),
            "preview_no_subtitles": str(paths["preview_no_subtitles"]),
            "voice_wav": str(paths["voice_wav"]),
        },
        "artifacts": {label: file_info(path) for label, path in paths.items()},
        "summary": {
            "status": qa_status,
            "audio_section_count": (audio_sections.get("summary") or {}).get("section_count")
            or len(audio_sections.get("sections") or []),
            "caption_count": (caption_plan.get("summary") or {}).get("caption_count")
            or len(caption_plan.get("captions") or []),
            "selected_clip_count": (timeline_fill.get("summary") or {}).get("selected_clip_count"),
            "selected_child_physical_clip_count": (timeline_fill.get("summary") or {}).get("selected_child_physical_clip_count"),
            "missing_duration_s": (timeline_fill.get("summary") or {}).get("missing_duration_s"),
            "final_duration_s": round_or_none(media_duration(final_probe)),
            "tts_duration_s": round_or_none((tts_audio.get("timing") or {}).get("actual_audio_duration_s")),
            "omni_final_status": ((final_omni.get("qa") or {}).get("status") or "missing"),
            "omni_final_passed": final_omni_ok,
        },
        "checks": checks,
        "quality": {
            "segmentation": segmentation_check,
            "segmentation_sources": segmentation_extra,
            "retrieval": retrieval_check,
            "loop_policy": loop_check,
            "voice_caption_alignment": voice_caption_check,
            "omni_alignment": omni_check,
            "render_qa": render_check,
        },
        "qa": {
            "status": qa_status,
            "warnings": counted_messages(warnings),
            "blocks": counted_messages(blocks),
            "resolved_warnings": resolved_warnings,
        },
        "next_consumers": ["desktop-review-page", "qa:getReport", "export-record"],
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Build desktop_quality_report.json and Markdown for a Voah task directory.")
    parser.add_argument("--task-dir", required=True, help="Voah task directory.")
    parser.add_argument(
        "--output",
        default="desktop_quality_report.json",
        help="JSON output path. Bare filenames are under task_dir; relative paths with directories are under cwd.",
    )
    parser.add_argument(
        "--markdown-output",
        default="",
        help="Markdown output path. Bare filenames are under task_dir; defaults to the JSON output path with .md suffix.",
    )
    args = parser.parse_args()

    task_dir = Path(args.task_dir).expanduser().resolve()
    if not task_dir.exists() or not task_dir.is_dir():
        raise SystemExit(f"task_dir does not exist or is not a directory: {task_dir}")
    output = as_output_path(args.output, task_dir)
    markdown_output = as_output_path(args.markdown_output, task_dir) if args.markdown_output else output.with_suffix(".md")

    report = build_report(task_dir, output, markdown_output)
    write_json(output, report)
    write_text(markdown_output, render_markdown(report))
    print(f"quality_report={output}")
    print(f"markdown_report={markdown_output}")
    print(f"qa={report['qa']['status']}")
    print(f"warnings={sum(item['count'] for item in report['qa']['warnings'])}")
    print(f"blocks={sum(item['count'] for item in report['qa']['blocks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
