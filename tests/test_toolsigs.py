"""Gemini thought signatures ride the OpenAI-compatible wire both ways (§1-38).

Fake SDK objects stand in for the response and the stream; the store is the
real one on a temp data dir.
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace as NS

TMP = tempfile.mkdtemp(prefix="risuhina-toolsigs-")
os.environ["RISUHINA_DATA_DIR"] = TMP
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pyserver"))

from app import db, toolsigs  # noqa: E402

fails = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global fails
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" - {detail}" if detail and not ok else ""))
    if not ok:
        fails += 1


db.connect()
SIG = {"google": {"thought_signature": "abc123"}}

print("test_capture_plain_response")
resp = NS(choices=[NS(message=NS(tool_calls=[NS(id="call_1", extra_content=SIG),
                                              NS(id="call_2", model_extra={})]))])
out = toolsigs.capture(resp)
check("the response comes back as-is", out is resp)
check("the signature is remembered by tool_call_id", toolsigs.lookup("call_1") == SIG)
check("a call without one is not", toolsigs.lookup("call_2") is None)

print("test_capture_stream")


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks

    def __aiter__(self):
        self._it = iter(self.chunks)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


chunks = [
    NS(choices=[NS(delta=NS(tool_calls=[NS(index=0, id="call_s", extra_content=None)]))]),
    NS(choices=[NS(delta=NS(tool_calls=[NS(index=0, id=None, model_extra={"extra_content": SIG})]))]),
    NS(choices=[NS(delta=NS(tool_calls=None))]),
]


async def drain(stream):
    seen = []
    async for c in stream:
        seen.append(c)
    return seen


proxy = toolsigs.capture(FakeStream(chunks))
seen = asyncio.run(drain(proxy))
check("every chunk passes through the proxy", seen == chunks)
check("a signature on a later delta maps back through the index", toolsigs.lookup("call_s") == SIG)

print("test_attach")
messages = [
    {"role": "user", "content": "hi"},
    {"role": "assistant", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "list_lore", "arguments": "{}"}}]},
    {"role": "tool", "tool_call_id": "call_1", "content": "..."},
    {"role": "assistant", "tool_calls": [{"id": "call_none", "type": "function", "function": {"name": "x", "arguments": "{}"}}]},
]
toolsigs.attach(messages)
check("the remembered signature is put back on its call", messages[1]["tool_calls"][0].get("extra_content") == SIG)
check("a call with no signature is left alone", "extra_content" not in messages[3]["tool_calls"][0])
toolsigs.attach(None)
toolsigs.attach([{"role": "assistant"}])
check("odd inputs are tolerated", True)

print("test_persists_across_memory")
toolsigs._MEM.clear()
check("the store answers after the cache is gone", toolsigs.lookup("call_1") == SIG)

print()
print("PASS - tool signatures round-trip" if not fails else f"FAIL - {fails} check(s)")
sys.exit(1 if fails else 0)
