"""RisuAI user personas as a working copy: the same edit → snapshot → 반영 loop
a bot has.

A persona (name, description `personaPrompt`, profile picture `icon`) lives in
RisuAI, and only the plugin can read or write it. The panel reads RisuAI's
persona list and hands it to `sync()`; from then on the user and the AI edit a
WORKING COPY here, exactly as they edit a card: approvals land in the working
copy, snapshots keep earlier versions, and nothing reaches RisuAI until 반영
(the plugin writes, then calls `commit()` so the baseline moves).

Why a backend copy rather than editing RisuAI directly, as the panel did
before: the AI has no way into RisuAI at all - its proposals need somewhere to
land that the user can look at, undo and then save on purpose. That is what
the card working copy already is, so personas get the same thing instead of a
second, looser rule.

Shapes:
    base  {"name", "prompt"}            what RisuAI held at the last read/반영
    work  {"name", "prompt", "image"}   image = '' (keep RisuAI's picture) or a
                                        space path of a new picture waiting
                                        for 반영

RisuAI's picture itself is cached as `<folder>/RisuAI 프로필.<ext>` so the
AI can look at it with view_image like any other space image.
"""
from __future__ import annotations

import base64
import binascii
import shutil
import uuid
from typing import Any

from . import db, files, log, workspace

# Automatic snapshots (before restore / reset / 반영) kept per persona. The
# user's own snapshots are never pruned.
AUTO_KEEP = 30

ICON_STEM = "RisuAI 프로필"
_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".gif")


class PersonaError(ValueError):
    """A refusal the user should read. `status` is the HTTP status it maps to."""
    status = 400


class PersonaNotFound(PersonaError):
    status = 404


# --- rows ------------------------------------------------------------------------

def _base(raw: Any) -> dict:
    d = raw if isinstance(raw, dict) else {}
    return {"name": str(d.get("name") or ""), "prompt": str(d.get("prompt") or "")}


def _work(raw: Any) -> dict:
    d = raw if isinstance(raw, dict) else {}
    return {"name": str(d.get("name") or ""), "prompt": str(d.get("prompt") or ""),
            "image": str(d.get("image") or "")}


def _fresh(base: dict) -> dict:
    return {**_base(base), "image": ""}


def _changed(base: dict, work: dict) -> int:
    """How many of name/prompt/image differ from RisuAI - the panel's count."""
    return int(work["name"] != base["name"]) + int(work["prompt"] != base["prompt"]) + int(bool(work["image"]))


def _row(key: str) -> dict | None:
    r = db.one("SELECT * FROM personas WHERE pkey = ?", (str(key or ""),))
    return dict(r) if r is not None else None


def _need(key: str) -> dict:
    row = _row(key)
    if row is None:
        raise PersonaNotFound("없는 페르소나입니다 - 패널의 페르소나 탭을 한 번 열어 RisuAI 목록을 다시 읽어 주세요")
    return row


def _icon_cached(row: dict) -> bool:
    rel = str(row.get("icon_path") or "")
    if not rel:
        return False
    try:
        return files._resolve(files.SPACE, rel).is_file()
    except files.FileError:
        return False


NEW_PREFIX = "new:"
# Kept in base_json beside name/prompt (no schema change): RisuAI moved the
# baseline under unapplied work. _base() drops it, so commit() clears it.
RISU_CHANGED = "risuChanged"


def _is_new(key: str) -> bool:
    """A persona made here that RisuAI has not got yet (반영 appends it)."""
    return str(key or "").startswith(NEW_PREFIX)


