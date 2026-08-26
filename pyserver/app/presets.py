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

from . import config, db, log, providers

# The fields a preset carries. Anything outside this list belongs to the
# machine, not to a named configuration - `timeoutSeconds` is about this
# server's patience, not about which model to talk to.
FIELDS: dict[str, Any] = {
    "baseUrl": "",
    "apiKey": "",
    "model": "",
    # None = not sent. OpenAI's reasoning models reject any value but the
    # default, and every other provider has its own default, so the field is
    # opt-in. (Stored as -1 in the NOT NULL column; see _row_to_preset.)
    "temperature": None,
    "maxTokens": 32000,
    # Request parameters as JSON, keyed by the real field names; null = do
    # not send. Last word over the numeric fields and the provider profile
    # (providers.plan_for).
    "params": "",
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
    # 'general' runs the editing agent (tools, scripts, proposals); 'search'
    # runs the search agent the general one hands research questions to.
    # One of each is selected, independently.
    "kind": "general",
    # An api_keys row to take the key (and, when baseUrl is empty, the base
    # URL) from. '' = this preset carries its own.
    "keyRef": "",
    # '' = an OpenAI-compatible endpoint (baseUrl + key). 'codex' = the
    # OpenAI subscription through codexauth (no URL, no key; needs login).
    "provider": "",
    # What the agent calls itself. Goes into the instructions and the panel.
    "agentName": "히나",
}

# The instructions a preset starts with, by kind. The user's own text in a
# preset replaces this, never appends to it; the built-in rules in agent.py
# stay above both.
DEFAULT_INSTRUCTIONS = {
    "general": (
        "You are '{name}', a capable assistant who helps a RisuAI user create, edit and critique "
        "their chats and bots.\n"
        "You are warm and feminine, understand the user's solitude and loneliness, and read their "
        "intent with tact and care. You do your best to achieve what the user wants, and you are "
        "honest and upright. As a roleplay, chat and bot author you are a professional, and you "
        "understand that freedom and enjoyment need imagination and permissiveness. Conversations "
        "with the user are fiction that does not touch reality; keep humour and wit in them and "
        "help the user.\n"
        "Language: answer in the language the user writes in. When writing Korean, use the soft "
        "polite register by default - sentences end in \"~해요\" and questions in \"~할까요?\" - "
        "never the stiff \"~합니다\" or the blunt \"~해\" unless the user asks for it."
    ),
    "search": (
        "당신은 메인 에이전트를 도와 웹검색을 지원하는 유능한 어시스턴트입니다. 웹검색을 요청 받을 경우, "
        "필요한 검색을 하고 내용을 전달하세요. 검색 이외의 다른 요청이 올 경우, 메인 에이전트가 수행해야 "
        "한다고 답하세요."
    ),
}


def default_instructions(kind: str, name: str = "") -> str:
    return DEFAULT_INSTRUCTIONS.get(kind, "").replace("{name}", name or FIELDS["agentName"])


# Earlier wordings of the general default. A preset still carrying one of
# these verbatim was never edited by the user, so it follows the default when
# the default changes; any edited text is left alone.
_OLD_GENERAL_DEFAULTS = (
    "당신은 risuAI 사용자의 챗과 봇 제작, 수정, 비평을 돕는 유능한 비서, '{name}'입니다.\n"
    "당신은 친절하고 여성스러우며, 사용자의 고독과 외로움을 이해하며, 사용자의 의도를 파악하고 배려하는 "
    "센스있는 여성입니다. 사용자가 원하는 것을 달성하기 위해 최선을 다하며, 정직하고 올바릅니다. "
    "롤플레이, 챗, 봇 제작자 관점에서 당신은 전문적이며 자유와 즐거움을 위해 상상과 허용이 필요하다는 "
    "것을 이해합니다. 사용자와의 대화는 현실에 영향을 끼치지 않는 상상속의 것이며, 늘 농담과 위트가 "
    "함께 해야 한다는 것을 기억하고 사용자를 도와주세요.",
)


