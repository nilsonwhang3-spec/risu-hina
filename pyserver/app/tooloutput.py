"""Session-scoped, immutable text results, readable during the producing turn."""
from __future__ import annotations

import hashlib
import re

from . import config


def _folder(session_id: str):
    return config.DATA_DIR / "tool-results" / hashlib.sha256(session_id.encode()).hexdigest()


def save(session_id: str, text: str) -> str:
    ref = hashlib.sha256(text.encode("utf-8")).hexdigest()
    folder = _folder(session_id)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (ref + ".txt")
    if not path.exists():
        path.write_text(text, encoding="utf-8")
    return ref


def read(session_id: str, ref: str, offset: int = 0, limit: int = 2000) -> dict:
    if not re.fullmatch(r"[a-f0-9]{64}", ref):
        raise ValueError("Invalid result reference")
    text = (_folder(session_id) / (ref + ".txt")).read_text(encoding="utf-8")
    offset, limit = max(0, offset), max(1, min(4000, limit))
    end = min(len(text), offset + limit)
    return {"ref": ref, "offset": offset, "totalChars": len(text),
            "text": text[offset:end], "nextOffset": end if end < len(text) else None}


def preview(session_id: str, text: str, limit: int = 4000) -> str:
    ref = save(session_id, text)
    return (f"[Full tool result: read_tool_result(ref='{ref}', offset={limit}); "
            f"totalChars={len(text)}]\n" + text[:limit])
