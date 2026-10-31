"""session.neutralise_thinking: a Responses model must not be handed reasoning
ids another provider minted (400 "Invalid 'input[N].id': 'reasoning'")."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))

from pydantic_ai.messages import (  # noqa: E402
    ModelRequest, ModelResponse, RetryPromptPart, TextPart, ThinkingPart, ToolCallPart, ToolReturnPart,
    UserPromptPart,
)

from app.session import drop_empty_replies, neutralise_thinking  # noqa: E402

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

print("\ntest_empty_replies_are_dropped (§1-122)")
# The 2026-10-31 session: view_image result -> empty reply -> nudge -> empty
# reply -> our failure note; then the next prompt, the same again.
nudge = "Please return text or call a tool."
stuck = [
    ModelRequest(parts=[UserPromptPart(content="보여줘")]),
    ModelResponse(parts=[ToolCallPart(tool_name="view_image", args={"path": "a.png"}, tool_call_id="c1")]),
    ModelRequest(parts=[ToolReturnPart(tool_name="view_image", content="남자 1명", tool_call_id="c1")]),
    ModelResponse(parts=[]),
    ModelRequest(parts=[RetryPromptPart(content=nudge)]),
    ModelResponse(parts=[ThinkingPart(content="hmm")]),
    ModelResponse(parts=[TextPart(content="(이 턴은 완료되지 못했습니다: ...)")]),
    ModelRequest(parts=[UserPromptPart(content="다시")]),
    ModelResponse(parts=[TextPart(content="  ")]),
    ModelRequest(parts=[RetryPromptPart(content=nudge)]),
    ModelResponse(parts=[TextPart(content="네")]),
]
clean = drop_empty_replies(stuck)
kinds = [type(m).__name__ for m in clean]
check("no empty reply survives", not any(isinstance(m, ModelResponse) and not m.parts for m in clean))
check("thinking-only and blank-text replies go too",
      all(any(isinstance(p, (TextPart, ToolCallPart)) and str(getattr(p, "content", "x")).strip() for p in m.parts)
          for m in clean if isinstance(m, ModelResponse)), str(kinds))
check("the nudges go with them",
      not any(isinstance(p, RetryPromptPart) for m in clean for p in m.parts))
check("requests and replies alternate again",
      all(kinds[i] != kinds[i + 1] for i in range(len(kinds) - 1)), str(kinds))
check("the real conversation is kept", len(clean) == 6 and clean[-1].parts[0].content == "네", str(kinds))
tool_retry = [ModelRequest(parts=[RetryPromptPart(content="bad args", tool_name="read_file", tool_call_id="c2")])]
check("a tool's own retry prompt is kept", drop_empty_replies(tool_retry) == tool_retry)

print()
if fails:
    print(f"FAIL - {fails} check(s)")
    sys.exit(1)
print("PASS - thinking ids neutralised for the Responses API; empty replies dropped")