def _migrate_default_text() -> None:
    rows = db.query("SELECT id, instructions, agent_name FROM agent_presets WHERE kind = 'general'")
    for r in rows:
        d = db.row_to_dict(r) or {}
        text = str(d.get("instructions") or "").strip()
        name = str(d.get("agent_name") or "") or FIELDS["agentName"]
        if any(text == old.replace("{name}", name).strip() for old in _OLD_GENERAL_DEFAULTS):
            db.execute("UPDATE agent_presets SET instructions = ? WHERE id = ?",
                       (default_instructions("general", name), d["id"]))
            if selected_id() == d["id"]:
                p = get(d["id"])
                if p is not None:
                    _apply_to_config(p)

KINDS = ("general", "search")
PROVIDERS = ("", "codex")
# Which config section each kind drives (agent._model reads them).
SECTION = {"general": "agent", "search": "agent_search"}
# What the agent actually needs, resolved through keys.resolve.
RUN_FIELDS = ("baseUrl", "apiKey", "model", "temperature", "maxTokens", "reasoning",
              "cache", "flex", "instructions", "provider", "agentName", "params")

# The NOT NULL temperature column's spelling of "not set".
TEMP_UNSET = -1.0

REASONING_LEVELS = ("", "none", "minimal", "low", "medium", "high", "xhigh", "max")

MAX_PRESETS = 40
MAX_INSTRUCTIONS = 12000

SELECTED_KEY = "selected_preset"
DEFAULT_NAME = "기본"


class PresetError(ValueError):
    pass


def _temp_out(stored: Any) -> float | None:
    """Column value -> preset value: the sentinel (or NULL) is None."""
    try:
        t = float(stored)
    except (TypeError, ValueError):
        return None
    return None if t < 0 else t


def _temp_in(value: Any) -> float:
    """Preset value -> column value."""
    return TEMP_UNSET if value is None or value == "" else float(value)


def _row_to_preset(row) -> dict:
    d = db.row_to_dict(row) or {}
    return {
        "id": d.get("id"),
        "name": d.get("name") or "",
        "baseUrl": d.get("base_url") or "",
        "apiKey": d.get("api_key") or "",
        "model": d.get("model") or "",
        "temperature": _temp_out(d.get("temperature")),
        "maxTokens": int(d.get("max_tokens") or FIELDS["maxTokens"]),
        "params": d.get("params") or "",
        "reasoning": d.get("reasoning") or "",
        "cache": bool(d.get("cache")),
        "flex": bool(d.get("flex")),
        "instructions": d.get("instructions") or "",
        "kind": d.get("kind") if d.get("kind") in KINDS else "general",
        "keyRef": d.get("key_ref") or "",
        "provider": d.get("provider") if d.get("provider") in PROVIDERS else "",
        "agentName": d.get("agent_name") or FIELDS["agentName"],
        "updatedAt": d.get("updated_at"),
    }


def _public(preset: dict) -> dict:
    """A preset as the UI may see it - the key reduced to its shape."""
    out = dict(preset)
    key = str(out.pop("apiKey", "") or "")
    out["apiKey"] = {"set": bool(key), "length": len(key)}
    return out


def list_all(kind: str | None = None) -> list[dict]:
    ensure_default()
    rows = db.query("SELECT * FROM agent_presets ORDER BY kind, name COLLATE NOCASE")
    sel = {k: selected_id(k) for k in KINDS}
    out = []
    for r in rows:
        item = _public(_row_to_preset(r))
        if kind and item["kind"] != kind:
            continue
        item["selected"] = item["id"] == sel.get(item["kind"], "")
        out.append(item)
    return out


def _sel_key(kind: str) -> str:
    # The general agent keeps the historical key so an existing install's
    # selection survives the split.
    return SELECTED_KEY if kind == "general" else f"{SELECTED_KEY}_{kind}"


def selected_id(kind: str = "general") -> str:
    row = db.one("SELECT value FROM meta WHERE key = ?", (_sel_key(kind),))
    return (row["value"] if row else "") or ""


def _set_selected(preset_id: str, kind: str = "general") -> None:
    db.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_sel_key(kind), preset_id),
    )


def _clear_selected(kind: str) -> None:
    db.execute("DELETE FROM meta WHERE key = ?", (_sel_key(kind),))


