#!/usr/bin/env python3
"""Run one-shot MiniMax TTS and build Voah audio_sections.json."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


def iso_now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


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


def run_command(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def has_command(command: str) -> bool:
    return subprocess.run(["/bin/sh", "-lc", f"command -v {command}"], check=False, capture_output=True, text=True).returncode == 0


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


def convert_to_wav(input_audio: Path, output_wav: Path) -> None:
    proc = run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_audio),
            "-ar",
            "32000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(output_wav),
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "failed to convert audio").strip())


def minimax_endpoint(provider: str, base_url: str) -> str:
    base = base_url.rstrip("/")
    if provider == "vectorengine-minimax":
        return f"{base}/minimax/v1/t2a_v2"
    return f"{base}/v1/t2a_v2"


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def env_int(name: str, default: int) -> int:
    try:
        return int(float(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def build_payload(text: str, args: argparse.Namespace) -> dict[str, Any]:
    voice_id = args.voice_id or os.environ.get("VOAH_TTS_VOICE_ID", "")
    model = args.model or os.environ.get("VOAH_TTS_MODEL", "speech-2.8-hd")
    speed = args.speed if args.speed is not None else env_float("VOAH_TTS_SPEED", 1.1)
    vol = args.vol if args.vol is not None else env_float("VOAH_TTS_VOL", 1)
    voice_pitch = args.voice_setting_pitch if args.voice_setting_pitch is not None else env_int("VOAH_TTS_VOICE_SETTING_PITCH", 0)
    emotion = args.emotion or os.environ.get("VOAH_TTS_EMOTION", "happy")
    return {
        "model": model,
        "text": text,
        "stream": False,
        "language_boost": "Chinese",
        "output_format": args.output_format,
        "voice_setting": {
            "voice_id": voice_id,
            "speed": speed,
            "vol": vol,
            "pitch": voice_pitch,
            "emotion": emotion,
        },
        "voice_modify": {
            "pitch": args.modify_pitch if args.modify_pitch is not None else env_int("VOAH_TTS_VOICE_MODIFY_PITCH", 20),
            "intensity": args.modify_intensity if args.modify_intensity is not None else env_int("VOAH_TTS_VOICE_MODIFY_INTENSITY", 20),
            "timbre": args.modify_timbre if args.modify_timbre is not None else env_int("VOAH_TTS_VOICE_MODIFY_TIMBRE", 0),
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
            "channel": 1,
        },
        "subtitle_enable": bool(args.subtitle_enable),
        "subtitle_type": args.subtitle_type,
    }


def sanitize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return dict(payload)


def sanitize_response(response: dict[str, Any]) -> dict[str, Any]:
    def scrub(value: Any) -> Any:
        if isinstance(value, dict):
            output = {}
            for key, item in value.items():
                if key == "audio":
                    output[key] = "<audio hex omitted>"
                else:
                    output[key] = scrub(item)
            return output
        if isinstance(value, list):
            return [scrub(item) for item in value]
        if isinstance(value, str) and len(value) > 1000:
            return value[:1000] + "...<truncated>"
        return value

    return scrub(response)


def parse_minimax_response_bytes(raw: bytes) -> dict[str, Any]:
    return json.loads(raw.decode("utf-8"))


def call_minimax(endpoint: str, api_key: str, payload: dict[str, Any], timeout_s: int) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(1, 4):
        req = urllib.request.Request(
            endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Connection": "close",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return parse_minimax_response_bytes(resp.read())
        except http.client.IncompleteRead as exc:
            last_error = exc
            partial = bytes(exc.partial or b"")
            if partial:
                try:
                    return parse_minimax_response_bytes(partial)
                except json.JSONDecodeError:
                    pass
        except Exception as exc:
            last_error = exc
        if attempt < 3:
            time.sleep(1.2 * attempt)
    raise RuntimeError(f"MiniMax request failed after retries: {last_error}")


def extract_audio_hex(response: dict[str, Any]) -> str:
    audio = (response.get("data") or {}).get("audio")
    if not isinstance(audio, str) or not audio.strip():
        raise RuntimeError("MiniMax response did not include data.audio")
    return audio.strip()


def extract_audio_value(response: dict[str, Any]) -> str:
    audio = (response.get("data") or {}).get("audio")
    if not isinstance(audio, str) or not audio.strip():
        raise RuntimeError("MiniMax response did not include data.audio")
    return audio.strip()


def save_audio_response(audio_value: str, mp3_path: Path, output_format: str, expected_size: int | None = None) -> None:
    if audio_value.startswith("http://") or audio_value.startswith("https://"):
        last_error: Exception | None = None
        tmp_path = mp3_path.with_suffix(mp3_path.suffix + ".part")
        for attempt in range(1, 4):
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
                expected_content_length = None
                if has_command("curl"):
                    proc = subprocess.run(
                        [
                            "curl",
                            "--location",
                            "--fail",
                            "--silent",
                            "--show-error",
                            "--retry",
                            "5",
                            "--retry-all-errors",
                            "--connect-timeout",
                            "30",
                            "--max-time",
                            "300",
                            "--output",
                            str(tmp_path),
                            "--write-out",
                            "%{size_download} %{http_code}",
                            audio_value,
                        ],
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    if proc.returncode != 0:
                        raise RuntimeError((proc.stderr or proc.stdout or "curl download failed").strip())
                    parts = (proc.stdout or "").strip().split()
                    bytes_written = int(float(parts[0])) if parts else tmp_path.stat().st_size
                else:
                    with urllib.request.urlopen(audio_value, timeout=180) as resp, tmp_path.open("wb") as f:
                        content_length = resp.headers.get("Content-Length")
                        try:
                            expected_content_length = int(content_length) if content_length else None
                        except ValueError:
                            expected_content_length = None
                        bytes_written = 0
                        while True:
                            chunk = resp.read(1024 * 256)
                            if not chunk:
                                break
                            bytes_written += len(chunk)
                            f.write(chunk)
                if tmp_path.exists():
                    bytes_written = tmp_path.stat().st_size
                if expected_content_length and bytes_written != expected_content_length:
                    raise RuntimeError(f"downloaded {bytes_written} bytes, expected Content-Length {expected_content_length}")
                if expected_size and bytes_written < expected_size:
                    raise RuntimeError(f"downloaded {bytes_written} bytes, expected audio_size {expected_size}")
                if tmp_path.exists() and tmp_path.stat().st_size > 0:
                    tmp_path.replace(mp3_path)
                    return
            except http.client.IncompleteRead as exc:
                last_error = exc
                if tmp_path.exists():
                    tmp_path.unlink()
            except Exception as exc:
                last_error = exc
                if tmp_path.exists():
                    tmp_path.unlink()
            if attempt < 3:
                time.sleep(1.2 * attempt)
        raise RuntimeError(f"failed to download MiniMax audio: {last_error}")
    audio_bytes = bytes.fromhex(audio_value)
    if expected_size and len(audio_bytes) < expected_size:
        raise RuntimeError(f"decoded {len(audio_bytes)} bytes, expected audio_size {expected_size}")
    mp3_path.write_bytes(audio_bytes)


def check_response_ok(response: dict[str, Any]) -> None:
    base = response.get("base_resp") or {}
    status_code = base.get("status_code")
    if status_code not in (0, None):
        raise RuntimeError(f"MiniMax failed: {status_code} {base.get('status_msg', '')}")


def download_subtitle_file(response: dict[str, Any], task_dir: Path) -> tuple[Path | None, Any, list[str]]:
    warnings: list[str] = []
    url = (response.get("data") or {}).get("subtitle_file")
    if not isinstance(url, str) or not url:
        return None, None, warnings
    output = task_dir / "minimax_subtitle_sentence.raw"
    try:
        with urllib.request.urlopen(url, timeout=120) as resp:
            raw = resp.read()
        output.write_bytes(raw)
        text = raw.decode("utf-8", errors="replace")
        try:
            parsed = json.loads(text)
            write_json(task_dir / "minimax_subtitle_sentence.json", parsed)
            return task_dir / "minimax_subtitle_sentence.json", parsed, warnings
        except json.JSONDecodeError:
            write_text(task_dir / "minimax_subtitle_sentence.txt", text)
            warnings.append("subtitle_file downloaded but is not valid JSON")
            return output, text, warnings
    except Exception as exc:
        warnings.append(f"failed to download MiniMax subtitle_file: {exc}")
        return None, None, warnings


PUNCT_RE = re.compile(r"[\s，。！？、,.!?；;：:\"'“”‘’（）()\[\]【】《》<>+\-_/]+")


def normalize_text(text: str) -> str:
    return PUNCT_RE.sub("", text or "")


def speech_units(text: str) -> int:
    normalized = normalize_text(text)
    return max(1, len(normalized))


def time_value(value: Any, audio_duration_s: float | None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if audio_duration_s and number > audio_duration_s * 3:
        number = number / 1000.0
    return round(number, 3)


def collect_subtitle_items(raw: Any, audio_duration_s: float | None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return

        text = None
        for key in ("text", "sentence", "subtitle", "content", "word"):
            if isinstance(value.get(key), str):
                text = value.get(key)
                break
        start = None
        end = None
        for key in ("start", "start_time", "start_ms", "begin", "begin_time", "begin_ms", "time_begin"):
            if key in value:
                start = time_value(value.get(key), audio_duration_s)
                break
        for key in ("end", "end_time", "end_ms", "finish", "finish_time", "finish_ms", "time_end"):
            if key in value:
                end = time_value(value.get(key), audio_duration_s)
                break
        if text is not None and start is not None and end is not None and end > start:
            char_start = value.get("pronounce_text_begin", value.get("text_begin"))
            char_end = value.get("pronounce_text_end", value.get("text_end"))
            item = {"text": text, "start_s": start, "end_s": end}
            try:
                item["char_start"] = int(char_start)
                item["char_end"] = int(char_end)
            except (TypeError, ValueError):
                pass
            items.append(item)

        for item in value.values():
            if isinstance(item, (dict, list)):
                visit(item)

    visit(raw)
    deduped = []
    seen = set()
    for item in sorted(items, key=lambda row: (row["start_s"], row["end_s"], row["text"])):
        key = (item["start_s"], item["end_s"], item["text"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def subtitle_timing_is_usable(subtitle_items: list[dict[str, Any]], audio_duration_s: float) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    if not subtitle_items:
        return False, warnings
    max_end = max(float(item.get("end_s") or 0) for item in subtitle_items)
    tolerance = max(1.0, audio_duration_s * 0.08)
    if abs(max_end - audio_duration_s) > tolerance:
        warnings.append(
            f"MiniMax subtitle max end {max_end:.3f}s differs from decoded voice.wav {audio_duration_s:.3f}s; fallback to weighted text timing"
        )
        return False, warnings
    previous_end = -0.001
    for index, item in enumerate(subtitle_items, start=1):
        start = float(item.get("start_s") or 0)
        end = float(item.get("end_s") or 0)
        if end <= start:
            warnings.append(f"MiniMax subtitle item {index} has invalid timing {start:.3f}->{end:.3f}")
            return False, warnings
        if start < previous_end - 0.02:
            warnings.append(f"MiniMax subtitle item {index} overlaps previous item {previous_end:.3f}->{start:.3f}")
            return False, warnings
        previous_end = end
    return True, warnings


def section_tts_lengths(sections: list[dict[str, Any]]) -> list[int]:
    return [len(str(section.get("tts_text") or section.get("voice_text") or "")) for section in sections]


def boundary_time_from_char_offset(subtitle_items: list[dict[str, Any]], offset: int, audio_duration_s: float) -> float:
    if not subtitle_items:
        return 0.0
    items = [item for item in subtitle_items if "char_start" in item and "char_end" in item]
    if not items:
        return 0.0
    items.sort(key=lambda item: (int(item["char_start"]), int(item["char_end"])))

    if offset <= int(items[0]["char_start"]):
        return 0.0
    if offset >= int(items[-1]["char_end"]):
        return round(audio_duration_s, 3)

    for index, item in enumerate(items):
        start_char = int(item["char_start"])
        end_char = int(item["char_end"])
        start_s = float(item["start_s"])
        end_s = float(item["end_s"])
        if offset == start_char:
            if index > 0 and int(items[index - 1]["char_end"]) == offset:
                return round((float(items[index - 1]["end_s"]) + start_s) / 2, 3)
            return round(start_s, 3)
        if offset == end_char:
            if index + 1 < len(items) and int(items[index + 1]["char_start"]) == offset:
                return round((end_s + float(items[index + 1]["start_s"])) / 2, 3)
            return round(end_s, 3)
        if start_char < offset < end_char:
            span = max(1, end_char - start_char)
            ratio = (offset - start_char) / span
            return round(start_s + ratio * (end_s - start_s), 3)

        if index + 1 < len(items) and end_char < offset < int(items[index + 1]["char_start"]):
            return round((end_s + float(items[index + 1]["start_s"])) / 2, 3)

    return round(audio_duration_s, 3)


def align_sections_with_char_offsets(
    sections: list[dict[str, Any]],
    subtitle_items: list[dict[str, Any]],
    audio_duration_s: float,
) -> tuple[list[tuple[float, float]], list[str]]:
    warnings: list[str] = []
    if not subtitle_items or not all("char_start" in item and "char_end" in item for item in subtitle_items):
        return [], warnings

    lengths = section_tts_lengths(sections)
    if any(length <= 0 for length in lengths):
        warnings.append("some script sections have empty tts_text; cannot use character-offset alignment")
        return [], warnings

    offsets = [0]
    cursor = 0
    for length in lengths:
        cursor += length
        offsets.append(cursor)

    max_subtitle_end = max(int(item["char_end"]) for item in subtitle_items)
    if abs(max_subtitle_end - offsets[-1]) > 2:
        warnings.append(f"tts section character total {offsets[-1]} differs from MiniMax subtitle end {max_subtitle_end}")
        return [], warnings

    boundaries = [boundary_time_from_char_offset(subtitle_items, offset, audio_duration_s) for offset in offsets]
    boundaries[0] = 0.0
    boundaries[-1] = round(audio_duration_s, 3)
    times = []
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            warnings.append(f"non-increasing character-offset boundary {start}->{end}")
            return [], warnings
        times.append((round(start, 3), round(end, 3)))
    return times, warnings


def align_sections_with_subtitles(
    sections: list[dict[str, Any]],
    subtitle_items: list[dict[str, Any]],
    audio_duration_s: float,
) -> tuple[list[tuple[float, float]], str, list[str]]:
    warnings: list[str] = []
    if not subtitle_items:
        return proportional_section_times(sections, audio_duration_s), "weighted_text_proportion", warnings

    usable_subtitle_timing, subtitle_timing_warnings = subtitle_timing_is_usable(subtitle_items, audio_duration_s)
    warnings.extend(subtitle_timing_warnings)
    if not usable_subtitle_timing:
        return proportional_section_times(sections, audio_duration_s), "weighted_text_proportion_after_unusable_minimax_subtitle", warnings

    char_times, char_warnings = align_sections_with_char_offsets(sections, subtitle_items, audio_duration_s)
    warnings.extend(char_warnings)
    if char_times:
        return char_times, "minimax_sentence_subtitle_character_offset_alignment", warnings

    if len(subtitle_items) == len(sections):
        return (
            [(float(item["start_s"]), float(item["end_s"])) for item in subtitle_items],
            "minimax_sentence_subtitle_one_to_one",
            warnings,
        )

    warnings.append(
        f"MiniMax subtitle item count {len(subtitle_items)} != script section count {len(sections)}; fallback to weighted text timing"
    )
    return proportional_section_times(sections, audio_duration_s), "weighted_text_proportion_after_subtitle_count_mismatch", warnings


def proportional_section_times(sections: list[dict[str, Any]], audio_duration_s: float) -> list[tuple[float, float]]:
    units = [speech_units(section.get("voice_text", "")) for section in sections]
    total = max(1, sum(units))
    cursor = 0.0
    times: list[tuple[float, float]] = []
    for index, value in enumerate(units):
        if index == len(units) - 1:
            end = audio_duration_s
        else:
            end = cursor + audio_duration_s * value / total
        times.append((round(cursor, 3), round(end, 3)))
        cursor = end
    return times


def tts_input_text(voice_script: dict[str, Any]) -> tuple[str, str]:
    section_tts = "".join(str(item.get("tts_text") or "") for item in voice_script.get("script_sections") or [])
    if section_tts.strip():
        return section_tts, "script_sections.tts_text"
    pronounce_text = str(voice_script.get("pronounce_text") or "").strip()
    if pronounce_text:
        return pronounce_text, "pronounce_text"
    full_voice_text = str(voice_script.get("full_voice_text") or "").strip()
    if full_voice_text:
        return full_voice_text, "full_voice_text"
    return "".join(str(item.get("voice_text") or "") for item in voice_script.get("script_sections") or []), "script_sections.voice_text"


def build_audio_sections(
    voice_script: dict[str, Any],
    voice_script_path: Path,
    task_dir: Path,
    tts_audio_path: Path,
    audio_duration_s: float,
    subtitle_items: list[dict[str, Any]],
) -> dict[str, Any]:
    raw_sections = voice_script.get("script_sections") or voice_script.get("script_items") or []
    if not raw_sections:
        raise ValueError("voice_script has no script_sections")
    times, timing_source, timing_warnings = align_sections_with_subtitles(raw_sections, subtitle_items, audio_duration_s)
    sections = []
    for index, (section, (start_s, end_s)) in enumerate(zip(raw_sections, times), start=1):
        start_s = round(float(start_s), 3)
        end_s = round(float(end_s), 3)
        if index == 1:
            start_s = 0.0
        if index == len(raw_sections):
            end_s = round(audio_duration_s, 3)
        voice_text = str(section.get("voice_text") or "").strip()
        item = {
            "timeline_order": index,
            "section_id": section.get("section_id") or section.get("slot_id") or f"section_{index:03d}",
            "role": section.get("role"),
            "voice_text": voice_text,
            "tts_text": section.get("tts_text", voice_text),
            "subtitle_text": voice_text,
            "intention_copy": section.get("intention_copy", ""),
            "required_meaning": section.get("required_meaning", ""),
            "required_visual": section.get("required_visual", ""),
            "avoid": section.get("avoid", []),
            "keywords": section.get("keywords", []),
            "audio_start_s": start_s,
            "audio_end_s": end_s,
            "audio_duration_s": round(max(0.0, end_s - start_s), 3),
            "caption_start_s": start_s,
            "caption_end_s": end_s,
            "timeline_start_s": start_s,
            "timeline_end_s": end_s,
            "timing_source": timing_source,
        }
        sections.append(item)

    return {
        "schema_version": "1.0.0",
        "stage": "voah_audio_sections_from_oneshot_tts",
        "created_at": iso_now(),
        "product": voice_script.get("product") or {},
        "inputs": {
            "voice_script": str(voice_script_path),
            "tts_audio": str(tts_audio_path),
        },
        "outputs": {
            "audio_sections": str(task_dir / "audio_sections.json"),
            "next_artifact": str(task_dir / "candidate_sections.json"),
        },
        "policy": {
            "script_first": True,
            "tts_mode": "oneshot",
            "caption_text_source": "voice_script.json",
            "timing_source": timing_source,
            "minimax_subtitle_file_used_for_timing_only": bool(subtitle_items),
            "asr_allowed_for_text": False,
        },
        "summary": {
            "section_count": len(sections),
            "total_duration_s": round(audio_duration_s, 3),
        },
        "sections": sections,
        "qa": {
            "status": "warning" if timing_warnings else "ok",
            "warnings": timing_warnings,
        },
        "next_consumers": ["voah-shot-retrieval", "voah-caption-plan"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one-shot MiniMax TTS for a Voah voice_script.json.")
    parser.add_argument("--voice-script", required=True)
    parser.add_argument("--task-dir", default=None)
    parser.add_argument("--provider", default=None, choices=["minimax-official", "vectorengine-minimax", None])
    parser.add_argument("--model", default=None)
    parser.add_argument("--voice-id", default=None)
    parser.add_argument("--speed", type=float, default=None)
    parser.add_argument("--vol", type=float, default=None)
    parser.add_argument("--voice-setting-pitch", type=int, default=None)
    parser.add_argument("--emotion", default=None)
    parser.add_argument("--modify-pitch", type=int, default=None)
    parser.add_argument("--modify-intensity", type=int, default=None)
    parser.add_argument("--modify-timbre", type=int, default=None)
    parser.add_argument("--subtitle-enable", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--subtitle-type", default="sentence", choices=["sentence", "word"])
    parser.add_argument("--output-format", default="url", choices=["url", "hex"])
    parser.add_argument("--timeout-s", type=int, default=300)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    voice_script_path = as_abs(args.voice_script)
    task_dir = as_abs(args.task_dir) if args.task_dir else voice_script_path.parent
    task_dir.mkdir(parents=True, exist_ok=True)

    load_env_files([Path("/Users/noah/混剪/.env"), Path("/Users/noah/.voah/video_intake/.env")])
    provider = args.provider or os.environ.get("VOAH_TTS_PROVIDER", "minimax-official")
    if provider == "vectorengine-minimax":
        base_url = os.environ.get("VECTORENGINE_BASE_URL", "https://api.vectorengine.ai")
        api_key = os.environ.get("VECTORENGINE_API_KEY", "")
    else:
        base_url = os.environ.get("MINIMAX_BASE_URL", "https://api.minimaxi.com")
        api_key = os.environ.get("MINIMAX_API_KEY", "")
    if not api_key and not args.dry_run:
        raise RuntimeError(f"missing API key for provider {provider}")

    voice_script = load_json(voice_script_path)
    text, text_source = tts_input_text(voice_script)
    if not text.strip():
        raise ValueError("voice_script has no full_voice_text")

    payload = build_payload(text, args)
    endpoint = minimax_endpoint(provider, base_url)
    write_json(task_dir / "minimax_oneshot_payload.safe.json", sanitize_payload(payload))

    if args.dry_run:
        print(f"payload={task_dir / 'minimax_oneshot_payload.safe.json'}")
        print("dry_run=true")
        return 0

    warnings: list[str] = []
    try:
        response = call_minimax(endpoint, api_key, payload, args.timeout_s)
        check_response_ok(response)
    except Exception as exc:
        if payload.get("subtitle_enable"):
            warnings.append(f"MiniMax subtitle-enabled request failed, retried without subtitles: {exc}")
            retry_payload = dict(payload)
            retry_payload["subtitle_enable"] = False
            retry_payload.pop("subtitle_type", None)
            write_json(task_dir / "minimax_oneshot_payload_retry.safe.json", sanitize_payload(retry_payload))
            response = call_minimax(endpoint, api_key, retry_payload, args.timeout_s)
            check_response_ok(response)
            payload = retry_payload
        else:
            raise

    write_json(task_dir / "minimax_oneshot_response.safe.json", sanitize_response(response))
    extra_info = response.get("extra_info") or {}
    audio_value = extract_audio_value(response)
    mp3_path = task_dir / "voice_minimax_oneshot.mp3"
    wav_path = task_dir / "voice.wav"
    save_audio_response(audio_value, mp3_path, args.output_format, extra_info.get("audio_size"))
    convert_to_wav(mp3_path, wav_path)
    duration_s = probe_duration(wav_path)
    if duration_s is None:
        raise RuntimeError("failed to probe voice.wav duration")

    subtitle_path, subtitle_raw, subtitle_warnings = download_subtitle_file(response, task_dir)
    warnings.extend(subtitle_warnings)
    subtitle_items = collect_subtitle_items(subtitle_raw, duration_s) if subtitle_raw is not None else []

    tts_audio_path = task_dir / "tts_audio.json"
    audio_sections = build_audio_sections(
        voice_script=voice_script,
        voice_script_path=voice_script_path,
        task_dir=task_dir,
        tts_audio_path=tts_audio_path,
        audio_duration_s=duration_s,
        subtitle_items=subtitle_items,
    )
    warnings.extend(audio_sections.get("qa", {}).get("warnings") or [])
    write_json(task_dir / "audio_sections.json", audio_sections)

    provider_payload = {
        "name": provider,
        "base_url": base_url,
        "endpoint": "/minimax/v1/t2a_v2" if provider == "vectorengine-minimax" else "/v1/t2a_v2",
        "model": payload.get("model"),
        "voice_id": payload.get("voice_setting", {}).get("voice_id"),
        "key_policy": "read_from_local_env_only_never_persist",
        "voice_setting": {k: v for k, v in payload.get("voice_setting", {}).items() if k != "voice_id"},
        "voice_modify": payload.get("voice_modify"),
        "subtitle_enable": payload.get("subtitle_enable", False),
        "subtitle_type": payload.get("subtitle_type"),
    }
    tts_audio = {
        "schema_version": "1.0.0",
        "stage": "voah_tts_oneshot",
        "created_at": iso_now(),
        "product": voice_script.get("product") or {},
        "inputs": {
            "voice_script": str(voice_script_path),
        },
        "outputs": {
            "voice_mp3": str(mp3_path),
            "voice_wav": str(wav_path),
            "audio_sections": str(task_dir / "audio_sections.json"),
            "minimax_payload_safe": str(task_dir / "minimax_oneshot_payload.safe.json"),
            "minimax_response_safe": str(task_dir / "minimax_oneshot_response.safe.json"),
            "minimax_subtitle_file": str(subtitle_path) if subtitle_path else "",
            "next_artifact": str(task_dir / "candidate_sections.json"),
        },
        "provider": provider_payload,
        "script_stats": {
            "full_voice_text": voice_script.get("full_voice_text") or "",
            "tts_input_text": text,
            "tts_input_source": text_source,
            "pronounce_text": voice_script.get("pronounce_text") or text,
            "voice_text_characters": len(voice_script.get("full_voice_text") or text),
            "tts_input_characters": len(text),
            "section_count": len(voice_script.get("script_sections") or []),
        },
        "remote_response": {
            "trace_id": response.get("trace_id"),
            "base_status_code": (response.get("base_resp") or {}).get("status_code"),
            "base_status_msg": (response.get("base_resp") or {}).get("status_msg"),
            "usage_characters": extra_info.get("usage_characters"),
            "word_count": extra_info.get("word_count"),
            "audio_length_ms": extra_info.get("audio_length"),
            "subtitle_item_count": len(subtitle_items),
        },
        "timing": {
            "target_duration_range_s": voice_script.get("target_duration_range_s") or [40, 50],
            "actual_audio_duration_s": duration_s,
            "audio_sections_timing_source": audio_sections.get("policy", {}).get("timing_source"),
        },
        "policy": {
            "tts_mode": "oneshot",
            "caption_text_source": "voice_script.json",
            "minimax_subtitle_file_used_for_timing_only": bool(subtitle_items),
            "asr_allowed_for_text": False,
        },
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
        "next_consumers": ["voah-shot-retrieval", "voah-caption-plan", "hyperframes-subtitle-burn"],
    }
    write_json(tts_audio_path, tts_audio)

    print(f"voice_wav={wav_path}")
    print(f"audio_sections={task_dir / 'audio_sections.json'}")
    print(f"duration_s={duration_s}")
    print(f"qa={tts_audio['qa']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
