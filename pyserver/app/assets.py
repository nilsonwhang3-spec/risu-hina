"""The asset store: every image a bot references, kept once, by content.

Why a store at all
------------------
The card editor (M1) never needed bytes - card fields, scripts and lore are
text and travel inside the /workspace upload. Everything after it does: a
charx is a zip of the card plus its images, PIL edits need the pixels, and
the assets tab has to say what a bot's 2980 images actually are. RisuAI
itself keys assets by content hash (`assets/<sha256>.<ext>`), so the store
mirrors that: `data/assets/<sha256>.<ext>`, global across bots, deduplicated
by construction. The hash is recomputed here on every write - it is the
integrity check on the upload as much as the file name.

Why the sync is shaped the way it is (plan M0, measured 2026-08-24)
-------------------------------------------------------------------
2980 assets / 142.6MB from a web (risu.xyz) account: 42.8 minutes to READ
them out of the host through `readImage` (862ms each - account storage does
a hub GET per asset) against 2.6 minutes to upload them. So the importer is
built around not reading from the host when something faster exists:

    hub pull      account-synced bots: the backend GETs `sv.risuai.xyz/rs/<key>`
                  itself, in parallel (probe returned 200). Browser bandwidth 0.
    fast path     PocketRisu on this machine: read `save/risuai.db` directly.
    plugin push   whatever is still missing after the two above, in batches
                  bounded by bytes (8MB raw) rather than count.

Content addressing is what makes it restartable: a second sync of the same
bot finds every key present and sends nothing, and a sync cut off half way
just resumes. Keys the host could not read are marked `failed` so the gate
does not wait for them forever; the next sync tries them again.

Three tables (db v9): `asset_blobs` is what is on disk, `asset_keys` maps a
RisuAI key to a blob (or records that it is missing/failed), `char_assets`
is the manifest - which keys a bot references, in card order, so the assets
tab and the charx builder do not have to re-derive it from card_json.
"""
from __future__ import annotations

import base64
import hashlib
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable

from . import config, db, log

ASSET_DIR = config.DATA_DIR / "assets"

# `assets/<hash>.<ext>`. RisuAI keys are sha256 hex, but nothing downstream
# depends on that; the file on disk is named by OUR hash. What matters is
# that the key cannot carry a path.
KEY_RE = re.compile(r"assets/[A-Za-z0-9_-]{1,80}\.[A-Za-z0-9]{1,8}")
FIELDS = ("image", "emotion", "additional", "cc", "vits")
STATES = ("present", "missing", "failed")

HUB = "https://sv.risuai.xyz/rs/"


class AssetError(Exception):
    pass


def settings() -> dict:
    return config.section("assets")


def key_ok(key: str) -> bool:
    return bool(KEY_RE.fullmatch(key or ""))


def ext_of(key: str) -> str:
    return key.rsplit(".", 1)[-1].lower()


def blob_path(content_hash: str, ext: str) -> Path:
    return ASSET_DIR / f"{content_hash}.{ext}"


# --- writing ----------------------------------------------------------------

def store_bytes(key: str, data: bytes) -> dict:
    """Put one asset in the store under its RisuAI key. Idempotent.

    Same bytes under a second key is a second row pointing at the same file -
    that is the dedup, and it is also why the file is written only when it is
    not already there.
    """
    if not key_ok(key):
        raise AssetError(f"bad asset key: {key!r}")
    limit = int(settings().get("maxItemBytes") or 0)
    if limit and len(data) > limit:
        raise AssetError(f"asset larger than {limit} bytes: {key}")
    h = hashlib.sha256(data).hexdigest()
    ext = ext_of(key)
    path = blob_path(h, ext)
    created = False
    if not path.is_file():
        ASSET_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)
        created = True
    now = db.now()
    db.execute(
        "INSERT INTO asset_blobs(content_hash, ext, size, created_at) VALUES(?,?,?,?) "
        "ON CONFLICT(content_hash) DO NOTHING",
        (h, ext, len(data), now))
    db.execute(
        "INSERT INTO asset_keys(risu_key, content_hash, state, error, updated_at) "
        "VALUES(?,?,'present','',?) "
        "ON CONFLICT(risu_key) DO UPDATE SET content_hash=excluded.content_hash, "
        "  state='present', error='', updated_at=excluded.updated_at",
        (key, h, now))
    return {"key": key, "hash": h, "size": len(data), "created": created}


