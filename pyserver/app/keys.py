"""API keys, kept apart from presets.

A preset used to carry its own base URL and key, which meant the same key
typed into every preset that used that provider - and re-typed into each
when it rotated. Now a key is a row here (name, provider, base URL, key)
and a preset either points at one (`keyRef`) or still carries its own for
the odd one-off. The settings page shows a key's shape (set, length),
never the key; the agent gets the resolved values through config, exactly
as before, so agent._model() did not have to learn anything.
"""
from __future__ import annotations

import uuid
from typing import Any

from . import config, db, log


class KeyError_(ValueError):
    pass


MAX_KEYS = 60


def _row(r) -> dict:
    d = db.row_to_dict(r) or {}
    return {
        "id": d.get("id"),
        "name": d.get("name") or "",
        "provider": d.get("provider") or "",
        "baseUrl": d.get("base_url") or "",
        "apiKey": d.get("api_key") or "",
        "note": d.get("note") or "",
        "updatedAt": d.get("updated_at"),
    }


def _public(k: dict) -> dict:
    out = dict(k)
    key = str(out.pop("apiKey", "") or "")
    out["apiKey"] = {"set": bool(key), "length": len(key)}
    return out


def list_all() -> list[dict]:
    return [_public(_row(r)) for r in db.query("SELECT * FROM api_keys ORDER BY name COLLATE NOCASE")]


def get(key_id: str) -> dict | None:
    if not key_id:
        return None
    r = db.one("SELECT * FROM api_keys WHERE id = ?", (key_id,))
    return _row(r) if r is not None else None


def save(values: dict, key_id: str | None = None) -> dict:
    name = str(values.get("name") or "").strip()
    if not name:
        raise KeyError_("키 이름을 입력해 주세요")
    if len(name) > 80:
        raise KeyError_("키 이름이 너무 깁니다 (80자까지)")
    previous = get(key_id) if key_id else None
    if key_id and previous is None:
        raise KeyError_("없는 키입니다")
    if not key_id:
        existing = db.one("SELECT id FROM api_keys WHERE name = ? COLLATE NOCASE", (name,))
        if existing is not None:
            key_id = existing["id"]
            previous = get(key_id)
        elif len(db.query("SELECT id FROM api_keys")) >= MAX_KEYS:
            raise KeyError_(f"키는 {MAX_KEYS}개까지 저장할 수 있습니다")
    raw = values.get("apiKey")
    if raw is None or raw == config.KEEP:
        api_key = (previous or {}).get("apiKey", "")
    else:
        api_key = str(raw).strip()
    kid = key_id or uuid.uuid4().hex
    now = db.now()
    db.execute(
        "INSERT INTO api_keys(id, name, provider, base_url, api_key, note, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, "
        "provider=excluded.provider, base_url=excluded.base_url, api_key=excluded.api_key, "
        "note=excluded.note, updated_at=excluded.updated_at",
        (kid, name, str(values.get("provider") or "").strip(), str(values.get("baseUrl") or "").strip().rstrip("/"),
         api_key, str(values.get("note") or "")[:500], now, now))
    log.info("api key saved id=%s name=%s provider=%s", kid, name, values.get("provider"))
    # Presets pointing at this key see the new value on their next use.
    from . import presets
    presets.reresolve_selected()
    return _public(get(kid) or {})


def delete(key_id: str) -> dict:
    if get(key_id) is None:
        raise KeyError_("없는 키입니다")
    used = db.query("SELECT name FROM agent_presets WHERE key_ref = ?", (key_id,))
    if used:
        raise KeyError_("이 키를 쓰는 프리셋이 있습니다: " + ", ".join(r["name"] for r in used))
    db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
    return {"deleted": key_id}


def resolve(base_url: str, api_key: str, key_ref: str) -> tuple[str, str]:
    """The base URL and key a preset actually runs with: its own, or the
    referenced key's (the key's base URL only when the preset has none)."""
    if not key_ref:
        return base_url, api_key
    k = get(key_ref)
    if k is None:
        return base_url, api_key
    return (base_url or k["baseUrl"]), (k["apiKey"] or api_key)
