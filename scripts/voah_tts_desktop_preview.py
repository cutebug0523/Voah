#!/usr/bin/env python3
"""Generate a desktop TTS preview audio file with MiniMax-compatible providers."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from voah_run_oneshot_minimax_tts import (
    as_abs,
    build_payload,
    call_minimax,
    check_response_ok,
    convert_to_wav,
    extract_audio_value,
    iso_now,
    load_env_files,
    minimax_endpoint,
    probe_duration,
    sanitize_payload,
    sanitize_response,
    save_audio_response,
    write_json,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = REPO_ROOT / "cache" / "voah_tts" / "desktop_preview"
ENV_FILES = [REPO_ROOT / ".env", Path("/Users/noah/.voah/video_intake/.env")]
VOICE_MODIFY_KEYS = {"pitch", "intensity", "timbre"}


def timestamp_slug() -> str:
    return datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")


def parse_voice_modify(value: str | None) -> dict[str, int]:
    if not value:
        return {}
    raw = value.strip()
    if not raw:
        return {}

    if raw.startswith("{"):
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise argparse.ArgumentTypeError("--voice-modify must be a JSON object")
        items = parsed.items()
    else:
        pairs = []
        for chunk in raw.split(","):
            if not chunk.strip():
                continue
            if "=" not in chunk:
                raise argparse.ArgumentTypeError("--voice-modify expects JSON or key=value pairs")
            key, item_value = chunk.split("=", 1)
            pairs.append((key.strip(), item_value.strip()))
        items = pairs

    output: dict[str, int] = {}
    for key, item_value in items:
        if key not in VOICE_MODIFY_KEYS:
            raise argparse.ArgumentTypeError(f"unsupported voice_modify key: {key}")
        try:
            output[key] = int(float(item_value))
        except (TypeError, ValueError) as exc:
            raise argparse.ArgumentTypeError(f"voice_modify.{key} must be numeric") from exc
    return output


def read_text(args: argparse.Namespace) -> tuple[str, str]:
    if args.text_file:
        path = as_abs(args.text_file)
        return path.read_text(encoding="utf-8"), str(path)
    if args.text == "-":
        return sys.stdin.read(), "stdin"
    return args.text or "", "cli"


def provider_config(provider: str) -> tuple[str, str, str, str]:
    if provider == "vectorengine-minimax":
        return (
            os.environ.get("VECTORENGINE_BASE_URL", "https://api.vectorengine.ai"),
            os.environ.get("VECTORENGINE_API_KEY", ""),
            "VECTORENGINE_API_KEY",
            "/minimax/v1/t2a_v2",
        )
    return (
        os.environ.get("MINIMAX_BASE_URL", "https://api.minimaxi.com"),
        os.environ.get("MINIMAX_API_KEY", ""),
        "MINIMAX_API_KEY",
        "/v1/t2a_v2",
    )


def build_preview_payload_args(args: argparse.Namespace, voice_modify: dict[str, int]) -> argparse.Namespace:
    return argparse.Namespace(
        voice_id=args.voice_id,
        model=args.model,
        speed=args.speed,
        vol=args.vol,
        voice_setting_pitch=args.pitch,
        emotion=args.emotion,
        modify_pitch=args.modify_pitch if args.modify_pitch is not None else voice_modify.get("pitch"),
        modify_intensity=args.modify_intensity if args.modify_intensity is not None else voice_modify.get("intensity"),
        modify_timbre=args.modify_timbre if args.modify_timbre is not None else voice_modify.get("timbre"),
        output_format=args.minimax_output_format,
        subtitle_enable=False,
        subtitle_type="sentence",
    )


def build_manifest(
    *,
    args: argparse.Namespace,
    run_dir: Path,
    text: str,
    text_source: str,
    provider: str,
    base_url: str,
    endpoint_path: str,
    required_env_key: str,
    payload: dict[str, Any],
    preview_audio: Path,
    source_audio: Path | None,
    response: dict[str, Any] | None,
    duration_s: float | None,
    dry_run: bool,
    warnings: list[str],
) -> dict[str, Any]:
    extra_info = (response or {}).get("extra_info") or {}
    voice_setting = payload.get("voice_setting") or {}
    return {
        "schema_version": "1.0.0",
        "stage": "voah_tts_desktop_preview",
        "created_at": iso_now(),
        "dry_run": dry_run,
        "inputs": {
            "text": text,
            "text_source": text_source,
            "text_characters": len(text),
        },
        "outputs": {
            "run_dir": str(run_dir),
            "preview_audio": "" if dry_run else str(preview_audio),
            "source_audio": "" if dry_run or source_audio is None else str(source_audio),
            "manifest": str(run_dir / "manifest.json"),
            "minimax_payload_safe": str(run_dir / "minimax_payload.safe.json"),
            "minimax_response_safe": "" if dry_run else str(run_dir / "minimax_response.safe.json"),
        },
        "provider": {
            "name": provider,
            "base_url": base_url,
            "endpoint": endpoint_path,
            "model": payload.get("model"),
            "voice_id": voice_setting.get("voice_id"),
            "required_env_key": required_env_key,
            "key_policy": "read_from_local_env_only_never_persist",
        },
        "request": {
            "voice_setting": {k: v for k, v in voice_setting.items() if k != "voice_id"},
            "voice_modify": payload.get("voice_modify") or {},
            "language_boost": payload.get("language_boost"),
            "audio_setting": payload.get("audio_setting") or {},
            "minimax_output_format": args.minimax_output_format,
            "preview_audio_format": args.audio_format,
            "subtitle_enable": False,
        },
        "remote_response": {
            "trace_id": (response or {}).get("trace_id"),
            "base_status_code": ((response or {}).get("base_resp") or {}).get("status_code"),
            "base_status_msg": ((response or {}).get("base_resp") or {}).get("status_msg"),
            "usage_characters": extra_info.get("usage_characters"),
            "word_count": extra_info.get("word_count"),
            "audio_length_ms": extra_info.get("audio_length"),
        },
        "timing": {
            "actual_audio_duration_s": duration_s,
        },
        "qa": {
            "status": "warning" if warnings else "ok",
            "warnings": warnings,
        },
        "next_consumers": ["desktop-tts-preview"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a Voah desktop TTS preview audio file.")
    text_group = parser.add_mutually_exclusive_group(required=True)
    text_group.add_argument("--text", help="Preview text. Use '-' to read from stdin.")
    text_group.add_argument("--text-file", help="UTF-8 text file for longer preview copy.")
    parser.add_argument("--provider", default=None, choices=["minimax-official", "vectorengine-minimax"])
    parser.add_argument("--model", default=None)
    parser.add_argument("--voice-id", default=None)
    parser.add_argument("--speed", type=float, default=None)
    parser.add_argument("--vol", type=float, default=None)
    parser.add_argument("--pitch", type=int, default=None, help="voice_setting.pitch")
    parser.add_argument("--emotion", default=None)
    parser.add_argument("--voice-modify", type=parse_voice_modify, default=None, help='JSON or CSV, e.g. \'{"pitch":20,"intensity":20,"timbre":0}\'')
    parser.add_argument("--modify-pitch", type=int, default=None)
    parser.add_argument("--modify-intensity", type=int, default=None)
    parser.add_argument("--modify-timbre", type=int, default=None)
    parser.add_argument("--audio-format", default="mp3", choices=["mp3", "wav"])
    parser.add_argument("--minimax-output-format", default="url", choices=["url", "hex"])
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    parser.add_argument("--timestamp", default=None, help="Override run directory name for repeatable tests.")
    parser.add_argument("--timeout-s", type=int, default=300)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    load_env_files(ENV_FILES)

    provider = args.provider or os.environ.get("VOAH_TTS_PROVIDER", "minimax-official")
    base_url, api_key, required_env_key, endpoint_path = provider_config(provider)
    endpoint = minimax_endpoint(provider, base_url)

    text, text_source = read_text(args)
    text = text.strip()
    if not text:
        raise ValueError("preview text is empty")

    run_dir = as_abs(args.output_root) / (args.timestamp or timestamp_slug())
    run_dir.mkdir(parents=True, exist_ok=True)

    voice_modify = args.voice_modify or {}
    payload_args = build_preview_payload_args(args, voice_modify)
    payload = build_payload(text, payload_args)
    write_json(run_dir / "minimax_payload.safe.json", sanitize_payload(payload))

    warnings: list[str] = []
    if not payload.get("voice_setting", {}).get("voice_id"):
        warnings.append("voice_id is empty; pass --voice-id or configure VOAH_TTS_VOICE_ID")

    preview_audio = run_dir / f"preview.{args.audio_format}"
    source_audio = None if args.audio_format == "mp3" else run_dir / "preview.source.mp3"
    duration_s: float | None = None
    response: dict[str, Any] | None = None

    if args.dry_run:
        manifest = build_manifest(
            args=args,
            run_dir=run_dir,
            text=text,
            text_source=text_source,
            provider=provider,
            base_url=base_url,
            endpoint_path=endpoint_path,
            required_env_key=required_env_key,
            payload=payload,
            preview_audio=preview_audio,
            source_audio=source_audio,
            response=response,
            duration_s=duration_s,
            dry_run=True,
            warnings=warnings,
        )
        write_json(run_dir / "manifest.json", manifest)
        print(f"manifest={run_dir / 'manifest.json'}")
        print(f"payload={run_dir / 'minimax_payload.safe.json'}")
        print("dry_run=true")
        return 0

    if not api_key:
        raise RuntimeError(f"missing API key for provider {provider}: {required_env_key}")
    if not payload.get("voice_setting", {}).get("voice_id"):
        raise RuntimeError("missing voice_id; pass --voice-id or configure VOAH_TTS_VOICE_ID")

    response = call_minimax(endpoint, api_key, payload, args.timeout_s)
    check_response_ok(response)
    write_json(run_dir / "minimax_response.safe.json", sanitize_response(response))

    extra_info = response.get("extra_info") or {}
    audio_value = extract_audio_value(response)
    raw_mp3_path = preview_audio if args.audio_format == "mp3" else source_audio
    if raw_mp3_path is None:
        raise RuntimeError("internal error: missing raw mp3 output path")
    save_audio_response(audio_value, raw_mp3_path, args.minimax_output_format, extra_info.get("audio_size"))

    if args.audio_format == "wav":
        convert_to_wav(raw_mp3_path, preview_audio)

    duration_s = probe_duration(preview_audio)
    if duration_s is None:
        warnings.append("failed to probe preview audio duration with ffprobe")

    manifest = build_manifest(
        args=args,
        run_dir=run_dir,
        text=text,
        text_source=text_source,
        provider=provider,
        base_url=base_url,
        endpoint_path=endpoint_path,
        required_env_key=required_env_key,
        payload=payload,
        preview_audio=preview_audio,
        source_audio=source_audio,
        response=response,
        duration_s=duration_s,
        dry_run=False,
        warnings=warnings,
    )
    write_json(run_dir / "manifest.json", manifest)

    print(f"preview_audio={preview_audio}")
    print(f"manifest={run_dir / 'manifest.json'}")
    if duration_s is not None:
        print(f"duration_s={duration_s}")
    print(f"qa={manifest['qa']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
