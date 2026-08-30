"""Agent sessions: history, streaming, and cost.

One session is one conversation about one chat. History is persisted per turn so
a closed panel or a restarted backend does not lose the thread - the staged
proposals it produced certainly outlive it, so the reasoning behind them should
too.

Streaming is NDJSON: one JSON object per line, flushed as it happens. Phase 0
measured first-byte at ~289ms over this path and lines arriving at the server's
own cadence, so the panel can render progressively rather than waiting for a
multi-minute run to finish.
"""
from __future__ import annotations

import json
import threading
import uuid
from typing import Any, AsyncGenerator

from pydantic_ai.messages import (
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    UserPromptPart,
)

from . import agent as agent_mod
from . import providers
from . import config, db, log, permits, presets, pyexec, skills, staging, store, workspace

_agent_cache: dict[str, Any] = {}


def get_agent():
    """Rebuilt whenever anything it was built from changes.

    The fingerprint covers the skills text too, not just credentials. Editing a
    skill and seeing the agent ignore it until the next restart would read as
    the agent disobeying its instructions rather than as a stale cache.
    """
    cfg = config.section("agent")
    fingerprint = presets.fingerprint() + "|skills:" + skills.fingerprint()
    cached = _agent_cache.get("fp")
    if cached != fingerprint or "agent" not in _agent_cache:
        _agent_cache["agent"] = agent_mod.build()
        _agent_cache["fp"] = fingerprint
        log.info("agent rebuilt model=%s", cfg.get("model"))
    return _agent_cache["agent"]


def create(chat_key: str, title: str = "") -> dict:
    row = store.chat_row(chat_key)
    if row is None:
        raise LookupError(f"unknown chat: {chat_key}")
    sid = uuid.uuid4().hex
    now = db.now()
    db.execute(
        "INSERT INTO sessions(id, chat_key, title, created_at, updated_at) VALUES(?,?,?,?,?)",
        (sid, chat_key, title, now, now),
    )
    return {"sessionId": sid, "chatKey": chat_key, "title": title}


def latest(chat_key: str) -> dict | None:
    row = db.one(
        "SELECT * FROM sessions WHERE chat_key = ? ORDER BY updated_at DESC LIMIT 1", (chat_key,)
    )
    return db.row_to_dict(row)


def list_all(chat_key: str) -> list[dict]:
    """Sessions for a chat, newest first, with enough to label them.

    The title is derived from the first user message rather than asked for:
    nobody names a conversation before having it, and an unnamed list of
    timestamps is unusable once there are more than two.
    """
    rows = db.query(
        "SELECT s.id, s.title, s.created_at, s.updated_at, "
        "  (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = s.id AND m.role = 'user') AS turns, "
        "  (SELECT content_json FROM agent_messages m WHERE m.session_id = s.id AND m.role = 'user' "
        "     ORDER BY m.seq LIMIT 1) AS first_user, "
        "  (SELECT SUM(cost_usd) FROM cost_ledger c WHERE c.session_id = s.id) AS cost "
        "FROM sessions s WHERE s.chat_key = ? ORDER BY s.updated_at DESC",
        (chat_key,),
    )
    out = []
    for r in rows:
        first = db.unjs(r["first_user"], "") or ""
        label = r["title"] or (str(first)[:40] if first else "")
        out.append({
            "sessionId": r["id"],
            "title": label or "(빈 대화)",
            "turns": r["turns"] or 0,
            "cost": r["cost"],
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
        })
    return out


def load(session_id: str) -> dict | None:
    row = db.one("SELECT * FROM sessions WHERE id = ?", (session_id,))
    if row is None:
        return None
    return {"sessionId": row["id"], "chatKey": row["chat_key"], "title": row["title"]}


def messages(session_id: str) -> list[dict]:
    rows = db.query(
        "SELECT seq, role, content_json, cost_usd, usage_json, ts FROM agent_messages "
        "WHERE session_id = ? ORDER BY seq", (session_id,)
    )
    return [
        {"seq": r["seq"], "role": r["role"], "content": db.unjs(r["content_json"], ""),
         "cost": r["cost_usd"], "usage": db.unjs(r["usage_json"], None), "ts": r["ts"]}
        for r in rows
    ]


def _next_seq(session_id: str) -> int:
    row = db.one("SELECT COALESCE(MAX(seq), -1) AS m FROM agent_messages WHERE session_id = ?",
                 (session_id,))
    return (int(row["m"]) + 1) if row else 0


def _save_message(session_id: str, role: str, content: Any,
                  usage: dict | None = None, cost: float | None = None) -> None:
    db.execute(
        "INSERT INTO agent_messages(session_id, seq, role, content_json, usage_json, cost_usd, ts) "
        "VALUES(?,?,?,?,?,?,?)",
        (session_id, _next_seq(session_id), role, db.js(content),
         db.js(usage) if usage else None, cost, db.now()),
    )
    db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (db.now(), session_id))


