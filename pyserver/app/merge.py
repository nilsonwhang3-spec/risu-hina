"""Three-way merge for material that both sides can edit.

Every material here exists twice: the WORKING copy the panel edits, and the
BASELINE - what RisuAI held when we last read it. The panel re-uploads the
whole character on every open, so an upload brings a third value: what RisuAI
holds NOW.

    base    the baseline, as of the previous upload
    theirs  what RisuAI has now
    ours    the working copy

Before this module the baseline was simply overwritten with `theirs` and the
working copy left alone, which made a row nobody had touched read as "edited
here" with its diff inverted - the panel offered to revert the user's own
RisuAI edit, and the host's `before` guard waved it through because `before`
had just been moved to the live value. The three-way rule fixes that at the
root:

    ours == base                  ->  adopt theirs   (we have nothing to lose)
    ours != base, theirs == base  ->  keep ours      (an edit in progress)
    both moved                    ->  conflict       (keep ours, record theirs)

`adopt` is the only action that can destroy anything, and it fires only when
the working copy provably equals the baseline. So the safety argument reduces
to: never adopt on a pairing we are not sure about. That is why a pair found
by position alone is never adopted - see `Spec.floor` and TIER_POSITIONAL.

The baseline itself always moves to `theirs` for a paired row, including a
conflicted one. Otherwise the next diff lies again, and the write-back guard
(which compares the baseline against the live value) can never pass.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any, Callable, Sequence

# --- canonical form ---------------------------------------------------------

# Flags RisuAI's own importer stamps onto entries that never carried them. A
# card that has been exported and re-imported grows `selective: false` on every
# lorebook entry; without this rule that round trip reads as "the user edited
# every single entry", and after it the write-back guard could never pass
# again. A default-valued flag is treated as absent, in both directions.
DEFAULT_FALSE = (
    "alwaysActive", "selective", "useRegex", "enabled", "case_sensitive",
    "scanDepth", "loreCache", "folder", "activationPercent",
)


def _strip(value: Any) -> Any:
    """Recursively drop what carries no meaning: nulls, empty strings, and
    flags sitting at their default. Dicts come back sorted so text comparison
    is order-independent - `structuredClone` and RisuAI's own save/load
    reorder keys freely, so key order can never be part of identity."""
    if isinstance(value, dict):
        out = {}
        for k in sorted(value):
            v = _strip(value[k])
            if v is None or v == "" or v == [] or v == {}:
                continue
            if k in DEFAULT_FALSE and v in (False, 0, "0"):
                continue
            out[k] = v
        return out
    if isinstance(value, list):
        return [_strip(v) for v in value]
    return value


def canon(value: Any) -> str:
    """A stable text form. Equal canon means "the same thing" for our purposes."""
    if isinstance(value, str):
        return value
    return json.dumps(_strip(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha1(canon(value).encode("utf-8")).hexdigest()[:16]


# --- key functions ----------------------------------------------------------
#
# A key is the item's natural identity: the thing that stays the same when the
# text changes. They are tried strongest first, and a key value that occurs
# more than once **on either side** is skipped entirely for that pass - an
# ambiguous key is worse than no key, because it pairs the wrong items with
# full confidence.

KeyFn = Callable[[Any], Any]


def _text(entry: Any, *names: str) -> str:
    if isinstance(entry, str):
        return entry
    if not isinstance(entry, dict):
        return ""
    for n in names:
        v = entry.get(n)
        if isinstance(v, str) and v.strip():
            return v
    return ""


def _keys_of(entry: Any) -> tuple:
    """A lorebook entry's activation keys, normalised. RisuAI stores them as a
    comma string in some versions and a list in others."""
    if not isinstance(entry, dict):
        return ()
    raw = entry.get("key") or entry.get("keys") or []
    if isinstance(raw, str):
        parts = raw.split(",")
    elif isinstance(raw, list):
        parts = [str(p) for p in raw]
    else:
        return ()
    return tuple(sorted({p.strip().lower() for p in parts if str(p).strip()}))


def lore_keys() -> list[KeyFn]:
    return [
        # RisuAI's own id when the entry carries one.
        lambda e: ("id", str(e.get("id"))) if isinstance(e, dict) and e.get("id") else None,
        # A folder's identity IS its key: the entries inside it join on that
        # value (lore-view groups by `folder === folderEntry.key`), so a folder
        # must never fall through to the title match below.
        lambda e: ("folder", str(e.get("key"))) if isinstance(e, dict) and e.get("mode") == "folder" else None,
        lambda e: ("comment", _text(e, "comment", "name").strip()) if _text(e, "comment", "name").strip() else None,
        lambda e: ("keys", _keys_of(e)) if _keys_of(e) else None,
        lambda e: ("head", digest(_text(e, "content")[:200])) if _text(e, "content") else None,
    ]


def regex_keys() -> list[KeyFn]:
    return [
        # The pattern is what the script does; comments are often blank.
        lambda e: ("in", str(e.get("in"))) if isinstance(e, dict) and e.get("in") else None,
        lambda e: ("comment", _text(e, "comment").strip()) if _text(e, "comment").strip() else None,
        lambda e: ("out", str(e.get("type") or ""), digest(e.get("out"))) if isinstance(e, dict) else None,
    ]


def trigger_keys() -> list[KeyFn]:
    return [
        lambda e: ("comment", _text(e, "comment").strip()) if _text(e, "comment").strip() else None,
        lambda e: ("cond", str(e.get("type") or ""), digest(e.get("conditions"))) if isinstance(e, dict) else None,
    ]


def asset_keys() -> list[KeyFn]:
    return [
        # `key` is assets/<sha256>.<ext> - a content hash, the strongest key of
        # any material here.
        lambda e: ("key", str(e.get("field") or ""), str(e.get("key"))) if isinstance(e, dict) and e.get("key") else None,
        lambda e: ("name", str(e.get("field") or ""), str(e.get("name"))) if isinstance(e, dict) and e.get("name") else None,
    ]


def memo_keys() -> list[KeyFn]:
    """Hypa summaries. `chatMemos` is hypa's own join key - the set of turns a
    summary covers - and it survives the regeneration that renumbers every
    index. Matching by (kind, seq) is what made one insertion rebase every
    summary onto its neighbour's text."""
    def memos(e: Any) -> tuple:
        if not isinstance(e, dict):
            return ()
        raw = e.get("chatMemos") or []
        return tuple(sorted(str(m) for m in raw)) if isinstance(raw, list) else ()
    return [
        lambda e: ("memos", memos(e)) if memos(e) else None,
        lambda e: ("memo0", memos(e)[0]) if memos(e) else None,
    ]


