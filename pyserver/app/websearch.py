"""Web search, behind one interface with several providers.

Provider registry shape borrowed from cocoAgent, which had already worked out
which endpoints are worth supporting. Unconfigured is the default and the tool
is simply not offered to the agent in that case - an agent with a search tool
that always errors is worse than one without it.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from . import config, log

TIMEOUT = 25
MAX_RESULTS = 8


def _cfg() -> dict:
    return config.section("websearch")


def configured() -> bool:
    c = _cfg()
    provider = (c.get("provider") or "").strip()
    if not provider:
        return False
    # searxng is the one that runs without a key.
    return provider == "searxng" or bool((c.get("apiKey") or "").strip())


def search(query: str) -> str:
    c = _cfg()
    provider = (c.get("provider") or "").strip().lower()
    key = (c.get("apiKey") or "").strip()
    base = (c.get("baseUrl") or "").strip()
    limit = max(1, min(MAX_RESULTS, int(c.get("maxResults") or 5)))

    try:
        if provider == "brave":
            results = _brave(query, key, base or "https://api.search.brave.com/res/v1/web/search", limit)
        elif provider == "tavily":
            results = _tavily(query, key, base or "https://api.tavily.com/search", limit)
        elif provider == "serper":
            results = _serper(query, key, base or "https://google.serper.dev/search", limit)
        elif provider == "searxng":
            results = _searxng(query, base, limit)
        else:
            return f"지원하지 않는 검색 프로바이더입니다: {provider or '(미설정)'}"
    except Exception as e:  # noqa: BLE001 - a failed search degrades the turn, never fails it
        log.warn("websearch failed provider=%s: %s", provider, e)
        return f"검색에 실패했습니다: {type(e).__name__}"

    if not results:
        return f"'{query}' 검색 결과가 없습니다"
    return "\n\n".join(
        f"{r['title']}\n{r['url']}\n{r['snippet']}" for r in results
    )


def _post(url: str, headers: dict, payload: Any) -> dict:
    r = httpx.post(url, headers=headers, json=payload, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def _get(url: str, headers: dict, params: dict) -> dict:
    r = httpx.get(url, headers=headers, params=params, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def _brave(q: str, key: str, url: str, n: int) -> list[dict]:
    data = _get(url, {"X-Subscription-Token": key, "Accept": "application/json"},
                {"q": q, "count": n})
    return [
        {"title": w.get("title", ""), "url": w.get("url", ""),
         "snippet": w.get("description", "")}
        for w in (data.get("web", {}).get("results") or [])[:n]
    ]


def _tavily(q: str, key: str, url: str, n: int) -> list[dict]:
    data = _post(url, {"Content-Type": "application/json"},
                 {"api_key": key, "query": q, "max_results": n})
    return [
        {"title": w.get("title", ""), "url": w.get("url", ""),
         "snippet": w.get("content", "")}
        for w in (data.get("results") or [])[:n]
    ]


def _serper(q: str, key: str, url: str, n: int) -> list[dict]:
    data = _post(url, {"X-API-KEY": key, "Content-Type": "application/json"},
                 {"q": q, "num": n})
    return [
        {"title": w.get("title", ""), "url": w.get("link", ""),
         "snippet": w.get("snippet", "")}
        for w in (data.get("organic") or [])[:n]
    ]


def _searxng(q: str, base: str, n: int) -> list[dict]:
    if not base:
        raise ValueError("searxng needs baseUrl")
    data = _get(base.rstrip("/") + "/search", {"Accept": "application/json"},
                {"q": q, "format": "json"})
    return [
        {"title": w.get("title", ""), "url": w.get("url", ""),
         "snippet": w.get("content", "")}
        for w in (data.get("results") or [])[:n]
    ]


def describe() -> str:
    c = _cfg()
    return json.dumps({"provider": c.get("provider") or "", "configured": configured()},
                      ensure_ascii=False)
