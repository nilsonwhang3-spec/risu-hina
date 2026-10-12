"""설정 → 저장공간 정리 (§1-106): every snapshot in one list, and the
workspace's temporary files by kind.

The bots / chats / modules RisuAI no longer has are presence.py's; the image
store is assets.py's. This module holds the other two sections:

Snapshots. Three tables keep them - card_checkpoints (bots and modules),
checkpoints (chats), persona_checkpoints - and each was only reachable from
its owner's 버전 popover, so the automatic backups piled up unseen (the test
install: 42 automatic bot snapshots, 68 MB of the DB) and the snapshots of an
owner that is gone could not be reached at all. `snapshot_listing` lists them
together with their owner, whether the user or the code took them, and their
size; `snapshot_delete` takes any mix of them.

Temporary files. The files tab's single 임시파일 정리 found only hina/'s
scratch and caches. Measured on the test install the space also held the old
quarantine (hina/.cleanup, 585 MB), the thumbnail cache (250 MB), assets an
old fetch_assets left in the SYSTEM folders (data/workspace/<key>/scratch,
90 MB) and the tool-result spool of finished conversations. `temp_scan`
sorts them into kinds, each split by bot where that means something, and
`temp_clean` deletes exactly the files of the scan the user looked at -
a file changed since is skipped, not deleted.
Nothing here touches projects/, studio output, skills or RisuAI.
"""
from __future__ import annotations

import hashlib
import os
import time
import uuid
from pathlib import Path

from . import config, db, log, workspace


class StorageError(Exception):
    pass


# --- snapshots ---------------------------------------------------------------

def _size(*parts) -> int:
    return sum(len(p or "") for p in parts)


def snapshot_listing() -> list[dict]:
    """Every snapshot: {type, id, owner, ownerKey, sub, label, auto,
    createdAt, bytes, orphan, ownerState}. type = bot | module | chat |
    persona; `orphan` = its owner is no longer in Hina (or, for a persona,
    no longer in RisuAI)."""
    from . import modules as modmod
    out: list[dict] = []
    chars = {r["char_key"]: dict(r) for r in db.query(
        "SELECT char_key, name, risu_state FROM characters")}
    for r in db.query("SELECT id, char_key, label, kind, source_name, created_at, "
                      "LENGTH(fields_json) + LENGTH(scripts_json) + LENGTH(lore_json) AS n "
                      "FROM card_checkpoints"):
        ck = r["char_key"]
        owner = chars.get(ck)
        is_mod = modmod.is_module_key(ck)
        st = (owner or {}).get("risu_state") or ""
        if is_mod and owner:
            st = modmod.meta(ck).get("risuState") or ""
        out.append({
            "type": "module" if is_mod else "bot", "id": r["id"], "ownerKey": ck,
            "owner": (owner or {}).get("name") or r["source_name"] or ck,
            "sub": f"{r['source_name']}에서" if r["source_name"] else "",
            "label": r["label"] or "", "auto": (r["kind"] or "user") != "user",
            "createdAt": r["created_at"], "bytes": r["n"] or 0,
            "orphan": owner is None, "ownerState": st,
        })
    chats = {r["chat_key"]: dict(r) for r in db.query(
        "SELECT c.chat_key, c.name, c.char_key, c.risu_state, ch.name AS bot, ch.risu_state AS bot_state "
        "FROM chats c LEFT JOIN characters ch ON ch.char_key = c.char_key")}
    for r in db.query("SELECT id, chat_key, label, kind, created_at, message_count, "
                      "LENGTH(markdown) + LENGTH(meta_json) + COALESCE(LENGTH(lore_json), 0) "
                      "+ COALESCE(LENGTH(memory_json), 0) AS n FROM checkpoints"):
        c = chats.get(r["chat_key"])
        st = ""
        if c:
            st = "missing" if c["risu_state"] == "missing" else (c["bot_state"] or "")
        out.append({
            "type": "chat", "id": r["id"], "ownerKey": r["chat_key"],
            "owner": (c or {}).get("bot") or "(지워진 봇)",
            "sub": ((c or {}).get("name") or "(이름 없는 챗)") + f" · {r['message_count']}턴",
            "label": r["label"] or "", "auto": (r["kind"] or "user") != "user",
            "createdAt": r["created_at"], "bytes": r["n"] or 0,
            "orphan": c is None, "ownerState": st,
        })
    personas = {}
    for r in db.query("SELECT pkey, work_json, base_json, gone FROM personas"):
        name = (db.unjs(r["work_json"], {}) or {}).get("name") or (db.unjs(r["base_json"], {}) or {}).get("name") or ""
        personas[r["pkey"]] = {"name": name, "gone": bool(r["gone"])}
    for r in db.query("SELECT id, pkey, label, kind, created_at, LENGTH(data_json) AS n FROM persona_checkpoints"):
        p = personas.get(r["pkey"])
        out.append({
            "type": "persona", "id": r["id"], "ownerKey": r["pkey"],
            "owner": (p or {}).get("name") or "(지워진 페르소나)", "sub": "",
            "label": r["label"] or "", "auto": (r["kind"] or "manual") != "manual",
            "createdAt": r["created_at"], "bytes": r["n"] or 0,
            "orphan": p is None or p["gone"], "ownerState": "missing" if (p or {}).get("gone") else "",
        })
    out.sort(key=lambda x: -(x["createdAt"] or 0))
    return out


