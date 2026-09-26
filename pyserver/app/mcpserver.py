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
- Tools read and edit the Hina WORKING COPY, not live RisuAI. Writes are PROPOSALS (propose_*, stage_*).
  They are applied when approved - in the panel, or here with approve_proposals (list_proposals ids) and
  approve_staged (turn edits). Approve what the user asked for; until approved, say "proposed", not "done".
- Approved changes land in the working copy; they reach RisuAI only on 반영 (write-back): approve a
  propose_writeback (chat) or call write_card_to_risu (card) when the user wants it saved to RisuAI.
  Both are carried out by the open panel, and the tool reports the verified result.
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
    if not st["active"]:
        # With the switch off the token opens nothing - including what the
        # panel was last looking at.
        return "\n".join(lines)
    if ctx.get("chatKey"):
        crow = store.chat_row(ctx["chatKey"])
        lines.append(f"열린 봇: {ctx.get('botName') or '?'} (charKey {crow['char_key'] if crow else '?'})")
        lines.append(f"열린 챗: {ctx.get('chatName') or '?'} (chatKey {ctx['chatKey']})")
        lines.append(f"패널 화면: {ctx.get('mode') or '선택 화면'}")
        pend = mcpbridge._pending_actions(ctx["chatKey"], crow["char_key"] if crow else "")
        lines.append(f"승인 대기: 제안 {pend['actions']}건 · 턴 수정 {pend['staged']}건 "
                     "(approve_proposals / approve_staged 또는 패널에서 승인)")
    else:
        lines.append("열린 봇·챗: 없음")
    return "\n".join(lines)


def _hina_guide() -> str:
    from . import agent as agent_mod, presets, skills
    return agent_mod.INSTRUCTIONS + presets.instructions() + skills.prompt()


# --- deciding proposals from the MCP client -----------------------------------
#
# The panel's 승인 buttons, as tools. They call the same handlers the buttons
# reach (main.h_action_decide / main.h_approve), so every guard holds: one
# dirty scope at a time, the auto checkpoint before turn edits are applied,
# the conflict check. They are separate tools from the propose_* ones on
# purpose - an MCP client's permission rules (Claude Code's allow list, auto
# mode) can then treat "propose" and "apply" differently.
#
# Host actions (반영 to RisuAI, 사본 저장, 복제 봇) cannot run here: they ride
# the panel's long poll as a 'host-action' job, the plugin runs its own
# decideAction (= clicking 승인·실행) and reports back, and the tool waits for
# that report, like write_card_to_risu does.

HOST_START_S = 15.0
HOST_DONE_S = 300.0
_CHAT_HOST_KINDS = ("host_writeback", "host_save_copy")


def _ids(raw: Any) -> list[str] | None:
    """'all' / '' -> None (everything); otherwise a list of ids."""
    if isinstance(raw, list):
        vals = [str(x).strip() for x in raw]
    else:
        vals = [x.strip() for x in str(raw or "").replace("\n", ",").split(",")]
    vals = [v for v in vals if v]
    return None if not vals or vals == ["all"] else vals


async def _await_host(action_id: str) -> tuple[str, str]:
    from . import actions
    t0 = time.monotonic()
    while True:
        cur = actions.get(action_id)
        if cur is None:
            return "failed", "작업을 찾을 수 없습니다."
        if cur["status"] in (actions.DONE, actions.FAILED, actions.REJECTED):
            return cur["status"], str(cur.get("result") or "")
        waited = time.monotonic() - t0
        if cur["status"] == actions.PENDING and waited > HOST_START_S:
            return "pending", "패널이 작업을 시작하지 않았습니다 (MCP 화면이 열려 있는지 확인). 제안은 그대로 남아 있습니다."
        if waited > HOST_DONE_S:
            return cur["status"], "패널 작업 완료 확인 대기를 마쳤습니다. list_proposals 로 결과를 확인하세요."
        await asyncio.sleep(0.25)


async def _approve_proposals(args: dict) -> str:
    from . import actions, db, main
    ctx = mcpbridge.context()
    crow = await asyncio.to_thread(_chat_row, ctx.get("chatKey") or "")
    if crow is None:
        raise _Refusal("Risu Hina 패널에 열린 봇·챗이 없습니다.")
    char_key, open_chat = crow["char_key"], ctx["chatKey"]
    approve = args.get("approve") is not False
    want = _ids(args.get("ids"))
    rows = db.query("SELECT * FROM pending_actions WHERE char_key = ? AND status = 'pending' ORDER BY created_at",
                    (char_key,))
    todo = [actions._row(r) | {"chatKey": str(r["chat_key"])} for r in rows]
    if want is not None:
        known = {a["id"] for a in todo}
        missing = [i for i in want if i not in known]
        todo = [a for a in todo if a["id"] in set(want)]
    else:
        missing = []
    if not todo:
        return "처리할 제안이 없습니다." + (f" (없는 id: {', '.join(missing)})" if missing else "")
    out = []
    for a in todo:
        label = f"[{a['kind']}] {a['summary']}"
        host = a["kind"] in actions.HOST_KINDS
        try:
            if host and approve:
                if a["kind"] in _CHAT_HOST_KINDS and a["chatKey"] != open_chat:
                    out.append(f"건너뜀 {a['id']} {label}: 다른 챗의 작업입니다 - 패널에서 그 챗을 연 뒤 다시 승인하세요.")
                    continue
                mcpbridge.push_job({"type": "host-action", "id": a["id"], "kind": a["kind"],
                                    "charKey": char_key, "chatKey": a["chatKey"]})
                status, detail = await _await_host(a["id"])
                out.append(f"{'완료' if status == 'done' else status} {a['id']} {label}" + (f" - {detail}" if detail else ""))
                if status != "done":
                    break
                continue
            r = await asyncio.to_thread(main.h_action_decide,
                                        {"chatKey": a["chatKey"], "id": a["id"], "approve": approve})
            if not approve:
                out.append(f"거절 {a['id']} {label}")
            else:
                out.append(f"적용 {a['id']} {label}" + (f" - {r.get('result')}" if r.get("result") else ""))
        except Exception as e:  # noqa: BLE001 - ApiError / ActionError: the guard's sentence
            out.append(f"실패 {a['id']} {label}: {e}")
            break
    if missing:
        out.append(f"없는 id: {', '.join(missing)}")
    if approve:
        out.append("적용된 변경은 Hina 작업본에 있습니다. RisuAI 에는 반영(propose_writeback 승인 / write_card_to_risu) 후에 들어갑니다.")
    return "\n".join(out)