def upload(items: list) -> dict:
    """A batch from the plugin: `[{key, data: base64}]`.

    Per-item failures are reported, never fatal - one unreadable item must not
    cost the other 49 their upload.
    """
    if not isinstance(items, list):
        raise AssetError("items must be a list")
    stored = 0
    new_bytes = 0
    total = 0
    bad: list[dict] = []
    for it in items:
        row = it if isinstance(it, dict) else {}
        key = str(row.get("key") or "")
        try:
            data = base64.b64decode(str(row.get("data") or ""), validate=True)
            if not data:
                raise AssetError("empty")
            r = store_bytes(key, data)
        except (AssetError, ValueError, TypeError, OSError) as e:
            bad.append({"key": key, "error": str(e)})
            continue
        stored += 1
        total += r["size"]
        if r["created"]:
            new_bytes += r["size"]
    return {"stored": stored, "bytes": total, "newBytes": new_bytes, "bad": bad}


def mark_failed(keys: Iterable[str], reason: str) -> int:
    """The plugin could not read these from the host. Present keys stay present."""
    now = db.now()
    n = 0
    for key in keys:
        if not key_ok(key):
            continue
        cur = db.execute(
            "UPDATE asset_keys SET state='failed', error=?, updated_at=? "
            "WHERE risu_key = ? AND state != 'present'",
            (reason[:200], now, key))
        n += cur.rowcount
    return n


# --- manifest / status ------------------------------------------------------

def _rows_for(ck: str) -> list[sqlite3.Row]:
    return db.query(
        "SELECT a.seq, a.field, a.name, a.risu_key, "
        "       COALESCE(k.state, 'missing') AS state, COALESCE(k.error, '') AS error, "
        "       k.content_hash, b.size, b.ext "
        "FROM char_assets a "
        "LEFT JOIN asset_keys k ON k.risu_key = a.risu_key "
        "LEFT JOIN asset_blobs b ON b.content_hash = k.content_hash "
        "WHERE a.char_key = ? ORDER BY a.seq", (ck,))


def manifest(ck: str, refs: list, *, hub_pull: bool = False) -> dict:
    """Record what the bot references and say what is still needed.

    Order of attempts, cheapest first: what the store already has, then the
    PocketRisu database next door (fast path), then a hub pull in the
    background when asked. What comes back as `missing` is what the plugin
    has to read from the host itself.
    """
    if not isinstance(refs, list):
        raise AssetError("refs must be a list")
    now = db.now()
    rows: list[tuple] = []
    seen: set[str] = set()
    for i, r in enumerate(refs):
        it = r if isinstance(r, dict) else {}
        key = str(it.get("key") or "")
        if not key_ok(key) or key in seen:
            continue
        seen.add(key)
        field = str(it.get("field") or "additional")
        if field not in FIELDS:
            field = "additional"
        rows.append((ck, len(rows), field, str(it.get("name") or "")[:200], ext_of(key), key))

    with db.LOCK:
        db.execute("DELETE FROM char_assets WHERE char_key = ?", (ck,))
        db.executemany(
            "INSERT INTO char_assets(char_key, seq, field, name, ext, risu_key) VALUES(?,?,?,?,?,?)",
            rows)
        # A key the store has never heard of starts as missing; a failed one
        # is retried by this very sync, so it counts as missing again.
        db.executemany(
            "INSERT INTO asset_keys(risu_key, content_hash, state, error, updated_at) "
            "VALUES(?, NULL, 'missing', '', ?) ON CONFLICT(risu_key) DO NOTHING",
            [(r[5], now) for r in rows])
        db.execute(
            "UPDATE asset_keys SET state='missing', updated_at=? WHERE state='failed' "
            "AND risu_key IN (SELECT risu_key FROM char_assets WHERE char_key = ?)",
            (now, ck))

    missing = _missing_keys(ck)
    fast = fast_path_info()
    filled = 0
    if missing and fast["fastPath"]:
        filled = _fast_fill(missing)
        if filled:
            missing = _missing_keys(ck)

    pulling = False
    if missing and hub_pull and bool(settings().get("hubPull", True)):
        pulling = _start_pull(ck, missing)

    st = status(ck)
    st.update({
        "missing": [] if pulling else missing,
        "fastPath": fast["fastPath"],
        "fastFilled": filled,
        "serverWrite": fast["serverWrite"],
    })
    log.info("assets manifest char=%s refs=%s present=%s missing=%s fast=%s pull=%s",
             ck, len(rows), st["present"], len(missing), filled, pulling)
    return st


