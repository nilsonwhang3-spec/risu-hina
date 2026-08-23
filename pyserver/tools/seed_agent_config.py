"""Seed Risu Elf's agent credentials from active-recall's config, in place.

Run on the machine that holds both. Reads active-recall's `sweep` block (an
OpenAI-compatible baseUrl/apiKey/model) and writes it into Risu Elf's
`agent` block, leaving every other setting alone.

Deliberately reads the source locally rather than having the key handed in as
an argument: the credential never has to cross the wire a second time, and it
never lands in a shell history.

    .venv/Scripts/python.exe tools/seed_agent_config.py [--source <path>]

Prints only whether a key was found, never the key.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402

DEFAULT_SOURCE = Path(r"D:\code\active-recall\data\config.json")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=str(DEFAULT_SOURCE))
    ap.add_argument("--block", default="sweep", help="section of the source config to read")
    args = ap.parse_args()

    src = Path(args.source)
    if not src.exists():
        print(f"source not found: {src}")
        return 1

    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except ValueError as e:
        print(f"source is not valid JSON: {e}")
        return 1

    block = data.get(args.block) or {}
    base_url = str(block.get("baseUrl") or "").strip()
    api_key = str(block.get("apiKey") or "").strip()
    model = str(block.get("model") or "").strip()

    missing = [n for n, v in (("baseUrl", base_url), ("apiKey", api_key), ("model", model)) if not v]
    if missing:
        print(f"source block '{args.block}' is missing: {', '.join(missing)}")
        return 1

    config.update({"agent": {"baseUrl": base_url, "apiKey": api_key, "model": model}})

    print(f"seeded from {src} [{args.block}]")
    print(f"  baseUrl = {base_url}")
    print(f"  model   = {model}")
    print(f"  apiKey  = set ({len(api_key)} chars)")
    print(f"  written to {config.CONFIG_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
