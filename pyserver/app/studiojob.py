"""Batches, on the `jobs` table that has been sitting unused since db v?.

A batch of thirty images is minutes of work, so the request that starts one has
to return immediately and the panel has to be able to ask how it is going -
the same shape the panel already uses for `permits` and `assets/status`. The
`jobs` table was created for exactly this and never wired to anything; this is
it being wired.

One worker thread per job, one image at a time. Not parallel: NovelAI queues by
account priority anyway, a batch that fails halfway should have produced the
images it got to, and a cancelled batch should stop at the next image rather
than mid-flight.

**Anlas is read before and after, always.** Generation is free at Opus and is
not free otherwise, so the job reports what actually moved rather than what we
predicted (docs/09 §4).
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Any

from . import db, log, nai, studio

_lock = threading.RLock()
_cancel: set[str] = set()

# ONE batch generates at a time, globally. NovelAI locks concurrent
# generation per account ("Concurrent generation is locked", HTTP 429), so
# jobs started together - an agent queuing per-character batches, the panel
# on top of an agent run - must take turns, not race. A job waiting its turn
# stays `pending` (the panel reads that as 대기) and still honours 취소.
_GEN_GATE = threading.Lock()

# Live previews stay in MEMORY, never in the jobs row: an intermediate frame
# arrives per diffusion step and weighs hundreds of KB - writing payload_json
# for each would grind SQLite for something worthless one second later.
_preview: dict[str, dict] = {}
_preview_lock = threading.Lock()


def _preview_put(job_id: str, step: int, total: int, current: str, png: bytes) -> None:
    with _preview_lock:
        rev = int(_preview.get(job_id, {}).get("rev", 0)) + 1
        _preview[job_id] = {"rev": rev, "step": step, "total": total,
                            "current": current, "png": png}


def preview(job_id: str, since: int) -> dict | None:
    """The newest intermediate frame, or just its rev when `since` has it.

    None means no frame exists (job unknown, finished, or not streaming) - the
    panel keeps polling the job row either way.
    """
    with _preview_lock:
        p = _preview.get(job_id)
        if not p:
            return None
        if int(p["rev"]) == int(since):
            return {"rev": p["rev"]}
        import base64
        return {"rev": p["rev"], "step": p["step"], "total": p["total"],
                "current": p["current"], "png": base64.b64encode(p["png"]).decode()}


def _row(job_id: str) -> dict | None:
    r = db.one("SELECT * FROM jobs WHERE id = ?", (job_id,))
    if r is None:
        return None
    d = db.row_to_dict(r)
    for key in ("payload_json", "result_json"):
        raw = d.pop(key, None)
        d[key[:-5]] = json.loads(raw) if raw else None
    return d


def get(job_id: str) -> dict | None:
    return _row(job_id)


def recent(limit: int = 10) -> list[dict]:
    rows = db.query("SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,))
    return [j for j in (_row(r["id"]) for r in rows) if j]


def cancel(job_id: str) -> bool:
    with _lock:
        _cancel.add(job_id)
    return True


def _update(job_id: str, **fields: Any) -> None:
    sets, params = [], []
    for k, v in fields.items():
        sets.append(f"{k} = ?")
        params.append(json.dumps(v, ensure_ascii=False) if k.endswith("_json") else v)
    params += [db.now(), job_id]
    db.execute(f"UPDATE jobs SET {', '.join(sets)}, updated_at = ? WHERE id = ?", params)


def start(spec: dict) -> dict:
    """Expand the batch, record it, and run it in the background.

    References follow the CARDS now: each item rides the vibe/charref presets
    of ITS OWN characters (a v2 `entries` batch mixes casts inside one job),
    resolved at run time. Explicit `vibes`/`charrefs` lists on the spec are
    still honored, and the legacy `useReference` key is accepted and ignored.
    """
    spec = studio.normalize_spec(spec)
    spec.pop("useReference", None)
    # A missing model is the default, not an empty string sent to NovelAI;
    # an unfamiliar id is asked about (free, ~330ms) so a typo fails the
    # batch ONCE with its name instead of failing every image.
    spec["model"] = str(spec.get("model") or "").strip() or nai.DEFAULT_MODEL
    if spec["model"] not in nai.KNOWN_MODELS and not nai.exists(spec["model"]):
        raise studio.StudioError(f"그런 모델이 없습니다: {spec['model']} (기본은 {nai.DEFAULT_MODEL})")
    items = studio.plan(spec)
    if not items:
        raise studio.StudioError("만들 이미지가 없습니다")

    # The estimate sees the union of the cards' references (the encodes it
    # names are per distinct image, which the run-time cache guarantees).
    model = str(spec.get("model") or "")
    est = dict(spec)
    if not est.get("vibes") and not est.get("charrefs"):
        union = sorted({c for i in items for c in (i.get("characters") or [])}) \
            or [str(c) for c in spec.get("characters") or []]
        vibes, charrefs = studio.refs_for_characters(union)
        if vibes and nai.supports_vibe(model):
            est["vibes"] = vibes
        if charrefs and nai.supports_charref(model):
            est["charrefs"] = charrefs

    job_id = "job_" + uuid.uuid4().hex[:12]
    now = db.now()
    payload = {"spec": spec, "items": items, "done": 0, "total": len(items),
               "saved": [], "failed": [], "anlasBefore": None, "anlasAfter": None}
    db.execute(
        "INSERT INTO jobs(id, kind, state, payload_json, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?)",
        (job_id, "studio_generate", "pending", json.dumps(payload, ensure_ascii=False), now, now))
    threading.Thread(target=_run, args=(job_id,), daemon=True,
                     name=f"studio-{job_id}").start()
    return {"jobId": job_id, "total": len(items),
            "estimate": studio.estimate(est, len(items)),
            "items": [{"name": i["name"], "scene": i.get("scene", ""),
                       "cast": i.get("cast", "")} for i in items],
            # References a scene names but no fragment collection provides.
            # Surfaced at the top so a batch is not started with a hole in
            # every prompt.
            "unresolved": sorted({r for i in items for r in i.get("unresolved", [])})}


def _run(job_id: str) -> None:
    # Wait for the account's one generation slot, cancellable while queued.
    while not _GEN_GATE.acquire(timeout=1.0):
        with _lock:
            if job_id in _cancel:
                _cancel.discard(job_id)
                _update(job_id, state="cancelled")
                return
    try:
        _run_locked(job_id)
    finally:
        _GEN_GATE.release()


def _run_locked(job_id: str) -> None:
    job = _row(job_id)
    if not job:
        return
    payload = job["payload"] or {}
    spec = payload.get("spec") or {}
    items = payload.get("items") or []
    model = str(spec.get("model") or "")
    folder = str(spec.get("folder") or "studio/output")
    params = dict(spec.get("params") or {})

    payload["anlasBefore"] = nai.anlas()
    _update(job_id, state="running", payload_json=payload)

    # References ride per ITEM (each item's own characters), cached so a
    # repeated image costs one encode: encode_vibe keys on (png, model,
    # information_extracted) and the in-run caches below skip even the disk
    # read. Director references (charrefs) are raw PNGs, no encode - but each
    # GENERATION carrying one costs 5 Anlas (docs/09 §7d), which estimate()
    # already said out loud. A model that cannot take a reference skips it
    # with a note instead of refusing the batch.
    explicit_vibes = spec.get("vibes") or []
    explicit_charrefs = spec.get("charrefs") or []
    vibe_cache: dict[tuple[str, float], dict] = {}
    charref_cache: dict[str, str] = {}
    skipped_refs = False
    bad_refs: set[str] = set()

    # Streaming is on unless the spec says otherwise, and turns itself off for
    # the REST of the batch after its first failure: the endpoint's framing is
    # measured from one client, so a batch must degrade to slower (ZIP), never
    # to broken. A content error fails the ZIP retry too and is recorded once.
    stream_ok = spec.get("streaming") is not False

    def generate_one(item: dict, p: dict, vibes: list[dict], charrefs: list[dict]) -> bytes:
        nonlocal stream_ok
        if stream_ok:
            total_steps = int(p.get("steps") or 28)

            def on_preview(step: int, png: bytes) -> None:
                _preview_put(job_id, step, total_steps, str(item["name"]), png)

            try:
                return nai.generate_stream(model, item["prompt"], item["negative"], p,
                                           vibes or None, charrefs or None,
                                           on_preview=on_preview)
            except Exception as e:  # noqa: BLE001
                stream_ok = False
                log.warn("studio batch %s: streaming failed (%s) - ZIP fallback for the rest", job_id, e)
        return nai.generate(model, item["prompt"], item["negative"], p,
                            vibes or None, charrefs or None)

    def item_refs(item: dict) -> tuple[list[dict], list[dict]]:
        nonlocal skipped_refs
        chars = item.get("characters")
        if chars is None:  # a legacy expansion: every item shares the spec's cast
            chars = [str(c) for c in spec.get("characters") or []]
        vibe_specs, charref_specs = studio.refs_for_characters(chars)
        if explicit_vibes:
            vibe_specs = explicit_vibes
        if explicit_charrefs:
            charref_specs = explicit_charrefs
        vibes: list[dict] = []
        charrefs: list[dict] = []
        # A reference the encoder cannot take (a WebP under a .png name, a
        # non-bucket size, a missing file) is SKIPPED with its reason kept in
        # the job note - one bad card must not fail every image in the batch.
        if vibe_specs:
            if not nai.supports_vibe(model):
                skipped_refs = True
            else:
                for ref in vibe_specs:
                    key = (str(ref["path"]), float(ref.get("informationExtracted", 1.0)))
                    try:
                        if key not in vibe_cache:
                            png = studio.read_bytes(key[0])
                            if nai.png_size(png) == (0, 0):
                                raise nai.NaiError("PNG 가 아닙니다")
                            enc, cached = nai.encode_vibe(png, model, key[1], studio.root())
                            vibe_cache[key] = {"enc": enc}
                            log.info("studio vibe %s %s", key[0], "(cached)" if cached else "(encoded, 2 Anlas)")
                        vibes.append(nai.vibe_entry(vibe_cache[key]["enc"],
                                                    float(ref.get("strength", 0.6)), key[1]))
                    except Exception as e:  # noqa: BLE001
                        bad_refs.add(f"{key[0].split('/')[-1]}: {e}")
        if charref_specs:
            if not nai.supports_charref(model):
                skipped_refs = True
            else:
                import base64 as _b64
                for ref in charref_specs:
                    path = str(ref["path"])
                    try:
                        if path not in charref_cache:
                            png = studio.read_bytes(path)
                            nai.check_charref_png(png, path)
                            charref_cache[path] = _b64.b64encode(png).decode()
                        charrefs.append({"image": charref_cache[path],
                                         "mode": str(ref.get("mode") or "character"),
                                         "strength": float(ref.get("strength", 0.6)),
                                         "fidelity": float(ref.get("fidelity", 0.6))})
                    except Exception as e:  # noqa: BLE001
                        bad_refs.add(f"{path.split('/')[-1]}: {e}")
        return vibes, charrefs

    for item in items:
        with _lock:
            if job_id in _cancel:
                _cancel.discard(job_id)
                with _preview_lock:
                    _preview.pop(job_id, None)
                payload["anlasAfter"] = nai.anlas()
                _update(job_id, state="cancelled", payload_json=payload)
                return
        # Which image is being drawn RIGHT NOW - the queue view's one fact
        # that done/total cannot give. Written before the generation so a
        # poll during the 4-8s wait sees it.
        payload["current"] = item["name"]
        _update(job_id, payload_json=payload)
        p = dict(params)
        if item.get("seed") is not None:
            p["seed"] = item["seed"]
        # A scene carries its own size in the preset file, and it wins: a
        # portrait and a wide shot are different scenes, not different runs.
        if item.get("size"):
            p["width"] = item["size"]["width"]
            p["height"] = item["size"]["height"]
        if item.get("charCaptions"):
            p["char_captions"] = item["charCaptions"]
            # Coordinates only when someone placed a character: captions alone
            # with use_coords on would tell the model about positions nobody set.
            p["use_coords"] = any(c.get("centers") for c in item["charCaptions"])
        try:
            vibes, charrefs = item_refs(item)
            notes = []
            if skipped_refs:
                notes.append("이 모델은 레퍼런스를 지원하지 않아 카드의 레퍼런스를 건너뜁니다.")
            if bad_refs:
                notes.append("건너뛴 레퍼런스: " + "; ".join(sorted(bad_refs))
                             + " — 카드를 열어 '맞추기' 또는 저장하면 고쳐집니다.")
            if notes:
                payload["note"] = " ".join(notes)
            png = generate_one(item, p, vibes, charrefs)
            saved = studio.save_image(folder, item["name"], png, {
                "scene": item.get("scene"), "prompt": item["prompt"],
                "negative": item["negative"], "model": model, "seed": item.get("seed"),
                "styles": spec.get("styles"),
                "characters": item.get("characters") or spec.get("characters"),
                "cast": item.get("cast") or "",
                "scenePreset": spec.get("scenePreset"),
            })
            payload["saved"].append(saved["path"])
        except Exception as e:  # noqa: BLE001
            # One bad image must not lose the batch: record it and carry on.
            payload["failed"].append({"name": item["name"], "error": str(e)})
            log.warn("studio batch %s: %s failed: %s", job_id, item["name"], e)
        payload["done"] += 1
        _update(job_id, payload_json=payload)

    with _preview_lock:
        _preview.pop(job_id, None)
    payload.pop("current", None)
    payload["anlasAfter"] = nai.anlas()
    before, after = payload["anlasBefore"], payload["anlasAfter"]
    spent = (before - after) if (before or 0) >= 0 and (after or 0) >= 0 else None
    result = {"saved": len(payload["saved"]), "failed": len(payload["failed"]),
              "anlasSpent": spent}
    _update(job_id, state="done" if not payload["failed"] else "partial",
            payload_json=payload, result_json=result)
    log.info("studio batch %s: %d saved, %d failed, %s Anlas",
             job_id, result["saved"], result["failed"], spent)


def cleanup(keep: int = 40) -> int:
    """Old job rows are a log, not state. Keep the recent ones."""
    rows = db.query("SELECT id FROM jobs ORDER BY created_at DESC LIMIT -1 OFFSET ?", (keep,))
    for r in rows:
        db.execute("DELETE FROM jobs WHERE id = ?", (r["id"],))
    return len(rows)
