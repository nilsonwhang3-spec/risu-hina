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
    """Expand the batch, record it, and run it in the background."""
    items = studio.plan(spec)
    if not items:
        raise studio.StudioError("만들 이미지가 없습니다")
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
            "estimate": studio.estimate(spec, len(items)),
            "items": [{"name": i["name"], "emotion": i["emotion"]} for i in items]}


def _run(job_id: str) -> None:
    job = _row(job_id)
    if not job:
        return
    payload = job["payload"] or {}
    spec = payload.get("spec") or {}
    items = payload.get("items") or []
    model = str(spec.get("model") or "")
    folder = str(spec.get("folder") or "images")
    params = dict(spec.get("params") or {})

    payload["anlasBefore"] = nai.anlas()
    _update(job_id, state="running", payload_json=payload)

    # References are encoded once for the whole batch: each encode is 2 Anlas,
    # so doing it per image would multiply the only certain cost by the batch
    # size. The cache makes a repeat batch free as well.
    vibes: list[dict] = []
    try:
        for ref in spec.get("vibes") or []:
            png = studio.read_bytes(str(ref["path"]))
            enc, cached = nai.encode_vibe(
                png, model, float(ref.get("informationExtracted", 1.0)), studio.root())
            vibes.append(nai.vibe_entry(enc, float(ref.get("strength", 0.6)),
                                        float(ref.get("informationExtracted", 1.0))))
            log.info("studio vibe %s %s", ref["path"], "(cached)" if cached else "(encoded, 2 Anlas)")
    except Exception as e:  # noqa: BLE001
        payload["anlasAfter"] = nai.anlas()
        _update(job_id, state="error", error=str(e), payload_json=payload)
        return

    for item in items:
        with _lock:
            if job_id in _cancel:
                _cancel.discard(job_id)
                payload["anlasAfter"] = nai.anlas()
                _update(job_id, state="cancelled", payload_json=payload)
                return
        p = dict(params)
        if item.get("seed") is not None:
            p["seed"] = item["seed"]
        if item.get("charCaptions"):
            p["char_captions"] = item["charCaptions"]
            p["use_coords"] = True
        try:
            png = nai.generate(model, item["prompt"], item["negative"], p, vibes or None)
            saved = studio.save_image(folder, item["name"], png, {
                "emotion": item["emotion"], "prompt": item["prompt"],
                "negative": item["negative"], "model": model, "seed": item.get("seed"),
                "style": spec.get("style"), "characters": spec.get("characters"),
                "emotionPreset": spec.get("emotionPreset"),
            })
            payload["saved"].append(saved["path"])
        except Exception as e:  # noqa: BLE001
            # One bad image must not lose the batch: record it and carry on.
            payload["failed"].append({"name": item["name"], "error": str(e)})
            log.warn("studio batch %s: %s failed: %s", job_id, item["name"], e)
        payload["done"] += 1
        _update(job_id, payload_json=payload)

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
