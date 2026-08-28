"""The web search tool, three ways.

One card under the general agent, one tool (`web_search`) on the agent, and
a mode that decides who actually touches the web:

    native    the main agent's own endpoint searches - OpenAI/codex
              Responses `web_search`, Vercel's gateway search, Ollama cloud's
              search API, Anthropic's web_search, Gemini grounding... The
              shape is found by trying, not by whitelisting hosts: the test
              button runs the candidates and remembers the first that answers
              (`nativeShape`), so a gateway we have never seen still gets a go.
    gemini    a helper agent pinned to Google AI Studio with Google Search
              grounding: instructions, model (gemini-3.7-flash), a key from
              the key list or typed in. Cheap, and it reads the pages itself.
    provider  a search API returns title/url/snippet and the main agent reads
              them. DuckDuckGo needs nothing and is the default; the keyed
              ones (Brave, Tavily, Serper, Firecrawl, SearXNG) are one field.

Before this there was a "search agent" preset *and* a provider card, and the
question "why are there two?" was fair: the preset was a model, the provider
was the engine, and neither could be tested as one thing.
"""
from __future__ import annotations

import asyncio
import html
import json
import re
import time
import urllib.parse
from typing import Any, Awaitable, Callable

import httpx

from . import codexauth, config, keys, log

TIMEOUT = 25
MAX_RESULTS = 8
# One native-shape attempt. The measured ones were 4-17s; a gateway that
# holds a request longer than this is not going to answer.
NATIVE_TIMEOUT = 60

MODES: list[dict] = [
    {"id": "native", "name": "메인 에이전트 내장 검색툴 사용",
     "note": "일반 에이전트의 모델·주소가 제공하는 검색을 그대로 씁니다 (OpenAI/codex web_search, Vercel 게이트웨이 검색, "
             "Ollama 클라우드 검색, Anthropic·Gemini 내장 검색 …). 되는지는 테스트로 확인합니다 — 첫 성공한 방식을 기억합니다."},
    {"id": "gemini", "name": "Gemini 보조 에이전트 사용",
     "note": "Google AI Studio 의 Gemini 가 Google 검색으로 찾고 읽어 정리한 답(출처 포함)을 돌려줍니다. 저렴하고 정확한 편입니다."},
    {"id": "provider", "name": "외부 검색 제공자 사용",
     "note": "검색 API 가 제목·URL·요약을 돌려주고 일반 에이전트가 읽습니다. DuckDuckGo 는 키 없이 바로 됩니다."},
]

PROVIDERS: list[dict] = [
    {"id": "duckduckgo", "name": "DuckDuckGo (기본 · 키 없음)", "needsKey": False, "needsUrl": False,
     "note": "비공식 HTML 엔드포인트를 읽습니다. 설정 없이 바로 되지만 결과가 적고 가끔 차단됩니다."},
    {"id": "brave", "name": "Brave Search", "needsKey": True, "needsUrl": False,
     "note": "api.search.brave.com 구독 키. 월 무료 구간이 있습니다."},
    {"id": "tavily", "name": "Tavily", "needsKey": True, "needsUrl": False,
     "note": "LLM 용 검색 API. tavily.com 키."},
    {"id": "serper", "name": "Serper (Google)", "needsKey": True, "needsUrl": False,
     "note": "구글 결과. serper.dev 키."},
    {"id": "firecrawl", "name": "Firecrawl", "needsKey": True, "needsUrl": False,
     "note": "firecrawl.dev 키. 결과와 함께 페이지 본문 일부를 돌려줍니다."},
    {"id": "searxng", "name": "SearXNG (자체 호스팅)", "needsKey": False, "needsUrl": True,
     "note": "내 SearXNG 인스턴스 주소(JSON 출력 허용 필요)."},
]
DEFAULT_PROVIDER = "duckduckgo"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_DEFAULT_MODEL = "gemini-3.7-flash"
GEMINI_DEFAULT_INSTRUCTIONS = (
    "당신은 조사 담당이다. 질문을 받으면 Google 검색으로 찾고, 여러 출처를 대조해 사실 위주로 답한다. "
    "모르면 모른다고 하고, 출처 URL 을 답 끝에 붙인다. 물어본 것에만 답한다. 한국어로 답한다."
)


