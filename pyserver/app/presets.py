"""Named agent configurations.

**There is always exactly one selected preset, and it is what the agent runs.**

An earlier version kept presets purely as saved copies, with `config.json`'s
`agent` section as the live configuration. That kept one source of truth but
made the panel show two things that looked like settings, and the user asked
for the obvious model instead: one selected preset on screen, a list behind a
button.

The single-source rule survives by making the mirror total rather than by
avoiding it. Selecting a preset writes it into `config.json`; editing the
selected preset re-writes it. `config.json` is still the only thing `agent.py`
reads, so nothing downstream has to know presets exist - but it is never a
second place to configure, only a projection of the selected row.

    selected()      현재 선택된 프리셋
    select(id)      선택 + config 로 반영
    save(...)       프리셋 편집. 선택된 것이면 즉시 반영된다
    capture(name)   현재 config -> 새 프리셋
    delete(id)      선택된 것을 지우면 다른 것이 선택된다

API keys are stored here in the clear, exactly as they already are in
config.json. Both files sit in the data directory; pretending one of them is a
vault while the other is not would be theatre. They are never returned over
HTTP in full - `_public()` reduces a key to {set, length}, which is enough to
tell "configured" from "typo".
"""
from __future__ import annotations

import uuid
from typing import Any

from . import config, db, log

# The fields a preset carries. Anything outside this list belongs to the
# machine, not to a named configuration - `timeoutSeconds` is about this
# server's patience, not about which model to talk to.
FIELDS: dict[str, Any] = {
    "baseUrl": "",
    "apiKey": "",
    "model": "",
    "temperature": 0.2,
    "maxTokens": 32000,
    # '' means "do not send the parameter at all". A gateway that has never
    # heard of reasoning effort will reject the field rather than ignore it, so
    # the default has to be silence rather than a value.
    "reasoning": "",
    # Both are provider-specific and both are opt-in for the same reason.
    "cache": False,
    "flex": False,
    # Free-form extra instructions. Additive to the built-in rules, never a
    # replacement for them - see agent.py.
    "instructions": "",
}

REASONING_LEVELS = ("", "none", "minimal", "low", "medium", "high", "xhigh", "max")

MAX_PRESETS = 40
MAX_INSTRUCTIONS = 12000

SELECTED_KEY = "selected_preset"
DEFAULT_NAME = "기본"


class PresetError(ValueError):
    pass


def _row_to_preset(row) -> dict:
    d = db.row_to_dict(row) or {}
    return {
        "id": d.get("id"),
        "name": d.get("name") or "",
        "baseUrl": d.get("base_url") or "",
        "apiKey": d.get("api_key") or "",
        "model": d.get("model") or "",
        "temperature": float(d.get("temperature") or 0.2),
        "maxTokens": int(d.get("max_tokens") or FIELDS["maxTokens"]),
        "reasoning": d.get("reasoning") or "",
        "cache": bool(d.get("cache")),
        "flex": bool(d.get("flex")),
        "instructions": d.get("instructions") or "",
        "updatedAt": d.get("updated_at"),
    }


def _public(preset: dict) -> dict:
    """A preset as the UI may see it - the key reduced to its shape."""
    out = dict(preset)
    key = str(out.pop("apiKey", "") or "")
    out["apiKey"] = {"set": bool(key), "length": len(key)}
    return out


def list_all() -> list[dict]:
    ensure_default()
    rows = db.query("SELECT * FROM agent_presets ORDER BY name COLLATE NOCASE")
    sel = selected_id()
    out = []
    for r in rows:
        item = _public(_row_to_preset(r))
        item["selected"] = item["id"] == sel
        out.append(item)
    return out


def selected_id() -> str:
    row = db.one("SELECT value FROM meta WHERE key = ?", (SELECTED_KEY,))
    return (row["value"] if row else "") or ""


def _set_selected(preset_id: str) -> None:
    db.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (SELECTED_KEY, preset_id),
    )


def selected() -> dict | None:
    """The preset the agent is running, key redacted. Never None after seeding."""
    ensure_default()
    p = get(selected_id())
    if p is None:
        row = db.one("SELECT id FROM agent_presets ORDER BY name COLLATE NOCASE LIMIT 1")
        if row is None:
            return None
        _set_selected(row["id"])
        p = get(row["id"])
    out = _public(p or {})
    out["selected"] = True
    return out