def _missing_keys(ck: str) -> list[str]:
    return [r["risu_key"] for r in db.query(
        "SELECT a.risu_key FROM char_assets a JOIN asset_keys k ON k.risu_key = a.risu_key "
        "WHERE a.char_key = ? AND k.state = 'missing' ORDER BY a.seq", (ck,))]


def status(ck: str) -> dict:
    """Counts for the gate and the progress bar. `complete` opens the gate:
    nothing is still missing and no pull is running. Failed keys do not hold
    the gate - they are reported, and the next sync tries them again."""
    counts = {s: 0 for s in STATES}
    total_bytes = 0
    for r in db.query(
            "SELECT COALESCE(k.state,'missing') AS state, COUNT(*) AS n, "
            "       COALESCE(SUM(b.size), 0) AS bytes "
            "FROM char_assets a LEFT JOIN asset_keys k ON k.risu_key = a.risu_key "
            "LEFT JOIN asset_blobs b ON b.content_hash = k.content_hash "
            "WHERE a.char_key = ? GROUP BY 1", (ck,)):
        counts[r["state"]] = int(r["n"])
        if r["state"] == "present":
            total_bytes = int(r["bytes"])
    pull = _pull_state(ck)
    pulling = bool(pull and pull.get("running"))
    return {
        "charKey": ck,
        "total": sum(counts.values()),
        "present": counts["present"],
        "missing": counts["missing"],
        "failed": counts["failed"],
        "bytes": total_bytes,
        "pulling": pulling,
        "pull": pull,
        "complete": counts["missing"] == 0 and not pulling,
        "store": store_stats(),
    }


def listing(ck: str) -> dict:
    """The manifest with state and size, for the assets tab."""
    items = []
    for r in _rows_for(ck):
        items.append({
            "seq": r["seq"], "field": r["field"], "name": r["name"], "key": r["risu_key"],
            "ext": r["ext"] or ext_of(r["risu_key"]), "state": r["state"],
            "error": r["error"], "size": r["size"], "hash": r["content_hash"],
        })
    return {"charKey": ck, "items": items, **status(ck)}


def store_stats() -> dict:
    r = db.one("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM asset_blobs")
    return {"blobs": int(r["n"]) if r else 0, "bytes": int(r["bytes"]) if r else 0,
            "dir": str(ASSET_DIR)}