async def _approve_staged(args: dict) -> str:
    from . import main, staging
    ctx = mcpbridge.context()
    chat_key = ctx.get("chatKey") or ""
    if await asyncio.to_thread(_chat_row, chat_key) is None:
        raise _Refusal("Risu Hina 패널에 열린 챗이 없습니다.")
    want = _ids(args.get("ids"))
    approve = args.get("approve") is not False
    pending = staging.pending(chat_key)
    if not pending:
        return "대기 중인 턴 수정이 없습니다."
    arg: dict = {"chatKey": chat_key, "approve": approve}
    if want is None:
        arg["all"] = True
    else:
        arg["ids"] = want
    try:
        r = await asyncio.to_thread(main.h_approve, arg)
    except Exception as e:  # noqa: BLE001
        conflicts = getattr(e, "payload", {}).get("conflicts") if hasattr(e, "payload") else None
        return f"적용하지 못했습니다: {e}" + (f" (충돌 {len(conflicts)}건)" if conflicts else "")
    if not approve:
        return f"턴 수정 {r.get('decided', 0)}건을 거절했습니다."
    return (f"턴 수정 {r.get('decided', 0)}건 승인, {r.get('applied', 0)}건을 작업본에 적용했습니다 "
            "(적용 직전 자동 체크포인트). RisuAI 에는 propose_writeback 승인 후 들어갑니다.")


def _chat_row(chat_key: str) -> Any:
    from . import store
    return store.chat_row(chat_key) if chat_key else None


_IDS_SCHEMA = {
    "type": "object",
    "properties": {
        "ids": {"type": "string", "description": "Comma-separated ids, or 'all' (default)."},
        "approve": {"type": "boolean", "description": "true = approve and apply (default), false = reject.",
                    "default": True},
    },
}
_NO_ARGS = {"type": "object", "properties": {}}


async def _plain(fn: Any) -> Any:
    return await asyncio.to_thread(fn)


# name -> (description, input schema, async fn(args), needs the panel switch)
_OWN_TOOLS: dict[str, tuple[str, dict, Any, bool]] = {
    "hina_status": ("Which bot and chat the Risu Hina panel has open, whether the panel's MCP switch is on, "
                    "and how many proposals await approval. Call this first. With the switch off it only says so.",
                    _NO_ARGS, lambda a: _plain(_hina_status), False),
    "hina_guide": ("The full editing rules and skill index the in-panel AI follows (Korean/English). "
                   "Read once before editing cards, lorebooks, scripts or assets.",
                   _NO_ARGS, lambda a: _plain(_hina_guide), True),
    "approve_proposals": (
        "Approve (or reject) pending proposals of the open bot - the panel's 승인 button. Covers lorebook, "
        "card, script, memory, asset, snapshot proposals (see list_proposals for ids) and host actions: an "
        "approved propose_writeback / propose_save_copy / propose_clone_bot is carried out by the panel in "
        "RisuAI and this waits for its result. Approving applies to the Hina working copy; approve only what "
        "the user asked for or agreed to. Stops at the first failure.",
        _IDS_SCHEMA, _approve_proposals, True),
    "approve_staged": (
        "Approve (or reject) pending turn edits of the open chat (stage_edit / stage_bulk / stage_delete; "
        "see list_staged). Approval applies them to the working copy after an automatic checkpoint.",
        _IDS_SCHEMA, _approve_staged, True),
}


async def _list_tools(ctx: Any, params: Any) -> Any:
    import mcp_types as types
    tools = [types.Tool(name=n, description=d, input_schema=schema)
             for n, (d, schema, _, _) in _OWN_TOOLS.items()]
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

    off = ("Risu Hina 패널의 MCP 가 꺼져 있습니다. RisuAI 에서 Risu Hina 를 열고 첫 화면의 "
           "'MCP 활성화' 를 켠 뒤, 그 화면을 연 채로 두세요.")
    if name in _OWN_TOOLS:
        _, _, fn, needs_panel = _OWN_TOOLS[name]
        if needs_panel and not mcpbridge.active():
            return err(off)
        try:
            out = await fn(args)
        except _Refusal as e:
            return err(str(e))
        except Exception as e:  # noqa: BLE001
            log.warn("mcp tool %s failed: %s: %s", name, type(e).__name__, e)
            return err(f"{type(e).__name__}: {e}")
        mcpbridge.note_call(name, True)
        return types.CallToolResult(content=_content(out))
    if not mcpbridge.active():
        return err(off)
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
