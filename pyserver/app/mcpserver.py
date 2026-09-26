"""The MCP route: `/mcp`, Streamable HTTP, the in-panel agent's tools.

**Same tools, same rules.** An MCP client gets the toolset the panel's AI
has (agent.build), called with the same `Deps`, so every write is still a
proposal in the approval queue and the user still approves it in the panel -
nothing here is a second, looser path into the store. What differs:

- The bot and chat come from the panel that pressed 'MCP 활성화'
  (mcpbridge.context), not from a session the panel opened.
- `Deps.mode` is '' - no screen gate. The MCP client is not looking at a
  screen, and the panel shows proposals of both halves anyway.
- A few tools are left out: the ones that manage the in-panel conversation
  itself (plans, handoff notes, compaction), `propose_open_tab` (a UI move),
  and `run_shell` / `pip_install`, whose permission prompt appears only in a
  panel conversation this client has no part in.
- The agent model is never called. Tools run with a stand-in model, so MCP
  works without an agent preset.

**Wiring.** The `mcp` package is an add-on (mcpaddon.py), so nothing here is
imported at module load. `enable()` builds a lowlevel `Server`, a stateless
`StreamableHTTPSessionManager` (SSE responses: sse-starlette pings every 15s,
which keeps a tunnel from timing out a long tool call), runs the manager in a
background task, and inserts ONE exact route `/mcp` ahead of the catch-all
dispatcher. `/mcp/status`, `/mcp/bridge/*` etc. stay ordinary dispatcher
routes with the backend token.
"""
from __future__ import annotations

import asyncio
import base64
import json
import time
from collections import deque
from typing import Any

from . import config, log, mcpbridge

EXCLUDED = frozenset({
    "review_learning", "read_plan", "update_plan", "recall_work", "save_work_state", "compact_context",
    "propose_open_tab", "run_shell", "pip_install",
})

INSTRUCTIONS = """\
Risu Hina: post-hoc editing of RisuAI bots (character cards) and their chats, through a remote backend.

How it works:
- Every tool acts on the bot and chat that are currently open in the Risu Hina panel inside RisuAI,
  where the user pressed 'MCP 활성화'. Call hina_status first to see which bot/chat that is. To work
  on another bot, ask the user to open it in the panel.
- Tools read and edit the Hina WORKING COPY, not live RisuAI. Writes are PROPOSALS (propose_*, stage_*):
  they wait in the panel until the user approves them there. Say "proposed, awaiting approval in the
  panel", never "done". list_proposals / list_staged show what is waiting.
- Approved changes land in the working copy; they reach RisuAI only on 반영 (write-back), which the
  user does in the panel, or write_card_to_risu when the user explicitly asked to save to RisuAI.
- Tool results and the user are Korean-speaking; answer the user in Korean.
- hina_guide returns the full editing rules the in-panel AI follows (CBS, assets, lorebook, scripts).
  Read it before non-trivial edits. list_skills / load_skill hold the method guides.
"""

_state: dict[str, Any] = {"server": None, "manager": None, "stop": None, "task": None, "route": None}
_loop: asyncio.AbstractEventLoop | None = None
_tool_agent: dict[str, Any] = {}
_fails: deque = deque()


def init(loop: asyncio.AbstractEventLoop) -> None:
    """Called at startup with the server loop; enable() may run on a thread."""
    global _loop
    _loop = loop


def mounted() -> bool:
    return _state["route"] is not None


# --- the toolset ---------------------------------------------------------------

def _agent():
    """The agent built for its tools only, with a stand-in model. Rebuilt when
    the skills change (their text is in some tool descriptions)."""
    from pydantic_ai.models.test import TestModel
    from . import agent as agent_mod, skills
    fp = skills.fingerprint()
    if _tool_agent.get("fp") != fp or "agent" not in _tool_agent:
        _tool_agent["agent"] = agent_mod.build(model=TestModel())
        _tool_agent["fp"] = fp
    return _tool_agent["agent"]


def _toolset():
    return _agent()._function_toolset


def _session_for(chat_key: str) -> str:
    """One hidden agent session per chat for MCP work: proposals, clipped
    tool output (read_tool_result) and studio jobs hang off a session id.
    Its title keeps it out of the panel's conversation list."""
    from . import db, session
    row = db.one("SELECT id FROM sessions WHERE chat_key = ? AND title = ? ORDER BY created_at DESC LIMIT 1",
                 (chat_key, mcpbridge.MCP_SESSION_TITLE))
    if row:
        db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (db.now(), row["id"]))
        return row["id"]
    return session.create(chat_key, mcpbridge.MCP_SESSION_TITLE)["sessionId"]