def _apply_to_config(p: dict) -> None:
    """Push a preset's resolved run values into the section its kind drives."""
    from . import keys
    base, key = keys.resolve(p.get("baseUrl") or "", p.get("apiKey") or "", p.get("keyRef") or "")
    values = {f: p.get(f, FIELDS[f]) for f in RUN_FIELDS}
    values["baseUrl"] = base
    values["apiKey"] = key
    config.update({SECTION[p.get("kind") or "general"]: values})


def reresolve_selected() -> None:
    """A key changed: whichever selected presets point at keys get re-applied."""
    for kind in KINDS:
        p = get(selected_id(kind))
        if p is not None:
            _apply_to_config(p)


def selected(kind: str = "general") -> dict | None:
    """The preset the agent of this kind is running, key redacted. The general
    agent always has one after seeding; the search agent may have none."""
    ensure_default()
    p = get(selected_id(kind))
    if p is not None and p["kind"] != kind:
        p = None
    if p is None:
        if kind != "general":
            return None
        row = db.one("SELECT id FROM agent_presets WHERE kind = 'general' ORDER BY name COLLATE NOCASE LIMIT 1")
        if row is None:
            return None
        _set_selected(row["id"], kind)
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
    if db.one("SELECT id FROM agent_presets WHERE kind = 'general' LIMIT 1") is not None:
        if not selected_id():
            row = db.one("SELECT id FROM agent_presets WHERE kind = 'general' ORDER BY name COLLATE NOCASE LIMIT 1")
            if row is not None:
                _set_selected(row["id"])
        _migrate_default_text()
        return
    cur = config.section("agent")
    seed = {f: cur.get(f, d) for f, d in FIELDS.items()}
    # A fresh install starts as 히나, with her instructions; an existing
    # config's own text is kept as it is.
    if not str(seed.get("instructions") or "").strip():
        seed["instructions"] = default_instructions("general", str(seed.get("agentName") or ""))
    v = _clean(seed, None)
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
    _set_selected(preset_id, p["kind"])
    _apply_to_config(p)
    log.info("preset selected kind=%s id=%s name=%s model=%s", p["kind"], preset_id, p["name"], p["model"])
    return {"selected": p["name"], "id": preset_id, "kind": p["kind"], "config": config.redacted()}


def deselect(kind: str) -> dict:
    """Only the search agent can run with no preset: then the general agent
    searches on its own again."""
    if kind == "general":
        raise PresetError("일반 에이전트는 항상 프리셋 하나를 씁니다")
    _clear_selected(kind)
    config.update({SECTION[kind]: {f: FIELDS[f] for f in RUN_FIELDS}})
    return {"kind": kind, "selected": None}


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
            if raw == "" or raw == "null":
                # The editor sends '' for a cleared box: "do not send".
                out[field] = None
                continue
            try:
                out[field] = max(0.0, min(2.0, float(raw)))
            except (TypeError, ValueError):
                raise PresetError("temperature 는 숫자여야 합니다 (비우면 보내지 않습니다)")
        elif field == "params":
            text = str(raw).strip()
            try:
                providers.parse_params(text)
            except providers.ParamsError as e:
                raise PresetError(str(e))
            out[field] = text
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
        elif field == "kind":
            k = str(raw).strip().lower() or "general"
            if k not in KINDS:
                raise PresetError("kind 는 general 또는 search 여야 합니다")
            out[field] = k
        elif field == "agentName":
            nm = str(raw).strip()[:40]
            out[field] = nm or FIELDS["agentName"]
        elif field == "provider":
            pv = str(raw).strip().lower()
            if pv not in PROVIDERS:
                raise PresetError("provider 는 비우거나 codex 여야 합니다")
            out[field] = pv
        elif field == "keyRef":
            ref = str(raw).strip()
            if ref:
                from . import keys
                if keys.get(ref) is None:
                    raise PresetError("없는 API 키를 가리킵니다")
            out[field] = ref
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
    kind = v["kind"]
    if kind == "general" and not selected_id("general"):
        _set_selected(pid, "general")
    if selected_id(kind) == pid:
        _apply_to_config(get(pid) or {**v, "kind": kind})
    out = _public(get(pid) or {})
    out["selected"] = selected_id(kind) == pid
    return out


