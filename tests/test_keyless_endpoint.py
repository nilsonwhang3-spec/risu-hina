"""A keyless endpoint (a local LLM) runs without an API key (§1-126).

The field report: a local LLM needs no key, but readiness, the agent build and
the connection test all demanded one; any made-up key happened to work. The
key is optional now: readiness asks for baseUrl + model, the OpenAI client
gets a stand-in (the SDK refuses an empty key), the raw connection test sends
no Authorization header at all. No network: requests go to a mock transport.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))
from app import agent as A, keys, main as M  # noqa: E402

LOCAL = {"baseUrl": "http://127.0.0.1:8080/v1", "apiKey": "", "model": "local-model",
         "maxTokens": 1000, "timeoutSeconds": 30}


def section(name):
    return dict(LOCAL) if name == "agent" else {}


# Readiness: baseUrl + model is enough; either missing is still not ready.
with patch.object(M.config, "section", section):
    assert M.agent_ready() is True
with patch.object(M.config, "section", lambda n: {**LOCAL, "model": ""} if n == "agent" else {}):
    assert M.agent_ready() is False
with patch.object(M.config, "section", lambda n: {**LOCAL, "baseUrl": ""} if n == "agent" else {}):
    assert M.agent_ready() is False

# The client key: empty -> stand-in; a real key passes through untouched.
assert keys.client_key(LOCAL["baseUrl"], "") == keys.NO_KEY
assert keys.client_key(LOCAL["baseUrl"], "  ") == keys.NO_KEY
assert keys.client_key(LOCAL["baseUrl"], "sk-real") == "sk-real"

# The client the agent builds on accepts the stand-in (an empty key raised
# "Missing credentials" inside the SDK) and the request goes out.
seen: dict = {}


def handler(req: httpx.Request) -> httpx.Response:
    seen["auth"] = req.headers.get("authorization")
    seen["url"] = str(req.url)
    return httpx.Response(200, json={
        "id": "x", "object": "chat.completion", "created": 0, "model": "local-model",
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}]})


async def call() -> str:
    c = A._client(LOCAL["baseUrl"], keys.client_key(LOCAL["baseUrl"], ""), set(), 30.0)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    r = await c.chat.completions.create(model="local-model", messages=[{"role": "user", "content": "hi"}])
    return r.choices[0].message.content

assert asyncio.run(call()) == "ok"
assert seen["url"].startswith("http://127.0.0.1:8080/v1/chat/completions"), seen
assert seen["auth"] == f"Bearer {keys.NO_KEY}", seen

# The agent model builds without a key (it raised before any request).
with patch.object(A.config, "section", section):
    model = A._model_for("agent")
assert type(model).__name__ == "OpenAIChatModel", model
print("keyless endpoint: OK")
