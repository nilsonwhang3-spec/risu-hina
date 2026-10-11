"""Bot snapshots shared by same-name bots, restore over today's baseline,
images kept for restore, and the "제안 작성 중" stream event (§1-103).

    pyserver/.venv/Scripts/python.exe tests/test_snapshot_share.py

The field case: 740 assets deleted on the AI's proposal and 반영. Restoring
the snapshot used to put the baseline back with the rows - 0 changes, 반영
sent nothing, and the next open deleted the restored rows again. And RisuAI
deletes asset files no character references on every boot, so the images
must be sent again from Hina's store.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))
DATA = tempfile.TemporaryDirectory(prefix="hina-snapshare-", ignore_cleanup_errors=True)
os.environ["RISUHINA_DATA_DIR"] = DATA.name
sys.stdout.reconfigure(encoding="utf-8")

from app import agent, assets, card, config, db, presence, session, snapshots, store, workspace  # noqa: E402
from pydantic_ai.messages import PartDeltaEvent, PartStartEvent, ToolCallPart, ToolCallPartDelta  # noqa: E402
from pydantic_ai.models.test import TestModel  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {name}{'' if cond else (' - ' + str(detail)[:400])}")
    if not cond:
        FAILURES.append(name)


def key(n: int) -> str:
    return f"assets/img{n:04d}.png"


def card_with(names: list[int], **extra) -> dict:
    return {"additionalAssets": [[f"a{n}", key(n), "png"] for n in names], **extra}


def bot(cha_id: str, name: str, idx: int, card_extra: dict) -> str:
    c = {"name": name, "chaId": cha_id, "desc": name + " 설명", **card_extra}
    return workspace.materialize({"charId": cha_id, "characterIndex": idx, "cardFull": True,
                                  "card": c, "chats": []})["charKey"]


def asset_rows(ck: str) -> list[dict]:
    return card.scripts(ck, card.ASSET_KIND)


def main() -> int:
    config.load()
    db.connect()
    for n in range(10):
        assets.store_bytes(key(n), f"bytes-{n}".encode())

    # --- restore after 반영 ------------------------------------------------
    print("restore after the deletion was 반영")
    ck = bot("cha-a", "파르마 기사단", 0, card_with(list(range(10))))
    check("ten asset rows", len(asset_rows(ck)) == 10)
    sid = snapshots.create_card(ck, "삭제 전")
    gone = [r["id"] for r in asset_rows(ck) if r["entry"]["name"] in ("a3", "a4", "a5")]
    for i in gone:
        card.delete_script(i)
    check("three deletions pending", card.changes(ck)["assetref"]["deleted"] == 3)
    # 반영: RisuAI now has 7, and the panel re-reads the card whole
    # (state.rereadCard -> upload cardReset -> ingest reset=True).
    card.ingest(ck, {"name": "파르마 기사단", "chaId": "cha-a", "desc": "파르마 기사단 설명",
                     **card_with([0, 1, 2, 6, 7, 8, 9])}, reset=True)
    check("after 반영 the working copy is clean with 7", card.changes(ck)["total"] == 0 and len(asset_rows(ck)) == 7,
          card.changes(ck))
    out = snapshots.restore_card(ck, sid)
    ch = card.changes(ck)
    check("restore shows the 3 assets as additions to 반영", ch["assetref"]["added"] == 3 and ch["total"] == 3, ch)
    check("and revives their images as pending keys", out["assetsRevived"] == 3 and out["assetsLost"] == 0, out)
    names = {r["entry"]["name"]: r["entry"]["key"] for r in asset_rows(ck)}
    check("the revived keys are pending, the kept ones untouched",
          names["a3"].startswith(assets.PENDING_PREFIX) and names["a0"] == key(0), names)
    blob = assets.read_bytes(names["a4"])
    check("a pending key reads the original bytes", blob is not None and blob[0] == b"bytes-4", blob)
    p = card.patch(ck)
    check("the patch writes 10 with the 7 as `before`",
          len(p["assets"]["additionalAssets"]) == 10 and len(p["assets"]["before"]["additionalAssets"]) == 7, p["assets"])
    order = [a[0] for a in p["assets"]["additionalAssets"]]
    check("in the snapshot's order", order == [f"a{n}" for n in range(10)], order)
    # The next open (RisuAI unchanged) must not throw the restore away.
    card.ingest(ck, {"name": "파르마 기사단", "chaId": "cha-a", "desc": "파르마 기사단 설명",
                     **card_with([0, 1, 2, 6, 7, 8, 9])}, reset=False)
    check("a re-open keeps the restored rows", len(asset_rows(ck)) == 10 and card.changes(ck)["assetref"]["added"] == 3)

    # The real flow: no snapshot taken by hand, delete, 반영 (commit, re-read),
    # then the automatic "반영 직전" must be the card BEFORE the deletion.
    from app import main as mainmod
    ck4 = bot("cha-d", "자동 백업 봇", 5, card_with([0, 1, 2, 3]))
    for r in asset_rows(ck4)[:2]:
        card.delete_script(r["id"])
    mainmod.h_card_commit({"charKey": ck4})
    card.ingest(ck4, {"name": "자동 백업 봇", "chaId": "cha-d", "desc": "자동 백업 봇 설명", **card_with([2, 3])}, reset=True)
    auto = next(r for r in snapshots.listing_card(ck4) if r["label"] == "반영 직전")
    snapshots.restore_card(ck4, auto["id"])
    check("'반영 직전' undoes the 반영 that deleted two assets",
          [r["entry"]["name"] for r in asset_rows(ck4)] == ["a0", "a1", "a2", "a3"]
          and card.changes(ck4)["assetref"]["added"] == 2, card.changes(ck4))

    # A deletion not yet 반영 is undone to "no change".
    ck2 = bot("cha-b", "단독 봇", 1, card_with([0, 1, 2]))
    s2 = snapshots.create_card(ck2, "전")
    card.delete_script(asset_rows(ck2)[1]["id"])
    card.update_field(next(f["id"] for f in card.listing(ck2)["fields"] if f["field"] == "desc"), "고친 설명")
    snapshots.restore_card(ck2, s2)
    check("restore before 반영 = nothing to write", card.changes(ck2)["total"] == 0, card.changes(ck2))
    check("no pending keys when RisuAI still has them",
          not any(r["entry"]["key"].startswith(assets.PENDING_PREFIX) for r in asset_rows(ck2)))

    # Lore and greetings follow the same rule.
    ck3 = bot("cha-c", "로어 봇", 2, {"alternateGreetings": ["g1", "g2"],
                                     "globalLore": [{"key": "k1", "comment": "c1", "content": "x"}]})
    store_rows = store.lore_rows_global(ck3)
    s3 = snapshots.create_card(ck3, "전")
    card.ingest(ck3, {"name": "로어 봇", "chaId": "cha-c", "desc": "로어 봇 설명", "alternateGreetings": ["g1"]},
                reset=True)
    if store_rows:
        store.reset_lore_global(ck3)
    snapshots.restore_card(ck3, s3)
    ch3 = card.changes(ck3)
    check("a greeting removed in RisuAI comes back as an addition", ch3["greetings"]["added"] == 1, ch3)

    # --- folder mates share snapshots --------------------------------------
    print("same-name bots share snapshots")
    v2 = bot("cha-v2", "Over The Next v0.2", 3, card_with([0, 1, 2, 3]))
    v3 = bot("cha-v3", "Over The Next v0.3", 4, card_with([0, 1]))
    check("both versions share one folder", workspace.bot_folder(v2) == workspace.bot_folder(v3),
          (workspace.bot_folder(v2), workspace.bot_folder(v3)))
    check("and are folder mates", set(snapshots.mates(v3)) >= {v2, v3}, snapshots.mates(v3))
    sv2 = snapshots.create_card(v2, "0.2 완성본")
    listed = {r["id"]: r for r in snapshots.listing_card(v3)}
    check("v0.3 lists v0.2's snapshot, marked", sv2 in listed and listed[sv2].get("from") == "Over The Next v0.2",
          listed.get(sv2))
    check("a bot of another name does not", sv2 not in {r["id"] for r in snapshots.listing_card(ck2)})
    out = snapshots.restore_card(v3, sv2)
    check("v0.3 restores v0.2's snapshot", out.get("from") == "Over The Next v0.2"
          and [r["entry"]["name"] for r in asset_rows(v3)] == ["a0", "a1", "a2", "a3"], out)
    check("over v0.3's own baseline: two additions", card.changes(v3)["assetref"]["added"] == 2, card.changes(v3))
    check("v0.2's working copy is untouched", len(asset_rows(v2)) == 4 and card.changes(v2)["total"] == 0)
    check("the 'restore 직전' backup is v0.3's own",
          db.one("SELECT char_key FROM card_checkpoints WHERE label = 'restore 직전' ORDER BY created_at DESC")["char_key"] == v3)
    snapshots.rename_card(v3, sv2, "0.2 최종")
    check("a mate's snapshot can be renamed from here",
          db.one("SELECT label FROM card_checkpoints WHERE id = ?", (sv2,))["label"] == "0.2 최종")
    try:
        snapshots.restore_card(ck2, sv2)
        refused = False
    except LookupError:
        refused = True
    check("another name's bot cannot restore it", refused)

    # Forgetting the old version hands its snapshots to the live one.
    presence.record([{"chaId": "cha-v3"}, {"chaId": "cha-a"}, {"chaId": "cha-b"}, {"chaId": "cha-c"}])
    row = next(b for b in presence.listing() if b["charKey"] == v2)
    check("the cleanup list says where the snapshots go", row["snapshots"] == 1 and row["snapshotHeir"] == "Over The Next v0.3", row)
    out = presence.forget(v2)
    check("forget hands the snapshot over", out["snapshotsHanded"] == 1
          and db.one("SELECT char_key, source_name FROM card_checkpoints WHERE id = ?", (sv2,))["char_key"] == v3, out)
    listed = {r["id"]: r for r in snapshots.listing_card(v3)}
    check("and it still says where it came from", listed[sv2].get("from") == "Over The Next v0.2", listed.get(sv2))

    # --- the image store keeps what snapshots need ---------------------------
    print("image store")
    assets.store_bytes("assets/only-in-snapshot.png", b"snap-only")
    assets.store_bytes("assets/nobody.png", b"nobody")
    db.execute("UPDATE asset_blobs SET created_at = 0")
    snap_only = snapshots.create_card(ck2, "스냅샷 전용")
    raw = db.one("SELECT scripts_json FROM card_checkpoints WHERE id = ?", (snap_only,))["scripts_json"]
    rows = json.loads(raw)
    rows.append({"id": "x1", "kind": "assetref", "seq": 99, "origin": "original",
                 "entry_json": json.dumps({"field": "additional", "name": "s", "key": "assets/only-in-snapshot.png"})})
    db.execute("UPDATE card_checkpoints SET scripts_json = ? WHERE id = ?", (json.dumps(rows), snap_only))
    u = assets.usage()
    check("usage splits live / snapshot / orphan", u["snapshot"]["blobs"] == 1 and u["orphan"]["blobs"] >= 1
          and u["orphan"]["collectable"] >= 1, u)
    r = assets.gc(days=0)
    check("gc keeps the snapshot's image", assets.read_bytes("assets/only-in-snapshot.png") is not None, r)
    check("and removes the unreferenced one", assets.read_bytes("assets/nobody.png") is None, r)
    check("and keeps the revived pending bytes", assets.read_bytes(names["a4"]) is not None)
    snapshots.delete_card(ck2, snap_only)
    assets.gc(days=0)
    check("deleting the snapshot frees its image", assets.read_bytes("assets/only-in-snapshot.png") is None)

    # --- agent: the rule-based delete --------------------------------------
    print("agent tools")
    with patch.object(agent, "_model", return_value=TestModel()):
        ag = agent.build()
    tools = ag._function_toolset.tools
    ctx = SimpleNamespace(deps=agent.Deps(f"{ck}:c", ck, "", Path(DATA.name), mode="bot", bot_key=ck))
    pv = json.loads(tools["propose_assets_delete"].function(ctx, reason="t", name_filter=r"^a[0-4]$"))
    check("preview counts by rule", pv["delete"] == 5 and pv["of"] == 10, pv)
    pv = json.loads(tools["propose_assets_delete"].function(ctx, reason="t", names="a0,a1", invert=True))
    check("invert keeps the named ones", pv["delete"] == 8, pv)
    res = tools["propose_assets_delete"].function(ctx, reason="t", name_filter=r"^a[0-4]$", preview=False)
    pa = db.one("SELECT kind, args_json FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC")
    check("one script_delete_many proposal with the 5 ids",
          pa is not None and pa["kind"] == "script_delete_many" and len(json.loads(pa["args_json"])["ids"]) == 5, res)
    lst = tools["list_bot_snapshots"].function(SimpleNamespace(deps=agent.Deps(f"{v3}:c", v3, "", Path(DATA.name),
                                                                              mode="bot", bot_key=v3)))
    check("list_bot_snapshots names a mate's snapshot", "Over The Next v0.2" in lst, lst)

    # --- the stream: a tool call still being written -------------------------
    print("stream")
    acc: list[str] = []
    drafts: dict = {}
    lines = session._translate(PartStartEvent(index=1, part=ToolCallPart(tool_name="propose_scripts_delete", args="")),
                               acc, drafts)
    check("the call's start names the tool", any('"tool"' in x and "propose_scripts_delete" in x for x in lines), lines)
    drafts[1]["at"] = 0.0
    lines = session._translate(PartDeltaEvent(index=1, delta=ToolCallPartDelta(args_delta="x" * 1200)), acc, drafts)
    check("a delta reports the size written so far",
          any('"toolDraft"' in x and '"chars": 1200' in x for x in lines), lines)
    lines = session._translate(PartDeltaEvent(index=1, delta=ToolCallPartDelta(args_delta="y" * 10)), acc, drafts)
    check("but at most once a second", not lines, lines)
    check("no stray text", acc == [])

    print()
    print("ALL OK" if not FAILURES else f"{len(FAILURES)} FAILED: {FAILURES}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