def fetch_to_scratch(ck: str, wanted: list[str]) -> dict:
    """Copy present assets into <workspace>/scratch/assets/ for the agent's
    PIL work. Names or keys; a name shared by several entries (a random
    pool) yields name, name_1, name_2..."""
    from . import workspace as ws
    rows = _rows_for(ck)
    dest = ws.root(ck) / "scratch" / "assets"
    dest.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    missing: list[str] = []
    for want in wanted:
        hits = [r for r in rows if r["risu_key"] == want or (r["name"] or "") == want]
        if not hits:
            missing.append(want)
            continue
        used: set[str] = set()
        for r in hits:
            p = locate(r["risu_key"])
            if p is None:
                missing.append(f"{want} ({r['state']})")
                continue
            ext = r["ext"] or ext_of(r["risu_key"])
            stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", r["name"] or "asset").strip(". ") or "asset"
            name, n = stem, 0
            while name in used or (dest / f"{name}.{ext}").exists() and name in used:
                n += 1
                name = f"{stem}_{n}"
            used.add(name)
            target = dest / f"{name}.{ext}"
            target.write_bytes(p.read_bytes())
            paths.append(f"scratch/assets/{name}.{ext}")
    return {"paths": paths, "missing": missing}


def stage_file(ck: str, rel: str) -> dict:
    """Validate a workspace file the agent wants to turn into an asset: it
    must exist inside the workspace and be a PNG (saveAsset names every key
    `.png`, so anything else would be mislabelled)."""
    from . import files
    p = files._resolve(ck, rel)
    if not p.is_file():
        raise AssetError(f"파일이 없습니다: {rel}")
    head = p.read_bytes()[:8] if p.stat().st_size >= 8 else b""
    if not head.startswith(b"\x89PNG"):
        raise AssetError("PNG 만 에셋으로 넣을 수 있습니다 (saveAsset 이 .png 키를 만듭니다): " + rel)
    limit = int(settings().get("maxItemBytes") or 0)
    if limit and p.stat().st_size > limit:
        raise AssetError(f"{limit} 바이트를 넘습니다: {rel}")
    return {"path": p.relative_to(files._root(ck)).as_posix(), "size": p.stat().st_size}


def adopt(ck: str, key: str, rel: str, *, name: str = "", field: str = "additional") -> dict:
    """The host saved a workspace file as an asset and told us the key: put
    the same bytes in the store under it and append it to the manifest, so
    the next charx or fetch sees it before the next full sync does."""
    from . import files
    if not key_ok(key):
        raise AssetError(f"bad asset key: {key!r}")
    p = files._resolve(ck, rel)
    if not p.is_file():
        raise AssetError(f"파일이 없습니다: {rel}")
    r = store_bytes(key, p.read_bytes())
    if field not in FIELDS:
        field = "additional"
    with db.LOCK:
        exists = db.one("SELECT seq FROM char_assets WHERE char_key = ? AND risu_key = ?", (ck, key))
        if exists is None:
            row = db.one("SELECT COALESCE(MAX(seq), -1) AS m FROM char_assets WHERE char_key = ?", (ck,))
            seq = int(row["m"]) + 1 if row else 0
            db.execute(
                "INSERT INTO char_assets(char_key, seq, field, name, ext, risu_key) VALUES(?,?,?,?,?,?)",
                (ck, seq, field, name[:200], ext_of(key), key))
    return {"key": key, "hash": r["hash"], "size": r["size"], "created": r["created"]}


def locate(key: str) -> Path | None:
    """The file behind a present key, or None. For streaming readers (charx)."""
    if not key_ok(key):
        return None
    r = db.one(
        "SELECT k.content_hash, b.ext FROM asset_keys k JOIN asset_blobs b "
        "ON b.content_hash = k.content_hash WHERE k.risu_key = ? AND k.state = 'present'",
        (key,))
    if r is None:
        return None
    p = blob_path(r["content_hash"], r["ext"])
    return p if p.is_file() else None


def read_bytes(key: str) -> tuple[bytes, str] | None:
    """(bytes, ext) for a present key, or None."""
    r = db.one(
        "SELECT k.content_hash, b.ext FROM asset_keys k JOIN asset_blobs b "
        "ON b.content_hash = k.content_hash WHERE k.risu_key = ? AND k.state = 'present'",
        (key,))
    if r is None:
        return None
    p = blob_path(r["content_hash"], r["ext"])
    try:
        return p.read_bytes(), r["ext"]
    except OSError:
        return None