def _history(session_id: str) -> list:
    """Rebuild pydantic-ai message history from the stored wire form."""
    row = db.one(
        "SELECT content_json FROM agent_messages WHERE session_id = ? AND role = 'history' "
        "ORDER BY seq DESC LIMIT 1", (session_id,)
    )
    if row is None:
        return []
    raw = db.unjs(row["content_json"], None)
    if not raw:
        return []
    try:
        return ModelMessagesTypeAdapter.validate_python(raw)
    except Exception as e:  # noqa: BLE001 - a corrupt history must not brick the session
        log.warn("history restore failed session=%s: %s", session_id, e)
        return []


def _price(model: str, usage: Any) -> tuple[float | None, dict]:
    """Cost for one run, and the token counts behind it.

    An unpriced model reports None rather than 0.00: a cost line that silently
    reads zero is worse than one that admits it does not know.

    Three sources, in order. `usage.cost` is populated by some providers but is
    None on this gateway. `genai_prices` knows the public rates but wants a bare
    model name - a gateway prefixes it ("google/gemini-3.7-flash"), and that
    prefix is enough to make the lookup miss entirely. The config table is the
    last word, so an operator can price a model the library has never heard of.
    """
    counts = {
        "input": getattr(usage, "input_tokens", None),
        "output": getattr(usage, "output_tokens", None),
        "requests": getattr(usage, "requests", None),
        "toolCalls": getattr(usage, "tool_calls", None),
    }

    reported = getattr(usage, "cost", None)
    if reported is not None:
        try:
            return float(reported), counts
        except (TypeError, ValueError):
            pass

    # The operator's own table wins over the library, so a wrong public rate can
    # be corrected without waiting for an upgrade.
    table = config.section("pricing") or {}
    entry = table.get(model) or table.get(model.split("/")[-1])
    if isinstance(entry, dict) and counts["input"] is not None and counts["output"] is not None:
        try:
            return (counts["input"] * float(entry.get("in", 0))
                    + counts["output"] * float(entry.get("out", 0))) / 1_000_000, counts
        except (TypeError, ValueError):
            pass

    try:
        from genai_prices import calc_price
    except ImportError:
        return None, counts

    for ref in _model_refs(model):
        try:
            return float(calc_price(usage, model_ref=ref).total_price), counts
        except Exception:  # noqa: BLE001 - unknown model is the normal miss here
            continue
    log.debug("no price for model=%s", model)
    return None, counts


def _model_refs(model: str) -> list[str]:
    """Candidate names for a price lookup, most specific first."""
    refs = [model]
    if "/" in model:
        refs.append(model.split("/")[-1])
    # Strip a trailing date stamp: "claude-x-20250101" prices as "claude-x".
    for r in list(refs):
        head = r.rsplit("-", 1)[0]
        if head != r and r.rsplit("-", 1)[1].isdigit():
            refs.append(head)
    return refs


def neutralise_thinking(history: list, model: Any) -> list:
    """Strip provider-specific reasoning ids the current model cannot replay.

    A preset can change between turns. A ThinkingPart a chat-completions
    gateway produced carries id='reasoning' (pydantic-ai names it after the
    field); sent back to the Responses API it becomes a reasoning item whose
    id must start with 'rs_' -> 400 "Invalid 'input[N].id': 'reasoning'".
    The reverse is harmless (chat/completions never replays ids), so the
    rule is one-sided: to a Responses model, keep only its own 'rs_' items;
    everything else loses its id (and signature), which is exactly the
    condition under which pydantic-ai does not send the part at all. The
    text of the thought stays in the history for the transcript.
    """
    from dataclasses import replace
    responses = type(model).__name__ == "OpenAIResponsesModel"
    if not responses:
        return history
    system = getattr(model, "system", "openai")
    out = []
    for m in history:
        if not isinstance(m, ModelResponse):
            out.append(m)
            continue
        parts = []
        changed = False
        for p in m.parts:
            if isinstance(p, ThinkingPart) and (p.id or p.signature):
                own = str(p.id or "").startswith("rs_") and (p.provider_name in (None, system))
                if not own:
                    p = replace(p, id=None, signature=None)
                    changed = True
            parts.append(p)
        out.append(replace(m, parts=parts) if changed else m)
    return out


# The screens the plugin may report. Anything else is treated as unknown - an
# older plugin, not an error. The studio is the third screen (agent.screen_gate).
SCREEN_MODES = ("chat", "bot", "studio")