def ensure_default() -> None:
    """Guarantee at least one preset, seeded from whatever config already holds.

    Without this the panel's "현재 프리셋" would be empty on an existing install
    even though the agent is configured and working - the settings would look
    lost rather than merely unnamed.
    """
    if db.one("SELECT id FROM agent_presets LIMIT 1") is not None:
        if not selected_id():
            row = db.one("SELECT id FROM agent_presets ORDER BY name COLLATE NOCASE LIMIT 1")
            if row is not None:
                _set_selected(row["id"])
        return
    cur = config.section("agent")
    v = _clean({f: cur.get(f, d) for f, d in FIELDS.items()}, None)
    pid = uuid.uuid4().hex
    now = db.now()
    _insert(pid, DEFAULT_NAME, v, now)
    _set_selected(pid)
    log.info("seeded the default agent preset from config")


def select(preset_id: str) -> dict:
    """Make this preset the one the agent runs."""
    p = get(preset_id)
    if p is None:
        raise PresetError("없는 프리셋입니다")
    _set_selected(preset_id)
    config.update({"agent": {f: p[f] for f in FIELDS}})
    log.info("preset selected id=%s name=%s model=%s", preset_id, p["name"], p["model"])
    return {"selected": p["name"], "id": preset_id, "config": config.redacted()}


def get(preset_id: str) -> dict | None:
    row = db.one("SELECT * FROM agent_presets WHERE id = ?", (preset_id,))
    return _row_to_preset(row) if row is not None else None


def _clean(values: dict, previous: dict | None) -> dict:
    """Validate a preset payload, filling from `previous` where asked to."""
    out: dict[str, Any] = {}
    for field, default in FIELDS.items():
        raw = values.get(field, None)
        if raw is None:
            out[field] = (previous or {}).get(field, default)
            continue
        if field == "apiKey":
            # The UI never receives the key, so it cannot send it back. The
            # sentinel is how it says "I did not touch this one".
            if raw == config.KEEP:
                out[field] = (previous or {}).get(field, "")
            else:
                out[field] = str(raw)
        elif field in ("cache", "flex"):
            out[field] = bool(raw)
        elif field == "temperature":
            try:
                out[field] = max(0.0, min(2.0, float(raw)))
            except (TypeError, ValueError):
                raise PresetError("temperature 는 숫자여야 합니다")
        elif field == "maxTokens":
            try:
                out[field] = max(256, min(2_000_000, int(raw)))
            except (TypeError, ValueError):
                raise PresetError("maxTokens 는 정수여야 합니다")
        elif field == "instructions":
            text = str(raw)
            if len(text) > MAX_INSTRUCTIONS:
                raise PresetError(
                    f"기본지침은 {MAX_INSTRUCTIONS}자까지입니다 (지금 {len(text)}자)")
            out[field] = text
        elif field == "reasoning":
            level = str(raw).strip().lower()
            if level not in REASONING_LEVELS:
                raise PresetError(
                    "reasoning 은 " + " · ".join(x or "(끔)" for x in REASONING_LEVELS) + " 중 하나여야 합니다")
            out[field] = level
        else:
            out[field] = str(raw).strip()
    return out


def save(name: str, values: dict, preset_id: str | None = None) -> dict:
    """Create or update one preset. Returns it, key redacted."""
    label = str(name or "").strip()
    if not label:
        raise PresetError("프리셋 이름을 입력해 주세요")
    if len(label) > 80:
        raise PresetError("프리셋 이름이 너무 깁니다 (80자까지)")

    previous = get(preset_id) if preset_id else None
    if preset_id and previous is None:
        raise PresetError("없는 프리셋입니다")
    if not preset_id:
        # Saving over a same-named preset is what the user means by "저장"
        # after tweaking one; making them delete first would be busywork.
        existing = db.one("SELECT id FROM agent_presets WHERE name = ? COLLATE NOCASE", (label,))
        if existing is not None:
            preset_id = existing["id"]
            previous = get(preset_id)
        elif len(db.query("SELECT id FROM agent_presets")) >= MAX_PRESETS:
            raise PresetError(f"프리셋은 {MAX_PRESETS}개까지만 저장할 수 있습니다")

    v = _clean(values, previous)
    pid = preset_id or uuid.uuid4().hex
    _insert(pid, label, v, db.now())
    log.info("preset saved id=%s name=%s model=%s", pid, label, v["model"])

    # Editing the selected preset has to reach the agent immediately. Saving
    # and then having to press 선택 again would be a trap: the panel would show
    # the new value while the agent kept using the old one.
    if not selected_id():
        _set_selected(pid)
    if selected_id() == pid:
        config.update({"agent": {f: v[f] for f in FIELDS}})
    out = _public(get(pid) or {})
    out["selected"] = selected_id() == pid
    return out