# --- GC ---------------------------------------------------------------------

def gc(days: float | None = None) -> dict:
    """Manual only. Drops blobs no manifest reaches, once they are old enough
    that a half-finished sync cannot be the reason nothing references them."""
    if days is None:
        days = float(settings().get("gcDays") or 7)
    cutoff = db.now() - days * 86400
    # Keys nobody references and blobs no key points at.
    orphan_keys = db.execute(
        "DELETE FROM asset_keys WHERE risu_key NOT IN (SELECT risu_key FROM char_assets)"
    ).rowcount
    victims = db.query(
        "SELECT content_hash, ext, size FROM asset_blobs WHERE created_at < ? AND content_hash "
        "NOT IN (SELECT content_hash FROM asset_keys WHERE content_hash IS NOT NULL)",
        (cutoff,))
    removed = 0
    freed = 0
    for v in victims:
        p = blob_path(v["content_hash"], v["ext"])
        try:
            if p.is_file():
                p.unlink()
        except OSError as e:
            log.warn("assets gc: could not remove %s: %s", p.name, e)
            continue
        db.execute("DELETE FROM asset_blobs WHERE content_hash = ?", (v["content_hash"],))
        removed += 1
        freed += int(v["size"] or 0)
    # Files on disk that no row knows about (a crash between write and insert).
    stray = 0
    try:
        known = {f"{r['content_hash']}.{r['ext']}" for r in db.query("SELECT content_hash, ext FROM asset_blobs")}
        for f in ASSET_DIR.iterdir() if ASSET_DIR.is_dir() else []:
            if f.is_file() and f.name not in known and f.stat().st_mtime < cutoff:
                f.unlink()
                stray += 1
    except OSError:
        pass
    log.info("assets gc days=%s keys=%s blobs=%s freed=%s stray=%s", days, orphan_keys, removed, freed, stray)
    return {"orphanKeys": orphan_keys, "removed": removed, "freed": freed, "stray": stray,
            "store": store_stats()}


# --- PocketRisu fast path ---------------------------------------------------

def fast_path_info() -> dict:
    """Whether a PocketRisu save directory is configured and readable here."""
    cfg = config.section("pocketrisu")
    raw = str(cfg.get("savePath") or "").strip()
    if not raw:
        return {"fastPath": False, "serverWrite": False, "savePath": ""}
    root = Path(raw).expanduser()
    dbfile = root / "risuai.db"
    return {
        "fastPath": dbfile.is_file(),
        "serverWrite": (root / "__jwt_secret").is_file(),
        "savePath": str(root),
    }


def _fast_fill(keys: list[str]) -> int:
    """Read missing keys straight out of PocketRisu's SQLite. Read-only, and
    every failure is a soft one - the plugin push is always there."""
    info = fast_path_info()
    if not info["fastPath"]:
        return 0
    dbfile = Path(info["savePath"]) / "risuai.db"
    filled = 0
    try:
        con = sqlite3.connect(f"file:{dbfile.as_posix()}?mode=ro", uri=True, timeout=5)
        try:
            con.execute("PRAGMA query_only = 1")
            con.execute("PRAGMA busy_timeout = 5000")
            table = _kv_table(con)
            if not table:
                log.warn("assets fast path: no key/value table in %s", dbfile)
                return 0
            tname, kcol, vcol = table
            for key in keys:
                row = con.execute(f'SELECT "{vcol}" FROM "{tname}" WHERE "{kcol}" = ?', (key,)).fetchone()
                if row is None or row[0] is None:
                    continue
                val = row[0]
                data = val if isinstance(val, (bytes, bytearray)) else str(val).encode("latin-1", "ignore")
                if not data:
                    continue
                try:
                    store_bytes(key, bytes(data))
                    filled += 1
                except AssetError:
                    continue
        finally:
            con.close()
    except sqlite3.Error as e:
        log.warn("assets fast path: %s", e)
    return filled


