#!/usr/bin/env python3
"""Load DashScope env for small local scripts; prints only whether key exists."""

from __future__ import annotations

import os
from pathlib import Path


SECRET_FILE = Path.home() / ".voah" / "video_intake" / ".env"


def set_dashscope_api_key(value: str) -> None:
    if not value:
        return
    try:
        import dashscope
        dashscope.api_key = value
    except Exception:
        return


def load_secret_file() -> None:
    if not SECRET_FILE.exists():
        return
    for line in SECRET_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())
    set_dashscope_api_key(os.environ.get("DASHSCOPE_API_KEY", "").strip())


def main() -> int:
    load_secret_file()
    has_key = bool(os.environ.get("DASHSCOPE_API_KEY", "").strip())
    set_dashscope_api_key(os.environ.get("DASHSCOPE_API_KEY", "").strip())
    print(f"DASHSCOPE_API_KEY available: {str(has_key).lower()}")
    return 0 if has_key else 1


if __name__ == "__main__":
    raise SystemExit(main())
