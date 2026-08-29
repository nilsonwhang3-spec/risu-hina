"""Undo the space_v1 migration by replaying its manifest in reverse.

The migration never deletes and never overwrites, which is what makes this
possible at all: every file it touched is one `from -> to` move in
`space/.hina/migration-space_v1.json`, and moving each `to` back to its `from`
restores the old tree exactly.

Run with the backend STOPPED:

    pyserver/.venv/Scripts/python.exe pyserver/tools/rollback_space.py [--dry-run]

After a rollback the migration marker is left in the DB on purpose - remove it
only if you want the next boot to migrate again:

    DELETE FROM meta WHERE key = 'mig_space_v1';
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402


def main() -> int:
    dry = "--dry-run" in sys.argv
    config.load()
    raw = str((config.section("workspace") or {}).get("globalPath") or "").strip()
    space = Path(raw).expanduser() if raw else config.DATA_DIR / "space"
    mpath = space / ".hina" / "migration-space_v1.json"
    if not mpath.is_file():
        print(f"manifest not found: {mpath}")
        return 1
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    moves = list(reversed(manifest.get("moves") or []))
    print(f"{len(moves)} moves to undo{' (dry run)' if dry else ''}")
    undone = missing = blocked = 0
    for m in moves:
        src, dst = Path(m["to"]), Path(m["from"])
        if not src.is_file():
            print(f"  missing: {src}")
            missing += 1
            continue
        if dst.exists():
            print(f"  target occupied, left in place: {dst}")
            blocked += 1
            continue
        if not dry:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
        undone += 1
    print(f"undone {undone}, missing {missing}, blocked {blocked}")
    if not dry and not missing and not blocked:
        print("clean rollback. To let the next boot migrate again:")
        print("  DELETE FROM meta WHERE key = 'mig_space_v1';")
    return 0 if not blocked else 2


if __name__ == "__main__":
    raise SystemExit(main())
