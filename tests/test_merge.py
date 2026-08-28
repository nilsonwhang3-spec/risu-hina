"""The three-way merge: matching, and the decision it feeds.

The whole safety argument of `app.merge` is one sentence - `adopt` is the only
action that can lose work, and it fires only when the working copy provably
equals the baseline - so these tests exist to keep the exceptions honest:
a pair found by position alone must never adopt, an ambiguous key must never
pair, and an entry vanishing upstream must never disappear silently.

    python tests/test_merge.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pyserver"))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp949
except Exception:  # noqa: BLE001
    pass

from app import merge  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


def lore(comment: str, content: str, **extra) -> dict:
    return {"key": [comment], "comment": comment, "content": content, **extra}


def rows(items: list[dict], ours: list[dict] | None = None, dirty: set[int] | None = None) -> list[merge.Row]:
    """Working rows whose baseline is `items`; `ours` overrides the working side."""
    dirty = dirty or set()
    return [
        merge.Row(id=f"r{i}", ours=(ours[i] if ours else items[i]), base=items[i],
                  dirty=(i in dirty), order=i)
        for i in range(len(items))
    ]


# The shipped specs, not test-local copies: the point is to pin what the
# backend actually merges with.
LORE = merge.LORE
GREET = merge.GREETING


def test_canon() -> None:
    print("test_canon")
    a = {"content": "본문", "key": ["왕국"], "comment": "왕국 파르마"}
    b = {"comment": "왕국 파르마", "key": ["왕국"], "content": "본문"}
    check("key order is not identity", merge.canon(a) == merge.canon(b))
    # A card that has been through RisuAI's importer grows schema defaults.
    imported = {**a, "selective": False, "useRegex": False, "alwaysActive": False}
    check("RisuAI's default flags are not an edit", merge.canon(a) == merge.canon(imported),
          merge.canon(imported))
    check("a real flag still counts", merge.canon(a) != merge.canon({**a, "alwaysActive": True}))
    check("empty and missing are the same", merge.canon({**a, "note": ""}) == merge.canon(a))


def test_match_tiers() -> None:
    print("\ntest_match_tiers")
    base = [lore("왕국 파르마", "본문 A"), lore("기사단 규율", "본문 B"), lore("북부 신전", "본문 C")]
    # Unchanged list: everything pairs exactly, nothing left over.
    m = merge.match(base, list(base), LORE)
    check("an unchanged list pairs exactly", len(m.pairs) == 3
          and all(p.tier == merge.TIER_EXACT for p in m.pairs), str(m.pairs))
    check("nothing is left over", not m.base_only and not m.theirs_only)

    # Insertion at the head must not shift the pairing - this is what index
    # addressing got wrong for greetings, scripts and summaries.
    theirs = [lore("새 항목", "본문 Z")] + list(base)
    m = merge.match(base, theirs, LORE)
    check("an insertion at the head shifts nothing", len(m.pairs) == 3
          and all(theirs[p.theirs_at]["comment"] == base[p.base_at]["comment"] for p in m.pairs))
    check("the new entry is reported as new", m.theirs_only == [0], str(m.theirs_only))

    # A retitled entry pairs on content, an edited entry pairs on its title.
    theirs = [lore("왕국 파르마", "본문 A"), lore("기사단 규율", "본문 B가 바뀜"), lore("북부 신전", "본문 C")]
    m = merge.match(base, theirs, LORE)
    by = {p.base_at: p for p in m.pairs}
    check("an edited body still pairs by title", by[1].theirs_at == 1 and by[1].tier == merge.TIER_KEYED,
          str(by.get(1)))

    # Reordering is not a change.
    theirs = [base[2], base[0], base[1]]
    m = merge.match(base, theirs, LORE)
    check("a reordered list pairs by content", len(m.pairs) == 3
          and all(merge.canon(theirs[p.theirs_at]) == merge.canon(base[p.base_at]) for p in m.pairs))

    # A duplicated title is ambiguous: the key pass must skip it rather than
    # pair the wrong one with full confidence.
    b2 = [lore("같은 제목", "본문 1"), lore("같은 제목", "본문 2")]
    t2 = [lore("같은 제목", "본문 1이 바뀜"), lore("같은 제목", "본문 2가 바뀜")]
    m = merge.match(b2, t2, LORE)
    check("a duplicated key does not pair by key",
          all(p.tier != merge.TIER_KEYED for p in m.pairs), str([p.tier for p in m.pairs]))


def test_positional_never_adopts() -> None:
    print("\ntest_positional_never_adopts")
    # Greetings are bare strings: no natural key exists, so a changed one can
    # only ever be paired by position.
    base = ["첫 인사", "둘째 인사"]
    theirs = ["첫 인사", "둘째 인사가 아주 조금 바뀜"]
    r = rows(base)
    ops = merge.plan(r, theirs, GREET)
    by = {op.row.id: op for op in ops if op.row}
    check("an unchanged greeting is a no-op", by["r0"].action == merge.KEEP, by["r0"].action)
    check("a positionally paired change asks instead of adopting",
          by["r1"].action == merge.CONFLICT and by["r1"].conflict["kind"] == merge.WEAK_MATCH,
          str(by["r1"]))


def test_three_way() -> None:
    print("\ntest_three_way")
    base = [lore("왕국 파르마", "본문 A"), lore("기사단 규율", "본문 B"), lore("북부 신전", "본문 C")]

    # 1. untouched here, changed in RisuAI -> adopt. This is the reported bug.
    theirs = [lore("왕국 파르마", "RisuAI가 고침"), base[1], base[2]]
    ops = merge.plan(rows(base), theirs, LORE)
    by = {op.row.id: op for op in ops if op.row}
    check("untouched + RisuAI changed = adopt", by["r0"].action == merge.ADOPT, by["r0"].action)
    check("and the adopted value is RisuAI's", by["r0"].theirs["content"] == "RisuAI가 고침")

    # 2. edited here, unchanged in RisuAI -> keep (the settled contract).
    ours = [lore("왕국 파르마", "내가 고침"), base[1], base[2]]
    ops = merge.plan(rows(base, ours), list(base), LORE)
    by = {op.row.id: op for op in ops if op.row}
    check("edited + RisuAI unchanged = keep", by["r0"].action == merge.KEEP, by["r0"].action)

    # 3. both moved -> conflict, ours kept, theirs recorded.
    ops = merge.plan(rows(base, ours), theirs, LORE)
    by = {op.row.id: op for op in ops if op.row}
    check("both moved = conflict", by["r0"].action == merge.CONFLICT, by["r0"].action)
    check("the conflict carries all three values",
          by["r0"].conflict["kind"] == merge.BOTH_MOVED
          and by["r0"].conflict["theirs"]["content"] == "RisuAI가 고침"
          and by["r0"].conflict["base"]["content"] == "본문 A", str(by["r0"].conflict)[:200])

    # 4. a row marked dirty by something a text compare cannot see (a greeting
    #    queued for deletion, a lore entry whose origin says 'edited').
    ops = merge.plan(rows(base, dirty={0}), theirs, LORE)
    by = {op.row.id: op for op in ops if op.row}
    check("a dirty row is never treated as untouched", by["r0"].action == merge.CONFLICT)


def test_upstream_delete() -> None:
    print("\ntest_upstream_delete")
    base = [lore("왕국 파르마", "본문 A"), lore("기사단 규율", "본문 B")]
    theirs = [base[0]]

    ops = merge.plan(rows(base), theirs, LORE)
    gone = [op for op in ops if op.row and op.row.id == "r1"][0]
    check("a lorebook entry deleted upstream is a conflict, not a silent removal",
          gone.action == merge.CONFLICT and gone.conflict["kind"] == merge.DELETED_UPSTREAM,
          str(gone.action))

    # Turns are the exception: a message deleted in RisuAI really is gone, and
    # keeping our untouched copy would resurrect it on write-back.
    ops = merge.plan(rows(base), theirs, LORE, drop_missing=True)
    gone = [op for op in ops if op.row and op.row.id == "r1"][0]
    check("with drop_missing an untouched row is deleted", gone.action == merge.DELETE)

    ops = merge.plan(rows(base, dirty={1}), theirs, LORE, drop_missing=True)
    gone = [op for op in ops if op.row and op.row.id == "r1"][0]
    check("but an edited one still asks", gone.action == merge.CONFLICT)


def test_inserts_and_same_addition() -> None:
    print("\ntest_inserts_and_same_addition")
    base = [lore("왕국 파르마", "본문 A")]
    theirs = [base[0], lore("새 항목", "본문 Z")]
    ops = merge.plan(rows(base), theirs, LORE)
    ins = [op for op in ops if op.action == merge.INSERT]
    check("a new upstream entry becomes an insert", len(ins) == 1 and ins[0].seq == 1, str(ops))

    # The same entry added on both sides must not end up twice.
    added = [merge.Row(id="a1", ours=lore("새 항목", "본문 Z"), base=None)]
    hits = merge.adopted_additions(added, ins, LORE)
    check("the same addition on both sides is folded together", "a1" in hits, str(hits))
    other = [merge.Row(id="a2", ours=lore("전혀 다른 것", "본문 Y"), base=None)]
    check("a different addition is left alone", not merge.adopted_additions(other, ins, LORE))


def test_memory_keys() -> None:
    print("\ntest_memory_keys")
    spec = merge.MEMO
    base = [
        {"text": "요약 1", "chatMemos": ["m1", "m2"]},
        {"text": "요약 2", "chatMemos": ["m3", "m4"]},
    ]
    # hypa regenerates: a new summary lands at the head and the rest shift.
    theirs = [{"text": "새 요약 0", "chatMemos": ["m0"]}, base[0], {"text": "요약 2가 늘어남", "chatMemos": ["m3", "m4"]}]
    m = merge.match(base, theirs, spec)
    by = {p.base_at: p for p in m.pairs}
    check("a summary keeps its identity through a shift", by[0].theirs_at == 1, str(by.get(0)))
    check("and an extended summary pairs by the turns it covers",
          by[1].theirs_at == 2 and by[1].tier in (merge.TIER_KEYED, merge.TIER_POSITIONAL), str(by.get(1)))


def test_asset_keys() -> None:
    print("\ntest_asset_keys")
    spec = merge.ASSET
    base = [{"field": "additional", "name": "표정", "key": "assets/aaa.png"},
            {"field": "additional", "name": "배경", "key": "assets/bbb.png"}]
    theirs = [base[1], {"field": "additional", "name": "표정 (수정)", "key": "assets/aaa.png"}]
    m = merge.match(base, theirs, spec)
    by = {p.base_at: p for p in m.pairs}
    check("assets pair on their content hash", by[0].theirs_at == 1, str(by.get(0)))
    check("and never on position", all(p.tier != merge.TIER_POSITIONAL for p in m.pairs))


def test_counts_and_touched() -> None:
    print("\ntest_counts_and_touched")
    base = [lore("왕국 파르마", "본문 A")]
    ops = merge.plan(rows(base), list(base), LORE)
    check("a repeat open with nothing new touches nothing", not merge.touched(ops), str(merge.counts(ops)))
    ops = merge.plan(rows(base), [lore("왕국 파르마", "바뀜")], LORE)
    check("an adoption counts as touched", merge.touched(ops))
    ours = [lore("왕국 파르마", "내가 고침")]
    ops = merge.plan(rows(base, ours), [lore("왕국 파르마", "RisuAI가 고침")], LORE)
    check("a conflict alone does not (nothing was overwritten)", not merge.touched(ops),
          str(merge.counts(ops)))


def main() -> int:
    test_canon()
    test_match_tiers()
    test_positional_never_adopts()
    test_three_way()
    test_upstream_delete()
    test_inserts_and_same_addition()
    test_memory_keys()
    test_asset_keys()
    test_counts_and_touched()
    print()
    if FAILURES:
        print(f"FAIL - {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASS - matching pairs by identity, and only a certain pair is adopted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