def _cfg() -> dict:
    return config.section("websearch")


def _agent_cfg() -> dict:
    return config.section("agent")


def mode() -> str:
    """Which of the three. Installs from before the mode existed had only a
    provider (or 'native' as a provider) - map those rather than reset them."""
    m = str(_cfg().get("mode") or "").strip().lower()
    if m in ("native", "gemini", "provider"):
        return m
    if (str(_cfg().get("provider") or "").strip().lower()) == "native":
        return "native"
    return "provider"


def provider_id() -> str:
    p = (str(_cfg().get("provider") or "").strip().lower()) or DEFAULT_PROVIDER
    return DEFAULT_PROVIDER if p == "native" else p


def _host(url: str) -> str:
    return urllib.parse.urlparse(str(url or "")).hostname or ""


def _gemini_key() -> str:
    c = _cfg()
    ref = str(c.get("geminiKeyRef") or "").strip()
    if ref:
        k = keys.get(ref)
        if k and k.get("apiKey"):
            return str(k["apiKey"])
    return str(c.get("geminiApiKey") or "").strip()


def _gemini_model() -> str:
    return str(_cfg().get("geminiModel") or "").strip() or GEMINI_DEFAULT_MODEL


def ready() -> bool:
    """Whether a search can be attempted in the current mode."""
    m = mode()
    if m == "native":
        a = _agent_cfg()
        if (a.get("provider") or "") == "codex":
            return bool(a.get("model")) and codexauth.logged_in()
        return bool(a.get("baseUrl") and a.get("apiKey") and a.get("model"))
    if m == "gemini":
        return bool(_gemini_key())
    c = _cfg()
    meta = next((p for p in PROVIDERS if p["id"] == provider_id()), None)
    if meta is None:
        return False
    if meta["needsKey"] and not (c.get("apiKey") or "").strip():
        return False
    if meta["needsUrl"] and not (c.get("baseUrl") or "").strip():
        return False
    return True


configured = ready  # older callers


def why_not() -> str:
    """The one sentence to show when `ready()` is False."""
    m = mode()
    if m == "native":
        return "내장 검색은 일반 에이전트의 모델·주소·키가 있어야 합니다 (⚙ → 에이전트 → 일반 에이전트에서 프리셋을 고르세요)"
    if m == "gemini":
        return "Gemini 보조 에이전트에는 Google AI Studio API 키가 필요합니다 (⚙ → 에이전트 → 웹 검색 툴)"
    meta = next((p for p in PROVIDERS if p["id"] == provider_id()), None)
    if meta is None:
        return f"모르는 검색 제공자입니다: {provider_id()}"
    if meta["needsKey"]:
        return f"{meta['name']} 에는 API 키가 필요합니다 (⚙ → 에이전트 → 웹 검색 툴)"
    return f"{meta['name']} 에는 주소가 필요합니다 (⚙ → 에이전트 → 웹 검색 툴)"


def tool_doc() -> str:
    """The `web_search` tool's docstring for the current mode - what comes
    back differs, and the agent should know whether it is reading a list of
    hits or an answer someone already wrote."""
    m = mode()
    if m == "gemini":
        return ("웹 조사 — Gemini 보조 에이전트가 검색하고 읽고 정리한 **답**(출처 포함)을 돌려준다. "
                "원작 설정·시대 고증·용어·최신 정보처럼 외부 사실이 필요한 모든 경우 쓴다. "
                "질문은 한 번에 하나, 구체적으로.")
    if m == "native":
        return ("웹 검색 — 네 모델의 내장 검색으로 찾는다. 출처가 붙은 답 또는 결과 목록(제목·URL·요약)이 돌아온다. "
                "원작 설정·시대 고증·용어·최신 정보처럼 외부 사실이 필요한 모든 경우 쓴다. "
                "검색어는 한 번에 하나, 구체적으로.")
    return ("웹 검색 — 검색 결과 목록(제목·URL·요약)을 돌려준다. 원작 설정·시대 고증·용어·최신 정보처럼 "
            "외부 사실이 필요한 모든 경우 쓴다. 결과를 읽고 대조해서 답하고 출처 URL 을 남겨라. "
            "검색어는 한 번에 하나, 구체적으로.")


