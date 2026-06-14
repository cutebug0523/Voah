#!/usr/bin/env python3
"""
参考实现：对每个 Shot 做物理裁切 + 上传到 DashScope 临时 OSS。

输入：assets.json、shots.json
输出：
- 更新 shots.json：trimmed_clip_path / trimmed_oss_url
- trim_upload_results.json：每个 shot 的裁切和 OSS 上传记录

兼容字段：asset_id/id、local_path/file.local、shot_id/id、start_s/start_time。
"""

import json
import mimetypes
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from http import HTTPStatus
from time import mktime
from typing import Any, Tuple
from urllib.parse import urlparse
from wsgiref.handlers import format_date_time

DASHSCOPE_CLI = os.path.expanduser("~/Library/Python/3.9/bin/dashscope")
UPLOAD_MODEL = "qwen3-vl-embedding"
VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".avi", ".webm")


def load_env() -> bool:
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


def as_float(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def parse_fps(value) -> float:
    if value in (None, ""):
        return 0.0
    text = str(value)
    if "/" in text:
        try:
            num, den = text.split("/", 1)
            den_f = float(den)
            return float(num) / den_f if den_f else 0.0
        except ValueError:
            return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def asset_id_of(asset: dict) -> str:
    return first(asset, "asset_id", "id", default="")


def shot_id_of(shot: dict) -> str:
    return first(shot, "shot_id", "id", default="")


def asset_local_path(asset: dict) -> str:
    nested_file = asset.get("file") if isinstance(asset.get("file"), dict) else {}
    return first(asset, "local_path", default=first(nested_file, "local", default=""))


def asset_fps(asset: dict) -> float:
    media = asset.get("media") if isinstance(asset.get("media"), dict) else {}
    nested_file = asset.get("file") if isinstance(asset.get("file"), dict) else {}
    return (
        as_float(first(asset, "fps_float", default=0))
        or as_float(first(media, "fps_float", default=0))
        or parse_fps(first(asset, "fps", default=first(media, "fps", default=first(nested_file, "fps", default=""))))
    )


def shot_times(shot: dict) -> Tuple[float, float]:
    start = as_float(first(shot, "usable_start", "start_s", "start_time", default=0))
    end = as_float(first(shot, "usable_end", "end_s", "end_time", default=start))
    return start, end


def probe_clip(path: str) -> dict:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames,r_frame_rate,duration",
            "-of",
            "json",
            path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {}
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}
    stream = (data.get("streams") or [{}])[0]
    return {
        "clip_frames": int(stream.get("nb_read_frames") or 0),
        "clip_actual_duration_s": as_float(stream.get("duration"), 0),
        "clip_fps": stream.get("r_frame_rate", ""),
    }


def extract_last_frame(clip_path: str, qa_dir: str, shot_id: str) -> str:
    os.makedirs(qa_dir, exist_ok=True)
    output_path = os.path.join(qa_dir, f"{shot_id}_last.jpg")
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-sseof",
            "-0.05",
            "-i",
            clip_path,
            "-frames:v",
            "1",
            output_path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not os.path.exists(output_path):
        return ""
    return output_path


def extract_preview_frame(clip_path: str, qa_dir: str, shot_id: str, duration_s: float) -> str:
    os.makedirs(qa_dir, exist_ok=True)
    output_path = os.path.join(qa_dir, f"{shot_id}_preview.jpg")
    seek_s = max(0.0, duration_s / 2.0)
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            f"{seek_s:.3f}",
            "-i",
            clip_path,
            "-frames:v",
            "1",
            output_path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not os.path.exists(output_path):
        return ""
    return output_path


def build_contact_sheet(preview_frames: list, output_path: str, columns: int = 5) -> str:
    frames = [path for path in preview_frames if path and os.path.exists(path)]
    if not frames:
        return ""
    list_path = os.path.join(os.path.dirname(output_path), "contact_sheet_frames.txt")
    with open(list_path, "w", encoding="utf-8") as f:
        for frame in frames:
            f.write(f"file '{frame}'\n")
            f.write("duration 1\n")
        f.write(f"file '{frames[-1]}'\n")

    rows = (len(frames) + columns - 1) // columns
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_path,
            "-vf",
            f"scale=180:-1,tile={columns}x{rows}",
            "-frames:v",
            "1",
            output_path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not os.path.exists(output_path):
        return ""
    return output_path