# --- matching ---------------------------------------------------------------

TIER_EXACT = "exact"
TIER_KEYED = "keyed"
TIER_POSITIONAL = "positional"


@dataclass
class Spec:
    """How one material is matched."""
    keys: list[KeyFn] = field(default_factory=list)
    # Which text carries the meaning, for the similarity floor.
    text: Callable[[Any], str] = lambda e: e if isinstance(e, str) else canon(e)
    # Position is a last resort and is disabled where it means nothing (a
    # 3000-entry asset list) or where it is too dangerous to guess.
    positional: bool = True
    # How alike two leftovers must be to pair by position. Low on purpose: a
    # positional pair is never adopted, so the worst a loose floor can do is
    # show the user one conflict with both versions side by side. Refusing to
    # pair is not the safer option - it splits that into two conflicts ("gone
    # upstream" plus "new upstream"), which reads as data loss and is harder
    # to resolve.
    floor: float = 0.35


def _body(*names: str) -> Callable[[Any], str]:
    return lambda e: _text(e, *names)


# The materials, defined once so the backend and its tests agree.
LORE = Spec(keys=lore_keys(), text=_body("content"))
REGEX = Spec(keys=regex_keys(), text=_body("out", "in"))
TRIGGER = Spec(keys=trigger_keys())
ASSET = Spec(keys=asset_keys(), positional=False)
MEMO = Spec(keys=memo_keys(), text=_body("text"))
# Bare strings in an array: no natural key exists at all, so position is the
# only pass that can ever fire. It never adopts.
GREETING = Spec(keys=[], text=lambda e: str(e), floor=0.0)
# A chat variable: the name is the identity, the value is what changes, so
# both travel together and only the name is a key.
VAR = Spec(keys=[lambda e: ("var", str(e.get("key")))], positional=False)


