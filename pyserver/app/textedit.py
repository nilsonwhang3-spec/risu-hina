"""Partial text replacement for the agent's propose_*_replace tools.

The whole-body tools (propose_lore_edit, propose_memory_edit, propose_card_edit)
take the complete new text. That is the right shape for a rewrite and the
wrong one for a one-line fix: to change a sentence in a 3,000-character
lorebook entry the model had to reproduce the other 2,900 characters, and
any slip - a dropped paragraph, a "…" where it got bored - became the
proposal. These helpers turn (find, replace) into the full new body on the
server, so the model only ever writes the part that changes.

The rules are the ones every editor's find/replace has and every diff-apply
tool converges on: the snippet must occur, and unless the caller says
otherwise it must occur exactly once - a match in two places is ambiguity,
not a hit.
"""
from __future__ import annotations


class ReplaceError(ValueError):
    pass


def _context(text: str, at: int, width: int = 40) -> str:
    lo = max(0, at - width)
    hi = min(len(text), at + width)
    return text[lo:hi].replace("\n", "⏎")


def replace_once(text: str, find: str, replace: str, *, replace_all: bool = False) -> tuple[str, int]:
    """Return (new_text, occurrences_replaced).

    Raises ReplaceError when `find` is empty, absent, or - without
    `replace_all` - present more than once. The message names the count and,
    for a single miss, the nearest line so the model can correct the snippet
    instead of falling back to a whole rewrite.
    """
    if not find:
        raise ReplaceError("find 가 비어 있습니다 — 바꿀 원문 조각을 그대로 넣어 주세요")
    n = text.count(find)
    if n == 0:
        # A near miss is usually whitespace or a quote mark; point at the
        # closest line by shared prefix so the retry is one edit away.
        head = find.strip().split("\n", 1)[0]
        hint = ""
        for width in (16, 10, 6):
            probe = head[:width]
            if len(probe) < 3:
                break
            line = next((ln for ln in text.split("\n") if probe in ln), None)
            if line is not None:
                hint = f" 비슷한 줄: “{line.strip()[:80]}”"
                break
        raise ReplaceError(f"find 가 본문에 없습니다 (정확히 같은 문자열이어야 합니다 — 공백·따옴표·줄바꿈까지).{hint}")
    if n > 1 and not replace_all:
        first = text.find(find)
        raise ReplaceError(
            f"find 가 {n}곳에 있습니다 — 앞뒤 문맥을 더 넣어 한 곳만 가리키거나 replace_all=True 로 전부 바꾸세요. "
            f"첫 위치 근처: “{_context(text, first)}”")
    if replace_all:
        return text.replace(find, replace), n
    return text.replace(find, replace, 1), 1