# --- side events ----------------------------------------------------------------
#
# Tools that want to say something structured to the panel - an artifact to
# show, images to strip in - cannot reach the NDJSON stream themselves: they
# run inside pydantic-ai, and _translate only sees the library's events. So
# they push here, keyed by session, and run() drains the queue after every
# translated event (landing the line right after its toolResult) and once
# more before done. The wire vocabulary stays exactly:
#   start | text | tool | toolResult | artifact | images | done | error

_EXTRA: dict[str, list[dict]] = {}
_EXTRA_LOCK = threading.Lock()


def push_stream_event(session_id: str | None, obj: dict) -> None:
    """Queue one side event for the running turn. A missing session id means
    there is no stream to land on; the push is dropped rather than raised -
    the tool's text return still says what happened."""
    if not session_id:
        return
    with _EXTRA_LOCK:
        _EXTRA.setdefault(session_id, []).append(obj)


def _drain_extra(session_id: str) -> list[dict]:
    with _EXTRA_LOCK:
        return _EXTRA.pop(session_id, [])


async def run(session_id: str, prompt: str, mode: str = "") -> AsyncGenerator[str, None]:
    """Drive one agent turn, yielding NDJSON lines. `mode` is the half of the
    panel the user is looking at ('chat' | 'bot'), see agent.Deps.mode."""
    srow = db.one("SELECT * FROM sessions WHERE id = ?", (session_id,))
    if srow is None:
        yield _line({"type": "error", "error": f"unknown session: {session_id}"})
        return
    chat_key = srow["chat_key"]
    crow = store.chat_row(chat_key)
    if crow is None:
        yield _line({"type": "error", "error": f"unknown chat: {chat_key}"})
        return

    # Reference and script skills are files in the bot's hina home, and the
    # agent is told to read them with read_file - so they have to exist
    # before the turn starts, not only after run_python has been called once.
    ws_dir = workspace.root(crow["char_key"])
    pyexec.install_skills(workspace.hina_dir(crow["char_key"]))

    deps = agent_mod.Deps(
        chat_key=chat_key,
        char_key=crow["char_key"],
        session_id=session_id,
        workspace_dir=ws_dir,
        mode=mode if mode in SCREEN_MODES else "",
    )

    _save_message(session_id, "user", prompt)
    yield _line({"type": "start", "sessionId": session_id})

    model_name = (config.section("agent").get("model") or "")
    text_acc: list[str] = []

    try:
        ag = get_agent()
        # Older turns are summarised once the history is past its budget.
        history = await agent_mod.compact_history(session_id, _history(session_id))
        history = neutralise_thinking(history, ag.model)
        async with ag.run_stream_events(
            prompt, deps=deps, message_history=history
        ) as events:
            async for ev in events:
                for line in _translate(ev, text_acc):
                    yield line
                # Side events land right after the event whose tool pushed
                # them - "showed it mid-turn" is the whole point.
                for extra in _drain_extra(session_id):
                    yield _line(extra)
            result = events.result
        for extra in _drain_extra(session_id):
            yield _line(extra)

        usage = result.usage
        cost, counts = _price(model_name, usage)
        text = "".join(text_acc) or (result.output if isinstance(result.output, str) else "")

        _save_message(session_id, "assistant", text,
                      usage={**counts, "model": model_name}, cost=cost)
        # Store the wire-form history separately so the next turn can resume the
        # conversation exactly, including tool calls and their results.
        # If the history processor compacted the conversation this turn, the
        # compacted form is what gets stored - otherwise every later turn would
        # pay to summarise the same old messages again.
        compacted = agent_mod.COMPACTED.pop(session_id, None)
        stored = (compacted + list(result.new_messages())) if compacted is not None else result.all_messages()
        _save_message(session_id, "history",
                      json.loads(ModelMessagesTypeAdapter.dump_json(stored)))
        db.execute(
            "INSERT INTO cost_ledger(session_id, chat_key, model, in_tokens, out_tokens, "
            "cost_usd, priced, ts) VALUES(?,?,?,?,?,?,?,?)",
            (session_id, chat_key, model_name, counts.get("input") or 0,
             counts.get("output") or 0, cost, 1 if cost is not None else 0, db.now()),
        )

        pending = staging.pending(chat_key)
        yield _line({
            "type": "done",
            "usage": counts,
            "cost": cost,
            "model": model_name,
            "staged": len(pending),
            "total": _session_cost(session_id),
        })
        log.info("agent turn session=%s in=%s out=%s cost=%s staged=%s",
                 session_id, counts.get("input"), counts.get("output"), cost, len(pending))
    except BaseException as e:  # noqa: BLE001 - the stream is the only channel back
        # A turn that fails or is cut off must still leave its prompt (and
        # whatever text arrived) in the history: the next turn used to start
        # from the last SUCCESSFUL one, so after one error the agent had never
        # heard the prompts in between and lost the thread.
        _save_partial_history(session_id, prompt, "".join(text_acc), _explain(e) if isinstance(e, Exception) else "중단됨")
        if not isinstance(e, Exception):
            raise
        log.exception(f"agent run failed session={session_id}")
        yield _line({"type": "error", "error": _explain(e)})
    finally:
        # "이번 턴 항상 허용" and any unanswered prompt end with the turn.
        permits.end_turn(session_id)
        # A side event pushed after the last drain has no stream to land on.
        _drain_extra(session_id)