@dataclass
class Pair:
    base_at: int
    theirs_at: int
    tier: str


@dataclass
class Matching:
    pairs: list[Pair]
    base_only: list[int]
    theirs_only: list[int]

    def by_base(self) -> dict[int, Pair]:
        return {p.base_at: p for p in self.pairs}


def match(base: Sequence[Any], theirs: Sequence[Any], spec: Spec) -> Matching:
    """Pair the list RisuAI last showed us with the one it shows now.

    Three passes, strongest first, each working only on what the previous one
    left over. Linear in practice: the exact pass is hashed, and the positional
    pass compares the i-th leftover with the i-th leftover rather than scoring
    every combination.
    """
    pairs: list[Pair] = []
    free_t = list(range(len(theirs)))
    free_b = list(range(len(base)))

    # 1. exact content. Duplicates pair with the copy nearest their old place,
    #    so a list containing the same entry twice does not cross over.
    buckets: dict[str, list[int]] = {}
    for j in free_t:
        buckets.setdefault(canon(theirs[j]), []).append(j)
    taken: set[int] = set()
    last = -1
    for i in list(free_b):
        pool = buckets.get(canon(base[i]))
        if not pool:
            continue
        ahead = [j for j in pool if j not in taken and j >= last]
        pick = ahead[0] if ahead else next((j for j in pool if j not in taken), None)
        if pick is None:
            continue
        taken.add(pick)
        last = pick
        pairs.append(Pair(i, pick, TIER_EXACT))
    free_b = [i for i in free_b if i not in {p.base_at for p in pairs}]
    free_t = [j for j in free_t if j not in taken]

    # 2. natural keys, one pass per key, strongest first.
    for keyfn in spec.keys:
        if not free_b or not free_t:
            break
        gb: dict[Any, list[int]] = {}
        gt: dict[Any, list[int]] = {}
        for i in free_b:
            k = _safe_key(keyfn, base[i])
            if k is not None:
                gb.setdefault(k, []).append(i)
        for j in free_t:
            k = _safe_key(keyfn, theirs[j])
            if k is not None:
                gt.setdefault(k, []).append(j)
        used_b, used_t = set(), set()
        for k, bs in gb.items():
            ts = gt.get(k)
            # Ambiguous on either side: skip rather than guess.
            if not ts or len(bs) != 1 or len(ts) != 1:
                continue
            pairs.append(Pair(bs[0], ts[0], TIER_KEYED))
            used_b.add(bs[0])
            used_t.add(ts[0])
        free_b = [i for i in free_b if i not in used_b]
        free_t = [j for j in free_t if j not in used_t]

    # 3. position, among what is left, and only when the two look alike. A
    #    pair found here is never adopted (see `decide`), so a wrong guess
    #    costs a click, never data.
    if spec.positional:
        used_b, used_t = set(), set()
        for i, j in zip(free_b, free_t):
            a, b = spec.text(base[i]), spec.text(theirs[j])
            if not a and not b:
                ratio = 1.0
            else:
                ratio = SequenceMatcher(None, a, b).quick_ratio()
            if ratio >= spec.floor:
                pairs.append(Pair(i, j, TIER_POSITIONAL))
                used_b.add(i)
                used_t.add(j)
        free_b = [i for i in free_b if i not in used_b]
        free_t = [j for j in free_t if j not in used_t]

    pairs.sort(key=lambda p: p.theirs_at)
    return Matching(pairs, free_b, free_t)


def _safe_key(fn: KeyFn, entry: Any) -> Any:
    try:
        return fn(entry)
    except Exception:  # noqa: BLE001 - a malformed entry must not stop the merge
        return None


# --- the decision -----------------------------------------------------------

ADOPT = "adopt"
KEEP = "keep"
CONFLICT = "conflict"
INSERT = "insert"
DELETE = "delete"

BOTH_MOVED = "both-moved"
DELETED_UPSTREAM = "deleted-upstream"
WEAK_MATCH = "weak-match"


@dataclass
class Row:
    """One working row, with its own baseline. `dirty` is for state a text
    comparison cannot see - a greeting marked for deletion, a lore entry whose
    `origin` says it was edited - so "untouched" never means "the text happens
    to match"."""
    id: str
    ours: Any
    base: Any | None
    dirty: bool = False
    order: int = 0


