"""Verify the configured agent credentials actually work, including tool calls.

Run before trusting `config.agent`. Two things get checked, because they fail
independently: plain completion proves the key and model resolve, tool calling
proves the model can drive the agent loop at all. A gateway that happily answers
prose but drops `tools` would otherwise only surface much later, as an agent
that "never uses its tools".

    pyserver/.venv/Scripts/python.exe pyserver/tools/check_agent.py

Never prints the key.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from app import config  # noqa: E402


def main() -> int:
    agent = config.section("agent")
    base = (agent.get("baseUrl") or "").rstrip("/")
    key = agent.get("apiKey") or ""
    model = agent.get("model") or ""

    print(f"baseUrl : {base or '<empty>'}")
    print(f"model   : {model or '<empty>'}")
    print(f"apiKey  : {'set (' + str(len(key)) + ' chars)' if key else '<empty>'}")
    if not (base and key and model):
        print("\nFAIL - agent credentials are incomplete")
        return 1

    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    url = base + "/chat/completions"
    ok = True

    print("\n[1/2] plain completion")
    try:
        r = httpx.post(url, headers=headers, timeout=60, json={
            "model": model,
            "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
            "max_tokens": 32,
            "temperature": 0,
        })
        if r.status_code >= 400:
            print(f"  FAIL HTTP {r.status_code}: {r.text[:200]}")
            ok = False
        else:
            data = r.json()
            msg = (data.get("choices") or [{}])[0].get("message") or {}
            usage = data.get("usage") or {}
            print(f"  ok  content={msg.get('content', '')[:40]!r}")
            print(f"      usage in={usage.get('prompt_tokens')} out={usage.get('completion_tokens')}")
    except Exception as e:
        print(f"  FAIL {type(e).__name__}: {e}")
        ok = False

    print("\n[2/2] tool calling")
    tools = [{
        "type": "function",
        "function": {
            "name": "read_turns",
            "description": "Read chat turns by index range.",
            "parameters": {
                "type": "object",
                "properties": {
                    "start": {"type": "integer"},
                    "end": {"type": "integer"},
                },
                "required": ["start", "end"],
            },
        },
    }]
    try:
        r = httpx.post(url, headers=headers, timeout=60, json={
            "model": model,
            "messages": [
                {"role": "system", "content": "You edit chat logs. Use tools to read before answering."},
                {"role": "user", "content": "Read turns 3 through 5."},
            ],
            "tools": tools,
            "tool_choice": "auto",
            "max_tokens": 256,
            "temperature": 0,
        })
        if r.status_code >= 400:
            print(f"  FAIL HTTP {r.status_code}: {r.text[:200]}")
            ok = False
        else:
            data = r.json()
            msg = (data.get("choices") or [{}])[0].get("message") or {}
            calls = msg.get("tool_calls") or []
            if calls:
                fn = (calls[0].get("function") or {})
                print(f"  ok  tool_calls={len(calls)} name={fn.get('name')} args={str(fn.get('arguments'))[:80]}")
            else:
                # Not fatal on its own, but the agent design depends on it.
                print(f"  FAIL no tool_calls returned; content={str(msg.get('content'))[:120]!r}")
                ok = False
    except Exception as e:
        print(f"  FAIL {type(e).__name__}: {e}")
        ok = False

    print()
    print("PASS - credentials usable for the agent loop" if ok else "FAIL - see above")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
