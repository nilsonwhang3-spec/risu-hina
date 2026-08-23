"""RisuAI chat <-> editable Markdown, losslessly.

Derived from vepo-bot/.claude/skills/chatlog-roundtrip/chatlog_roundtrip.py and
copied here on purpose: the backend must not reach across projects at runtime.
Two things had to change before it could be trusted with a real chat.

1. The original rebuilt each message from role/data/time/name/chatId only, so
   `generationInfo`, `promptInfo`, `saying`, `disabled` and `isComment` were
   silently dropped on encode. Per-message extras are now parked in the sidecar
   and merged back.

2. It kept `data["message"]` out of the sidecar and everything else in, which is
   right - but the *reason* it has to stay whitelist-free was only proved in
   Phase 0. A real 394-turn chat carries fields that are not in RisuAI's `Chat`
   interface at all: `useModelPreset`, `modelBinding`, `bindedBotPreset`,
   `savedToggleValues`, `activeStreamingDisplayOptimizationMode`, and `arKey`
   - the last one being another plugin's identity stamp. Dropping unknown keys
   would quietly destroy another plugin's data, so the contract here is:
   **everything except `message` round-trips untouched, known or not.**

The Markdown side is what the agent edits, so the delimiters have to survive
hand editing and LLM editing alike: one line, greppable, and carrying the
stable key (`chatId`) rather than a positional index.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

# The envelope RisuAI's own exporter writes (characters.ts:236-241) and its
# importer accepts (characters.ts:435). Matching it exactly is what makes our
# output importable by stock RisuAI.
ENVELOPE_TYPE = "risuChat"
ENVELOPE_VER = 2

DELIM_OPEN = "<!--[MSG:{idx}|role:{role}|time:{time}|chatId:{chat_id}|name:{name}]-->"
DELIM_CLOSE = "<!--[/MSG:{idx}]-->"

RE_OPEN = re.compile(
    r"<!--\[MSG:(\d+)\|role:([^|]*)\|time:([^|]*)\|chatId:([^|]*)\|name:([^\]]*)\]-->"
)
RE_CLOSE = re.compile(r"<!--\[/MSG:(\d+)\]-->")
# The human-readable hint line is regenerated on decode and stripped on encode,
# so editing or deleting it can never change the reconstructed message.
RE_HINT = re.compile(r"^\s*<!-- #\d+ \[[^\]]*\] .* -->\s*$")

# Fields the delimiter already carries; everything else on a message goes to the
# sidecar. Listed rather than inferred so a future field lands in the sidecar by
# default instead of being lost.
INLINE_FIELDS = ("role", "data", "time", "chatId", "name")


class ChatFormatError(ValueError):
    """Raised when a payload or an edited document cannot be trusted."""


def _unwrap(payload: dict) -> dict:
    """Accept either the export envelope or a bare Chat object."""
    if not isinstance(payload, dict):
        raise ChatFormatError("payload must be an object")
    if payload.get("type") == ENVELOPE_TYPE and isinstance(payload.get("data"), dict):
        return payload
    if isinstance(payload.get("message"), list):
        return {"type": ENVELOPE_TYPE, "ver": ENVELOPE_VER, "data": payload, "folders": []}
    raise ChatFormatError("not a risuChat envelope and has no message[]")


def _stamp(time_ms: Any) -> str:
    try:
        ms = int(time_ms)
    except (TypeError, ValueError):
        return "no timestamp"
    if ms <= 0:
        return "no timestamp"
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except (OverflowError, OSError, ValueError):
        return "no timestamp"


# A body that happens to contain `<!--[MSG:` would be parsed as a delimiter and
# split one message into several phantom ones. That is not hypothetical here:
# the agent reads and writes this document with unrestricted tools, and a chat
# about Risu Elf (or one where someone pasted a decoded chatlog) contains
# exactly this text. So `<!--[` inside a body gets one backslash added on
# decode and one removed on encode, which is reversible for any number of
# pre-existing backslashes.
RE_ESCAPE_OPEN = re.compile(r"<!--(\\*)\[")
RE_UNESCAPE_OPEN = re.compile(r"<!--(\\+)\[")


def _escape_body(body: str) -> str:
    return RE_ESCAPE_OPEN.sub(lambda m: "<!--" + m.group(1) + "\\[", body)


def _unescape_body(body: str) -> str:
    return RE_UNESCAPE_OPEN.sub(lambda m: "<!--" + m.group(1)[:-1] + "[", body)


def _sanitize_inline(value: Any) -> str:
    """Keep a delimiter on one line and keep its field separators unambiguous.

    A `|` or a newline inside chatId/name would make the open tag unparseable.
    Neither has ever appeared in real data (chatId is a v4 UUID), but the
    delimiter is the one thing an edit pass must never be able to corrupt, so
    the escape is applied rather than assumed unnecessary.
    """
    s = "" if value is None else str(value)
    return s.replace("\\", "\\\\").replace("|", "\\p").replace("\n", "\\n").replace("]", "\\b")


def _desanitize_inline(s: str) -> str:
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            if nxt == "p":
                out.append("|"); i += 2; continue
            if nxt == "n":
                out.append("\n"); i += 2; continue
            if nxt == "b":
                out.append("]"); i += 2; continue
            if nxt == "\\":
                out.append("\\"); i += 2; continue
        out.append(c)
        i += 1
    return "".join(out)


def decode(payload: dict) -> dict:
    """Chat payload -> {"markdown": str, "meta": dict}.

    `meta` is the whole envelope with `data.message` removed, plus a per-message
    `extras` table keyed by the same index the delimiters use.
    """
    env = _unwrap(payload)
    data = env["data"]
    messages = data.get("message")
    if not isinstance(messages, list):
        raise ChatFormatError("data.message is not a list")

    extras: dict[str, dict] = {}
    lines: list[str] = [
        f"# {data.get('name') or 'Chat'}",
        f"# messages: {len(messages)}",
        "#",
        "# 구분자 <!--[MSG:...]--> / <!--[/MSG:N]--> 는 유지할 것. 그 사이 본문만 고친다.",
        "# <!-- #N [ROLE] ... --> 줄은 읽기용 힌트이며 encode 시 무시된다.",
        "",
    ]

    for i, msg in enumerate(messages):
        if not isinstance(msg, dict):
            raise ChatFormatError(f"message[{i}] is not an object")
        rest = {k: v for k, v in msg.items() if k not in INLINE_FIELDS}
        if rest:
            extras[str(i)] = rest

        lines.append(DELIM_OPEN.format(
            idx=i,
            role=_sanitize_inline(msg.get("role", "")),
            time=_sanitize_inline(msg.get("time", 0)),
            chat_id=_sanitize_inline(msg.get("chatId", "")),
            name=_sanitize_inline(msg.get("name", "") or ""),
        ))
        lines.append(f"<!-- #{i} [{str(msg.get('role', '?')).upper()}] {_stamp(msg.get('time'))} -->")
        lines.append("")
        lines.append(_escape_body(str(msg.get("data", ""))))
        lines.append("")
        lines.append(DELIM_CLOSE.format(idx=i))
        lines.append("")

    envelope_rest = {k: v for k, v in env.items() if k != "data"}
    data_rest = {k: v for k, v in data.items() if k != "message"}

    meta = {
        "envelope": envelope_rest,   # type, ver, folders, and anything else
        "chat": data_rest,           # every Chat field except message[] - no whitelist
        "extras": extras,            # per-message fields the delimiter cannot carry
        "message_count": len(messages),
    }
    return {"markdown": "\n".join(lines), "meta": meta}


def encode(markdown: str, meta: dict) -> dict:
    """{"markdown", "meta"} -> the risuChat envelope, ready to import or patch."""
    if not isinstance(meta, dict):
        raise ChatFormatError("meta must be an object")
    extras = meta.get("extras") or {}
    chat_rest = dict(meta.get("chat") or {})
    envelope_rest = dict(meta.get("envelope") or {})

    messages: list[dict] = []
    opens = list(RE_OPEN.finditer(markdown))
    for n, m in enumerate(opens):
        idx = int(m.group(1))
        role = _desanitize_inline(m.group(2))
        time_raw = _desanitize_inline(m.group(3))
        chat_id = _desanitize_inline(m.group(4))
        name = _desanitize_inline(m.group(5))

        body_start = m.end()
        body_end = opens[n + 1].start() if n + 1 < len(opens) else len(markdown)
        segment = markdown[body_start:body_end]
        close = RE_CLOSE.search(segment)
        if close:
            segment = segment[:close.start()]

        body_lines = [ln for ln in segment.split("\n") if not RE_HINT.match(ln)]
        while body_lines and not body_lines[0].strip():
            body_lines.pop(0)
        while body_lines and not body_lines[-1].strip():
            body_lines.pop()

        try:
            time_val: Any = int(time_raw)
        except (TypeError, ValueError):
            time_val = time_raw

        msg: dict[str, Any] = {
            "role": role,
            "data": _unescape_body("\n".join(body_lines)),
            "time": time_val,
            "chatId": chat_id,
        }
        # `name` is optional on Message; writing "" where the original had
        # nothing would be a diff against the source, so only set it when real.
        if name:
            msg["name"] = name

        extra = extras.get(str(idx))
        if isinstance(extra, dict):
            msg.update(extra)
        messages.append(msg)

    chat_rest["message"] = messages
    out = {"type": ENVELOPE_TYPE, "ver": ENVELOPE_VER}
    out.update(envelope_rest)
    out["data"] = chat_rest
    return out


def message_count(markdown: str) -> int:
    return len(RE_OPEN.findall(markdown))


def verify(markdown: str, meta: dict) -> list[str]:
    """Structural warnings about an edited document, for the commit path.

    Structural edits (split/merge/insert/delete) are a feature, so a changed
    count is not an error - but a silently halved chat is the worst outcome
    this module can produce, so the check exists as something the workspace
    layer must call and show the user, rather than as a comment saying it is
    fine. Returns an empty list when the document is unremarkable.
    """
    warnings: list[str] = []
    opens = [int(m.group(1)) for m in RE_OPEN.finditer(markdown)]
    closes = [int(m.group(1)) for m in RE_CLOSE.finditer(markdown)]

    expected = meta.get("message_count")
    if isinstance(expected, int) and expected != len(opens):
        warnings.append(f"메시지 수가 {expected} → {len(opens)} 로 바뀌었습니다 (구조 편집이면 정상입니다)")

    if len(closes) != len(opens):
        warnings.append(f"여는 구분자 {len(opens)}개 / 닫는 구분자 {len(closes)}개 — 짝이 맞지 않습니다")

    ids = [_desanitize_inline(m.group(4)) for m in RE_OPEN.finditer(markdown)]
    dupes = sorted({i for i in ids if i and ids.count(i) > 1})
    if dupes:
        # Duplicate chatIds break patch targeting and hypa's chatMemos join.
        warnings.append("chatId 가 중복입니다: " + ", ".join(dupes[:5]))

    blank = [i for i, cid in enumerate(ids) if not cid]
    if blank:
        warnings.append(f"chatId 가 빈 메시지 {len(blank)}건 (인덱스 {blank[:5]}) — 패치 조준이 불가능합니다")

    head = markdown[:opens and RE_OPEN.search(markdown).start() or len(markdown)]
    if RE_CLOSE.search(head):
        warnings.append("첫 여는 구분자보다 앞에 닫는 구분자가 있습니다")

    return warnings


def roundtrip_diff(original: dict, rebuilt: dict) -> list[str]:
    """Field-level comparison used by the tests and by the workspace verifier.

    Returns a list of human-readable differences; empty means byte-equivalent
    at the JSON-value level. Comparing whole JSON strings would flag key order,
    which does not matter to RisuAI.
    """
    diffs: list[str] = []
    a, b = _unwrap(original), _unwrap(rebuilt)
    ad, bd = a["data"], b["data"]

    for key in sorted(set(ad) | set(bd)):
        if key == "message":
            continue
        if key not in ad:
            diffs.append(f"chat.{key}: added by roundtrip")
        elif key not in bd:
            diffs.append(f"chat.{key}: LOST by roundtrip")
        elif ad[key] != bd[key]:
            diffs.append(f"chat.{key}: changed")

    am, bm = ad.get("message") or [], bd.get("message") or []
    if len(am) != len(bm):
        diffs.append(f"message count {len(am)} -> {len(bm)}")
        return diffs

    for i, (x, y) in enumerate(zip(am, bm)):
        for key in sorted(set(x) | set(y)):
            if key not in x:
                diffs.append(f"message[{i}].{key}: added by roundtrip")
            elif key not in y:
                diffs.append(f"message[{i}].{key}: LOST by roundtrip")
            elif x[key] != y[key]:
                diffs.append(f"message[{i}].{key}: changed")
    return diffs


def loads(raw: str) -> dict:
    return json.loads(raw)


def dumps(envelope: dict) -> str:
    # ensure_ascii=False keeps Korean readable in the exported file; RisuAI
    # reads it back as UTF-8 either way.
    return json.dumps(envelope, ensure_ascii=False)
