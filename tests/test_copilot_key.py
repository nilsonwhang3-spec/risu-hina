"""GitHub Copilot as an API key row (device-code login), like Vertex.

The key row holds a GitHub token; keys.runtime swaps it for a short Copilot
token per request, the provider profile adds the editor headers and picks
max_tokens / non-strict tools, codex models go to /responses, and the agent's
client marks tool rounds X-Initiator: agent. keys.save claims a finished
device login by its state and never sees the token from the panel. No
network: GitHub and the Copilot API are mocked.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))
from app import agent as A, copilotauth as C, keys, providers as P  # noqa: E402

BASE = "https://api.githubcopilot.com"
GH = "gho_testtoken"
exchanges = {"n": 0}


def fake_exchange(token: str) -> dict:
    assert token == GH
    exchanges["n"] += 1
    sess = {"token": f"tid=copilot{exchanges['n']}", "expires_at": time.time() + 1500, "api": BASE}
    import hashlib
    C._sessions[hashlib.sha256(token.encode()).hexdigest()] = sess
    return sess


with patch.object(C, "_exchange", fake_exchange):
    # runtime swaps the GitHub token; the second call is served from cache.
    assert keys.runtime(BASE, GH) == (BASE, "tid=copilot1")
    assert keys.runtime(BASE, GH) == (BASE, "tid=copilot1")
    assert exchanges["n"] == 1
    # A non-GitHub key on the same host (a relay) passes through untouched.
    assert keys.runtime(BASE, "sk-relay") == (BASE, "sk-relay")
    # Other hosts are untouched.
    assert keys.runtime("https://api.openai.com/v1", GH) == ("https://api.openai.com/v1", GH)
    # Near expiry renews.
    for s in C._sessions.values():
        s["expires_at"] = time.time() + 60
    assert C.access_token(GH) == "tid=copilot2"
    # The agent client gets an awaitable key.
    k = keys.client_key(BASE, GH)
    assert callable(k)
    assert asyncio.run(k()) == "tid=copilot2"

# Profile: editor headers, max_tokens, non-strict tools, codex -> responses.
prof = P.for_url(BASE)
assert prof and prof["id"] == "github-copilot"
assert P.for_url("https://api.business.githubcopilot.com")["id"] == "github-copilot"
h = P.auto_headers(BASE)
assert h["Copilot-Integration-Id"] == "vscode-chat" and h["Editor-Version"].startswith("vscode/")
plan = P.plan_for({"baseUrl": BASE, "model": "claude-sonnet-4", "cache": True})
assert plan.api == "chat" and plan.cap_field == "max_tokens" and plan.strict_tools is False
assert "prompt_cache_key" in plan.drop
assert P.plan_for({"baseUrl": BASE, "model": "gpt-5.1-codex-mini"}).api == "responses"

# keys.save claims a finished device login; the panel never held the token.
C._pending["s1"] = {"device_code": "d", "user_code": "ABCD-EFGH", "uri": C.VERIFY_URL, "interval": 5,
                    "deadline": time.time() + 900, "token": GH, "login": "octo",
                    "api": "https://api.business.githubcopilot.com", "error": "", "cancelled": False}
saved: dict = {}


def fake_execute(sql, params=()):
    saved["params"] = params


with patch.object(keys.db, "execute", fake_execute), \
        patch.object(keys.db, "one", lambda *a, **k: None), \
        patch.object(keys.db, "query", lambda *a, **k: []), \
        patch.object(keys, "get", lambda kid: {"id": kid, "name": "GitHub Copilot", "provider": "github-copilot",
                                               "baseUrl": saved["params"][3], "apiKey": saved["params"][4],
                                               "note": saved["params"][5], "updatedAt": 0} if kid and saved else None), \
        patch("app.presets.reresolve_selected", lambda: None):
    out = keys.save({"name": "GitHub Copilot", "provider": "github-copilot", "apiKey": C.CLAIM_PREFIX + "s1"})
    kid, name, provider, base, key, note = saved["params"][:6]
    assert provider == "github-copilot" and key == GH
    assert base == "https://api.business.githubcopilot.com"
    assert note == "GitHub octo"
    assert out["apiKey"] == {"set": True, "length": len(GH)}
    # Claimed once: a second save with the same state is refused, readably.
    try:
        keys.save({"name": "GitHub Copilot 2", "provider": "github-copilot", "apiKey": C.CLAIM_PREFIX + "s1"})
        raise AssertionError("second claim should fail")
    except keys.KeyError_ as e:
        assert "아직" in str(e)

# The agent client marks who started the call.
seen: list[dict] = []


def handler(req: httpx.Request) -> httpx.Response:
    seen.append({"init": req.headers.get("x-initiator"), "integ": req.headers.get("copilot-integration-id"),
                 "auth": req.headers.get("authorization")})
    return httpx.Response(200, json={
        "id": "x", "object": "chat.completion", "created": 0, "model": "m",
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}]})


async def two_calls() -> None:
    c = A._client(BASE, "tid=x", set(), 30.0)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await c.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}])
    await c.chat.completions.create(model="m", messages=[
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "t1", "type": "function", "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "r"}])

asyncio.run(two_calls())
assert [s["init"] for s in seen] == ["user", "agent"], seen
assert all(s["integ"] == "vscode-chat" and s["auth"] == "Bearer tid=x" for s in seen), seen

# Usage: GitHub's quota snapshot, reduced to what the panel line shows, cached.
calls = {"n": 0}


def fake_get(url, **kw):
    calls["n"] += 1
    assert url == C.USER_URL_COPILOT and kw["headers"]["Authorization"] == f"token {GH}"
    return httpx.Response(200, json={
        "access_type_sku": "free_limited_copilot", "quota_reset_date": "2026-12-01",
        "quota_snapshots": {
            "chat": {"remaining": 198, "entitlement": 200, "unlimited": False, "percent_remaining": 99.0},
            "premium_interactions": {"remaining": 0, "entitlement": 0, "unlimited": False, "percent_remaining": 0.0}}},
        request=httpx.Request("GET", url))


with patch.object(httpx, "get", fake_get):
    u = C.usage(GH)
    assert u["plan"] == "free_limited_copilot" and u["resetDate"] == "2026-12-01"
    assert u["quotas"]["chat"] == {"remaining": 198, "entitlement": 200, "unlimited": False, "percentRemaining": 99.0, "overage": 0}
    C.usage(GH)
    assert calls["n"] == 1, "cached for a minute"
    C.usage(GH, force=True)
    assert calls["n"] == 2

print("OK copilot key")
