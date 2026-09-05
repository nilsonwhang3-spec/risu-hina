"""Gemini thought signatures for tool calls, across the OpenAI-compatible wire.

Gemini 3 thinking models attach `extra_content: {"google": {"thought_signature":
...}}` to each tool call they make, and refuse a later request whose history
replays that call without the signature (400 INVALID_ARGUMENT, "Function call
is missing a thought_signature"). pydantic-ai 2.33's OpenAI chat model drops
unknown fields on both sides, so the agent could never get past its first
tool call on those models.

This module is the round trip: `capture` reads the field off a response (or
off every streamed delta) and remembers it by tool_call_id; `attach` puts it
back on the assistant messages of the next request. The store is a small
table, because the history is persisted and replayed across turns and
sessions - a dict would forget the signature exactly when a conversation is
continued the next day. Providers that never send the field cost one dict
lookup per tool call and nothing else.
"""
from __future__ import annotations

import json
import time
from typing import Any

from . import db, log

_MEM: dict[str, dict] = {}
_PRUNE_AFTER = 30 * 86400
_pruned_at = 0.0


def _extra(obj: Any) -> dict | None:
    """The `extra_content` the SDK kept as an unknown field, if any."""
    v = getattr(obj, "extra_content", None)
    if v is None:
        extra = getattr(obj, "model_extra", None) or {}
        v = extra.get("extra_content") if isinstance(extra, dict) else None
    if isinstance(v, dict) and v:
        return v
    return None


def remember(tool_call_id: str, extra: dict) -> None:
    if not tool_call_id or not extra:
        return
    _MEM[tool_call_id] = extra
    try:
        db.execute("INSERT OR REPLACE INTO tool_sigs(tool_call_id, payload_json, created_at) VALUES(?, ?, ?)",
                   (tool_call_id, json.dumps(extra, ensure_ascii=False), time.time()))
    except Exception as e:  # noqa: BLE001 - a lost signature is a later 400, not a crash now
        log.warn("tool signature not saved: %s", e)
    _prune()


def lookup(tool_call_id: str) -> dict | None:
    hit = _MEM.get(tool_call_id)
    if hit is not None:
        return hit
    try:
        row = db.one("SELECT payload_json FROM tool_sigs WHERE tool_call_id = ?", (tool_call_id,))
    except Exception:  # noqa: BLE001
        row = None
    if row is None:
        return None
    try:
        extra = json.loads(row["payload_json"])
    except (TypeError, ValueError):
        return None
    if isinstance(extra, dict):
        _MEM[tool_call_id] = extra
        return extra
    return None


def _prune() -> None:
    global _pruned_at
    now = time.time()
    if now - _pruned_at < 3600:
        return
    _pruned_at = now
    try:
        db.execute("DELETE FROM tool_sigs WHERE created_at < ?", (now - _PRUNE_AFTER,))
    except Exception:  # noqa: BLE001
        pass


def attach(messages: Any) -> None:
    """Put remembered signatures back on the request's assistant tool calls."""
    if not isinstance(messages, list):
        return
    for m in messages:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        for tc in m.get("tool_calls") or []:
            if not isinstance(tc, dict) or tc.get("extra_content"):
                continue
            extra = lookup(str(tc.get("id") or ""))
            if extra:
                tc["extra_content"] = extra


def capture(out: Any) -> Any:
    """Read signatures off a plain response, or wrap a stream to read them
    off its deltas as they pass. Returns what the caller should use."""
    choices = getattr(out, "choices", None)
    if isinstance(choices, list):
        for ch in choices:
            msg = getattr(ch, "message", None)
            for tc in (getattr(msg, "tool_calls", None) or []):
                extra = _extra(tc)
                if extra:
                    remember(str(getattr(tc, "id", "") or ""), extra)
        return out
    if hasattr(out, "__aiter__"):
        return _StreamProxy(out)
    return out


class _StreamProxy:
    """An async stream that looks like the SDK's, capturing tool-call deltas.

    A streamed tool call arrives as one delta carrying `id` (and, on Gemini,
    `extra_content`) followed by argument deltas with only `index`; the
    index→id map covers a signature that arrives on a later delta.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self._ids: dict[int, str] = {}

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    async def __aenter__(self) -> "_StreamProxy":
        enter = getattr(self._inner, "__aenter__", None)
        if enter is not None:
            await enter()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        leave = getattr(self._inner, "__aexit__", None)
        if leave is not None:
            return await leave(*exc)
        return None

    def __aiter__(self) -> "_StreamProxy":
        self._it = self._inner.__aiter__()
        return self

    async def __anext__(self) -> Any:
        chunk = await self._it.__anext__()
        try:
            for ch in (getattr(chunk, "choices", None) or []):
                delta = getattr(ch, "delta", None)
                for tc in (getattr(delta, "tool_calls", None) or []):
                    ix = getattr(tc, "index", None)
                    tid = str(getattr(tc, "id", "") or "")
                    if tid and isinstance(ix, int):
                        self._ids[ix] = tid
                    elif not tid and isinstance(ix, int):
                        tid = self._ids.get(ix, "")
                    extra = _extra(tc)
                    if extra and tid:
                        remember(tid, extra)
        except Exception as e:  # noqa: BLE001 - never break the stream over bookkeeping
            log.warn("tool signature capture: %s", e)
        return chunk
