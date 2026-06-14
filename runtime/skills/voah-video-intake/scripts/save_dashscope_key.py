#!/usr/bin/env python3
"""Save DashScope API key for Voah Video Intake without printing it."""

from __future__ import annotations

import getpass
import os
from pathlib import Path


SECRET_DIR = Path.home() / ".voah" / "video_intake"
SECRET_FILE = SECRET_DIR / ".env"


def main() -> int:
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not key:
        key = getpass.getpass("DASHSCOPE_API_KEY: ").strip()

    if not key:
        print("No key provided; nothing saved.")
        return 1

    SECRET_DIR.mkdir(parents=True, exist_ok=True)
    SECRET_FILE.write_text(f"DASHSCOPE_API_KEY={key}\n", encoding="utf-8")
    SECRET_FILE.chmod(0o600)
    print(f"Saved DashScope API key to {SECRET_FILE} with mode 0600.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
