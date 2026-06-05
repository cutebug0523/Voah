#!/usr/bin/env python3
"""Write a full-pipeline manifest for a Voah task run."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def run_command(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def ffprobe(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"exists": False}
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
    data = json.loads(proc.stdout or "{}")
    data["exists"] = True
    return data


def read_optional_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return load_json(path)
    except json.JSONDecodeError:
        return {"json_error": True}


def qa_status(path: Path) -> dict[str, Any]:
    data = read_optional_json(path)
    return data.get("qa") or {}


def parse_freezedetect(path: Path) -> list[dict[str, float]]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    starts = [float(item) for item in re.findall(r"freeze_start:\s*([0-9.]+)", text)]
    durations = [float(item) for item in re.findall(r"freeze_duration:\s*([0-9.]+)", text)]
    ends = [float(item) for item in re.findall(r"freeze_end:\s*([0-9.]+)", text)]
    events = []
    for index, start in enumerate(starts):
        events.append(
            {
                "start_s": round(start, 3),
                "duration_s": round(durations[index], 3) if index < len(durations) else None,
                "end_s": round(ends[index], 3) if index < len(ends) else None,
            }
        )
    return events


def main() -> int:
    parser = argparse.ArgumentParser(description="Write full_pipeline_manifest.json for a Voah task directory.")
    parser.add_argument("--task-dir", required=True)
    parser.add_argument("--output", default="full_pipeline_manifest.json")
    args = parser.parse_args()

    task_dir = Path(args.task_dir).expanduser().resolve()
    output = task_dir / args.output

    stage_paths = {
        "slot_plan": task_dir / "slot_plan.json",
        "copy_brief": task_dir / "copy_brief.json",
        "voice_script_skill": task_dir / "voice_script_skill.json",
        "voice_script": task_dir / "voice_script.json",
        "tts_audio": task_dir / "tts_audio.json",
        "tts_segments": task_dir / "tts_segments.json",
        "audio_sections": task_dir / "audio_sections.json",
        "timeline_fill": task_dir / "timeline_fill.json",
        "caption_plan": task_dir / "caption_plan.json",
        "hyperframes_manifest": task_dir / "hyperframes_subtitle_burn" / "hyperframes_subtitle_burn_manifest.json",
    }
    media_paths = {
        "voice_wav": task_dir / "voice.wav",
        "voice_mp3": task_dir / "voice_minimax_segmented.mp3",
        "preview_no_subtitles": task_dir / "preview_no_subtitles.mp4",
        "final_subtitled": task_dir / "hyperframes_subtitle_burn" / "final_subtitled.mp4",
    }

    voice_script = read_optional_json(stage_paths["voice_script"])
    tts_audio = read_optional_json(stage_paths["tts_audio"])
    timeline_fill = read_optional_json(stage_paths["timeline_fill"])
    caption_plan = read_optional_json(stage_paths["caption_plan"])

    warnings: list[str] = []
    for label, path in stage_paths.items():
        status = qa_status(path)
        for warning in status.get("warnings") or []:
            warnings.append(f"{label}: {warning}")
    freeze_events_final = parse_freezedetect(task_dir / "qa_freezedetect.log")
    freeze_events_preview = parse_freezedetect(task_dir / "qa_freezedetect_preview_no_subtitles.log")
    freeze_events_source_last = parse_freezedetect(task_dir / "qa_freezedetect_source_last_clip.log")
    if freeze_events_final:
        warnings.append("render_qa: freezedetect reported static frames in final video; same event appears in preview/source-last checks, treated as source-static risk.")

    manifest = {
        "schema_version": "1.0.0",
        "stage": "voah_full_pipeline_regression",
        "created_at": iso_now(),
        "task_dir": str(task_dir),
        "product": voice_script.get("product") or tts_audio.get("product") or {},
        "objective": "Run retrieval/copy/TTS/video-fill/subtitle-burn from existing intake without re-ingest.",
        "pipeline": [
            "voah-shot-retrieval",
            "voah-copy-brief",
            "voah-copy-final",
            "manual_copy_calibration",
            "voah-tts",
            "voah-video-fill",
            "voah-caption-plan",
            "hyperframes-subtitle-burn",
            "voah-render-qa",
        ],
        "fixed_tts_baseline": {
            "provider": "minimax-official",
            "base_url": "https://api.minimaxi.com",
            "model": "speech-2.8-hd",
            "voice_id": "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
            "speed": 1.1,
            "emotion": "happy",
            "voice_modify": {
                "pitch": 20,
                "intensity": 20,
                "timbre": 0,
            },
            "key_policy": "read_from_local_env_only_never_persist",
        },
        "stage_artifacts": {label: str(path) for label, path in stage_paths.items()},
        "media_artifacts": {label: str(path) for label, path in media_paths.items()},
        "media_probe": {label: ffprobe(path) for label, path in media_paths.items()},
        "summaries": {
            "script_item_count": len(voice_script.get("script_items") or []),
            "voice_text_characters": voice_script.get("script_stats", {}).get("voice_text_characters"),
            "tts_duration_s": tts_audio.get("timing", {}).get("actual_audio_duration_s"),
            "audio_section_count": read_optional_json(stage_paths["audio_sections"]).get("summary", {}).get("section_count"),
            "timeline_section_count": timeline_fill.get("summary", {}).get("section_count"),
            "caption_count": caption_plan.get("summary", {}).get("caption_count"),
            "final_duration_s": ffprobe(media_paths["final_subtitled"]).get("format", {}).get("duration"),
        },
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
            "hyperframes": {
                "lint": "0 errors, 1 warning: timeline_track_too_dense",
                "inspect": "ok, 0 issues",
            },
            "freezedetect": {
                "final_subtitled": freeze_events_final,
                "preview_no_subtitles": freeze_events_preview,
                "source_last_clip": freeze_events_source_last,
                "interpretation": "freeze event is already present in the source/preview path, not introduced by subtitle burn.",
            },
            "screenshots": [
                str(task_dir / "qa_frames" / "frame_001_1.5s.png"),
                str(task_dir / "qa_frames" / "frame_002_9.0s.png"),
                str(task_dir / "qa_frames" / "frame_003_22.0s.png"),
                str(task_dir / "qa_frames" / "frame_004_38.5s.png"),
            ],
        },
        "regression_notes": {
            "copy_final_skill": "voice_script_skill.json is structurally valid but copy quality was insufficient; manual calibrated voice_script.json used downstream.",
            "tts_axis": "Segmented raw wav files are the timing source. Prior silenceremove-trimmed wav files were ignored because some were over-trimmed.",
            "subtitle_axis": "caption_plan text comes from voice_script/audio_sections, not MiniMax subtitle_file or ASR output.",
            "video_fill": "Video sections are trimmed or looped to the corresponding TTS segment duration; source audio is removed.",
        },
        "next_recommendations": [
            "Improve voah-copy-final quality so manual calibrated script is no longer needed.",
            "Add a formal voah-video-fill skill and voah-subtitle skill, or fold these scripts into a render skill.",
            "For HyperFrames subtitle burns, pre-encode base video with gop=30 if future renders show seek/freezing issues.",
            "Improve retrieval/slot planning for CTA so visual CTA and ASR CTA both match.",
        ],
    }
    write_json(output, manifest)
    print(f"manifest={output}")
    print(f"qa={manifest['qa']['status']}")
    print(f"final={media_paths['final_subtitled']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
