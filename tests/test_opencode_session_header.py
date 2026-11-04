"""OpenCode Go/Zen get x-opencode-session per conversation (§1-127).

The field report: OpenCode Go answered 400 MissingSessionID ("Request is
missing x-opencode-session") and there was nowhere to put the header. The
preset's parameter JSON did take `extra_headers`, but the connection test sent
it inside the JSON body, so the header never left. Now the OpenCode profiles
send it on their own: one stable id per Hina conversation (the same value as
prompt_cache_key), a process-wide id outside a conversation, plus a named
User-Agent; a header the user sets in extra_headers still wins.
No network: requests go to a mock transport / a patched httpx.post.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))
from app import agent as A, main as M, providers as P  # noqa: E402

GO = "https://opencode.ai/zen/go/v1"
ZEN = "https://opencode.ai/zen/v1"
HDR = "x-opencode-session"

# Profiles: both OpenCode endpoints carry the header, others do not.
assert HDR in P.auto_headers(GO) and HDR in P.auto_headers(ZEN)
assert P.auto_headers("https://openrouter.ai/api/v1") == {}
ua = P.auto_headers(GO)["User-Agent"]
assert not ua.startswith(("pydantic-ai/", "OpenAI/", "python-httpx/")), ua

# Id: explicit > conversation > process; stable within each.
assert P.auto_headers(GO, "risu-hina-abc")[HDR] == "risu-hina-abc"
proc = P.auto_headers(GO)[HDR]
assert proc == P.auto_headers(GO)[HDR] and proc.startswith("risu-hina-")
tok = P.CURRENT_SESSION.set("s42")
try:
    assert P.auto_headers(GO)[HDR] == "risu-hina-s42"
finally:
    P.CURRENT_SESSION.reset(tok)

# Merge: user header wins (any case); a library User-Agent is replaced.
m = P.merge_headers({"X-OpenCode-Session": "mine", "User-Agent": "pydantic-ai/1.0"},
                    {HDR: "auto", "User-Agent": ua})
assert m == {"X-OpenCode-Session": "mine", "User-Agent": ua}, m
assert P.merge_headers({"User-Agent": "custom/1"}, {"User-Agent": ua})["User-Agent"] == "custom/1"

# The agent's client: prompt_cache_key becomes the header even though the
# OpenCode plan drops prompt_cache_key from the body.
seen: dict = {}


def handler(req: httpx.Request) -> httpx.Response:
    seen["session"] = req.headers.get(HDR)
    seen["ua"] = req.headers.get("user-agent")
    seen["body"] = json.loads(req.content)
    return httpx.Response(200, json={
        "id": "x", "object": "chat.completion", "created": 0, "model": "kimi-k3",
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}]})


async def call(**kw) -> None:
    c = A._client(GO, "sk-go", {"prompt_cache_key"}, 30.0)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await c.chat.completions.create(model="kimi-k3", messages=[{"role": "user", "content": "hi"}], **kw)

asyncio.run(call(prompt_cache_key="risu-hina-sess1"))
assert seen["session"] == "risu-hina-sess1", seen
assert seen["ua"] == ua, seen
assert "prompt_cache_key" not in seen["body"], seen["body"]

# No cache key (the summariser): the conversation from the context var.
tok = P.CURRENT_SESSION.set("sess2")
try:
    asyncio.run(call())
finally:
    P.CURRENT_SESSION.reset(tok)
assert seen["session"] == "risu-hina-sess2", seen

# A preset extra_headers override survives.
asyncio.run(call(prompt_cache_key="risu-hina-sess1", extra_headers={HDR: "risu-agent-001"}))
assert seen["session"] == "risu-agent-001", seen

# Non-OpenCode endpoints are untouched.
async def call_other() -> None:
    c = A._client("https://openrouter.ai/api/v1", "sk", set(), 30.0)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await c.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}],
                                    prompt_cache_key="risu-hina-x")
asyncio.run(call_other())
assert seen["session"] is None, seen

# The connection test: auto header sent, and extra_headers from the parameter
# JSON goes out as headers, not as a body field.
CFG = {"baseUrl": GO, "apiKey": "sk-go", "model": "kimi-k3", "maxTokens": 1000,
       "timeoutSeconds": 30, "params": ""}
posts: list = []


def fake_post(url, headers=None, json=None, timeout=None, **_):
    posts.append({"url": url, "headers": dict(headers or {}), "json": json})
    msg = {"role": "assistant", "content": "PONG"}
    if json and json.get("tools"):
        msg = {"role": "assistant", "content": None, "tool_calls": [{
            "id": "c1", "type": "function", "function": {"name": "read_turns", "arguments": "{\"start\":0,\"end\":1}"}}]}
    return httpx.Response(200, json={"choices": [{"message": msg}], "usage": {}},
                          request=httpx.Request("POST", url))


def run_test(cfg):
    posts.clear()
    with patch.object(M.config, "section", lambda n: dict(cfg) if n == "agent" else {}), \
         patch.object(httpx, "post", fake_post):
        return M.h_config_test({})


r = run_test(CFG)
assert r["ok"], r
assert posts and all(p["headers"].get(HDR) for p in posts), posts
assert all("extra_headers" not in (p["json"] or {}) for p in posts), posts

r = run_test({**CFG, "params": '{"extra_headers": {"x-opencode-session": "risu-agent-001", "X-Custom": "1"}}'})
assert r["ok"], r
for p in posts:
    assert p["headers"][HDR] == "risu-agent-001", p["headers"]
    assert p["headers"]["X-Custom"] == "1", p["headers"]
    assert "extra_headers" not in p["json"], p["json"]
print("opencode session header: OK")
