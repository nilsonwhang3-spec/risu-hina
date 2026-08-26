"""The model catalog: models.dev, cached, searchable.

"Which base URL does this provider use and what are its models called" is
the question every preset starts with, and the answer changes monthly.
models.dev (https://models.dev/api.json, maintained by the opencode team)
publishes exactly that - ~200 providers with their API base, docs link and
every model's id, context/output limits, prices and capabilities - so the
settings page searches it instead of shipping a list that would be stale by
the next release.

Fetched at most once a day into data/models-dev.json; served from the cache
when the network is down. Nothing here is required for the agent to run.
"""
from __future__ import annotations

import json
import time
from typing import Any

from . import config, log

URL = "https://models.dev/api.json"
CACHE = config.DATA_DIR / "models-dev.json"
MAX_AGE_S = 24 * 3600
MAX_RESULTS = 80

_mem: dict[str, Any] | None = None
_mem_at = 0.0


def _load(force: bool = False) -> dict[str, Any]:
    global _mem, _mem_at
    now = time.time()
    if _mem is not None and not force and now - _mem_at < MAX_AGE_S:
        return _mem
    if not force and CACHE.is_file() and now - CACHE.stat().st_mtime < MAX_AGE_S:
        try:
            _mem = json.loads(CACHE.read_text(encoding="utf-8"))
            _mem_at = now
            return _mem
        except (OSError, ValueError):
            pass
    try:
        import httpx
        r = httpx.get(URL, timeout=20, follow_redirects=True,
                      headers={"User-Agent": f"{config.APP_NAME}/{config.VERSION}"})
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict) or not data:
            raise ValueError("unexpected shape")
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(data), encoding="utf-8")
        _mem, _mem_at = data, now
        log.info("model catalog refreshed: %s providers", len(data))
        return data
    except Exception as e:  # noqa: BLE001 - the cache is the fallback
        log.warn("model catalog fetch failed: %s", e)
        if CACHE.is_file():
            try:
                _mem = json.loads(CACHE.read_text(encoding="utf-8"))
                _mem_at = now
                return _mem
            except (OSError, ValueError):
                pass
        return _mem or {}


def _provider(pid: str, p: dict) -> dict:
    return {
        "id": pid,
        "name": str(p.get("name") or pid),
        "api": str(p.get("api") or ""),
        "doc": str(p.get("doc") or ""),
        "env": list(p.get("env") or []),
        "models": len(p.get("models") or {}),
    }


def _model(pid: str, mid: str, m: dict) -> dict:
    lim = m.get("limit") or {}
    cost = m.get("cost") or {}
    return {
        "provider": pid,
        "id": mid,
        "name": str(m.get("name") or mid),
        "reasoning": bool(m.get("reasoning")),
        "toolCall": bool(m.get("tool_call")),
        "context": lim.get("context"),
        "output": lim.get("output"),
        "costIn": cost.get("input"),
        "costOut": cost.get("output"),
        "releaseDate": m.get("release_date") or "",
    }


def provider_api(provider: str) -> str:
    """The OpenAI-compatible base URL models.dev lists for a provider, matched
    by id or display name (case-insensitive); '' when unknown. A few common
    ones are pinned so the key page works before the catalog has been fetched."""
    want = (provider or "").strip().lower()
    if not want:
        return ""
    pinned = {
        "openai": "https://api.openai.com/v1",
        "google": "https://generativelanguage.googleapis.com/v1beta/openai",
        "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
        "anthropic": "https://api.anthropic.com/v1",
        "openrouter": "https://openrouter.ai/api/v1",
        "vercel": "https://ai-gateway.vercel.sh/v1",
        "groq": "https://api.groq.com/openai/v1",
        "deepseek": "https://api.deepseek.com/v1",
        "xai": "https://api.x.ai/v1",
        "mistral": "https://api.mistral.ai/v1",
        "ollama": "https://ollama.com/v1",
    }
    data = _load()
    for pid, p in data.items():
        if not isinstance(p, dict):
            continue
        if pid.lower() == want or str(p.get("name") or "").lower() == want:
            api = str(p.get("api") or "").rstrip("/")
            if api:
                return api
            break
    return pinned.get(want, "")


def search(q: str, *, provider: str = "", refresh: bool = False) -> dict:
    """Providers and models matching `q` (substring on ids and names).
    `provider` narrows to one provider's models; empty `q` with a provider
    lists that provider whole."""
    data = _load(force=refresh)
    needle = (q or "").strip().lower()
    want = (provider or "").strip().lower()
    providers: list[dict] = []
    models: list[dict] = []
    for pid, p in data.items():
        if not isinstance(p, dict):
            continue
        pname = str(p.get("name") or pid)
        p_hit = needle and (needle in pid.lower() or needle in pname.lower())
        if want and pid.lower() != want:
            continue
        if p_hit or want or not needle:
            providers.append(_provider(pid, p))
        for mid, m in (p.get("models") or {}).items():
            if not isinstance(m, dict):
                continue
            mname = str(m.get("name") or mid)
            if want or p_hit or (needle and (needle in mid.lower() or needle in mname.lower())):
                models.append(_model(pid, mid, m))
                if len(models) >= MAX_RESULTS:
                    break
        if len(models) >= MAX_RESULTS:
            break
    providers.sort(key=lambda x: x["name"].lower())
    stale = bool(CACHE.is_file()) and time.time() - CACHE.stat().st_mtime > MAX_AGE_S
    return {
        "query": q, "provider": provider,
        "providers": providers if (needle or want) else providers[:MAX_RESULTS],
        "models": models, "truncated": len(models) >= MAX_RESULTS,
        "totalProviders": len(data), "cachedAt": CACHE.stat().st_mtime if CACHE.is_file() else 0,
        "stale": stale, "source": URL,
    }