def shape(row: dict) -> dict:
    """The one persona JSON every route returns."""
    base, work = _base(db.unjs(row["base_json"], {})), _work(db.unjs(row["work_json"], {}))
    new = _is_new(row["pkey"])
    if new:
        # Everything about it is unsaved; the count says how much there is.
        total = max(1, sum(1 for f in ("name", "prompt", "image") if work[f]))
    else:
        total = _changed(base, work)
    return {
        "key": row["pkey"], "id": row["persona_id"] or "", "index": int(row["idx"] or 0),
        "name": base["name"], "selected": bool(row["selected"]), "gone": bool(row["gone"]),
        "isNew": new,
        "folder": row["folder"] or "", "base": base, "work": work,
        "dirty": new or total > 0, "total": total,
        # RisuAI changed this persona while it had unapplied edits here (sync):
        # 반영 would overwrite that change, so the panel says so.
        "risuChanged": bool(not new and total > 0 and db.unjs(row["base_json"], {}).get(RISU_CHANGED)),
        "iconPath": (row["icon_path"] or "") if _icon_cached(row) else "",
        "iconKey": row["icon_key"] or "",
    }


def _save_work(key: str, work: dict) -> None:
    db.execute("UPDATE personas SET work_json = ?, updated_at = ? WHERE pkey = ?",
               (db.js(_work(work)), db.now(), key))


# --- reading RisuAI's list -----------------------------------------------------------

def sync(personas: list[dict]) -> list[dict]:
    """Take RisuAI's persona list as the panel just read it.

    A persona RisuAI changed on its own side (the user edited it in RisuAI)
    moves the baseline. The working copy follows only when it had nothing of
    its own - otherwise the user's unsaved edit would silently vanish, which
    is the one thing a working copy exists to prevent; it stays, flagged
    `risuChanged` (반영 would overwrite RisuAI's change, as the panel shows),
    and RisuAI's version is kept as an automatic snapshot to go back to.
    """
    if not isinstance(personas, list):
        raise PersonaError("personas 는 목록이어야 합니다")
    out: list[dict] = []
    seen: set[str] = set()
    now = db.now()
    for i, p in enumerate(personas):
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "")
        base = _base({"name": p.get("name"), "prompt": p.get("prompt")})
        try:
            key = workspace._persona_key(pid, base["name"])
            folder = workspace.persona_folder(pid, base["name"])
        except workspace.WorkspaceError as e:
            raise PersonaError(str(e)) from e
        if key in seen:
            continue
        seen.add(key)
        icon = str(p.get("icon") or "")
        try:
            idx = int(p.get("index", i))
        except (TypeError, ValueError):
            idx = i
        selected = 1 if p.get("selected") else 0
        with db.transaction():
            row = _row(key)
            if row is None:
                db.execute(
                    "INSERT INTO personas(pkey, persona_id, idx, folder, base_json, work_json, icon_key, "
                    "icon_path, selected, gone, updated_at) VALUES(?,?,?,?,?,?,?,?,?,0,?)",
                    (key, pid, idx, folder, db.js(base), db.js(_fresh(base)), "", "", selected, now))
            else:
                stored = db.unjs(row["base_json"], {})
                old = _base(stored)
                work = _work(db.unjs(row["work_json"], {}))
                flagged = bool(isinstance(stored, dict) and stored.get(RISU_CHANGED))
                if old != base and work == _fresh(old):
                    work = _fresh(base)
                elif old != base and work != _fresh(base):
                    flagged = True
                    checkpoint_create(key, "RisuAI 쪽 변경 (반영 전에 받아 둠)", kind="auto", data=_fresh(base))
                    log.info("persona %s: changed in RisuAI under unapplied edits", key)
                if flagged and work != _fresh(base):
                    base = {**base, RISU_CHANGED: True}
                icon_key, icon_path = row["icon_key"] or "", row["icon_path"] or ""
                if not icon:
                    # RisuAI dropped the picture: forget it, but the cached
                    # file is the user's to delete, not ours.
                    icon_key, icon_path = "", ""
                db.execute(
                    "UPDATE personas SET persona_id = ?, idx = ?, folder = ?, base_json = ?, work_json = ?, "
                    "icon_key = ?, icon_path = ?, selected = ?, gone = 0, updated_at = ? WHERE pkey = ?",
                    (pid, idx, folder, db.js(base), db.js(work), icon_key, icon_path, selected, now, key))
        row = _need(key)
        need = bool(icon) and ((row["icon_key"] or "") != icon or not _icon_cached(row))
        out.append({**shape(row), "needIcon": need})
    # Everything RisuAI did not list is gone - kept, because its snapshots and
    # any unsaved work are still the user's; it just cannot be written back.
    rows = db.query("SELECT pkey FROM personas WHERE gone = 0")
    # New personas were never in RisuAI's list; their absence means nothing.
    stale = [r["pkey"] for r in rows if r["pkey"] not in seen and not _is_new(r["pkey"])]
    for k in stale:
        db.execute("UPDATE personas SET gone = 1, selected = 0, updated_at = ? WHERE pkey = ?", (now, k))
    if stale:
        log.info("personas: %d no longer in RisuAI (kept as gone)", len(stale))
    return out