def _deps() -> Any:
    from . import agent as agent_mod, pyexec, store, workspace
    ctx = mcpbridge.context()
    chat_key = ctx.get("chatKey") or ""
    crow = store.chat_row(chat_key) if chat_key else None
    if crow is None:
        raise _Refusal("Risu Hina 패널에 열린 봇·챗이 없습니다. RisuAI 에서 Risu Hina 를 열고 봇과 챗을 골라 주세요.")
    char_key = crow["char_key"]
    pyexec.install_skills(workspace.hina_dir(char_key))
    return agent_mod.Deps(chat_key=chat_key, char_key=char_key, session_id=_session_for(chat_key),
                          workspace_dir=workspace.root(char_key), mode="")


class _Refusal(Exception):
    pass


def _content(obj: Any) -> list:
    """A tool's return value as MCP content blocks."""
    import mcp_types as types
    from pydantic_ai.messages import BinaryContent, ToolReturn
    if obj is None:
        return []
    if isinstance(obj, str):
        return [types.TextContent(type="text", text=obj)]
    if isinstance(obj, ToolReturn):
        return _content(obj.return_value) + _content(obj.content)
    if isinstance(obj, BinaryContent):
        if (obj.media_type or "").startswith("image/"):
            return [types.ImageContent(type="image", data=base64.b64encode(obj.data).decode("ascii"),
                                       mime_type=obj.media_type)]
        return [types.TextContent(type="text", text=f"({obj.media_type} {len(obj.data)} bytes)")]
    if isinstance(obj, (list, tuple)):
        out: list = []
        for x in obj:
            out += _content(x)
        return out
    return [types.TextContent(type="text", text=json.dumps(obj, ensure_ascii=False, default=str, indent=1))]


def _hina_status() -> str:
    from . import store
    st = mcpbridge.status()
    ctx = st.get("context") or {}
    lines = [f"Risu Hina 백엔드 v{config.VERSION}",
             f"패널 연결: {'활성' if st['active'] else '비활성 (패널에서 MCP 활성화를 켜 주세요)'}"]
    if ctx.get("chatKey"):
        crow = store.chat_row(ctx["chatKey"])
        lines.append(f"열린 봇: {ctx.get('botName') or '?'} (charKey {crow['char_key'] if crow else '?'})")
        lines.append(f"열린 챗: {ctx.get('chatName') or '?'} (chatKey {ctx['chatKey']})")
        lines.append(f"패널 화면: {ctx.get('mode') or '선택 화면'}")
        pend = mcpbridge._pending_actions(ctx["chatKey"], crow["char_key"] if crow else "")
        lines.append(f"승인 대기: 제안 {pend['actions']}건 · 턴 수정 {pend['staged']}건 (패널에서 승인)")
    else:
        lines.append("열린 봇·챗: 없음")
    return "\n".join(lines)


def _hina_guide() -> str:
    from . import agent as agent_mod, presets, skills
    return agent_mod.INSTRUCTIONS + presets.instructions() + skills.prompt()


_OWN_TOOLS = {
    "hina_status": ("Which bot and chat the Risu Hina panel has open, whether the panel's MCP switch is on, "
                    "and how many proposals await approval. Call this first.", _hina_status),
    "hina_guide": ("The full editing rules and skill index the in-panel AI follows (Korean/English). "
                   "Read once before editing cards, lorebooks, scripts or assets.", _hina_guide),
}


async def _list_tools(ctx: Any, params: Any) -> Any:
    import mcp_types as types
    tools = [types.Tool(name=n, description=d, input_schema={"type": "object", "properties": {}})
             for n, (d, _) in _OWN_TOOLS.items()]
    for name, tool in _toolset().tools.items():
        if name in EXCLUDED:
            continue
        td = tool.tool_def
        tools.append(types.Tool(name=name, description=td.description or "", input_schema=td.parameters_json_schema))
    return types.ListToolsResult(tools=tools)