_SNAP_TABLE = {"bot": "card_checkpoints", "module": "card_checkpoints",
               "chat": "checkpoints", "persona": "persona_checkpoints"}


def snapshot_delete(items: list[dict]) -> dict:
    """Delete snapshots by {type, id}. Unknown ids are reported, not fatal."""
    removed, missing = 0, []
    with db.transaction():
        for it in items or []:
            table = _SNAP_TABLE.get(str((it or {}).get("type") or ""))
            sid = str((it or {}).get("id") or "")
            if not table or not sid:
                missing.append(sid or "?")
                continue
            n = db.execute(f"DELETE FROM {table} WHERE id = ?", (sid,)).rowcount or 0
            if n:
                removed += n
            else:
                missing.append(sid)
    log.info("storage: deleted %s snapshots (%s not found)", removed, len(missing))
    return {"removed": removed, "missing": missing}


# --- temporary files ---------------------------------------------------------

# (id, label, what it is). The order is the panel's.
TEMP_KINDS = (
    ("cleanup", "옛 정리 보관함", "예전 '임시파일 정리'가 지우지 않고 옮겨 두던 hina/.cleanup/ 입니다. 더는 쓰지 않습니다."),
    ("scratch", "AI 작업 임시 파일", "AI가 작업하며 만든 hina/<봇>/scratch/ 의 파일입니다. 결과물(projects/<봇>/out)은 여기 없습니다."),
    ("scripts", "AI 실행 스크립트", "run_python 이 남긴 hina/<봇>/scripts/ 의 스크립트입니다 (도우미 risuhina.py 는 제외, 실행마다 다시 씀)."),
    ("spacescratch", "공간 scratch/ 폴더", "작업 공간 맨 위 scratch/ 에 쌓인 파일입니다 (주로 MCP·외부 AI가 쓴 중간 결과)."),
    ("caches", "캐시·조각 파일", "__pycache__·.cache 폴더, .tmp/.temp 파일, 하루 넘게 멈춘 업로드 조각(.part)입니다."),
    ("sources", "RisuAI 소스 사본", "소스 대조 스킬이 받아 둔 hina/.sources/ 입니다. 필요하면 다시 받습니다."),
    ("thumbs", "썸네일 캐시", "스튜디오·파일 탭의 미리보기 이미지입니다. 지우면 볼 때 다시 만듭니다."),
    ("system", "시스템 작업 폴더", "봇마다의 시스템 폴더(data/workspace)에 있는 scratch/ 와 .scratch/ 입니다. "
               "옛 버전이 받아 둔 에셋 사본과 run_python 용 DB 사본으로, 다음 실행 때 다시 만듭니다."),
    ("toolresults", "지난 도구 결과", "AI 도구의 긴 결과를 대화 중에 다시 읽으려고 남긴 data/tool-results/ 입니다. 끝난 대화의 것만 셉니다."),
)
_KIND_IDS = {k for k, _, _ in TEMP_KINDS}
_CACHE_DIRS = {"__pycache__", ".cache", ".pytest_cache"}
_PART_AGE = 86400