def trim_shot(asset: dict, shot: dict, clips_dir: str, precise: bool = True) -> Tuple[str, dict]:
    source_path = asset_local_path(asset)
    shot_id = shot_id_of(shot)
    start, end = shot_times(shot)
    duration = end - start
    fps = asset_fps(asset)
    end_epsilon = 1.0 / fps if fps > 0 else 0.0
    trim_duration = duration - end_epsilon if duration > end_epsilon + 0.05 else duration

    if not source_path or not os.path.exists(source_path):
        raise FileNotFoundError(f"{shot_id}: source video not found: {source_path}")
    if duration <= 0:
        raise ValueError(f"{shot_id}: invalid duration {start}-{end}")

    os.makedirs(clips_dir, exist_ok=True)
    output_path = os.path.join(clips_dir, f"{shot_id}.mp4")

    if precise:
        cmd = [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            str(start),
            "-t",
            str(trim_duration),
            "-i",
            source_path,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-avoid_negative_ts",
            "make_zero",
            output_path,
        ]
    else:
        cmd = [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            str(start),
            "-t",
            str(trim_duration),
            "-i",
            source_path,
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            output_path,
        ]

    print(f"  [{shot_id}] trimming {start:.3f}s-{end:.3f}s, t={trim_duration:.3f}s ...", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg error: {result.stderr[:300]}")
    if not os.path.exists(output_path) or os.path.getsize(output_path) <= 0:
        raise RuntimeError("ffmpeg produced empty clip")

    meta = {
        "source_fps": fps,
        "trim_start_s": start,
        "trim_end_s": end,
        "trim_duration_s": trim_duration,
        "trim_end_epsilon_s": round(end_epsilon, 6),
        "trim_interval": "[start,end)",
    }
    meta.update(probe_clip(output_path))
    return output_path, meta


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


def sanitize_log_text(value: Any, max_len: int = 700) -> str:
    text = str(value or "")
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if api_key:
        text = text.replace(api_key, "<DASHSCOPE_API_KEY>")
    text = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "sk-***", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_len]


def proxy_env_keys() -> list:
    names = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ]
    return sorted(name for name in names if os.environ.get(name))


def log_upload_event(
    file_path: str,
    model: str,
    label: str,
    stage: str,
    status: str,
    started_at: float,
    **extra,
) -> None:
    payload = {
        "event": "dashscope_oss_upload",
        "stage": stage,
        "status": status,
        "label": label,
        "model": model,
        "file": os.path.basename(file_path),
        "bytes": os.path.getsize(file_path) if os.path.exists(file_path) else 0,
        "duration_s": round(time.time() - started_at, 3),
        "proxy_env_keys": proxy_env_keys(),
    }
    payload.update({key: value for key, value in extra.items() if value not in (None, "")})
    print("  " + json.dumps(payload, ensure_ascii=False), flush=True)


def validate_oss_url(oss_url: str, file_path: str = "") -> str:
    value = str(oss_url or "").strip()
    if not value:
        raise RuntimeError("empty oss url")
    if not value.startswith("oss://"):
        raise RuntimeError(f"invalid oss url scheme: {value[:40]}")
    if any(ch.isspace() for ch in value):
        raise RuntimeError("invalid oss url contains whitespace")
    if len(value) < 16:
        raise RuntimeError("invalid oss url is too short")
    suffix = os.path.splitext(file_path)[1].lower()
    if suffix in VIDEO_EXTENSIONS:
        clean_value = value.split("?", 1)[0].lower()
        if not clean_value.endswith(VIDEO_EXTENSIONS):
            raise RuntimeError(f"invalid oss url extension for video: {value[-80:]}")
    return value


def decode_response_error(response) -> str:
    content_type = response.headers.get("content-type", "")
    try:
        if "application/json" in content_type:
            return json.dumps(response.json(), ensure_ascii=False)
        return response.content.decode("utf-8", errors="replace")
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"