async def _call_tool(ctx: Any, params: Any) -> Any:
    import mcp_types as types
    from pydantic_ai import ModelRetry, RunContext
    from pydantic_ai.usage import RunUsage
    name = params.name
    args = dict(params.arguments or {})
    try:
        client = getattr(getattr(ctx.session, "client_params", None), "client_info", None)
        if client is not None:
            mcpbridge.note_client(getattr(client, "name", "") or "")
    except Exception:  # noqa: BLE001 - cosmetic only
        pass

    def err(text: str) -> Any:
        mcpbridge.note_call(name, False)
        return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=True)

    if name in _OWN_TOOLS:
        mcpbridge.note_call(name, True)
        out = await asyncio.to_thread(_OWN_TOOLS[name][1])
        return types.CallToolResult(content=_content(out))
    if not mcpbridge.active():
        return err("Risu Hina 패널의 MCP 가 꺼져 있습니다. RisuAI 에서 Risu Hina 를 열고 첫 화면의 "
                   "'MCP 활성화' 를 켠 뒤, 그 화면을 연 채로 두세요.")
    if name in EXCLUDED:
        return err(f"'{name}' 은 MCP 에서 쓸 수 없는 툴입니다.")
    t0 = time.time()
    try:
        deps = await asyncio.to_thread(_deps)
        ag = _agent()
        rctx = RunContext(deps=deps, model=ag.model, usage=RunUsage())
        ts = ag._function_toolset
        tools = await ts.get_tools(rctx)
        tool = tools.get(name)
        if tool is None:
            return err(f"모르는 툴입니다: {name}")
        try:
            validated = tool.args_validator.validate_python(args)
        except Exception as e:  # noqa: BLE001 - pydantic ValidationError, shown to the model
            return err(f"인자가 올바르지 않습니다: {e}")
        result = await ts.call_tool(name, validated, rctx, tool)
    except _Refusal as e:
        return err(str(e))
    except ModelRetry as e:
        return err(str(e.message if hasattr(e, "message") else e))
    except Exception as e:  # noqa: BLE001 - a tool bug must come back as a result, not a 500
        log.warn("mcp tool %s failed: %s: %s", name, type(e).__name__, e)
        return err(f"{type(e).__name__}: {e}")
    mcpbridge.note_call(name, True)
    log.info("mcp tool %s ok %.1fs", name, time.time() - t0)
    return types.CallToolResult(content=_content(result) or [types.TextContent(type="text", text="(결과 없음)")])


# --- HTTP ------------------------------------------------------------------------

class _Gate:
    """Bearer check in front of the MCP transport. Always required."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            return await self.inner(scope, receive, send)
        now = time.time()
        while _fails and now - _fails[0] > 60:
            _fails.popleft()
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        status, body = 0, b""
        if len(_fails) >= 20:
            status, body = 429, b'{"error":"too many failed attempts"}'
        elif not mcpbridge.check_token(headers.get("authorization", "")):
            _fails.append(now)
            status, body = 401, b'{"error":"unauthorized - use the MCP token from Risu Hina settings"}'
        if status:
            log.warn("mcp %s %s -> %s", scope.get("method"), scope.get("path"), status)
            await send({"type": "http.response.start", "status": status,
                        "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
            await send({"type": "http.response.body", "body": body})
            return
        await self.inner(scope, receive, send)


async def _run_manager(manager: Any, stop: asyncio.Event) -> None:
    try:
        async with manager.run():
            await stop.wait()
    except Exception as e:  # noqa: BLE001
        log.warn("mcp session manager stopped: %s", e)


async def _enable_async() -> None:
    from mcp.server.lowlevel import Server
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    from starlette.routing import Route
    from .main import app
    if mounted():
        return
    server = Server("risu-hina", version=config.VERSION, instructions=INSTRUCTIONS,
                    on_list_tools=_list_tools, on_call_tool=_call_tool)
    manager = StreamableHTTPSessionManager(app=server, stateless=True, json_response=False)
    stop = asyncio.Event()
    task = asyncio.get_running_loop().create_task(_run_manager(manager, stop))
    # Give run() a moment to open its task group before the first request.
    await asyncio.sleep(0)
    route = Route("/mcp", endpoint=_Gate(manager.handle_request), methods=["GET", "POST", "DELETE"])
    app.router.routes.insert(0, route)
    _state.update(server=server, manager=manager, stop=stop, task=task, route=route)
    mcpbridge.token()
    log.info("mcp route mounted at /mcp")


def enable() -> None:
    """Mount /mcp. Safe from the server loop or from a worker thread."""
    from . import mcpaddon
    if not mcpaddon.load():
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None and running is _loop:
        running.create_task(_enable_async())
    elif _loop is not None:
        asyncio.run_coroutine_threadsafe(_enable_async(), _loop).result(timeout=30)
    else:
        log.warn("mcp enable skipped: no server loop yet")


def disable() -> None:
    from .main import app
    route = _state.get("route")
    if route is not None:
        try:
            app.router.routes.remove(route)
        except ValueError:
            pass
    stop = _state.get("stop")
    if stop is not None and _loop is not None:
        _loop.call_soon_threadsafe(stop.set)
    _state.update(server=None, manager=None, stop=None, task=None, route=None)
    mcpbridge.set_enabled(False)
    log.info("mcp route removed")