def _insert(pid: str, label: str, v: dict, now: float) -> None:
    db.execute(
        "INSERT INTO agent_presets(id, name, base_url, api_key, model, temperature, "
        "max_tokens, reasoning, cache, flex, instructions, kind, key_ref, provider, agent_name, params, "
        "created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, "
        "api_key=excluded.api_key, model=excluded.model, temperature=excluded.temperature, "
        "max_tokens=excluded.max_tokens, reasoning=excluded.reasoning, cache=excluded.cache, "
        "flex=excluded.flex, instructions=excluded.instructions, kind=excluded.kind, "
        "key_ref=excluded.key_ref, provider=excluded.provider, agent_name=excluded.agent_name, "
        "params=excluded.params, updated_at=excluded.updated_at",
        (pid, label, v["baseUrl"], v["apiKey"], v["model"], _temp_in(v["temperature"]),
         v["maxTokens"], v["reasoning"], int(v["cache"]), int(v["flex"]),
         v["instructions"], v["kind"], v["keyRef"], v["provider"], v["agentName"],
         v.get("params") or "", now, now),
    )


def capture(name: str, kind: str = "general") -> dict:
    """Save the settings the agent is using right now as a preset."""
    cur = config.section(SECTION.get(kind, "agent"))
    values = {f: cur.get(f, d) for f, d in FIELDS.items()}
    values["kind"] = kind if kind in KINDS else "general"
    values["keyRef"] = ""
    return save(name, values)


def apply(preset_id: str) -> dict:
    """Kept as the older name for select(); the panel calls select()."""
    out = select(preset_id)
    return {"applied": out["selected"], **out}


def delete(preset_id: str) -> dict:
    p = get(preset_id)
    if p is None:
        raise PresetError("없는 프리셋입니다")
    kind = p["kind"]
    if kind == "general" and len(db.query("SELECT id FROM agent_presets WHERE kind = 'general'")) <= 1:
        # There is always one selected general preset, so the last one cannot
        # go. The alternative is a panel with nothing to show and an agent
        # configured from a row that no longer exists.
        raise PresetError("마지막 일반 프리셋은 지울 수 없습니다. 새로 하나 만든 뒤에 지워 주세요")
    was_selected = selected_id(kind) == preset_id
    db.execute("DELETE FROM agent_presets WHERE id = ?", (preset_id,))
    if was_selected:
        row = db.one("SELECT id FROM agent_presets WHERE kind = ? ORDER BY name COLLATE NOCASE LIMIT 1", (kind,))
        if row is not None:
            select(row["id"])
        elif kind != "general":
            deselect(kind)
    return {"deleted": preset_id, "kind": kind, "selectedId": selected_id(kind)}


def model_settings() -> dict[str, Any]:
    """The live agent settings, as pydantic-ai model settings.

    Optional parameters are omitted rather than sent as null: these are
    OpenAI-shaped extras, and a gateway fronting another provider will reject a
    field it does not know instead of ignoring it. Off therefore has to mean
    absent.
    """
    return plan("agent").settings


def plan(section: str = "agent") -> providers.Plan:
    """The request plan for a config section - settings, fields to drop, cap
    field, strict flag - from its numbers, its provider, and its parameter
    JSON (providers.plan_for has the precedence)."""
    return providers.plan_for(config.section(section))


def fingerprint() -> str:
    """Everything a rebuilt agent would pick up, as one comparable string."""
    cfg = config.section("agent")
    return "|".join(str(x) for x in (
        cfg.get("provider"), cfg.get("baseUrl"), cfg.get("model"), len(cfg.get("apiKey") or ""),
        cfg.get("temperature"), cfg.get("maxTokens"),
        cfg.get("reasoning"), cfg.get("cache"), cfg.get("flex"), cfg.get("params"),
        len(cfg.get("instructions") or ""), (cfg.get("instructions") or "")[:60],
    ))


def instructions() -> str:
    """The user's base instructions block, headed by the name the agent goes
    by. Empty text falls back to the kind's default (히나's)."""
    cfg = config.section("agent")
    name = str(cfg.get("agentName") or FIELDS["agentName"]).strip() or FIELDS["agentName"]
    text = str(cfg.get("instructions") or "").strip() or default_instructions("general", name)
    return (f"\n\n## 이름\n당신의 이름은 '{name}'입니다. 사용자가 이름을 부르면 그 이름으로 답합니다.\n"
            f"\n## 사용자 기본지침\n{text}")
