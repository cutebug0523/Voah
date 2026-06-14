#!/usr/bin/env python3
"""Run the voah-video-intake skill with stricter JSON recovery.

The upstream skill remains the source of truth for scene detection and Omni
grouping. This wrapper only patches model JSON extraction so a single missing
closing bracket from streamed Omni output does not fail the whole CLI intake.
"""

from __future__ import annotations

import importlib.util
import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SKILL_RUNNER = REPO_ROOT / "runtime" / "skills" / "voah-video-intake" / "scripts" / "run_intake.py"


def parse_json_with_repairs(text: str) -> dict[str, Any]:
    cleaned = str(text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned.strip(), flags=re.I).strip()
        cleaned = re.sub(r"```$", "", cleaned.strip()).strip()
    cleaned = re.sub(r'(:\s*)“', r'\1"', cleaned)

    candidates = [cleaned]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0:
        if end > start:
            candidates.append(cleaned[start : end + 1])
        else:
            candidates.append(cleaned[start:])

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        repaired_variants = [
            candidate,
            re.sub(r'([,\[]\s*)([\u4e00-\u9fff][^,\]\n]*?)"', r'\1"\2"', candidate),
        ]
        for repaired in repaired_variants:
            balanced = balance_json_tail(repaired)
            for variant in (repaired, balanced):
                try:
                    parsed = json.loads(variant)
                    if isinstance(parsed, dict):
                        return parsed
                except json.JSONDecodeError:
                    continue
    raise json.JSONDecodeError("could not repair model JSON", cleaned, 0)


def balance_json_tail(value: str) -> str:
    in_string = False
    escaped = False
    stack: list[str] = []
    for char in value:
        if escaped:
            escaped = False
            continue
        if char == "\\" and in_string:
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char in "{[":
            stack.append(char)
        elif char in "}]":
            if stack and ((stack[-1] == "{" and char == "}") or (stack[-1] == "[" and char == "]")):
                stack.pop()
    close = {"{": "}", "[": "]"}
    return value + "".join(close[item] for item in reversed(stack))


def load_runner(path: Path):
    spec = importlib.util.spec_from_file_location("voah_skill_run_intake", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load skill run_intake.py: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--skill-runner", default=str(DEFAULT_SKILL_RUNNER))
    return parser.parse_known_args(argv)


def main(argv: list[str] | None = None) -> int:
    compat_args, runner_args = parse_args(argv or sys.argv[1:])
    runner_path = Path(compat_args.skill_runner).expanduser().resolve()
    module = load_runner(runner_path)
    module.extract_json_text = parse_json_with_repairs
    old_argv = sys.argv[:]
    try:
        sys.argv = [str(runner_path), *runner_args]
        return int(module.main() or 0)
    finally:
        sys.argv = old_argv


if __name__ == "__main__":
    raise SystemExit(main())
