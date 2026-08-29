"""The NovelAI image client. Written from `docs/09`, not from memory.

Every constant here was observed in a response on 2026-08-29 — the host, the
envelope, the field names, the prices. `docs/09` is the record; this file is
that record as code, and the two are meant to be read together. If NovelAI
changes something, re-run `tools/probe_nai.py`, update `docs/09`, then change
this.

Three things are deliberately **not** hardcoded:

  models        There is no endpoint that lists them and no published schema.
                A model id is data (it comes from a preset) and `exists()` asks
                the service, which answers in ~330ms for nothing.
  parameters    Same reason. `DEFAULTS` below is a floor that produced a 200,
                not a schema; a preset's `params` is merged over it and unknown
                keys ride along untouched.
  what is free  Generation cost nothing throughout the probe because that
                account is Opus. It is an entitlement, not a property of the
                API, so nothing here says "free" - `subscription()` is read
                before and after and the difference is reported.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import httpx

from . import config, db, log

BASE = "https://image.novelai.net"

# Measured: validation answers in ~330ms, a generation in 4-8s, and a director
# call in 6-13s. The long one is the ceiling.
TIMEOUT = 300.0
QUICK_TIMEOUT = 60.0

# An impossible size: the model-existence check must never be able to produce
# an image. With `parameters: {}` the service fills in defaults and generates -
# that is how one probe run made a picture it did not mean to (docs/09 §5).
NO_GENERATE = {"width": 7, "height": 7}

# A floor that returned 200 on nai-diffusion-4-5-full and -5-full. Accepted as
# a set; no field here is proven individually necessary, and a preset may
# replace any of it.
DEFAULTS: dict[str, Any] = {
    "params_version": 3,
    "width": 832,
    "height": 1216,
    "scale": 5,
    "sampler": "k_euler_ancestral",
    "steps": 23,
    "n_samples": 1,
    "ucPreset": 0,
    "qualityToggle": True,
    "cfg_rescale": 0,
    "noise_schedule": "karras",
}

# `req_type` values the service recognises. An unknown one is refused by name,
# which is how this list was found; the control is in docs/09 §7b. These are
# touch-up tools - an expression set is made with an emotion preset and
# ordinary generations, not with `emotion` here.
DIRECTOR_ACTIONS = ("emotion", "bg-removal", "lineart", "declutter", "colorize", "sketch")

# Vibe transfer is two calls and the first one is the one you pay for, so its
# result is cached by (image, model, information_extracted) - all three change
# the output. Re-encoding one reference across a batch of thirty is thirty
# times the price of encoding it once.
VIBE_CACHE_DIR = ".studio/vibe"


class NaiError(RuntimeError):
    pass


def token() -> str:
    """The persistent token.

    The `api_keys` row whose provider is `novelai` is the normal place - it is
    what the settings page writes. `NAI_API_KEY` in the environment wins over
    it, for the same reason every other `RISUHINA_*` override exists: an
    operator running this as a service may want the secret in their process
    manager rather than in the data directory.
    """
    import os
    env = (os.environ.get("NAI_API_KEY") or "").strip()
    if env:
        return env
    row = db.one(
        "SELECT api_key FROM api_keys WHERE lower(provider) IN ('novelai','nai') "
        "AND api_key <> '' ORDER BY updated_at DESC LIMIT 1")
    return str(row["api_key"]) if row else ""


def configured() -> bool:
    return bool(token())


def _client(timeout: float = TIMEOUT) -> httpx.Client:
    t = token()
    if not t:
        raise NaiError("NovelAI 토큰이 없습니다 — 설정 → API 키에 provider 'novelai' 로 추가해 주세요")
    return httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {t}",
                 "Content-Type": "application/json",
                 "User-Agent": f"{config.APP_NAME}/{config.VERSION}"},
        timeout=timeout,
    )


def _fail(r: httpx.Response, what: str) -> NaiError:
    """NovelAI's errors are short and worth quoting; a 500 has no body worth
    reading, so say what we asked for instead of pretending it explained."""
    try:
        msg = str(r.json().get("message") or "")
    except Exception:  # noqa: BLE001
        msg = ""
    if not msg:
        msg = f"HTTP {r.status_code}" + (" (본문 없음)" if not r.content else "")
    return NaiError(f"{what}: {msg}")


# --- account -----------------------------------------------------------------

def subscription() -> dict:
    """Anlas and the v5 usage meter. Two separate currencies (docs/09 §2)."""
    with _client(QUICK_TIMEOUT) as c:
        r = c.get("/user/subscription")
        if r.status_code >= 300:
            raise _fail(r, "구독 정보를 읽지 못했습니다")
        d = r.json()
    steps = d.get("trainingStepsLeft") or {}
    usage = d.get("usage") or {}
    return {
        "anlas": int(steps.get("fixedTrainingStepsLeft") or 0)
                 + int(steps.get("purchasedTrainingSteps") or 0),
        "fixed": int(steps.get("fixedTrainingStepsLeft") or 0),
        "purchased": int(steps.get("purchasedTrainingSteps") or 0),
        # The v5 quota. Reported as NovelAI reports it - nothing is derived
        # from it, because what it counts was never watched changing.
        "usagePercent": usage.get("percent"),
        "usageNegative": bool(usage.get("isNegative")),
        "tier": d.get("tier"),
        "active": bool(d.get("active")),
        "expiresAt": d.get("expiresAt"),
    }


def anlas() -> int:
    try:
        return int(subscription()["anlas"])
    except Exception:  # noqa: BLE001
        return -1


# --- models ------------------------------------------------------------------

def exists(model: str) -> bool:
    """Does this model id exist? Free, and cannot generate (see NO_GENERATE)."""
    if not model:
        return False
    with _client(QUICK_TIMEOUT) as c:
        r = c.post("/ai/generate-image",
                   json={"input": "x", "model": model, "parameters": dict(NO_GENERATE)})
    if r.status_code == 200:
        # Would mean the guard stopped working - a 200 here is an image we did
        # not want and may have paid for. Loud, not silent.
        log.warn("nai: existence check for %s produced a response body (%d bytes)",
                 model, len(r.content))
        return True
    try:
        return "doesn't exist" not in str(r.json().get("message") or "")
    except Exception:  # noqa: BLE001
        return True


# --- generation --------------------------------------------------------------

def _unzip(raw: bytes, what: str) -> bytes:
    """The response is a ZIP holding `image_0.png`; it is never a bare PNG."""
    if raw[:4] == b"\x89PNG":
        return raw
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
        name = next((n for n in z.namelist() if n.lower().endswith(".png")), "")
        if not name:
            raise NaiError(f"{what}: ZIP 안에 PNG 가 없습니다 ({z.namelist()})")
        return z.read(name)
    except zipfile.BadZipFile as e:
        raise NaiError(f"{what}: 응답이 ZIP 도 PNG 도 아닙니다 ({len(raw)} 바이트)") from e


def build_parameters(prompt: str, negative: str, params: dict | None = None,
                     vibes: list[dict] | None = None) -> dict:
    """The `parameters` object for one generation.

    `params` is the preset's, merged over DEFAULTS with unknown keys kept - the
    preset is data and may carry fields this file has never heard of. `vibes`
    is a list of {encoding, strength, informationExtracted}: the *multiple*
    naming is NovelAI's and it means exactly that, a list with per-item
    strengths (docs/09 §7).
    """
    p = {**DEFAULTS, **(params or {})}
    p["negative_prompt"] = negative
    p["v4_prompt"] = {
        "caption": {"base_caption": prompt,
                    "char_captions": p.pop("char_captions", []) or []},
        "use_coords": bool(p.pop("use_coords", False)),
        "use_order": bool(p.pop("use_order", True)),
    }
    p["v4_negative_prompt"] = {
        "caption": {"base_caption": negative,
                    "char_captions": p.pop("negative_char_captions", []) or []},
        "legacy_uc": False,
    }
    if vibes:
        p["reference_image_multiple"] = [v["encoding"] for v in vibes]
        p["reference_information_extracted_multiple"] = [
            float(v.get("informationExtracted", 1.0)) for v in vibes]
        p["reference_strength_multiple"] = [float(v.get("strength", 0.6)) for v in vibes]
    return p


def generate(model: str, prompt: str, negative: str = "",
             params: dict | None = None, vibes: list[dict] | None = None) -> bytes:
    """One image, as PNG bytes."""
    body = {"input": prompt, "model": model, "action": "generate",
            "parameters": build_parameters(prompt, negative, params, vibes)}
    with _client() as c:
        r = c.post("/ai/generate-image", json=body)
    if r.status_code >= 300:
        raise _fail(r, "생성에 실패했습니다")
    return _unzip(r.content, "생성")


def augment(action: str, model: str, png: bytes, prompt: str = "",
            width: int = 0, height: int = 0) -> bytes:
    """A director tool. About 10 Anlas a call - the expensive path."""
    if action not in DIRECTOR_ACTIONS:
        raise NaiError(f"모르는 도구입니다: {action} (가능: {', '.join(DIRECTOR_ACTIONS)})")
    w, h = (width, height) if width and height else png_size(png)
    body = {"req_type": action, "model": model,
            "image": base64.b64encode(png).decode(), "prompt": prompt,
            "width": w, "height": h}
    with _client() as c:
        r = c.post("/ai/augment-image", json=body)
    if r.status_code >= 300:
        raise _fail(r, f"{action} 에 실패했습니다")
    return _unzip(r.content, action)


# --- vibe transfer -----------------------------------------------------------

def supports_vibe(model: str) -> bool:
    """v5 cannot encode a vibe; v4.5 can (measured, docs/09 §7)."""
    return "diffusion-4" in model


def _vibe_key(png: bytes, model: str, information_extracted: float) -> str:
    h = hashlib.sha256()
    h.update(png)
    h.update(model.encode("utf-8"))
    h.update(f"{information_extracted:.4f}".encode("ascii"))
    return h.hexdigest()


def encode_vibe(png: bytes, model: str, information_extracted: float = 1.0,
                cache_root: Path | None = None) -> tuple[bytes, bool]:
    """Encode a reference image. Returns (encoding, was_cached).

    **2 Anlas every time it actually runs**, so the cache is a cost control
    rather than a speed one. A raw image cannot be used instead - putting one
    straight into `reference_image_multiple` is a 500 (docs/09 §7).
    """
    if not supports_vibe(model):
        raise NaiError(f"{model} 은 바이브 트랜스퍼를 지원하지 않습니다 (v5 는 아직 불가)")
    key = _vibe_key(png, model, information_extracted)
    cached = (cache_root / VIBE_CACHE_DIR / f"{key}.bin") if cache_root else None
    if cached and cached.is_file():
        return cached.read_bytes(), True
    with _client() as c:
        r = c.post("/ai/encode-vibe", json={
            "model": model,
            "image": base64.b64encode(png).decode(),
            "information_extracted": information_extracted,
        })
    if r.status_code >= 300:
        raise _fail(r, "레퍼런스 인코딩에 실패했습니다")
    if cached:
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(r.content)
    return r.content, False


def vibe_entry(encoding: bytes, strength: float = 0.6,
               information_extracted: float = 1.0) -> dict:
    return {"encoding": base64.b64encode(encoding).decode(),
            "strength": strength, "informationExtracted": information_extracted}


# --- reading a NovelAI PNG ----------------------------------------------------

def png_size(png: bytes) -> tuple[int, int]:
    if len(png) < 24 or png[:4] != b"\x89PNG":
        return 0, 0
    return int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")


def recipe(png: bytes) -> dict:
    """The generation parameters NovelAI embedded in its own output.

    A NovelAI PNG carries `Comment` as JSON holding every applied parameter,
    defaults included (docs/09 §5b). So an image is self-describing: "make more
    like this one" needs no bookkeeping of ours, and an image made elsewhere
    can be read the same way. Returns {} for anything that is not one.
    """
    out: dict[str, Any] = {}
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        return out
    off = 8
    while off + 12 <= len(png):
        length = int.from_bytes(png[off:off + 4], "big")
        kind = png[off + 4:off + 8]
        if kind == b"IDAT":
            break
        if kind == b"tEXt":
            key, _, value = png[off + 8:off + 8 + length].partition(b"\x00")
            name = key.decode("latin-1", "replace")
            text = value.decode("utf-8", "replace")
            if name == "Comment":
                try:
                    out["parameters"] = json.loads(text)
                except ValueError:
                    out["comment"] = text
            else:
                out[name.lower()] = text
        off += 12 + length
    return out