# --- running a search ----------------------------------------------------------

async def run(query: str) -> str:
    """The tool body. Never raises: a failed search degrades the turn."""
    if not ready():
        return f"웹 검색이 설정되지 않았습니다 — {why_not()}. 사용자에게 안내하고, 기억으로 사실을 지어내지 마라."
    m = mode()
    try:
        if m == "native":
            return await _native(query)
        if m == "gemini":
            return await _gemini_search(_gemini_model(), _gemini_key(), _gemini_instructions(), query)
        return await asyncio.to_thread(search, query)
    except Exception as e:  # noqa: BLE001
        log.warn("websearch (%s) failed: %s", m, e)
        return f"검색에 실패했습니다 ({m}): {type(e).__name__}: {str(e)[:300]}"


async def test(query: str) -> dict:
    """One real search for the card. In native mode this is also the probe
    that finds and stores the shape."""
    t0 = time.time()
    m = mode()
    if not ready():
        return {"ok": False, "mode": m, "detail": "", "error": why_not(), "ms": 0}
    try:
        if m == "native":
            shape, text = await _native_probe(query, force=True)
            detail = f"{_SHAPE_LABELS.get(shape, shape)} · {_agent_cfg().get('model') or ''}"
        elif m == "gemini":
            text = await _gemini_search(_gemini_model(), _gemini_key(), _gemini_instructions(), query)
            detail = f"Google AI Studio · {_gemini_model()}"
        else:
            text = await asyncio.to_thread(search, query)
            detail = provider_id()
            if text.startswith("검색에 실패") or text.startswith("지원하지"):
                return {"ok": False, "mode": m, "detail": detail, "error": text[:400], "ms": int((time.time() - t0) * 1000)}
        return {"ok": True, "mode": m, "detail": detail, "query": query, "text": text[:6000],
                "ms": int((time.time() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "mode": m, "detail": "", "error": f"{type(e).__name__}: {str(e)[:500]}",
                "ms": int((time.time() - t0) * 1000)}


def _gemini_instructions() -> str:
    return str(_cfg().get("geminiInstructions") or "").strip() or GEMINI_DEFAULT_INSTRUCTIONS


# --- mode: gemini helper ---------------------------------------------------------

async def _gemini_search(model: str, key: str, instructions: str, question: str) -> str:
    """Google AI Studio, native API, Google Search grounding. The OpenAI
    compatibility layer does not expose grounding, so this is the raw
    generateContent call. Sources come from groundingMetadata."""
    if not key:
        raise RuntimeError("Google AI Studio API 키가 없습니다")
    url = f"{GEMINI_BASE}/models/{model}:generateContent"
    body = {
        "system_instruction": {"parts": [{"text": instructions}]},
        "contents": [{"role": "user", "parts": [{"text": question}]}],
        "tools": [{"google_search": {}}],
    }
    async with httpx.AsyncClient(timeout=NATIVE_TIMEOUT) as c:
        r = await c.post(url, headers={"x-goog-api-key": key, "Content-Type": "application/json"}, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    cands = data.get("candidates") or []
    if not cands:
        block = (data.get("promptFeedback") or {}).get("blockReason")
        raise RuntimeError(f"Gemini 가 답을 돌려주지 않았습니다{(' (' + block + ')') if block else ''}")
    cand = cands[0]
    text = "".join(p.get("text", "") for p in ((cand.get("content") or {}).get("parts") or []) if isinstance(p, dict))
    chunks = ((cand.get("groundingMetadata") or {}).get("groundingChunks") or [])
    sources = []
    for ch in chunks:
        w = (ch or {}).get("web") or {}
        if w.get("uri") and w["uri"] not in [s[1] for s in sources]:
            sources.append((w.get("title") or "", w["uri"]))
    if sources and "http" not in text:
        text += "\n\n출처:\n" + "\n".join(f"- {t} — {u}" if t else f"- {u}" for t, u in sources[:8])
    return (text.strip() or "(빈 답)")[:20000]


# --- mode: native (the main agent's own endpoint) -------------------------------

_SHAPE_LABELS = {
    "codex": "codex Responses web_search",
    "ollama": "Ollama 클라우드 web_search API",
    "anthropic": "Anthropic web_search",
    "gemini": "Gemini Google 검색 grounding",
    "responses": "Responses API web_search",
    "vercel": "Vercel 게이트웨이 exa_search",
    "chat_options": "chat completions web_search_options",
    "openrouter": "OpenRouter web 플러그인",
}

_NATIVE_INSTRUCTIONS = (
    "You are a research assistant. Use your web search tool for anything factual, compare sources, "
    "answer in Korean, and end with the source URLs."
)


def _shape_candidates(a: dict) -> list[tuple[str, Callable[[str], Awaitable[str]]]]:
    """Ordered attempts for this endpoint. Host-specific first (they are
    certain), then the OpenAI-compatible guesses on any host."""
    base = str(a.get("baseUrl") or "")
    host = _host(base)
    key = str(a.get("apiKey") or "")
    model = str(a.get("model") or "")
    out: list[tuple[str, Callable[[str], Awaitable[str]]]] = []
    if (a.get("provider") or "") == "codex":
        out.append(("codex", lambda q: _codex_search(model, q, str(a.get("reasoning") or "low"))))
        return out
    if host.endswith("ollama.com"):
        out.append(("ollama", lambda q: _ollama_search(key, q)))
    if "anthropic.com" in host:
        out.append(("anthropic", lambda q: _anthropic_search(base, key, model, q)))
    if "generativelanguage.googleapis.com" in host:
        out.append(("gemini", lambda q: _gemini_search(model, key, _NATIVE_INSTRUCTIONS, q)))
    out.append(("responses", lambda q: _openai_responses_search(base, key, model, q)))
    out.append(("vercel", lambda q: _openai_chat_tool(base, key, model, q, {"tools": [{"type": "vercel:exa_search"}]})))
    out.append(("chat_options", lambda q: _openai_chat_tool(base, key, model, q, {"web_search_options": {}})))
    out.append(("openrouter", lambda q: _openai_chat_tool(base, key, model, q, {"extra_body": {"plugins": [{"id": "web"}]}})))
    return out


async def _native_probe(query: str, force: bool = False) -> tuple[str, str]:
    """Try the remembered shape, then the rest; store what worked."""
    a = _agent_cfg()
    cands = _shape_candidates(a)
    remembered = str(_cfg().get("nativeShape") or "")
    order = cands
    if remembered and not force:
        order = [c for c in cands if c[0] == remembered] + [c for c in cands if c[0] != remembered]
    errors: list[str] = []
    for shape, fn in order:
        try:
            text = await asyncio.wait_for(fn(query), NATIVE_TIMEOUT + 5)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{_SHAPE_LABELS.get(shape, shape)}: {type(e).__name__}: {str(e)[:160]}")
            continue
        if text and text.strip():
            if shape != remembered:
                config.update({"websearch": {"nativeShape": shape}})
            return shape, text
        errors.append(f"{_SHAPE_LABELS.get(shape, shape)}: 빈 응답")
    raise RuntimeError("이 엔드포인트에서 되는 내장 검색을 찾지 못했습니다:\n" + "\n".join(errors))


async def _native(query: str) -> str:
    _, text = await _native_probe(query)
    return text[:20000]


async def _codex_search(model: str, q: str, reasoning: str) -> str:
    c = codexauth.client()
    r = await c.responses.create(
        model=model, instructions=_NATIVE_INSTRUCTIONS,
        input=[{"role": "user", "content": q}],
        tools=[{"type": "web_search"}], reasoning={"effort": reasoning or "low"},
        timeout=NATIVE_TIMEOUT,
    )
    return _responses_text(r)


def _responses_text(r: Any) -> str:
    text = str(getattr(r, "output_text", "") or "")
    urls: list[str] = []
    for it in getattr(r, "output", None) or []:
        action = getattr(it, "action", None)
        url = getattr(action, "url", None)
        if url and url not in urls:
            urls.append(str(url))
    if text and urls and "http" not in text:
        text += "\n\n출처:\n" + "\n".join(urls[:8])
    return text


async def _openai_responses_search(base: str, key: str, model: str, q: str) -> str:
    import openai
    c = openai.AsyncOpenAI(base_url=base, api_key=key, timeout=NATIVE_TIMEOUT)
    r = await c.responses.create(model=model, instructions=_NATIVE_INSTRUCTIONS,
                                 input=[{"role": "user", "content": q}], tools=[{"type": "web_search"}])
    return _responses_text(r)


async def _openai_chat_tool(base: str, key: str, model: str, q: str, extra: dict) -> str:
    import openai
    c = openai.AsyncOpenAI(base_url=base, api_key=key, timeout=NATIVE_TIMEOUT)
    r = await c.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": _NATIVE_INSTRUCTIONS}, {"role": "user", "content": q}],
        **extra,
    )
    if not r.choices:
        return ""
    m = r.choices[0].message
    text = str(m.content or "")
    ann = getattr(m, "annotations", None) or []
    urls = []
    for a in ann:
        cite = getattr(a, "url_citation", None) or (a.get("url_citation") if isinstance(a, dict) else None)
        u = getattr(cite, "url", None) if cite is not None and not isinstance(cite, dict) else (cite or {}).get("url")
        if u and u not in urls:
            urls.append(str(u))
    if text and urls and "http" not in text:
        text += "\n\n출처:\n" + "\n".join(urls[:8])
    return text


async def _ollama_search(key: str, q: str) -> str:
    """Ollama cloud's search API, with the same key the model uses. Returns
    hits, so the main agent reads them like a provider."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post("https://ollama.com/api/web_search", headers={"Authorization": f"Bearer {key}"},
                         json={"query": q, "max_results": 6})
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    hits = (r.json() or {}).get("results") or []
    return _fmt([{"title": h.get("title", ""), "url": h.get("url", ""), "snippet": str(h.get("content", ""))[:600]}
                 for h in hits], q)


async def _anthropic_search(base: str, key: str, model: str, q: str) -> str:
    url = (base.rstrip("/") if base else "https://api.anthropic.com") + "/v1/messages"
    if not url.startswith("http"):
        url = "https://" + url
    body = {
        "model": model, "max_tokens": 2000, "system": _NATIVE_INSTRUCTIONS,
        "messages": [{"role": "user", "content": q}],
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
    }
    async with httpx.AsyncClient(timeout=NATIVE_TIMEOUT) as c:
        r = await c.post(url, headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                       "Content-Type": "application/json"}, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
    parts = (r.json() or {}).get("content") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")
    urls: list[str] = []
    for p in parts:
        if isinstance(p, dict) and p.get("type") == "web_search_tool_result":
            for hit in p.get("content") or []:
                if isinstance(hit, dict) and hit.get("url") and hit["url"] not in urls:
                    urls.append(hit["url"])
    if text and urls and "http" not in text:
        text += "\n\n출처:\n" + "\n".join(urls[:8])
    return text


# --- mode: provider ---------------------------------------------------------------

def _fmt(results: list[dict], query: str) -> str:
    if not results:
        return f"'{query}' 검색 결과가 없습니다"
    return "\n\n".join(f"{r['title']}\n{r['url']}\n{r['snippet']}" for r in results)


def search(query: str) -> str:
    """Provider mode, synchronous: hits as text."""
    c = _cfg()
    provider = provider_id()
    key = (c.get("apiKey") or "").strip()
    base = (c.get("baseUrl") or "").strip()
    limit = max(1, min(MAX_RESULTS, int(c.get("maxResults") or 5)))
    try:
        if provider == "duckduckgo":
            results = _duckduckgo(query, limit)
        elif provider == "brave":
            results = _brave(query, key, base or "https://api.search.brave.com/res/v1/web/search", limit)
        elif provider == "tavily":
            results = _tavily(query, key, base or "https://api.tavily.com/search", limit)
        elif provider == "serper":
            results = _serper(query, key, base or "https://google.serper.dev/search", limit)
        elif provider == "firecrawl":
            results = _firecrawl(query, key, base or "https://api.firecrawl.dev/v2/search", limit)
        elif provider == "searxng":
            results = _searxng(query, base, limit)
        else:
            return f"지원하지 않는 검색 프로바이더입니다: {provider or '(미설정)'}"
    except Exception as e:  # noqa: BLE001 - a failed search degrades the turn, never fails it
        log.warn("websearch failed provider=%s: %s", provider, e)
        return f"검색에 실패했습니다 ({provider}): {type(e).__name__}: {str(e)[:160]}"
    return _fmt(results, query)


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
    and a keyed provider is one field away when it stops."""
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


def _firecrawl(q: str, key: str, url: str, n: int) -> list[dict]:
    """v2 search (`data.web[]`); the v1 shape (`data[]`) is read too, so an
    older base URL keeps working. Page markdown, when asked for, rides as
    the snippet - it is what makes this provider worth a key."""
    data = _post(url, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                 {"query": q, "limit": n, "scrapeOptions": {"formats": ["markdown"]}})
    body = data.get("data")
    hits = (body.get("web") if isinstance(body, dict) else body) or []
    out = []
    for w in hits[:n]:
        if not isinstance(w, dict):
            continue
        snippet = str(w.get("markdown") or w.get("description") or "")
        out.append({"title": w.get("title", ""), "url": w.get("url", ""), "snippet": snippet[:1500]})
    return out


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
    return json.dumps({"mode": mode(), "provider": provider_id(), "ready": ready()}, ensure_ascii=False)


def status() -> dict:
    """For the settings card: the choices, what is set, and whether it can run."""
    c = _cfg()
    a = _agent_cfg()
    ref = str(c.get("geminiKeyRef") or "").strip()
    return {
        "modes": MODES,
        "mode": mode(),
        "nativeShape": str(c.get("nativeShape") or ""),
        "nativeShapeLabel": _SHAPE_LABELS.get(str(c.get("nativeShape") or ""), ""),
        "agent": {"model": a.get("model") or "", "host": ("codex" if (a.get("provider") or "") == "codex"
                                                          else _host(str(a.get("baseUrl") or "")))},
        "gemini": {
            "model": _gemini_model(), "defaultModel": GEMINI_DEFAULT_MODEL,
            "keyRef": ref, "apiKeySet": bool(str(c.get("geminiApiKey") or "").strip()),
            "instructions": str(c.get("geminiInstructions") or ""),
            "defaultInstructions": GEMINI_DEFAULT_INSTRUCTIONS,
        },
        "providers": PROVIDERS,
        "provider": provider_id(),
        "apiKeySet": bool((c.get("apiKey") or "").strip()),
        "baseUrl": c.get("baseUrl") or "",
        "maxResults": int(c.get("maxResults") or 5),
        "ready": ready(),
        "configured": ready(),
        "whyNot": "" if ready() else why_not(),
    }
