"""The edit-session lifecycle: restore, discard, and what an upload may not do.

Three families of fact, all from real use (2026-08-29):

  * a restore is an **edit**, not a re-read. Routing it through
    `ingest_chat(force=True)` rewrote the baseline too, so 반영 found nothing
    to write and the next re-open adopted RisuAI's version - the restore
    silently undone twice over.
  * an **empty upload never wipes a chat**. PocketRisu hands back a chat it
    has not opened as `message: []`, which passes every "is this a chat"
    check; a 9-turn chat became 0 turns with 반영 ready to make it real.
  * **discarding discards everything**. `POST /reset` used to reset the turns
    alone, leaving lorebook and memory edits silently pending behind a chat
    the user had just declared clean - and conflict marks survived to keep
    반영 blocked over rows that no longer differed.

    python tests/test_lifecycle.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))

os.environ["RISUHINA_DATA_DIR"] = tempfile.mkdtemp(prefix="risuhina-lifecycle-")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app import config, db, snapshots, store, workspace  # noqa: E402
from app import memory as mem  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


config.load()
db.connect()

CHA = "cha-restore"
# What RisuAI holds, and keeps holding: the write-back never stuck.
HOST_CHAT = {"id": "chat-1", "name": "c", "message": [
    {"role": "user", "data": "원본1", "chatId": "m1"},
    {"role": "char", "data": "원본2", "chatId": "m2"},
]}

ck = store.upsert_character(CHA, "Restore", {"name": "Restore"}, 0)
workspace.root(ck).mkdir(parents=True, exist_ok=True)
TK = store.ingest_chat(CHA, HOST_CHAT, 0)["chatKey"]


def pending() -> int:
    p = store.patch(TK)
    return len(p["edits"]) + len(p["added"]) + len(p["removed"])


def bodies() -> list[str]:
    return [t["body"] for t in store.turns(TK)["turns"]]


print("\ntest_restore_leaves_a_pending_change")
for msg_id, body in (("m1", "고친1"), ("m2", "고친2")):
    store.set_body(TK, msg_id, body)
check("editing shows as pending", pending() == 2, str(pending()))

cid = snapshots.create(TK, "반영 직전")
# The write-back reported success but RisuAI kept its own copy; the re-read
# that follows a commit then resets the working copy to it. This is the
# "원래대로 돌아갔다" step, and it is what makes the snapshot the only way back.
store.ingest_chat(CHA, HOST_CHAT, 0, force=True)
check("the failed write-back left nothing pending", pending() == 0, str(pending()))
check("and the edit is gone from the working copy", bodies() == ["원본1", "원본2"], str(bodies()))

snapshots.restore(TK, cid)
check("restoring brings the text back", bodies() == ["고친1", "고친2"], str(bodies()))
# The bug: this was 0, so 반영 reported "0건" and could not write the restore.
check("and leaves it pending, so 반영 has something to write",
      pending() == 2, str(pending()))

print("\ntest_a_restore_survives_the_next_open")
# RisuAI still holds the original. An untouched row would be adopted away;
# a restored one must be kept.
summary = store.ingest_chat(CHA, HOST_CHAT, 0)
merged = summary.get("merge") or {}
check("the merge keeps the restored rows rather than adopting",
      not merged.get("adopt"), str(merged))
check("the restore survived the re-open", bodies() == ["고친1", "고친2"], str(bodies()))
check("and is still pending", pending() == 2, str(pending()))

print("\ntest_the_baseline_is_still_risuai's")
# The point of leaving the baseline alone: it has to keep describing RisuAI,
# or the next merge has no common ancestor to reason from.
base = [r["body"] for r in db.query(
    "SELECT body FROM turns_original WHERE chat_key = ? ORDER BY seq", (TK,))]
check("the baseline still holds what RisuAI has", base == ["원본1", "원본2"], str(base))

print("\ntest_restore_is_itself_undoable")
before = bodies()
cid2 = snapshots.create(TK, "두 번째")
store.set_body(TK, "m1", "또 고침")
snapshots.restore(TK, cid2)
check("restoring again returns to that point", bodies() == before, str(bodies()))
labels = [c["label"] for c in snapshots.listing(TK)]
check("and the state before each restore was snapshotted",
      labels.count("restore 직전") >= 1, str(labels))

# Five restores used to leave five identical rows; only ever one is useful:
# the one before the restore you just regretted.
cid3 = snapshots.create(TK, "되돌릴 지점")
for _ in range(3):
    snapshots.restore(TK, cid3)
after = [c["label"] for c in snapshots.listing(TK) if c["label"] == "restore 직전"]
check("repeated restores keep only one 'restore 직전'", len(after) == 1, str(len(after)))

print("\ntest_an_empty_upload_never_wipes_a_chat")
# Measured on a live install, 2026-08-29: PocketRisu hands back a chat it has
# not opened as `message: []`. That passes every "is this a chat" check, so a
# 9-turn chat was ingested as 0 turns - it showed as 0턴 in the panel and left
# 반영 ready to delete nine real turns in RisuAI.
STUB_CHA = "cha-stub"
FULL = {"id": "chat-s", "name": "복사본", "message": [
    {"role": "user", "data": "살아있어야 함 1", "chatId": "s1"},
    {"role": "char", "data": "살아있어야 함 2", "chatId": "s2"},
]}
sk = store.upsert_character(STUB_CHA, "Stub", {"name": "Stub"}, 0)
workspace.root(sk).mkdir(parents=True, exist_ok=True)
STK = store.ingest_chat(STUB_CHA, FULL, 0)["chatKey"]
check("the chat starts with its turns", len(store.turns(STK)["turns"]) == 2)

stub = store.ingest_chat(STUB_CHA, {**FULL, "message": []}, 0)
check("an empty upload is refused, not applied", bool(stub.get("skipped")), str(stub))
check("and the turns are still there",
      [t["body"] for t in store.turns(STK)["turns"]] == ["살아있어야 함 1", "살아있어야 함 2"],
      str([t["body"] for t in store.turns(STK)["turns"]]))
sbase = db.query("SELECT body FROM turns_original WHERE chat_key = ? ORDER BY seq", (STK,))
check("the baseline survived too", len(sbase) == 2, str(len(sbase)))
# The refusal must name what to do, because the fix is on RisuAI's side.
check("the refusal says how to fix it", "🔄" in (stub.get("skipped") or ""), stub.get("skipped"))

# A chat that is genuinely new and genuinely empty is still allowed in.
fresh = store.ingest_chat(STUB_CHA, {"id": "chat-new", "name": "빈 챗", "message": []}, 1)
check("a genuinely empty new chat is still accepted", not fresh.get("skipped"), str(fresh))

# 🔄 (force) is the stated way out when RisuAI really is empty now.
forced = store.ingest_chat(STUB_CHA, {**FULL, "message": []}, 0, force=True)
check("force still empties the chat - that is what 🔄 means",
      not forced.get("skipped") and forced.get("workingReset") is True
      and len(store.turns(STK)["turns"]) == 0, str(forced))

print("\ntest_reset_discards_all_three_materials")
CHA2 = "cha-reset"
CH2 = {"id": "chat-r", "name": "r", "message": [
    {"role": "user", "data": "베이스1", "chatId": "r1"},
    {"role": "char", "data": "베이스2", "chatId": "r2"},
]}
rk = store.upsert_character(CHA2, "Reset", {"name": "Reset"}, 0)
workspace.root(rk).mkdir(parents=True, exist_ok=True)
RTK = store.ingest_chat(CHA2, CH2, 0)["chatKey"]

# One lore entry the baseline knows (as a checkpoint would put it back), edited;
# one added here; a conflict mark, as a merge would leave it.
E1 = {"comment": "베이스 로어", "content": "원문"}
store.restore_lore_rows(rk, RTK, [{
    "id": "L1", "seq": 0, "entry_json": db.js(E1), "original_json": db.js(E1),
    "origin": "original", "created_at": db.now(),
}])
store.update_lore("L1", {"comment": "베이스 로어", "content": "고침"})
L2 = store.add_lore(rk, {"comment": "새 로어", "content": "추가"}, scope="local", tk=RTK)
db.execute("UPDATE lore_entries SET conflict_json = ? WHERE id = 'L1'", (db.js({"theirs": None}),))

# One memory row added here; one with a baseline, edited away from it.
m_added = mem.add(rk, RTK, "supaMemoryData", "새 요약")
m_base = mem.add(rk, RTK, "lastMemory", "기억 원문")
db.execute("UPDATE memories SET original = body WHERE id = ?", (m_base["id"],))
mem.update(m_base["id"], "기억 고침")

store.set_body(RTK, "r1", "고친 베이스1")
check("everything reads as pending before the reset",
      store.lore_changes(rk, RTK)["total"] == 2 and mem.changes(RTK)["total"] >= 2,
      f"lore={store.lore_changes(rk, RTK)} mem={mem.changes(RTK)}")

# The h_reset trio. Turns alone was the old behaviour, and the bug.
store.reset_working(RTK)
store.reset_lore_local(rk, RTK)
mem.reset_working(RTK)

check("turns are back at the baseline",
      [t["body"] for t in store.turns(RTK)["turns"]] == ["베이스1", "베이스2"],
      str([t["body"] for t in store.turns(RTK)["turns"]]))
l1 = db.one("SELECT * FROM lore_entries WHERE id = 'L1'")
check("the edited lore entry returned to its original",
      l1 is not None and l1["entry_json"] == db.js(E1) and l1["origin"] == "original",
      str(dict(l1) if l1 else None))
check("its conflict mark is gone - discarding is taking theirs",
      l1 is not None and l1["conflict_json"] is None)
check("the added lore entry is gone",
      db.one("SELECT id FROM lore_entries WHERE id = ?", (L2,)) is None)
check("the added memory is gone",
      mem.get(m_added["id"]) is None)
mb = mem.get(m_base["id"])
check("the edited memory returned to its original",
      mb is not None and mb["body"] == "기억 원문", str(mb))
check("nothing is pending after the reset",
      store.lore_changes(rk, RTK)["total"] == 0 and mem.changes(RTK)["total"] == 0
      and not store.patch(RTK)["edits"],
      f"lore={store.lore_changes(rk, RTK)} mem={mem.changes(RTK)}")

print("\ntest_snapshot_kinds_prune_and_dedup")
# 'user' = the version list (saves the user asked for by name); 'auto' = the
# code protecting itself before something destructive - internal backups.
listed = snapshots.listing(TK)
check("restore's own snapshot is kind='auto'",
      any(c["kind"] == "auto" and c["label"] == "restore 직전" for c in listed),
      str([(c["label"], c["kind"]) for c in listed]))
check("a snapshot the user saved is kind='user'",
      all(c["kind"] == "user" for c in listed if c["label"] in ("두 번째", "되돌릴 지점")),
      str([(c["label"], c["kind"]) for c in listed]))

# A user snapshot may share an auto label; the restore dedup folds only autos.
snapshots.create(TK, "restore 직전")  # deliberately the auto label, saved by hand
snapshots.restore(TK, cid3)
pairs = [(c["label"], c["kind"]) for c in snapshots.listing(TK)]
check("the dedup folds only the auto 'restore 직전'",
      pairs.count(("restore 직전", "user")) == 1 and pairs.count(("restore 직전", "auto")) == 1,
      str(pairs))

# Autos self-prune as they are taken (keep defaults to 5), so no caller can
# forget; explicit pruning can tighten, but never to zero - RisuAI has no
# undo of its own for a plugin write.
for i in range(9):
    snapshots.create(TK, f"자동{i}", kind="auto")
autos = [c for c in snapshots.listing(TK) if c["kind"] == "auto"]
check("auto snapshots self-prune as they are taken", len(autos) == 5, str(len(autos)))
n = snapshots.prune_auto(TK, keep=2)
left = snapshots.listing(TK)
check("explicit pruning tightens further",
      n == 3 and len([c for c in left if c["kind"] == "auto"]) == 2, f"n={n}")
check("every user snapshot survived the pruning",
      {"두 번째", "되돌릴 지점", "반영 직전", "restore 직전"}
      <= {c["label"] for c in left if c["kind"] == "user"},
      str([(c["label"], c["kind"]) for c in left]))
snapshots.prune_auto(TK, keep=0)
check("pruning cannot go to zero",
      len([c for c in snapshots.listing(TK) if c["kind"] == "auto"]) == 1)

# Bot snapshots: the same two kinds, the same pruning.
snapshots.create_card(rk, "봇 저장")
for i in range(3):
    snapshots.create_card(rk, f"봇자동{i}", kind="auto")
snapshots.prune_auto_card(rk, keep=1)
cleft = snapshots.listing_card(rk)
check("card pruning keeps the user save and the newest auto",
      [c["label"] for c in cleft if c["kind"] == "user"] == ["봇 저장"]
      and len([c for c in cleft if c["kind"] == "auto"]) == 1,
      str([(c["label"], c["kind"]) for c in cleft]))

print("\ntest_schema_13_backfills_old_auto_labels")
# A database from before schema 13 has every snapshot at the column default
# ('user'); the one-time backfill files the code-written labels as backups.
old = snapshots.create(TK, "반영 직전")  # lands as 'user', as a pre-13 row would read
db.execute("UPDATE meta SET value = '12' WHERE key = 'schema_version'")
db._backfill_snapshot_kinds(db._conn)
db.execute("UPDATE meta SET value = '13' WHERE key = 'schema_version'")
row = db.one("SELECT kind FROM checkpoints WHERE id = ?", (old,))
check("a pre-13 auto-labelled row is filed as a backup",
      row is not None and row["kind"] == "auto", str(dict(row) if row else None))

print("\ntest_one_dirty_thing_at_a_time")
# The global single-edit rule: the bot-wide summary the leave guard reads,
# and the refusal that keeps an approval from opening a second dirty front.
from app import actions  # noqa: E402

s = workspace.dirty_summary(rk)
check("everything reads clean after the reset",
      not s["card"]["dirty"] and all(not c["dirty"] for c in s["chats"]), str(s))

store.set_body(RTK, "r1", "다시 고침")  # the chat goes dirty
s = workspace.dirty_summary(rk)
check("the summary sees the dirty chat",
      any(c["dirty"] and c["chatKey"] == RTK for c in s["chats"]), str(s))
check("editing the dirty chat itself is allowed",
      workspace.cross_scope_blocker(rk, "chat", RTK) == "")
check("writing the card is refused while the chat is dirty",
      "미반영" in workspace.cross_scope_blocker(rk, "card"),
      workspace.cross_scope_blocker(rk, "card"))
RT2 = store.ingest_chat(CHA2, {"id": "chat-r2", "name": "r2", "message": [
    {"role": "user", "data": "x", "chatId": "q1"}]}, 1)["chatKey"]
check("a second chat is refused while the first is dirty",
      "미반영" in workspace.cross_scope_blocker(rk, "chat", RT2),
      workspace.cross_scope_blocker(rk, "chat", RT2))

# An agent action is refused at the same door, and stays pending - the user
# resolves the other edit and approves again, nothing is lost.
aid = actions.propose("card_edit", chat_key=RTK, char_key=rk, summary="t",
                      args={"id": "nope", "body": "x"})["id"]
try:
    actions.decide(aid, True)
    check("approving a card action while the chat is dirty is refused", False)
except actions.ActionError as e:
    check("approving a card action while the chat is dirty is refused",
          "미반영" in str(e), str(e))
act = actions.get(aid)
check("the refused action is still pending, not failed",
      act is not None and act["status"] == "pending", str(act and act["status"]))

store.reset_working(RTK)
left_over = workspace.cross_scope_blocker(rk, "card")
check("and allowed again once the chat is clean", left_over == "", left_over)

print()
if FAILURES:
    print(f"FAIL - {len(FAILURES)} check(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("PASS - restore is an edit, an empty upload is a stub, reset discards everything")