def _save_partial_history(session_id: str, prompt: str, partial: str, why: str) -> None:
    try:
        history = list(_history(session_id))
        history.append(ModelRequest(parts=[UserPromptPart(content=prompt)]))
        note = (partial + "\n\n" if partial else "") + f"(이 턴은 완료되지 못했습니다: {why})"
        history.append(ModelResponse(parts=[TextPart(content=note)]))
        _save_message(session_id, "history",
                      json.loads(ModelMessagesTypeAdapter.dump_json(history)))
    except Exception as e2:  # noqa: BLE001 - best effort, never masks the real error
        log.warn("partial history save failed session=%s: %s", session_id, e2)


def _explain(e: Exception) -> str:
    """Turn a library failure into something the user can act on.

    The raw messages are accurate but describe the library's world, not the
    settings screen. The token-budget one in particular reads as a prompt
    problem when the fix is a number in the settings tab.
    """
    raw = f"{type(e).__name__}: {e}"
    text = str(e)
    limit = config.section("agent").get("maxTokens")

    # A provider refusing a request field: say which, and the JSON that
    # stops it being sent, before anything else - the raw message names a
    # library parameter the user never typed.
    fix = providers.hint(text)
    if fix:
        return f"{raw[:400]}\n→ {fix}"

    if "token limit" in text.lower() or "max_tokens" in text.lower():
        return (
            f"모델이 출력 토큰 한도({limit})를 답을 내기 전에 다 썼습니다. "
            "사고(reasoning) 모델은 생각한 토큰도 출력으로 계산합니다 — "
            "설정 탭 → AI 에이전트에서 '최대 출력 토큰'을 32000 이상으로 올려 주세요."
        )
    low = text.lower()
    if "401" in text or "unauthorized" in low or "api key" in low:
        return "모델 API 인증에 실패했습니다. 설정 탭에서 API Key를 확인해 주세요."
    if "429" in text or "rate limit" in low:
        return "모델 쪽에서 요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요."
    if "timeout" in low or "timed out" in low:
        return "모델 응답이 시간 안에 오지 않았습니다. 지시를 짧게 나눠 주시거나 다시 시도해 주세요."
    if "not found" in low and "model" in low:
        return "설정된 모델 이름을 찾지 못했습니다. 설정 탭에서 모델명을 확인해 주세요."
    return raw


def _translate(ev: Any, acc: list[str]) -> list[str]:
    """pydantic-ai events -> our NDJSON vocabulary.

    Only what the panel renders is forwarded; the rest is dropped rather than
    passed through, so the wire format stays ours and a library upgrade cannot
    silently change what the client receives.
    """
    out = []
    if isinstance(ev, PartStartEvent):
        part = ev.part
        if isinstance(part, TextPart) and part.content:
            acc.append(part.content)
            out.append(_line({"type": "text", "text": part.content}))
        elif getattr(part, "tool_name", None):
            out.append(_line({"type": "tool", "name": part.tool_name}))
    elif isinstance(ev, PartDeltaEvent):
        delta = ev.delta
        if isinstance(delta, TextPartDelta) and delta.content_delta:
            acc.append(delta.content_delta)
            out.append(_line({"type": "text", "text": delta.content_delta}))
    else:
        name = type(ev).__name__
        if name == "FunctionToolCallEvent":
            part = getattr(ev, "part", None)
            out.append(_line({
                "type": "tool",
                "name": getattr(part, "tool_name", "?"),
                "args": _short(getattr(part, "args", None)),
            }))
        elif name == "FunctionToolResultEvent":
            content = getattr(getattr(ev, "result", None), "content", None)
            out.append(_line({"type": "toolResult", "result": _short(content)}))
    return out


def _short(v: Any, n: int = 300) -> str:
    if v is None:
        return ""
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    return s if len(s) <= n else s[:n] + " …"


def _session_cost(session_id: str) -> float | None:
    row = db.one(
        "SELECT SUM(cost_usd) AS c, COUNT(*) AS n, SUM(priced) AS p "
        "FROM cost_ledger WHERE session_id = ?", (session_id,)
    )
    if not row or not row["n"]:
        return None
    # If any call in the session was unpriced the total would understate itself;
    # say nothing rather than something wrong.
    if row["p"] != row["n"]:
        return None
    return float(row["c"] or 0)


def _line(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"