def get_upload_certificate(model: str, api_key: str, timeout_s: int) -> dict:
    from dashscope.utils.oss_utils import OssUtils

    response = OssUtils.get_upload_certificate(
        model=model,
        api_key=api_key,
        request_timeout=timeout_s,
    )
    if response.status_code != HTTPStatus.OK:
        code = getattr(response, "code", "")
        message = getattr(response, "message", "")
        raise RuntimeError(f"getPolicy failed code={code} message={message}")
    output = getattr(response, "output", None)
    if not isinstance(output, dict):
        raise RuntimeError("getPolicy returned empty upload certificate")
    required = [
        "oss_access_key_id",
        "signature",
        "policy",
        "upload_dir",
        "x_oss_object_acl",
        "x_oss_forbid_overwrite",
        "upload_host",
    ]
    missing = [key for key in required if not output.get(key)]
    if missing:
        raise RuntimeError(f"getPolicy missing fields: {', '.join(missing)}")
    return output


def upload_via_policy_post(
    file_path: str,
    model: str,
    api_key: str,
    label: str,
    certificate_timeout_s: int,
    post_timeout_s: int,
) -> str:
    import requests
    from dashscope.common.utils import get_user_agent

    cert_started = time.time()
    try:
        upload_info = get_upload_certificate(model, api_key, certificate_timeout_s)
    except Exception as exc:
        log_upload_event(
            file_path,
            model,
            label,
            "get_policy",
            "error",
            cert_started,
            error_type=type(exc).__name__,
            error=sanitize_log_text(exc),
        )
        raise
    upload_host = upload_info["upload_host"]
    host = urlparse(upload_host).netloc or upload_host
    log_upload_event(
        file_path,
        model,
        label,
        "get_policy",
        "ok",
        cert_started,
        upload_host=host,
    )

    key = upload_info["upload_dir"] + "/" + os.path.basename(file_path)
    form_data = {
        "OSSAccessKeyId": upload_info["oss_access_key_id"],
        "Signature": upload_info["signature"],
        "policy": upload_info["policy"],
        "key": key,
        "x-oss-object-acl": upload_info["x_oss_object_acl"],
        "x-oss-forbid-overwrite": upload_info["x_oss_forbid_overwrite"],
        "success_action_status": "200",
        "x-oss-content-type": mimetypes.guess_type(file_path)[0] or "application/octet-stream",
    }
    headers = {
        "user-agent": get_user_agent(),
        "Accept": "application/json",
        "Date": format_date_time(mktime(datetime.now().timetuple())),
    }

    post_started = time.time()
    try:
        with open(file_path, "rb") as file_obj:
            files = {"file": file_obj}
            with requests.Session() as session:
                response = session.post(
                    upload_host,
                    files=files,
                    data=form_data,
                    headers=headers,
                    timeout=(8, post_timeout_s),
                )
    except Exception as exc:
        log_upload_event(
            file_path,
            model,
            label,
            "oss_post",
            "error",
            post_started,
            upload_host=host,
            error_type=type(exc).__name__,
            error=sanitize_log_text(exc),
        )
        raise
    if response.status_code != HTTPStatus.OK:
        detail = sanitize_log_text(decode_response_error(response))
        log_upload_event(
            file_path,
            model,
            label,
            "oss_post",
            "error",
            post_started,
            upload_host=host,
            status_code=response.status_code,
            error=detail,
        )
        raise RuntimeError(f"oss POST failed status={response.status_code} detail={detail}")

    oss_url = validate_oss_url("oss://" + key, file_path)
    log_upload_event(
        file_path,
        model,
        label,
        "oss_post",
        "ok",
        post_started,
        upload_host=host,
        oss_url_tail=oss_url[-72:],
    )
    return oss_url


def upload_via_cli(file_path: str, model: str, label: str, timeout_s: int) -> str:
    started = time.time()
    try:
        result = subprocess.run(
            [DASHSCOPE_CLI, "oss", "upload", "-f", file_path, "-m", model],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env={**os.environ},
        )
    except subprocess.TimeoutExpired as exc:
        log_upload_event(
            file_path,
            model,
            label,
            "cli_upload",
            "error",
            started,
            error_type=type(exc).__name__,
            error=f"timeout after {timeout_s}s",
        )
        raise RuntimeError(f"CLI upload timeout after {timeout_s}s") from exc

    if result.returncode != 0:
        detail = sanitize_log_text(result.stderr or result.stdout)
        log_upload_event(
            file_path,
            model,
            label,
            "cli_upload",
            "error",
            started,
            returncode=result.returncode,
            error=detail,
        )
        raise RuntimeError(f"CLI upload failed returncode={result.returncode} detail={detail}")

    oss_url = extract_oss_url(result.stdout, result.stderr)
    try:
        oss_url = validate_oss_url(oss_url, file_path)
    except RuntimeError as exc:
        log_upload_event(
            file_path,
            model,
            label,
            "cli_upload",
            "error",
            started,
            error_type=type(exc).__name__,
            error=str(exc),
            stdout_tail=sanitize_log_text(result.stdout[-500:]),
            stderr_tail=sanitize_log_text(result.stderr[-500:]),
        )
        raise

    log_upload_event(
        file_path,
        model,
        label,
        "cli_upload",
        "ok",
        started,
        oss_url_tail=oss_url[-72:],
    )
    return oss_url