# The last scan per plan id: exactly what the user was shown. A clean deletes
# these entries (if unchanged), never a fresh walk.
_SCANS: dict[str, dict] = {}
_SCANS_KEEP = 4


def _files(d: Path):
    if not d.is_dir():
        return
    for folder, dirs, names in os.walk(d, followlinks=False):
        here = Path(folder)
        dirs[:] = [x for x in dirs if not (here / x).is_symlink()]
        for n in names:
            f = here / n
            if f.is_symlink():
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            yield f, st


def _active_session_dirs() -> set[str]:
    from . import session
    return {hashlib.sha256(sid.encode()).hexdigest()
            for sid, ev in list(session._ACTIVE.items()) if not ev.is_set()}


def _ai_running() -> bool:
    from . import session
    return any(not ev.is_set() for ev in list(session._ACTIVE.values()))


def _system_names() -> dict[str, str]:
    """data/workspace/<dir> → a bot (or module) name to show."""
    names: dict[str, str] = {}
    for r in db.query("SELECT char_key, family_key, name FROM characters ORDER BY updated_at"):
        names[(r["family_key"] or r["char_key"])] = r["name"] or r["char_key"]
    return names


def _collect() -> dict[str, list[tuple[str, str, int, int]]]:
    """kind → [(group, path, size, mtime_ns)]; paths absolute."""
    space = workspace.space_root()
    hina = space / "hina"
    now = time.time()
    out: dict[str, list] = {k: [] for k in _KIND_IDS}

    def add(kind: str, group: str, f: Path, st) -> None:
        out[kind].append((group, str(f), st.st_size, st.st_mtime_ns))

    if hina.is_dir():
        for top in sorted(hina.iterdir()):
            if not top.is_dir() or top.is_symlink():
                continue
            if top.name == ".cleanup":
                for f, st in _files(top):
                    add("cleanup", "", f, st)
                continue
            if top.name == ".sources":
                for f, st in _files(top):
                    add("sources", "", f, st)
                continue
            if top.name.startswith("."):
                continue
            for f, st in _files(top):
                rel = f.relative_to(top).parts
                if any(p in _CACHE_DIRS for p in rel[:-1]):
                    add("caches", top.name, f, st)
                elif rel[0] == "scratch" and len(rel) > 1:
                    add("scratch", top.name, f, st)
                elif rel[0] == "scripts" and len(rel) > 1 and rel[-1] != "risuhina.py":
                    add("scripts", top.name, f, st)
                elif f.suffix in (".tmp", ".temp"):
                    add("caches", top.name, f, st)
    for f, st in _files(space / "scratch"):
        parts = f.relative_to(space / "scratch").parts
        add("spacescratch", parts[0] if len(parts) > 1 else "", f, st)
    # Upload fragments and stray temp files anywhere else in the space.
    for area in ("projects", "studio"):
        for f, st in _files(space / area):
            if f.suffix == ".part" and now - st.st_mtime > _PART_AGE:
                add("caches", area, f, st)
            elif f.suffix in (".tmp", ".temp") and now - st.st_mtime > 3600:
                add("caches", area, f, st)
    for f, st in _files(space / "studio" / "config" / ".studio" / "thumbs"):
        add("thumbs", "", f, st)
    names = _system_names()
    wsdir = config.WORKSPACE_DIR
    if wsdir.is_dir():
        for d in sorted(wsdir.iterdir()):
            if not d.is_dir():
                continue
            label = names.get(d.name, d.name)
            for sub in ("scratch", ".scratch"):
                for f, st in _files(d / sub):
                    add("system", label, f, st)
    active = _active_session_dirs()
    tr = config.DATA_DIR / "tool-results"
    if tr.is_dir():
        for d in tr.iterdir():
            if d.is_dir() and d.name not in active:
                for f, st in _files(d):
                    add("toolresults", "", f, st)
    return out