def _kv_table(con: sqlite3.Connection) -> tuple[str, str, str] | None:
    """Find the key/value table without hard-coding PocketRisu's name."""
    names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    for name in sorted(names, key=lambda n: (n != "kv", n)):
        cols = [r[1] for r in con.execute(f'PRAGMA table_info("{name}")')]
        low = [c.lower() for c in cols]
        if "key" in low and "value" in low:
            return name, cols[low.index("key")], cols[low.index("value")]
    return None


# --- hub pull (account-synced web users) ------------------------------------

_pulls: dict[str, dict] = {}
_pull_lock = threading.Lock()


def _pull_state(ck: str) -> dict | None:
    with _pull_lock:
        p = _pulls.get(ck)
        return dict(p) if p else None


def _start_pull(ck: str, keys: list[str]) -> bool:
    with _pull_lock:
        cur = _pulls.get(ck)
        if cur and cur.get("running"):
            return True
        _pulls[ck] = {"running": True, "total": len(keys), "done": 0, "ok": 0,
                      "notFound": 0, "failed": 0, "bytes": 0, "startedAt": time.time()}
    t = threading.Thread(target=_pull_worker, args=(ck, list(keys)), daemon=True,
                         name=f"asset-pull-{ck[:8]}")
    t.start()
    return True


def _pull_worker(ck: str, keys: list[str]) -> None:
    import httpx
    workers = max(1, min(16, int(settings().get("hubWorkers") or 6)))
    timeout = float(settings().get("hubTimeoutSeconds") or 30)

    def bump(**delta: int) -> None:
        with _pull_lock:
            p = _pulls.get(ck)
            if not p:
                return
            for k, v in delta.items():
                p[k] = p.get(k, 0) + v

    def one(client: httpx.Client, key: str) -> None:
        try:
            r = client.get(HUB + key, timeout=timeout, follow_redirects=True)
            if r.status_code == 200 and r.content:
                store_bytes(key, r.content)
                bump(done=1, ok=1, bytes=len(r.content))
            elif r.status_code == 404:
                # Left 'missing' on purpose: the plugin's push is the fallback.
                db.execute("UPDATE asset_keys SET error=? WHERE risu_key=? AND state!='present'",
                           ("hub 404", key))
                bump(done=1, notFound=1)
            else:
                db.execute("UPDATE asset_keys SET error=? WHERE risu_key=? AND state!='present'",
                           (f"hub {r.status_code}", key))
                bump(done=1, failed=1)
        except Exception as e:  # noqa: BLE001 - one key must not stop the pull
            db.execute("UPDATE asset_keys SET error=? WHERE risu_key=? AND state!='present'",
                       (f"hub {type(e).__name__}"[:200], key))
            bump(done=1, failed=1)

    t0 = time.time()
    try:
        with httpx.Client(headers={"User-Agent": f"{config.APP_NAME}/{config.VERSION}"}) as client:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                list(pool.map(lambda k: one(client, k), keys))
    except Exception as e:  # noqa: BLE001
        log.error("assets pull char=%s aborted: %s", ck, e)
    finally:
        with _pull_lock:
            p = _pulls.get(ck)
            if p:
                p["running"] = False
                p["seconds"] = round(time.time() - t0, 1)
        st = _pull_state(ck) or {}
        log.info("assets pull char=%s total=%s ok=%s 404=%s failed=%s %.1fs",
                 ck, st.get("total"), st.get("ok"), st.get("notFound"), st.get("failed"),
                 time.time() - t0)


def pull_running(ck: str) -> bool:
    p = _pull_state(ck)
    return bool(p and p.get("running"))


def ensure_dir() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)


def summary_for_diag() -> dict[str, Any]:
    return {**store_stats(), **{k: v for k, v in fast_path_info().items() if k != "savePath"}}