@dataclass
class Op:
    action: str
    row: Row | None = None
    theirs: Any | None = None
    seq: int | None = None          # index in the incoming list = the new base_seq
    conflict: dict | None = None


def decide(row: Row, theirs: Any, tier: str) -> Op:
    """One paired row. The baseline moves to `theirs` in every branch - the
    caller writes `theirs` into original/original_json regardless of action."""
    if canon(theirs) == canon(row.base):
        # RisuAI has not moved. Whatever is in the working copy stays, and
        # there is nothing to adopt - the ordinary repeat-open, which must not
        # count as having touched anything (see `touched`).
        return Op(KEEP, row, theirs)
    if canon(theirs) == canon(row.ours):
        # Both moved to the *same* value: nothing to reconcile. This is the
        # ordinary state right after a write-back - we wrote our copy into
        # RisuAI, so RisuAI now agrees with us - and treating it as a conflict
        # would put a prompt in front of the user for work they just shipped.
        return Op(KEEP, row, theirs)
    if not row.dirty and canon(row.ours) == canon(row.base):
        if tier == TIER_POSITIONAL:
            # We are not certain these two are the same item, and adopting is
            # the only irreversible move. Ask.
            return Op(CONFLICT, row, theirs,
                      conflict=_conflict(WEAK_MATCH, theirs, row.base, tier))
        return Op(ADOPT, row, theirs)
    return Op(CONFLICT, row, theirs, conflict=_conflict(BOTH_MOVED, theirs, row.base, tier))


def _conflict(kind: str, theirs: Any, base: Any, tier: str) -> dict:
    return {"kind": kind, "theirs": theirs, "base": base, "tier": tier}


def plan(rows: Sequence[Row], theirs: Sequence[Any], spec: Spec,
         *, drop_missing: bool = False) -> list[Op]:
    """Merge one material.

    `rows` are the working rows that have a baseline, in baseline order.
    Rows added here (base is None) are not passed in - they have nothing to
    match against and are handled by the caller (see `adopted_additions`).

    `drop_missing` is for turns: a message the user deleted in RisuAI really
    is gone, and keeping our untouched copy would resurrect it on write-back.
    For the list materials the same situation is a conflict instead, because
    a lorebook entry vanishing from the panel with no trace is the kind of
    silent loss this whole module exists to prevent.
    """
    base = [r.base for r in rows]
    m = match(base, theirs, spec)
    ops: list[Op] = []
    for p in m.pairs:
        op = decide(rows[p.base_at], theirs[p.theirs_at], p.tier)
        op.seq = p.theirs_at
        ops.append(op)
    for i in m.base_only:
        row = rows[i]
        untouched = not row.dirty and canon(row.ours) == canon(row.base)
        if untouched and drop_missing:
            ops.append(Op(DELETE, row))
        else:
            ops.append(Op(CONFLICT, row, None,
                          conflict=_conflict(DELETED_UPSTREAM, None, row.base, "")))
    for j in m.theirs_only:
        ops.append(Op(INSERT, None, theirs[j], seq=j))
    return ops


def adopted_additions(added: Sequence[Row], inserts: Sequence[Op], spec: Spec) -> dict[str, Op]:
    """Rows added in the panel that RisuAI now has too.

    Someone added the same lorebook entry on both sides. Without this the
    write-back would ship both copies. Matching is exact-only: anything less
    would merge two entries that merely resemble each other.
    """
    out: dict[str, Op] = {}
    pool = {canon(op.theirs): op for op in inserts}
    for row in added:
        hit = pool.get(canon(row.ours))
        if hit is not None:
            out[row.id] = hit
            pool.pop(canon(row.ours), None)
    return out


def counts(ops: Sequence[Op]) -> dict[str, int]:
    out = {ADOPT: 0, KEEP: 0, CONFLICT: 0, INSERT: 0, DELETE: 0}
    for op in ops:
        out[op.action] = out.get(op.action, 0) + 1
    return out


def touched(ops: Sequence[Op]) -> bool:
    """Whether this merge changes anything the user could want back. A run of
    pure `keep` is the ordinary repeat-open and must not cost a snapshot."""
    return any(op.action in (ADOPT, INSERT, DELETE) for op in ops)