def temp_scan() -> dict:
    """The temporary files by kind, with a plan id `temp_clean` acts on."""
    entries = _collect()
    plan = uuid.uuid4().hex
    _SCANS[plan] = {"at": time.time(), "entries": entries}
    while len(_SCANS) > _SCANS_KEEP:
        _SCANS.pop(min(_SCANS, key=lambda k: _SCANS[k]["at"]))
    space = workspace.space_root()
    kinds = []
    for kid, label, hint in TEMP_KINDS:
        rows = entries[kid]
        groups: dict[str, dict] = {}
        for g, _, size, mt in rows:
            x = groups.setdefault(g, {"group": g, "count": 0, "bytes": 0, "newest": 0})
            x["count"] += 1
            x["bytes"] += size
            x["newest"] = max(x["newest"], mt / 1e9)
        sample = []
        for _, p, _, _ in sorted(rows, key=lambda r: -r[2])[:30]:
            try:
                sample.append(Path(p).relative_to(space).as_posix())
            except ValueError:
                sample.append("data/" + Path(p).relative_to(config.DATA_DIR).as_posix()
                              if Path(p).is_relative_to(config.DATA_DIR) else p)
        kinds.append({
            "id": kid, "label": label, "hint": hint,
            "count": len(rows), "bytes": sum(r[2] for r in rows),
            "newest": max((r[3] for r in rows), default=0) / 1e9,
            "groups": sorted(groups.values(), key=lambda x: -x["bytes"]) if any(groups) else [],
            "largest": sample,
        })
    return {"plan": plan, "kinds": kinds, "aiRunning": _ai_running()}


def _prune_empty(start: Path, stop: set[Path]) -> None:
    d = start
    while d not in stop and d.parent != d:
        try:
            if any(d.iterdir()):
                return
            d.rmdir()
        except OSError:
            return
        d = d.parent


def temp_clean(plan: str, picks: list[dict]) -> dict:
    """Delete the scanned files of the picked kinds (and groups).

    `picks`: [{kind, group?}] - no group = the whole kind. Files changed
    since the scan are skipped. Refused while an AI turn runs: its scratch
    and scope DB are in use."""
    scan = _SCANS.get(str(plan or ""))
    if scan is None:
        raise StorageError("목록이 오래됐습니다. 다시 불러온 뒤 정리해 주세요.")
    if _ai_running():
        raise StorageError("AI 작업이 끝난 후 정리해 주세요. 실행 중인 임시 파일을 보호합니다.")
    want: dict[str, set[str] | None] = {}
    for p in picks or []:
        kid = str((p or {}).get("kind") or "")
        if kid not in _KIND_IDS:
            continue
        if "group" in (p or {}) and p.get("group") is not None:
            cur = want.get(kid, set())
            if cur is not None:
                cur.add(str(p["group"]))
                want[kid] = cur
        else:
            want[kid] = None
    if not want:
        raise StorageError("정리할 항목을 골라 주세요")
    space = workspace.space_root()
    stops = {space, space / "hina", space / "scratch", space / "projects", space / "studio",
             config.WORKSPACE_DIR, config.DATA_DIR, config.DATA_DIR / "tool-results",
             space / "studio" / "config" / ".studio" / "thumbs"}
    hina = space / "hina"
    if hina.is_dir():
        for top in hina.iterdir():
            stops |= {top, top / "scratch", top / "scripts"}
    if config.WORKSPACE_DIR.is_dir():
        for d in config.WORKSPACE_DIR.iterdir():
            stops |= {d, d / "scratch", d / ".scratch"}
    removed = freed = skipped = 0
    by_kind: dict[str, dict] = {}
    parents: set[Path] = set()
    for kid, groups in want.items():
        k = by_kind.setdefault(kid, {"removed": 0, "freed": 0})
        for g, p, size, mt in scan["entries"].get(kid, []):
            if groups is not None and g not in groups:
                continue
            f = Path(p)
            try:
                st = f.stat()
                if f.is_symlink() or st.st_size != size or st.st_mtime_ns != mt:
                    skipped += 1
                    continue
                f.unlink()
            except OSError:
                skipped += 1
                continue
            removed += 1
            freed += size
            k["removed"] += 1
            k["freed"] += size
            parents.add(f.parent)
    for d in sorted(parents, key=lambda q: len(q.parts), reverse=True):
        _prune_empty(d, stops)
    _SCANS.pop(plan, None)
    log.info("storage temp clean %s: removed=%s freed=%s skipped=%s", sorted(want), removed, freed, skipped)
    return {"removed": removed, "freed": freed, "skipped": skipped, "byKind": by_kind}
