"""session.neutralise_thinking: a Responses model must not be handed reasoning
ids another provider minted (400 "Invalid 'input[N].id': 'reasoning'")."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))

from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ThinkingPart, UserPromptPart  # noqa: E402

from app.session import neutralise_thinking  # noqa: E402

fails = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global fails
    print(("  ok   " if ok else "  FAIL ") + label + (f" - {detail}" if detail and not ok else ""))
    if not ok:
        fails += 1


class FakeResponses:
    system = "openai"


FakeResponses.__name__ = "OpenAIResponsesModel"


class FakeChat:
    system = "openai"


FakeChat.__name__ = "OpenAIChatModel"


history = [
    ModelRequest(parts=[UserPromptPart(content="hi")]),
    ModelResponse(parts=[
        # From a chat-completions gateway: id named after the field.
        ThinkingPart(content="thought", id="reasoning", provider_name="openai"),
        TextPart(content="a"),
    ]),
    ModelResponse(parts=[
        # The Responses API's own, replayable.
        ThinkingPart(content="", id="rs_abc", signature="enc", provider_name="openai"),
        TextPart(content="b"),
    ]),
    ModelResponse(parts=[
        # Another provider's Responses-shaped id: still not ours.
        ThinkingPart(content="x", id="rs_other", provider_name="vercel"),
        TextPart(content="c"),
    ]),
]

out = neutralise_thinking(history, FakeResponses())
th = [p for m in out if isinstance(m, ModelResponse) for p in m.parts if isinstance(p, ThinkingPart)]
check("three thinking parts survive as text", len(th) == 3 and th[0].content == "thought")
check("the chat-completions id is dropped", th[0].id is None)
check("our own rs_ item keeps id and signature", th[1].id == "rs_abc" and th[1].signature == "enc")
check("a foreign rs_ id is dropped", th[2].id is None)
check("requests untouched", isinstance(out[0], ModelRequest) and out[0] is history[0])
check("untouched responses are the same objects", out[2] is history[2])
check("the input is not mutated", history[1].parts[0].id == "reasoning")

same = neutralise_thinking(history, FakeChat())
check("chat models get the history as is", same is history)

print()
if fails:
    print(f"FAIL - {fails} check(s)")
    sys.exit(1)
print("PASS - thinking ids neutralised for the Responses API")