def upload_to_dashscope_oss(
    file_path: str,
    model: str = UPLOAD_MODEL,
    label: str = "",
    attempts: int = 3,
    certificate_timeout_s: int = 20,
    post_timeout_s: int = 45,
    cli_timeout_s: int = 60,
    cli_attempts: int = 1,
) -> str:
    path = os.path.abspath(file_path)
    upload_label = label or os.path.basename(path)
    if not os.path.exists(path) or os.path.getsize(path) <= 0:
        raise RuntimeError(f"upload file is missing or empty: {path}")
    if not load_env():
        raise RuntimeError("DASHSCOPE_API_KEY not found")
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    last_error = ""

    for attempt in range(1, attempts + 1):
        try:
            print(f"  [{upload_label}] DashScope OSS upload attempt {attempt}/{attempts} via policy+post", flush=True)
            return upload_via_policy_post(
                path,
                model,
                api_key,
                upload_label,
                certificate_timeout_s,
                post_timeout_s,
            )
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {sanitize_log_text(exc)}"
            log_upload_event(
                path,
                model,
                upload_label,
                "policy_post",
                "error",
                time.time(),
                attempt=attempt,
                error_type=type(exc).__name__,
                error=sanitize_log_text(exc),
            )
            if attempt < attempts:
                sleep_s = min(2.0 * attempt, 8.0)
                print(f"  [{upload_label}] upload retry {attempt}/{attempts - 1} after error: {last_error}", flush=True)
                time.sleep(sleep_s)

    for attempt in range(1, cli_attempts + 1):
        try:
            print(f"  [{upload_label}] DashScope OSS upload fallback CLI {attempt}/{cli_attempts}", flush=True)
            return upload_via_cli(path, model, upload_label, cli_timeout_s)
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {sanitize_log_text(exc)}"
            if attempt < cli_attempts:
                time.sleep(2.0 * attempt)

    raise RuntimeError(
        "dashscope_oss_upload_failed "
        f"model={model} file={os.path.basename(path)} bytes={os.path.getsize(path)} "
        f"last_error={last_error}"
    )


def upload_clip(clip_path: str, shot_id: str) -> str:
    print(f"  [{shot_id}] uploading {clip_path} ...", flush=True)
    oss_url = upload_to_dashscope_oss(
        clip_path,
        model=UPLOAD_MODEL,
        label=shot_id,
        attempts=3,
        certificate_timeout_s=20,
        post_timeout_s=45,
        cli_timeout_s=60,
        cli_attempts=1,
    )
    print(f"  [{shot_id}] uploaded: {oss_url}", flush=True)
    return oss_url


