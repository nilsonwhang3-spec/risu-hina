"""Install the source snapshot without overwriting locally edited cards."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import config, log

SOURCE = Path(__file__).parent / "studio_defaults"


def install() -> dict:
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    root = config.DATA_DIR / "space" / "studio" / "config"
    state_path = root / ".studio" / "defaults.json"
    old = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    installed, preserved = [], []
    # Validate the complete package before writing any destination.
    contents = []
    for entry in manifest["files"]:
        rel = Path(entry["path"])
        if rel.is_absolute() or ".." in rel.parts or rel.parts[0] not in ("styles", "scenes", "fragments"):
            raise ValueError("invalid default library path")
        source = (SOURCE / rel).resolve()
        target = (root / rel).resolve()
        if not source.is_relative_to(SOURCE.resolve()) or not target.is_relative_to(root.resolve()):
            raise ValueError("default library path escaped its root")
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError(f"default library checksum mismatch: {rel}")
        contents.append((entry, target, data))
    for entry, target, data in contents:
        rel = entry["path"]
        current = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
        if current is None or current == old.get(rel) or current == entry["sha256"]:
            if current != entry["sha256"]:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                installed.append(rel)
            old[rel] = entry["sha256"]
        else:
            preserved.append(rel)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temp = state_path.with_suffix(".tmp")
    temp.write_text(json.dumps(old, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(state_path)
    log.info("studio defaults installed=%s preserved=%s", len(installed), len(preserved))
    return {"installed": installed, "preserved": preserved}
