"""Web search, behind one interface with several providers.

Provider registry shape borrowed from cocoAgent, which had already worked out
which endpoints are worth supporting. Unconfigured is the default and the tool
is simply not offered to the agent in that case - an agent with a search tool
that always errors is worse than one without it.
"""
from __future__ import annotations

import html
import json
import re
import urllib.parse
from typing import Any

import httpx

from . import config, log

TIMEOUT = 25
MAX_RESULTS = 8


# What the settings card lists. `needsKey` / `needsUrl` drive its fields; the
# note is the one line a person needs to pick. DuckDuckGo first: it is what
# runs with nothing configured, so a fresh install can search at once.
PROVIDERS: list[dict] = [
    {"id": "duckduckgo", "name": "DuckDuckGo (기본 · 키 없음)", "needsKey": False, "needsUrl": False,
     "note": "비공식 HTML 엔드포인트를 읽습니다. 설정 없이 바로 되지만 결과가 적고 가끔 차단됩니다."},
    {"id": "brave", "name": "Brave Search", "needsKey": True, "needsUrl": False,
     "note": "api.search.brave.com 구독 키. 월 무료 구간이 있습니다."},
    {"id": "tavily", "name": "Tavily", "needsKey": True, "needsUrl": False,
     "note": "LLM 용 검색 API. tavily.com 키."},
    {"id": "serper", "name": "Serper (Google)", "needsKey": True, "needsUrl": False,
     "note": "구글 결과. serper.dev 키."},
    {"id": "searxng", "name": "SearXNG (자체 호스팅)", "needsKey": False, "needsUrl": True,
     "note": "내 SearXNG 인스턴스 주소(JSON 출력 허용 필요)."},
    # Measured 2026-08-28 on the operator's box: codex web_search answered a
    # "latest release" question exactly in 8.8s (search + open_page, no extra
    # cost on the subscription); Vercel's gateway search with Gemini took
    # 10-17s at $0.03-0.07 a question and one of its two engines was five
    # months stale. Offered because it needs no key of its own, not as the
    # default: a fresh install may have neither.
    {"id": "native", "name": "모델 내장 검색 (codex · Vercel AI Gateway)", "needsKey": False, "needsUrl": False,
     "note": "검색 에이전트 모델 쪽의 검색을 그대로 씁니다 — codex(ChatGPT 구독)는 OpenAI web_search, "
             "Vercel AI Gateway 주소면 게이트웨이의 exa 검색. 그 밖의 엔드포인트에서는 안 됩니다."},
]
DEFAULT_PROVIDER = "duckduckgo"
VERCEL_HOST = "ai-gateway.vercel.sh"


def native_kind() -> str:
    """Which built-in search the *search agent's* endpoint can do: 'codex',
    'vercel', or '' when that endpoint has none we know how to call."""
    cfg = config.section("agent_search")
    if (cfg.get("provider") or "") == "codex":
        return "codex"
    host = urllib.parse.urlparse(str(cfg.get("baseUrl") or "")).hostname or ""
    if host.endswith(VERCEL_HOST) and cfg.get("apiKey") and cfg.get("model"):
        return "vercel"
    return ""


def native_why_not() -> str:
    cfg = config.section("agent_search")
    host = urllib.parse.urlparse(str(cfg.get("baseUrl") or "")).hostname or "(주소 없음)"
    where = "codex" if (cfg.get("provider") or "") == "codex" else host
    return (f"내장 검색은 검색 에이전트가 codex(ChatGPT 구독) 프리셋이거나 Vercel AI Gateway 주소일 때만 됩니다 "
            f"— 지금 검색 에이전트: {cfg.get('model') or '(모델 없음)'} @ {where}")


def _cfg() -> dict:
    return config.section("websearch")


def provider_id() -> str:
    return ((_cfg().get("provider") or "").strip().lower()) or DEFAULT_PROVIDER


