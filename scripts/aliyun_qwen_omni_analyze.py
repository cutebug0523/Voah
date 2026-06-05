#!/usr/bin/env python3
import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path
from urllib import error, request


DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


PROMPT = """请对这个视频做适合“短视频混剪素材库”的结构化理解。

你必须按时间戳输出，不要只写总体摘要。

请输出以下部分：

## 全局摘要
用 3-5 句话概括视频的主要内容、情绪、人物、场景和可用于混剪的价值。

## 时间线故事
按时间顺序拆分语义片段。每个片段必须包含：
- 起止时间，格式为 mm:ss.xxx - mm:ss.xxx
- 画面描述
- 发生的动作或事件
- 情绪/氛围
- 适合的混剪用途标签

## 可见文字
列出画面中出现的文字。每条包含：
- 起止时间
- 原文
- 位置或外观
如果没有文字，明确写“无可见文字”。

## 说话人与转写
列出语音内容。每条包含：
- 起止时间
- 说话人
- 原文
- 语气、情绪、语速
如果没有人声，明确写“无人声”。

## 可检索标签
输出 10-30 个标签，覆盖人物、场景、动作、情绪、物体、主题、拍摄类型。

## 混剪建议
列出这个素材适合用于哪些短视频段落，例如开头钩子、冲突升级、情绪铺垫、证据展示、反转、结尾留白。
"""


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def encode_video_data_url(video_path: Path) -> str:
    encoded = base64.b64encode(video_path.read_bytes()).decode("utf-8")
    return f"data:;base64,{encoded}"


def parse_sse_line(line: bytes):
    text = line.decode("utf-8", errors="replace").strip()
    if not text or text.startswith(":"):
        return None
    if not text.startswith("data:"):
        return None
    payload = text[len("data:") :].strip()
    if payload == "[DONE]":
        return {"done": True}
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {"raw": payload}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Analyze a local or remote video with Aliyun Qwen-Omni HTTP streaming API."
    )
    parser.add_argument("--video-path", help="Local video path. Encoded as base64 data URL.")
    parser.add_argument("--video-url", help="Public video URL.")
    parser.add_argument("--output-dir", required=True, help="Directory for request/response files.")
    parser.add_argument("--model", default="qwen3.5-omni-plus")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument("--max-base64-mb", type=float, default=10.0)
    parser.add_argument("--dump-request-body", help="Write API request body JSON and exit.")
    args = parser.parse_args()

    load_env(Path(".env"))
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        print("DASHSCOPE_API_KEY is missing. Put it in .env or environment.", file=sys.stderr)
        return 2

    if bool(args.video_path) == bool(args.video_url):
        print("Pass exactly one of --video-path or --video-url.", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.video_path:
        video_path = Path(args.video_path)
        raw_size = video_path.stat().st_size
        encoded_size_mb = raw_size * 4 / 3 / 1024 / 1024
        if encoded_size_mb >= args.max_base64_mb:
            print(
                f"Base64 payload is about {encoded_size_mb:.2f} MB, "
                f"over limit {args.max_base64_mb:.2f} MB.",
                file=sys.stderr,
            )
            return 3
        video_url = encode_video_data_url(video_path)
        source = {"kind": "local_base64", "path": str(video_path), "raw_size": raw_size}
    else:
        video_url = args.video_url
        source = {"kind": "url", "url": args.video_url}

    body = {
        "model": args.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "video_url", "video_url": {"url": video_url}},
                    {"type": "text", "text": args.prompt},
                ],
            }
        ],
        "modalities": ["text"],
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    if args.dump_request_body:
        dump_path = Path(args.dump_request_body)
        dump_path.parent.mkdir(parents=True, exist_ok=True)
        dump_path.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote request body to {dump_path}")
        return 0

    request_record = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "base_url": args.base_url,
        "model": args.model,
        "source": source,
        "prompt": args.prompt,
        "body_without_video_payload": {
            **body,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "video_url", "video_url": {"url": "<redacted>"}},
                        {"type": "text", "text": args.prompt},
                    ],
                }
            ],
        },
    }
    (output_dir / "request.json").write_text(
        json.dumps(request_record, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    endpoint = args.base_url.rstrip("/") + "/chat/completions"
    req = request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    raw_events = []
    content_parts = []
    usage = None

    try:
        with request.urlopen(req, timeout=600) as response:
            for line in response:
                event = parse_sse_line(line)
                if not event:
                    continue
                raw_events.append(event)
                if event.get("done"):
                    break
                if "usage" in event and event.get("usage"):
                    usage = event["usage"]
                for choice in event.get("choices", []) or []:
                    delta = choice.get("delta") or {}
                    text = delta.get("content")
                    if text:
                        content_parts.append(text)
                        print(text, end="", flush=True)
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        (output_dir / "error.txt").write_text(detail, encoding="utf-8")
        print(f"\nHTTP error {exc.code}: {detail}", file=sys.stderr)
        return 1
    except Exception as exc:
        (output_dir / "error.txt").write_text(str(exc), encoding="utf-8")
        print(f"\nRequest failed: {exc}", file=sys.stderr)
        return 1

    raw_response = "".join(content_parts)
    (output_dir / "raw_response.md").write_text(raw_response, encoding="utf-8")
    (output_dir / "events.jsonl").write_text(
        "\n".join(json.dumps(event, ensure_ascii=False) for event in raw_events) + "\n",
        encoding="utf-8",
    )
    if usage is not None:
        (output_dir / "usage.json").write_text(
            json.dumps(usage, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    print(f"\n\nSaved response to {output_dir / 'raw_response.md'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
