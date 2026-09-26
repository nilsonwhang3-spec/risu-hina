"""Native web search on a Vertex agent (no network).

The field report: every shape came back 401 "Expected OAuth 2 access token"
because the service-account JSON itself went out as the bearer. The agent
exchanged it (keys.runtime); the search tool did not.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))
from app import vertexauth, websearch as W  # noqa: E402

SA = json.dumps({"type": "service_account", "project_id": "p-1",
                 "client_email": "x@p-1.iam.gserviceaccount.com", "private_key": "k"})
BASE = vertexauth.base_url("p-1", "asia-northeast3")
AGENT = {"baseUrl": BASE, "apiKey": SA, "model": "gemini-3.7-flash"}

assert W._vertex_generate_url(BASE, "google/gemini-3.7-flash") == (
    "https://asia-northeast3-aiplatform.googleapis.com/v1/projects/p-1/locations/asia-northeast3"
    "/publishers/google/models/gemini-3.7-flash:generateContent")

sent: list[dict] = []


class Resp:
    status_code = 200
    text = ""

    def json(self):
        return {"candidates": [{"content": {"parts": [{"text": "답"}]},
                                "groundingMetadata": {"groundingChunks": [{"web": {"uri": "https://a.example", "title": "A"}}]}}]}


class Client:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, headers=None, json=None):
        sent.append({"url": url, "headers": headers, "json": json})
        return Resp()


def section(name):
    return dict(AGENT) if name == "agent" else {}


with patch.object(vertexauth, "access_token", lambda raw: "ya29.token"), \
        patch.object(W.config, "section", section), \
        patch.object(W.config, "update", lambda *_: None), \
        patch.object(W.httpx, "AsyncClient", Client):
    a = W._runtime_agent(AGENT)
    assert a["apiKey"] == "ya29.token" and a["model"] == "google/gemini-3.7-flash", a
    assert [s for s, _ in W._shape_candidates(a)] == ["vertex"]
    shape, text = asyncio.run(W._native_probe("질문", force=True))
    assert shape == "vertex" and text.startswith("답") and "https://a.example" in text, (shape, text)
    assert sent[-1]["headers"]["Authorization"] == "Bearer ya29.token", sent[-1]["headers"]
    assert SA not in json.dumps(sent[-1]["headers"])
    assert sent[-1]["url"].endswith("/publishers/google/models/gemini-3.7-flash:generateContent")
    assert sent[-1]["json"]["tools"] == [{"google_search": {}}]

    # A non-Google model on Vertex has no search: say so, don't fire 4 guesses.
    AGENT["model"] = "claude-sonnet-5"
    assert W._shape_candidates(W._runtime_agent(AGENT)) == []
    try:
        asyncio.run(W._native_probe("q", force=True))
        raise AssertionError("expected a clear error")
    except RuntimeError as e:
        assert "Vertex" in str(e) and "외부 검색 제공자" in str(e), e

# Non-Vertex endpoints keep the old candidate list, key untouched.
plain = W._runtime_agent({"baseUrl": "https://api.openai.com/v1", "apiKey": "sk-x", "model": "gpt-5"})
assert plain["apiKey"] == "sk-x" and plain["model"] == "gpt-5"
assert [s for s, _ in W._shape_candidates(plain)] == ["responses", "vercel", "chat_options", "openrouter"]

# The vision helper had the same gap: a Vertex key in the helper slot.
from app import vision as V  # noqa: E402


class VResp:
    status_code = 200
    text = ""

    def json(self):
        return {"choices": [{"message": {"content": "보임"}}]}


class VClient(Client):
    async def post(self, url, headers=None, json=None):
        sent.append({"url": url, "headers": headers, "json": json})
        return VResp()


img = V.Loaded("a.png", b"PNG", "image/png", 1, 1, 1, 1, 3)
with patch.object(vertexauth, "access_token", lambda raw: "ya29.token"), \
        patch.object(V, "_cfg", lambda: {"helperBaseUrl": BASE, "helperApiKey": SA, "helperModel": "gemini-3.7-flash"}), \
        patch("httpx.AsyncClient", VClient):
    assert asyncio.run(V.describe_with_helper([img], "?")).startswith("보임")
assert sent[-1]["headers"]["Authorization"] == "Bearer ya29.token"
assert sent[-1]["json"]["model"] == "google/gemini-3.7-flash"
print("websearch/vision vertex ok")