def configured() -> bool:
    """Whether a search can be attempted: the keyless providers always, the
    keyed ones once a key is there. Empty means DuckDuckGo, so this is only
    False when a keyed provider was picked and its key was not."""
    c = _cfg()
    provider = provider_id()
    meta = next((p for p in PROVIDERS if p["id"] == provider), None)
    if meta is None:
        return False
    if provider == "native":
        return bool(native_kind())
    if meta["needsKey"] and not (c.get("apiKey") or "").strip():
        return False
    if meta["needsUrl"] and not (c.get("baseUrl") or "").strip():
        return False
    return True


def why_not() -> str:
    """The one sentence to show when `configured()` is False."""
    provider = provider_id()
    meta = next((p for p in PROVIDERS if p["id"] == provider), None)
    if meta is None:
        return f"모르는 검색 제공자입니다: {provider}"
    if provider == "native":
        return native_why_not()
    if meta["needsKey"]:
        return f"{meta['name']} 에는 API 키가 필요합니다 (⚙ → 에이전트 → 검색 제공자)"
    return f"{meta['name']} 에는 주소가 필요합니다 (⚙ → 에이전트 → 검색 제공자)"


def search(query: str) -> str:
    c = _cfg()
    provider = provider_id()
    key = (c.get("apiKey") or "").strip()
    base = (c.get("baseUrl") or "").strip()
    limit = max(1, min(MAX_RESULTS, int(c.get("maxResults") or 5)))
    if not configured():
        return why_not()
    if provider == "native":
        # Not a query→results function: the model does the searching inside
        # its own turn. agent.research() takes that path before calling here.
        return "내장 검색은 검색 에이전트 안에서 실행됩니다 (web_research 툴)"

    try:
        if provider == "duckduckgo":
            results = _duckduckgo(query, limit)
        elif provider == "brave":
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
        return f"검색에 실패했습니다 ({provider}): {type(e).__name__}: {str(e)[:160]}"

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


_DDG_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
_DDG_RESULT = re.compile(
    r'<a[^>]+class="result__a"[^>]+href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>.*?'
    r'(?:<a[^>]+class="result__snippet"[^>]*>(?P<snippet>.*?)</a>)?',
    re.S)
_TAG = re.compile(r"<[^>]+>")


def _duckduckgo(q: str, n: int) -> list[dict]:
    """The HTML endpoint, parsed. Unofficial and rate-limited, which is why it
    is the default and not the recommendation: it works with nothing set up,
    and a keyed provider is one card away when it stops."""
    r = httpx.post("https://html.duckduckgo.com/html/", data={"q": q, "kl": "kr-kr"},
                   headers={"User-Agent": _DDG_UA, "Accept-Language": "ko,en;q=0.8"},
                   timeout=TIMEOUT, follow_redirects=True)
    r.raise_for_status()
    text = r.text
    if "anomaly" in r.url.path or "bot" in text[:2000].lower() and "result__a" not in text:
        raise RuntimeError("DuckDuckGo 가 요청을 차단했습니다 (잠시 뒤 다시, 또는 키 있는 제공자로)")
    out: list[dict] = []
    for m in _DDG_RESULT.finditer(text):
        href = html.unescape(m.group("href"))
        # Result links are wrapped: //duckduckgo.com/l/?uddg=<encoded url>&rut=…
        if "uddg=" in href:
            href = urllib.parse.unquote(href.split("uddg=", 1)[1].split("&", 1)[0])
        title = html.unescape(_TAG.sub("", m.group("title") or "")).strip()
        snippet = html.unescape(_TAG.sub("", m.group("snippet") or "")).strip()
        if not title or not href.startswith("http"):
            continue
        out.append({"title": title, "url": href, "snippet": snippet})
        if len(out) >= n:
            break
    return out


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
    return json.dumps({"provider": provider_id(), "configured": configured()},
                      ensure_ascii=False)


def status() -> dict:
    """For the settings card: the choices, what is set, and whether it can run."""
    c = _cfg()
    return {
        "providers": PROVIDERS,
        "provider": provider_id(),
        "apiKeySet": bool((c.get("apiKey") or "").strip()),
        "baseUrl": c.get("baseUrl") or "",
        "maxResults": int(c.get("maxResults") or 5),
        "configured": configured(),
        "whyNot": "" if configured() else why_not(),
    }