def trim_and_upload_all(
    assets_file: str,
    shots_file: str,
    clips_dir: str,
    results_file: str = "",
    upload: bool = True,
    precise: bool = True,
):
    assets = {asset_id_of(asset): asset for asset in load_json(assets_file)}
    shots = load_json(shots_file)

    results = []
    preview_frames = []
    for index, shot in enumerate(shots, start=1):
        shot_id = shot_id_of(shot)
        asset_id = first(shot, "asset_id", default="")
        asset = assets.get(asset_id)
        print(f"[{index}/{len(shots)}] {shot_id}", flush=True)

        if not asset:
            results.append({"shot_id": shot_id, "status": "asset_not_found", "asset_id": asset_id})
            continue

        start, end = shot_times(shot)
        try:
            clip_path, trim_meta = trim_shot(asset, shot, clips_dir, precise=precise)
            size_bytes = os.path.getsize(clip_path)
            qa_dir = os.path.join(os.path.dirname(os.path.abspath(results_file or shots_file)), "qa_last_frames")
            last_frame = extract_last_frame(clip_path, qa_dir, shot_id)
            preview_dir = os.path.join(os.path.dirname(os.path.abspath(results_file or shots_file)), "qa_preview_frames")
            preview_frame = extract_preview_frame(
                clip_path,
                preview_dir,
                shot_id,
                trim_meta.get("clip_actual_duration_s") or trim_meta.get("trim_duration_s") or (end - start),
            )
            if preview_frame:
                preview_frames.append(preview_frame)
            oss_url = ""
            if upload:
                oss_url = upload_clip(clip_path, shot_id)

            shot["trimmed_clip_path"] = clip_path
            shot["trim_end_epsilon_s"] = trim_meta.get("trim_end_epsilon_s")
            shot["clip_actual_duration_s"] = trim_meta.get("clip_actual_duration_s")
            shot["clip_frames"] = trim_meta.get("clip_frames")
            if last_frame:
                shot["qa_last_frame"] = last_frame
            if preview_frame:
                shot["qa_preview_frame"] = preview_frame
            if oss_url:
                shot["trimmed_oss_url"] = oss_url
            results.append({
                "shot_id": shot_id,
                "asset_id": asset_id,
                "status": "ok",
                "trimmed_path": clip_path,
                "oss_url": oss_url,
                "upload_model": UPLOAD_MODEL,
                "uploaded": bool(oss_url),
                "precise_trim": precise,
                "start": start,
                "end": end,
                "duration": end - start,
                **trim_meta,
                "qa_last_frame": last_frame,
                "qa_preview_frame": preview_frame,
                "size_bytes": size_bytes,
            })
        except Exception as exc:
            print(f"  [{shot_id}] ERROR: {exc}", flush=True)
            results.append({
                "shot_id": shot_id,
                "asset_id": asset_id,
                "status": "error",
                "error": str(exc),
                "start": start,
                "end": end,
                "duration": end - start,
            })

        time.sleep(0.5)

    with open(shots_file, "w", encoding="utf-8") as f:
        json.dump(shots, f, ensure_ascii=False, indent=2)

    results_path = results_file or os.path.join(os.path.dirname(os.path.abspath(shots_file)), "trim_upload_results.json")
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    qa_path = os.path.join(os.path.dirname(os.path.abspath(results_path)), "qa_last_frames.json")
    contact_sheet_path = build_contact_sheet(
        preview_frames,
        os.path.join(os.path.dirname(os.path.abspath(results_path)), "contact_sheet.jpg"),
    )
    with open(qa_path, "w", encoding="utf-8") as f:
        json.dump(
            [
                {
                    "shot_id": item.get("shot_id"),
                    "clip_frames": item.get("clip_frames"),
                    "clip_duration_s": item.get("clip_actual_duration_s"),
                    "last_frame": item.get("qa_last_frame", ""),
                    "trim_end_epsilon_s": item.get("trim_end_epsilon_s"),
                }
                for item in results
                if item.get("status") == "ok"
            ],
            f,
            ensure_ascii=False,
            indent=2,
        )

    ok = sum(1 for item in results if item.get("status") == "ok")
    failed = len(results) - ok
    print(f"\nTrim & Upload done: {ok}/{len(results)} ok, {failed} failed")
    print(f"Results: {results_path}")
    print(f"QA last frames: {qa_path}")
    if contact_sheet_path:
        print(f"Contact sheet: {contact_sheet_path}")
    if failed:
        sys.exit(1)
    return shots, results


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("assets", help="assets.json")
    parser.add_argument("shots", help="shots.json or physical_shots.json")
    parser.add_argument("clips_dir", help="output clips directory")
    parser.add_argument("results", nargs="?", default="", help="trim_upload_results.json")
    parser.add_argument("--no-upload", action="store_true", help="trim locally but do not upload to DashScope OSS")
    parser.add_argument("--copy", action="store_true", help="use stream copy instead of precise re-encode")
    args = parser.parse_args()

    if not args.no_upload and not load_env():
        print("DASHSCOPE_API_KEY not found. Run scripts/save_dashscope_key.py first.", file=sys.stderr)
        sys.exit(1)

    trim_and_upload_all(
        args.assets,
        args.shots,
        args.clips_dir,
        args.results,
        upload=not args.no_upload,
        precise=not args.copy,
    )
