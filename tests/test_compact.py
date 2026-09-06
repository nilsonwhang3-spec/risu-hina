"""agent.compact_history (§1-44): old tool traffic is clipped every turn, and
when the summary model fails (it refused an adult transcript on every turn of
a 100MB session) whole turns are dropped mechanically so the budget holds."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))
os.environ["RISUHINA_DATA_DIR"] = tempfile.mkdtemp(prefix="hina-compact-")

from pydantic_ai.messages import (  # noqa: E402
    ModelMessagesTypeAdapter, ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart,
)

from app import agent as agent_mod  # noqa: E402
from app import config, session  # noqa: E402

fails = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global fails
    print(("  ok   " if ok else "  FAIL ") + label + (f" - {detail}" if detail and not ok else ""))
    if not ok:
        fails += 1


def turn(i: int, big: int = 5000) -> list:
    """One user turn: prompt, a tool call with big args, a big return, an answer."""
    return [
        ModelRequest(parts=[UserPromptPart(content=f"요청 {i}: " + "ㄱ" * 40)]),
        ModelResponse(parts=[ToolCallPart(tool_name="run_python", args={"code": "x" * big}, tool_call_id=f"c{i}")]),
        ModelRequest(parts=[ToolReturnPart(tool_name="run_python", content="stdout: " + "y" * big, tool_call_id=f"c{i}")]),
        ModelResponse(parts=[TextPart(content=f"답 {i}")]),
    ]


def chars(msgs: list) -> int:
    return sum(agent_mod._msg_chars(m) for m in msgs)


def main() -> int:
    msgs = [m for i in range(6) for m in turn(i)]
    before = chars(msgs)

    print("prune_tool_parts")
    pruned, saved = agent_mod.prune_tool_parts(msgs)
    check("saves most of the old tool traffic", saved > before * 0.5, f"saved={saved} of {before}")
    check("the input list is not mutated", chars(msgs) == before)
    last_two = pruned[-8:]
    check("the last two turns are untouched", all(a is b for a, b in zip(last_two, msgs[-8:])))
    old_ret = pruned[2].parts[0]
    check("an old return is clipped with a note", len(old_ret.content) < 800 and "생략" in old_ret.content)
    old_call = pruned[1].parts[0]
    check("old call args stay a dict", isinstance(old_call.args, dict) and "_clipped" in old_call.args)
    again, saved2 = agent_mod.prune_tool_parts(pruned)
    check("idempotent", saved2 == 0)
    try:
        ModelMessagesTypeAdapter.dump_json(pruned)
        check("the pruned history still serialises", True)
    except Exception as e:  # noqa: BLE001
        check("the pruned history still serialises", False, str(e))
    small, s0 = agent_mod.prune_tool_parts([m for i in range(2) for m in turn(i)])
    check("two turns or fewer: nothing to prune", s0 == 0)

    print("compact_history fallback")
    saved_cfg = dict(config.section("agent"))
    config.update({"agent": {"historyBudgetChars": 12000}})

    class Boom:
        def __init__(self, *a, **k):
            pass

        async def run(self, *a, **k):
            raise RuntimeError("content_filter: PROHIBITED_CONTENT")

    real_agent, real_model = agent_mod.Agent, agent_mod._model
    agent_mod.Agent = Boom  # type: ignore[assignment]
    agent_mod._model = lambda: None  # type: ignore[assignment]
    try:
        agent_mod.COMPACTED.clear()
        out = asyncio.run(agent_mod.compact_history("s1", msgs))
        check("fits the budget without a model", chars(out) <= 12000, f"chars={chars(out)}")
        check("starts with the drop note listing the dropped requests",
              isinstance(out[0], ModelRequest) and "생략" in out[0].parts[0].content and "요청 0" in out[0].parts[0].content)
        check("the newest turn survives whole", any("답 5" in getattr(p, "content", "") for m in out for p in m.parts))
        check("never cuts between a call and its return",
              all(not (isinstance(m, ModelRequest) and m.parts[0].part_kind == "tool-return") for m in out[:3]))
        check("remembered for session.run to store", agent_mod.COMPACTED.get("s1") is out)
        agent_mod.COMPACTED.clear()
        out2 = asyncio.run(agent_mod.compact_history("s2", [m for i in range(2) for m in turn(i, 100)]))
        check("a small history passes through untouched", "s2" not in agent_mod.COMPACTED and len(out2) == 8)
    finally:
        agent_mod.Agent, agent_mod._model = real_agent, real_model  # type: ignore[assignment]
        config.update({"agent": {"historyBudgetChars": saved_cfg.get("historyBudgetChars")}})

    print("explicit stop")
    session.note_job("sx", "job-1")
    r = session.stop("sx")
    check("stop flags the session and cancels its jobs", session.stopped("sx") and r["jobsCancelled"] == 1)
    check("stop is idempotent", session.stop("sx")["jobsCancelled"] == 0)
    check("TurnStopped explains as 중단됨", session._explain(session.TurnStopped()) == "중단됨")

    print()
    print("PASS" if not fails else f"FAIL ({fails})")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