def _insert(pid: str, label: str, v: dict, now: float) -> None:
    db.execute(
        "INSERT INTO agent_presets(id, name, base_url, api_key, model, temperature, "
        "max_tokens, reasoning, cache, flex, instructions, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, "
        "api_key=excluded.api_key, model=excluded.model, temperature=excluded.temperature, "
        "max_tokens=excluded.max_tokens, reasoning=excluded.reasoning, cache=excluded.cache, "
        "flex=excluded.flex, instructions=excluded.instructions, updated_at=excluded.updated_at",
        (pid, label, v["baseUrl"], v["apiKey"], v["model"], v["temperature"],
         v["maxTokens"], v["reasoning"], int(v["cache"]), int(v["flex"]),
         v["instructions"], now, now),
    )


def capture(name: str) -> dict:
    """Save the settings the agent is using right now as a preset."""
    cur = config.section("agent")
    return save(name, {f: cur.get(f, d) for f, d in FIELDS.items()})


def apply(preset_id: str) -> dict:
    """Kept as the older name for select(); the panel calls select()."""
    out = select(preset_id)
    return {"applied": out["selected"], **out}


def delete(preset_id: str) -> dict:
    if get(preset_id) is None:
        raise PresetError("없는 프리셋입니다")
    if len(db.query("SELECT id FROM agent_presets")) <= 1:
        # There is always one selected preset, so the last one cannot go. The
        # alternative is a panel with nothing to show and an agent configured
        # from a row that no longer exists.
        raise PresetError("마지막 프리셋은 지울 수 없습니다. 새로 하나 만든 뒤에 지워 주세요")
    was_selected = selected_id() == preset_id
    db.execute("DELETE FROM agent_presets WHERE id = ?", (preset_id,))
    if was_selected:
        row = db.one("SELECT id FROM agent_presets ORDER BY name COLLATE NOCASE LIMIT 1")
        if row is not None:
            select(row["id"])
    return {"deleted": preset_id, "selectedId": selected_id()}


def model_settings() -> dict[str, Any]:
    """The live agent settings, as pydantic-ai model settings.

    Optional parameters are omitted rather than sent as null: these are
    OpenAI-shaped extras, and a gateway fronting another provider will reject a
    field it does not know instead of ignoring it. Off therefore has to mean
    absent.
    """
    cfg = config.section("agent")
    out: dict[str, Any] = {
        "temperature": float(cfg.get("temperature") or 0.2),
        "max_tokens": int(cfg.get("maxTokens") or FIELDS["maxTokens"]),
    }
    level = str(cfg.get("reasoning") or "").strip().lower()
    if level and level in REASONING_LEVELS and level != "":
        out["openai_reasoning_effort"] = level
    if cfg.get("flex"):
        # Cheaper, slower, and only on tiers that offer it. Requests can queue
        # for minutes, so the agent timeout matters more when this is on.
        out["openai_service_tier"] = "flex"
    if cfg.get("cache"):
        # A stable routing key. The cacheable prefix is the instructions plus
        # the tool schemas, which are identical across chats, so one key for the
        # whole app maximises hits rather than fragmenting them per chat.
        out["openai_prompt_cache_key"] = "risu-elf"
        out["openai_prompt_cache_retention"] = "24h"
    return out


def fingerprint() -> str:
    """Everything a rebuilt agent would pick up, as one comparable string."""
    cfg = config.section("agent")
    return "|".join(str(x) for x in (
        cfg.get("baseUrl"), cfg.get("model"), len(cfg.get("apiKey") or ""),
        cfg.get("temperature"), cfg.get("maxTokens"),
        cfg.get("reasoning"), cfg.get("cache"), cfg.get("flex"),
        len(cfg.get("instructions") or ""), (cfg.get("instructions") or "")[:60],
    ))


def instructions() -> str:
    """The user's base instructions block, or empty."""
    text = str(config.section("agent").get("instructions") or "").strip()
    if not text:
        return ""
    return "\n\n## 사용자 기본지침\n" + text