def _sniff(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"GIF8":
        return ".gif"
    return ".png"


def set_icon(key: str, icon_key: str, b64: str) -> dict:
    """Cache RisuAI's current picture in the persona's folder, so view_image
    (and the user) can see it as an ordinary space file."""
    row = _need(key)
    raw = str(b64 or "")
    if "," in raw[:100] and raw.startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError) as e:
        raise PersonaError(f"그림 데이터가 base64 가 아닙니다: {e}") from e
    if not data:
        raise PersonaError("그림 데이터가 비어 있습니다")
    folder = row["folder"] or workspace.persona_folder(row["persona_id"] or "", _base(db.unjs(row["base_json"], {}))["name"])
    rel = f"{folder}/{ICON_STEM}{_sniff(data)}"
    try:
        target = files._resolve(files.SPACE, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        old = str(row["icon_path"] or "")
        if old and old != rel:
            # Our own cache under another extension - the old picture would
            # otherwise sit beside the new one under the same name.
            prev = files._resolve(files.SPACE, old)
            if prev.is_file() and prev.stem == ICON_STEM:
                prev.unlink()
    except (OSError, files.FileError) as e:
        raise PersonaError(f"프로필 사진을 저장하지 못했습니다: {e}") from e
    db.execute("UPDATE personas SET icon_key = ?, icon_path = ?, updated_at = ? WHERE pkey = ?",
               (str(icon_key or ""), rel, db.now(), key))
    return shape(_need(key))


def get(key: str) -> dict:
    row = _need(key)
    n = db.one("SELECT COUNT(*) AS n FROM persona_checkpoints WHERE pkey = ?", (key,))["n"]
    return {**shape(row), "checkpoints": int(n)}


def listing(query: str = "") -> list[dict]:
    """Personas RisuAI still has, filtered by a case-insensitive substring over
    name and description (both RisuAI's and the working copy's)."""
    q = str(query or "").casefold().strip()
    out = []
    # RisuAI's personas in RisuAI's order, then the new ones, newest last
    # (rowid survives the re-key at 반영, so creation order holds).
    for r in db.query("SELECT * FROM personas WHERE gone = 0 "
                      "ORDER BY (pkey LIKE 'new:%'), CASE WHEN pkey LIKE 'new:%' THEN rowid ELSE idx END, pkey"):
        p = shape(dict(r))
        hay = " ".join((p["base"]["name"], p["base"]["prompt"], p["work"]["name"], p["work"]["prompt"])).casefold()
        if not q or q in hay:
            out.append(p)
    return out


def dirty() -> list[dict]:
    """Personas with unsaved work - the title-row 반영 lists them beside the bot and chats."""
    return [{"key": p["key"], "name": p["work"]["name"] or p["name"], "total": p["total"]}
            for p in listing() if p["dirty"]]


def resolve(ref: str) -> dict:
    """A persona by key or name: the key exactly, then a name exactly (RisuAI's
    or the working copy's), then a unique partial name. For the AI tools,
    which are handed whatever the user called the persona."""
    ref = str(ref or "").strip()
    if not ref:
        raise PersonaError("페르소나를 지정해 주세요 (이름 또는 key)")
    row = _row(ref)
    if row is not None:
        return shape(row)
    rows = listing()
    low = ref.casefold()
    exact = [p for p in rows if low in (p["base"]["name"].casefold(), p["work"]["name"].casefold())]
    if len(exact) == 1:
        return exact[0]
    part = exact or [p for p in rows if low in p["base"]["name"].casefold() or low in p["work"]["name"].casefold()]
    if len(part) == 1:
        return part[0]
    if not part:
        raise PersonaNotFound(f"'{ref}' 페르소나를 찾지 못했습니다 - list_personas 로 이름과 key 를 확인하세요")
    names = ", ".join(f"{p['work']['name'] or p['name']} (key={p['key']})" for p in part[:10])
    raise PersonaError(f"'{ref}' 에 맞는 페르소나가 여럿입니다: {names} - key 로 지정해 주세요")


# --- editing -----------------------------------------------------------------------

def _image_rel(path: str) -> str:
    rel = str(path or "").replace("\\", "/").strip().lstrip("/")
    try:
        target = files._resolve(files.SPACE, rel)
    except files.FileError as e:
        raise PersonaError(str(e)) from e
    if target.suffix.lower() not in _IMAGE_SUFFIXES or not target.is_file():
        raise PersonaError(f"공간에 있는 그림 파일(png/jpg/webp/gif)이 아닙니다: {rel}")
    return target.relative_to(files._root(files.SPACE)).as_posix()


def _adopt_image(folder: str, rel: str) -> str:
    """A picture from elsewhere in the space (the studio, the agent's output
    folder) is copied into the persona's folder as `프로필 <n>.<ext>`, so a
    persona's pictures live with it and a later cleanup of the studio or a
    scratch folder cannot pull one out from under a pending 반영."""
    rel = _image_rel(rel)
    if not folder or rel.startswith(folder.rstrip("/") + "/"):
        return rel
    src = files._resolve(files.SPACE, rel)
    ext = src.suffix.lower()
    try:
        dest_dir = files._resolve(files.SPACE, folder)
        dest_dir.mkdir(parents=True, exist_ok=True)
        n = 1
        while (dest_dir / f"프로필 {n}{ext}").exists():
            n += 1
        dest = dest_dir / f"프로필 {n}{ext}"
        shutil.copy2(src, dest)
    except (OSError, files.FileError) as e:
        raise PersonaError(f"그림을 페르소나 폴더로 복사하지 못했습니다: {e}") from e
    log.info("persona picture %s copied to %s/%s", rel, folder, dest.name)
    return f"{folder.rstrip('/')}/{dest.name}"


def create(name: str, prompt: str = "", image: str = "") -> dict:
    """A persona RisuAI does not have yet. It lives only here until 반영,
    which appends it to RisuAI's list and calls commit() with the id RisuAI
    gave it. Keyed 'new:<hex>' until then; its folder is pinned under that
    key so the folder is the persona's from the start."""
    name = str(name or "")
    if not name.strip():
        raise PersonaError("페르소나 이름이 비어 있습니다")
    key = NEW_PREFIX + uuid.uuid4().hex
    try:
        folder = workspace.persona_folder(key, name)
    except workspace.WorkspaceError as e:
        raise PersonaError(str(e)) from e
    work = {"name": name, "prompt": str(prompt or ""),
            "image": _adopt_image(folder, image) if str(image or "").strip() else ""}
    db.execute(
        "INSERT INTO personas(pkey, persona_id, idx, folder, base_json, work_json, icon_key, "
        "icon_path, selected, gone, updated_at) VALUES(?,?,?,?,?,?,?,?,0,0,?)",
        (key, "", -1, folder, db.js(_base({})), db.js(work), "", "", db.now()))
    log.info("persona created key=%s name=%s", key, name[:40])
    return shape(_need(key))


def edit(key: str, *, name: str | None = None, prompt: str | None = None, image: str | None = None) -> dict:
    """Change the working copy. Only the given fields move; image '' drops a
    pending new picture (RisuAI's stays)."""
    row = _need(key)
    work = _work(db.unjs(row["work_json"], {}))
    if name is not None:
        if not str(name).strip():
            raise PersonaError("페르소나 이름이 비어 있습니다")
        work["name"] = str(name)
    if prompt is not None:
        work["prompt"] = str(prompt)
    if image is not None:
        work["image"] = _adopt_image(row["folder"] or "", image) if str(image).strip() else ""
    _save_work(key, work)
    return shape(_need(key))


def reset(key: str) -> dict:
    """Throw the working copy away (RisuAI's version comes back). Kept as an
    automatic snapshot first, so a mis-click is one restore away."""
    row = _need(key)
    if _is_new(key):
        # Nothing in RisuAI to go back to: discarding a new persona is
        # deleting it. The folder stays - it may hold pictures worth keeping.
        with db.transaction():
            db.execute("DELETE FROM persona_checkpoints WHERE pkey = ?", (key,))
            db.execute("DELETE FROM personas WHERE pkey = ?", (key,))
        log.info("new persona discarded key=%s", key)
        return {"deleted": True, "key": key}
    p = shape(row)
    if p["dirty"]:
        checkpoint_create(key, "버리기 직전", kind="auto")
    _save_work(key, _fresh(p["base"]))
    db.execute("UPDATE personas SET base_json = ? WHERE pkey = ?", (db.js(_base(p["base"])), key))
    return {**shape(_need(key)), "discarded": p["total"]}


# --- snapshots -----------------------------------------------------------------------

def checkpoints(key: str) -> list[dict]:
    _need(key)
    rows = db.query("SELECT id, label, created_at, kind FROM persona_checkpoints WHERE pkey = ? "
                    "ORDER BY created_at DESC, rowid DESC", (key,))
    return [dict(r) for r in rows]


def checkpoint_create(key: str, label: str, kind: str = "manual", data: dict | None = None) -> str:
    """Store the working copy (or `data`, same shape). kind 'manual' = the user
    (or an approved AI proposal) saved it by name; 'auto' = the code backing
    itself up before something destructive, pruned to the newest AUTO_KEEP."""
    if kind not in ("manual", "auto"):
        raise PersonaError(f"모르는 스냅샷 종류입니다: {kind}")
    row = _need(key)
    snap = _work(data if data is not None else db.unjs(row["work_json"], {}))
    cid = uuid.uuid4().hex
    db.execute("INSERT INTO persona_checkpoints(id, pkey, label, kind, data_json, created_at) VALUES(?,?,?,?,?,?)",
               (cid, key, str(label or "")[:200], kind, db.js(snap), db.now()))
    if kind == "auto":
        db.execute(
            "DELETE FROM persona_checkpoints WHERE pkey = ? AND kind = 'auto' AND id NOT IN "
            "(SELECT id FROM persona_checkpoints WHERE pkey = ? AND kind = 'auto' "
            "ORDER BY created_at DESC, rowid DESC LIMIT ?)", (key, key, AUTO_KEEP))
    return cid


def _checkpoint(key: str, cid: str) -> dict:
    r = db.one("SELECT * FROM persona_checkpoints WHERE pkey = ? AND id = ?", (key, str(cid or "")))
    if r is None:
        raise PersonaNotFound("없는 페르소나 스냅샷입니다")
    return dict(r)


def checkpoint_restore(key: str, cid: str) -> dict:
    """Put a snapshot back into the working copy (RisuAI is untouched until
    반영). The current work is kept first when the restore would lose it."""
    row = _need(key)
    snap = _work(db.unjs(_checkpoint(key, cid)["data_json"], {}))
    cur = _work(db.unjs(row["work_json"], {}))
    if snap["image"]:
        try:
            _image_rel(snap["image"])
        except PersonaError:
            # The picture it pointed at was moved or deleted since; restoring
            # a dead path would only fail later, at 반영.
            log.warn("persona restore %s: pending picture %s is gone, dropped", key, snap["image"])
            snap["image"] = ""
    if cur != snap:
        checkpoint_create(key, "복원 직전", kind="auto")
    _save_work(key, snap)
    return shape(_need(key))


def checkpoint_delete(key: str, cid: str) -> None:
    _checkpoint(key, cid)
    db.execute("DELETE FROM persona_checkpoints WHERE pkey = ? AND id = ?", (key, cid))


def checkpoint_rename(key: str, cid: str, label: str) -> None:
    _checkpoint(key, cid)
    label = str(label or "").strip()
    if not label:
        raise PersonaError("스냅샷 이름이 비어 있습니다")
    db.execute("UPDATE persona_checkpoints SET label = ? WHERE pkey = ? AND id = ?", (label[:200], key, cid))


# --- 반영 ---------------------------------------------------------------------------

def _commit_new(row: dict, name: str, prompt: str, icon_key: str, persona_id: str, index: int | None) -> dict:
    """반영 of a persona made here: RisuAI appended it and gave it an id. The
    row, its snapshots and its folder pin move from 'new:<hex>' to that id;
    the folder itself moves only when the name changed since it was made."""
    key = row["pkey"]
    pid = str(persona_id or "").strip()
    if not pid:
        raise PersonaError("새 페르소나 반영에는 RisuAI 가 준 id 가 필요합니다")
    base = _base({"name": name, "prompt": prompt})
    try:
        new_key = workspace._persona_key(pid, base["name"])
    except workspace.WorkspaceError as e:
        raise PersonaError(str(e)) from e
    folder = row["folder"] or ""
    pin = workspace.rekey_persona(key, new_key)
    pinned = str(pin.get("name") or "")
    if base["name"].strip() and pinned and base["name"] != pinned:
        try:
            folder = workspace.rename_persona_folder(pid, pinned, base["name"])["path"]
        except workspace.WorkspaceError as e:
            log.warn("persona commit %s: folder not renamed (%s)", new_key, e)
    elif pin.get("folder"):
        folder = f"projects/{workspace.PERSONA_TOP}/{pin['folder']}"
    idx = int(index) if index is not None else int(row["idx"] or 0)
    with db.transaction():
        # A sync that ran between RisuAI's append and this call has already
        # made a row for the id - a clean copy of what we just wrote.
        db.execute("DELETE FROM persona_checkpoints WHERE pkey = ?", (new_key,))
        db.execute("DELETE FROM personas WHERE pkey = ?", (new_key,))
        db.execute("UPDATE personas SET pkey = ?, persona_id = ?, idx = ?, base_json = ?, work_json = ?, "
                   "icon_key = ?, icon_path = '', folder = ?, gone = 0, updated_at = ? WHERE pkey = ?",
                   (new_key, pid, idx, db.js(base), db.js(_fresh(base)), str(icon_key or ""), folder,
                    db.now(), key))
        db.execute("UPDATE persona_checkpoints SET pkey = ? WHERE pkey = ?", (new_key, key))
    log.info("new persona committed %s -> %s name=%s", key, new_key, base["name"][:40])
    return shape(_need(new_key))


def commit(key: str, name: str, prompt: str, icon_key: str,
           persona_id: str = "", index: int | None = None) -> dict:
    """The plugin just wrote this persona to RisuAI: move the baseline.
    For a new persona (key 'new:…') `persona_id`/`index` are what RisuAI
    gave the appended entry - see _commit_new.

    The old baseline is kept as an automatic snapshot (반영 is the one step
    that changes RisuAI, so it is the one worth being able to undo). The
    cached picture is marked stale rather than trusted: what RisuAI stored
    under `icon_key` is the plugin's business, and the next sync fetches it.
    A rename follows into the persona's folder; a refused folder move is not
    a failed 반영 - RisuAI already has the new name - so it is only logged.
    """
    row = _need(key)
    if _is_new(key):
        return _commit_new(row, name, prompt, icon_key, persona_id, index)
    old = _base(db.unjs(row["base_json"], {}))
    base = _base({"name": name, "prompt": prompt})
    checkpoint_create(key, "반영 직전", kind="auto", data=_fresh(old))
    folder = row["folder"] or ""
    new_key = key
    if base["name"] != old["name"] and base["name"].strip():
        pid = row["persona_id"] or ""
        try:
            moved = workspace.rename_persona_folder(pid, old["name"], base["name"])
            folder = moved["path"]
        except workspace.WorkspaceError as e:
            log.warn("persona commit %s: folder not renamed (%s)", key, e)
        if not pid:
            # A persona without an id is keyed by its name; the next sync
            # will ask for it under the new one.
            cand = workspace._persona_key("", base["name"])
            if cand != key and _row(cand) is None:
                new_key = cand
    with db.transaction():
        db.execute("UPDATE personas SET base_json = ?, work_json = ?, icon_key = ?, icon_path = '', folder = ?, "
                   "updated_at = ? WHERE pkey = ?",
                   (db.js(base), db.js(_fresh(base)), str(icon_key or ""), folder, db.now(), key))
        if new_key != key:
            db.execute("UPDATE personas SET pkey = ? WHERE pkey = ?", (new_key, key))
            db.execute("UPDATE persona_checkpoints SET pkey = ? WHERE pkey = ?", (new_key, key))
    log.info("persona committed key=%s name=%s", new_key, base["name"][:40])
    return shape(_need(new_key))


# --- for the AI tools ---------------------------------------------------------------

def first_line(text: str, width: int = 80) -> str:
    line = next((ln.strip() for ln in str(text or "").splitlines() if ln.strip()), "")
    return line if len(line) <= width else line[:width - 1] + "…"


def describe_row(p: dict) -> str:
    """One compact line per persona for list_personas."""
    bits = [f"- {p['work']['name'] or p['name']} (key={p['key']})"]
    if p.get("isNew"):
        bits.append("[새 페르소나 - RisuAI 에는 반영 후 생김]")
    if p["selected"]:
        bits.append("[RisuAI 선택 중]")
    if p.get("risuChanged"):
        bits.append("[RisuAI 쪽에서도 바뀜 - 반영하면 덮어씀]")
    bits.append(f"변경 {p['total']}건" if p["dirty"] else "변경 없음")
    bits.append(f"폴더 {p['folder']}")
    bits.append(f"프로필 사진 {p['iconPath']} (view_image 로 볼 수 있음)" if p["iconPath"] else "프로필 사진 없음/미수신")
    if p["work"]["image"]:
        bits.append(f"반영 대기 새 사진 {p['work']['image']}")
    head = " · ".join(bits)
    line = first_line(p["work"]["prompt"])
    return head + (f"\n    {line}" if line else "")


def describe_full(p: dict, snapshots: int) -> str:
    """Everything read_persona returns: both versions in full."""
    base, work = p["base"], p["work"]
    out = [f"페르소나 {work['name'] or p['name']} (key={p['key']})",
           *(["새 페르소나: RisuAI 에는 아직 없습니다 (propose_persona_writeback 승인 시 RisuAI 목록에 추가)"]
             if p.get("isNew") else []),
           f"RisuAI 선택 중: {'예 - 반영하면 원본 대신 새 페르소나(사본)로 저장됩니다 (원본을 고치려면 RisuAI 에서 다른 페르소나를 고른 뒤 패널을 다시 열기)' if p['selected'] else '아니오'}",
           f"폴더: {p['folder']}",
           f"RisuAI 프로필 사진: {p['iconPath'] + ' (view_image 로 볼 수 있음)' if p['iconPath'] else '없음/미수신'}",
           f"반영 대기 새 사진: {work['image'] or '없음'}",
           f"스냅샷: {snapshots}개",
           f"작업본 변경: {p['total']}건"
           + (f" (이름: {base['name']} -> {work['name']})" if work["name"] != base["name"] else "")]
    if p["gone"]:
        out.append("주의: RisuAI 목록에 더 이상 없는 페르소나입니다 (반영 불가)")
    if p.get("risuChanged"):
        out.append("주의: 이 작업본에 미반영 변경이 있는 동안 RisuAI 쪽에서도 이 페르소나가 바뀌었습니다. 반영하면 "
                   "RisuAI 쪽 변경을 덮어씁니다 (RisuAI 버전은 자동 스냅샷 'RisuAI 쪽 변경' 으로 남아 있음) - "
                   "반영 전에 사용자에게 확인하세요.")
    if work["prompt"] == base["prompt"]:
        out.append(f"--- 설명 (RisuAI = 작업본)\n{base['prompt']}")
    else:
        out.append(f"--- 설명 (작업본)\n{work['prompt']}")
        out.append(f"--- 설명 (RisuAI 원본)\n{base['prompt']}")
    return "\n".join(out)
