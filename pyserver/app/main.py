"""HTTP surface.

An explicit route table plus one dispatcher, rather than decorated endpoints.
The wire behaviour - which routes exist, what is auth-exempt, what order the
checks run in - is then readable in one screen, and a black-box suite can be
written against it without reading any handler.

Order matters and is deliberate:
    OPTIONS  -> answered first, so preflight never needs auth
    404      -> decided BEFORE auth, so probing routes is not an oracle
    auth     -> loopback may be exempt, non-loopback never is
    body cap -> before parsing, so a huge body cannot be used to spend memory

Concurrency: handlers touch SQLite and the filesystem, so they are plain `def`
and run in the threadpool; a slow disk read can never stall the event loop.
"""
from __future__ import annotations

import hmac
import inspect
import json
import pathlib
import re
import sys
import time
import urllib.parse
import uuid
from collections import defaultdict, deque
from typing import Any, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from . import (chatfmt, config, db, files, log, presets, session, skills, staging,
               store, websearch, workspace)
from . import actions, assets, catalog, charx, codexauth, keys, snapshots, updater
from . import card as cardmod
from . import memory as mem

Handler = Callable[..., Any]


def _json(status: int, payload: Any, origin: str | None = None) -> Response:
    # Explicit charset: Starlette emits a bare application/json and some clients
    # then decode UTF-8 Korean as latin-1.
    return Response(
        content=json.dumps(payload, ensure_ascii=False),
        status_code=status,
        media_type="application/json; charset=utf-8",
        headers=config.cors_headers(origin),
    )


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.payload = {"error": message, **extra}


# --- auth -------------------------------------------------------------------

_auth_fails: dict[str, deque] = defaultdict(deque)
_AUTH_WINDOW_S = 60
_AUTH_MAX_FAILS = 20


def _rate_limited(addr: str) -> bool:
    now = time.time()
    q = _auth_fails[addr]
    while q and now - q[0] > _AUTH_WINDOW_S:
        q.popleft()
    return len(q) >= _AUTH_MAX_FAILS


def _authorized(request: Request) -> tuple[bool, str]:
    addr = request.client.host if request.client else ""
    if not config.token_required_for(addr):
        return True, addr
    presented = request.headers.get("authorization") or ""
    expected = f"Bearer {config.ensure_token()}"
    return hmac.compare_digest(presented, expected), addr


# --- argument helpers -------------------------------------------------------

def _char(arg: dict) -> str:
    key = str(arg.get("charKey") or arg.get("key") or "").strip()
    if not key:
        raise ApiError(400, "charKey is required")
    if workspace.info(key) is None:
        raise ApiError(404, f"unknown workspace: {key}")
    return key


def _chat(arg: dict) -> str:
    key = str(arg.get("chatKey") or "").strip()
    if not key:
        raise ApiError(400, "chatKey is required")
    if store.chat_row(key) is None:
        raise ApiError(404, f"unknown chat: {key}")
    return key


def _int(arg: dict, name: str, default: int) -> int:
    raw = arg.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ApiError(400, f"{name} must be an integer")


# --- handlers ---------------------------------------------------------------

def agent_ready() -> bool:
    """Whether the agent can actually run.

    Shared by /health and /session so the two can never disagree - they already
    did once, and the panel believed the wrong one.
    """
    a = config.section("agent")
    if (a.get("provider") or "") == "codex":
        return bool((a.get("model") or "").strip()) and codexauth.logged_in()
    return bool((a.get("baseUrl") or "").strip()
                and (a.get("apiKey") or "").strip()
                and (a.get("model") or "").strip())


def h_health(arg: dict) -> dict:
    return {
        # The signature the plugin checks before it is willing to attach a
        # bearer token (plan 7.1). Must stay stable.
        "service": "risu-elf",
        "version": config.VERSION,
        "ok": True,
        "agentReady": agent_ready(),
        "clientIp": arg.get("_addr"),
        "loopback": config.is_loopback(arg.get("_addr") or ""),
        "tokenRequired": config.token_required_for(arg.get("_addr") or ""),
        "workspaces": len(workspace.list_all()),
    }


def h_config_get(arg: dict) -> dict:
    return {"config": config.redacted(), "keepSentinel": config.KEEP}


def h_config_set(arg: dict) -> dict:
    patch = arg.get("config")
    if not isinstance(patch, dict):
        raise ApiError(400, "config must be an object")
    try:
        return {"config": config.update(patch)}
    except ValueError as e:
        raise ApiError(400, str(e))


def h_config_test(arg: dict) -> dict:
    """Prove the configured agent credentials actually work.

    Plain completion and tool calling are checked separately because they fail
    independently: a gateway that answers prose but drops `tools` would
    otherwise only surface later, as an agent that "never uses its tools".
    """
    import httpx

    agent = config.section("agent")
    base = (agent.get("baseUrl") or "").rstrip("/")
    key = agent.get("apiKey") or ""
    model = agent.get("model") or ""
    if not (base and key and model):
        return {"ok": False, "stage": "config", "error": "baseUrl · apiKey · model 이 모두 필요합니다"}

    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    url = base + "/chat/completions"

    def body_of(r) -> dict:
        """The JSON body, or a ValueError that names what actually came back.

        A bare JSONDecodeError hides the two common misconfigurations: a host
        that only redirects (api.ollama.com -> ollama.com, which httpx does not
        follow, so a 301 with an empty body reached `r.json()`), and a baseUrl
        that lands on an HTML page. Both used to surface as "Expecting value:
        line 1 column 1", which points at nothing the user can change.
        """
        if 300 <= r.status_code < 400:
            where = r.headers.get("location") or "(Location 헤더 없음)"
            if where.endswith("/chat/completions"):
                where = where[: -len("/chat/completions")]
            raise ValueError(
                f"HTTP {r.status_code} 리다이렉트 → {where} — baseUrl 을 이 주소로 바꿔 주세요")
        if r.status_code >= 400:
            # Sanitised: an upstream error body can echo the key back.
            raise ValueError(f"HTTP {r.status_code}: {_scrub(r.text[:200], key)}")
        try:
            data = r.json()
        except ValueError:
            ctype = r.headers.get("content-type") or "?"
            raise ValueError(
                f"응답이 JSON 이 아닙니다 (HTTP {r.status_code}, {ctype}): "
                f"{_scrub(r.text[:120].strip(), key) or '(빈 본문)'} — baseUrl 이 OpenAI 호환 "
                f"엔드포인트(…/v1)인지 확인해 주세요")
        if not isinstance(data, dict):
            raise ValueError(f"응답이 객체가 아닙니다: {_scrub(str(data)[:120], key)}")
        return data

    try:
        r = httpx.post(url, headers=headers, timeout=45, json={
            "model": model,
            "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
            "max_tokens": 32, "temperature": 0,
        })
        data = body_of(r)
        usage = data.get("usage") or {}
    except ValueError as e:
        return {"ok": False, "stage": "completion", "error": str(e)}
    except Exception as e:
        return {"ok": False, "stage": "completion", "error": _scrub(f"{type(e).__name__}: {e}", key)}

    try:
        r = httpx.post(url, headers=headers, timeout=45, json={
            "model": model,
            "messages": [{"role": "user", "content": "Read turns 3 through 5."}],
            "tools": [{"type": "function", "function": {
                "name": "read_turns", "description": "Read chat turns by index range.",
                "parameters": {"type": "object",
                               "properties": {"start": {"type": "integer"}, "end": {"type": "integer"}},
                               "required": ["start", "end"]}}}],
            "tool_choice": "auto", "max_tokens": 256, "temperature": 0,
        })
        calls = ((body_of(r).get("choices") or [{}])[0].get("message") or {}).get("tool_calls") or []
    except ValueError as e:
        return {"ok": False, "stage": "tools", "error": str(e)}
    except Exception as e:
        return {"ok": False, "stage": "tools", "error": _scrub(f"{type(e).__name__}: {e}", key)}

    return {
        "ok": bool(calls),
        "stage": "done",
        "model": model,
        "toolCalls": len(calls),
        "usage": {"in": usage.get("prompt_tokens"), "out": usage.get("completion_tokens")},
        "error": None if calls else "모델이 tool_calls 를 돌려주지 않습니다 — 에이전트가 동작할 수 없습니다",
    }


def _scrub(text: str, secret: str) -> str:
    return text.replace(secret, "***") if secret else text


def h_logs(arg: dict) -> dict:
    """Recent server log, for a bug report.

    Deliberately not a file path: by the time someone needs this they are
    looking at a panel, possibly on a phone over Tailscale, and telling them to
    go and find server.log on the host is not an answer. The panel shows it and
    offers to copy it.
    """
    lines = log.recent(_int(arg, "limit", 300), str(arg.get("level") or ""))
    return {
        "lines": lines,
        "count": len(lines),
        "debug": log.DEBUG,
        "version": config.VERSION,
        "dataDir": str(config.DATA_DIR),
        "port": config.PORT,
    }


def h_diag(arg: dict) -> dict:
    """One block a user can paste into a bug report.

    Everything needed to place a failure - versions, what is configured, how
    much is stored - and nothing that identifies a person or leaks a key. The
    counts are shapes, not contents.
    """
    agent_cfg = config.section("agent")
    counts = {}
    for table in ("characters", "chats", "turns", "memories", "skills",
                  "agent_presets", "sessions", "pending_actions", "asset_blobs", "char_assets"):
        try:
            r = db.one(f"SELECT COUNT(*) AS n FROM {table}")
            counts[table] = int(r["n"]) if r else 0
        except Exception:  # noqa: BLE001 - a missing table is itself the answer
            counts[table] = -1
    return {
        "service": config.APP_NAME,
        "version": config.VERSION,
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "debug": log.DEBUG,
        "agentReady": agent_ready(),
        "agent": {
            "model": agent_cfg.get("model") or "",
            "baseUrlHost": (agent_cfg.get("baseUrl") or "").split("/")[2]
            if "//" in (agent_cfg.get("baseUrl") or "") else "",
            "hasKey": bool(agent_cfg.get("apiKey")),
            "maxTokens": agent_cfg.get("maxTokens"),
            "reasoning": agent_cfg.get("reasoning") or "",
            "cache": bool(agent_cfg.get("cache")),
            "flex": bool(agent_cfg.get("flex")),
        },
        "webSearch": websearch.configured(),
        "assets": assets.summary_for_diag(),
        "counts": counts,
        "routes": len(ROUTES),
    }


# --- M0: asset-transfer measurement (bot-edit plan, milestone 0) -------------

def h_diag_asset_echo(arg: dict) -> dict:
    """Receive an asset batch, count it, discard it.

    Measures the plugin->backend transfer path (readImage -> base64 -> POST)
    before the real asset store exists. Nothing touches disk. The address the
    backend saw goes back in the response: the user's own IP means a direct
    fetch, a hub address means the request was relayed - the two paths have
    very different bandwidth and privacy stories, and this is how they are
    told apart.
    """
    import base64
    items = arg.get("items")
    if not isinstance(items, list):
        raise ApiError(400, "items must be a list")
    t0 = time.time()
    total = 0
    bad: list[str] = []
    for it in items:
        row = it if isinstance(it, dict) else {}
        try:
            total += len(base64.b64decode(str(row.get("data") or ""), validate=True))
        except (ValueError, TypeError):
            bad.append(str(row.get("key") or "?"))
    return {
        "items": len(items),
        "bytes": total,
        "decodeMs": int((time.time() - t0) * 1000),
        "badItems": bad,
        "addr": str(arg.get("_addr") or ""),
    }


_RS_HUB = "https://sv.risuai.xyz/rs/"
# Only the exact content-addressed shape may leave this server as a probe.
_RS_KEY = re.compile(r"assets/[0-9a-f]{16,64}\.[A-Za-z0-9]{1,8}")


def h_diag_rs_probe(arg: dict) -> dict:
    """Can this backend pull an asset straight from the RisuAI hub?

    Web-mainline client code fetches `<hub>/rs/assets/<hash>.<ext>` without
    credentials, but whether the server actually gates it is unknowable from
    client source alone. If this returns 200 for an account-synced bot, the
    plugin only ever needs to send key lists and the backend downloads the
    content itself - no browser bandwidth at all.
    """
    import httpx
    key = str(arg.get("key") or "").strip()
    if not _RS_KEY.fullmatch(key):
        raise ApiError(400, "key must look like assets/<hash>.<ext>")
    t0 = time.time()
    try:
        r = httpx.get(_RS_HUB + key, timeout=30, follow_redirects=True)
        return {
            "key": key,
            "status": r.status_code,
            "bytes": len(r.content),
            "contentType": r.headers.get("content-type", ""),
            "ms": int((time.time() - t0) * 1000),
        }
    except Exception as e:  # noqa: BLE001 - the failure itself is the finding
        return {"key": key, "error": f"{type(e).__name__}: {e}",
                "ms": int((time.time() - t0) * 1000)}


# --- M2: the asset store ------------------------------------------------------

def h_assets_manifest(arg: dict) -> dict:
    """The plugin says what the bot references; the store says what it lacks."""
    ck = _char(arg)
    try:
        return assets.manifest(ck, arg.get("refs") or [], hub_pull=bool(arg.get("hubPull")))
    except assets.AssetError as e:
        raise ApiError(400, str(e))


def h_assets_upload(arg: dict) -> dict:
    try:
        return assets.upload(arg.get("items"))
    except assets.AssetError as e:
        raise ApiError(400, str(e))


def h_assets_fail(arg: dict) -> dict:
    keys = arg.get("keys")
    if not isinstance(keys, list):
        raise ApiError(400, "keys must be a list")
    return {"marked": assets.mark_failed([str(k) for k in keys], str(arg.get("reason") or "host read failed"))}


def h_assets_status(arg: dict) -> dict:
    return assets.status(_char(arg))


def h_assets_list(arg: dict) -> dict:
    return assets.listing(_char(arg))


def h_assets_gc(arg: dict) -> dict:
    days = arg.get("days")
    return assets.gc(None if days in (None, "") else float(days))


def h_assets_blob(arg: dict) -> Any:
    raise ApiError(500, "assets/blob must be dispatched directly")


# --- M2: charx ------------------------------------------------------------------

def h_charx_preview(arg: dict) -> dict:
    try:
        return charx.preview(_char(arg))
    except charx.CharxError as e:
        raise ApiError(409, str(e))


def h_charx_build(arg: dict) -> dict:
    """Assemble out/<name>.charx from the working card and the store. A
    refusal over missing assets is a 409 with the list, not an exception."""
    ck = _char(arg)
    try:
        r = charx.build(ck, allow_missing=bool(arg.get("allowMissing")),
                        filename=str(arg.get("name") or "") or None)
    except charx.CharxError as e:
        raise ApiError(409, str(e))
    if not r.get("ok"):
        raise ApiError(409, "에셋이 빠져 있어 charx 를 만들지 않았습니다", **r)
    return r


def h_file_download(arg: dict) -> Any:
    raise ApiError(500, "files/download must be dispatched directly")


def h_assets_adopt(arg: dict) -> dict:
    """The plugin saved a workspace file into RisuAI; record the key here."""
    ck = _char(arg)
    try:
        return assets.adopt(ck, str(arg.get("key") or ""), str(arg.get("path") or ""),
                            name=str(arg.get("name") or ""), field=str(arg.get("field") or "additional"))
    except (assets.AssetError, files.FileError) as e:
        raise ApiError(400, str(e))


def _plugin_file() -> "pathlib.Path | None":
    """The newest built plugin, wherever this install keeps it.

    Two locations because there are two situations. A deployment drops the file
    into `data/plugin/`, which survives a version swap. A checkout has it in
    `plugin/dist/`, and during development that is the one that is current.
    Newest wins, so a developer never serves yesterday's build by accident.
    """
    install = pathlib.Path(__file__).resolve().parent.parent.parent
    roots = [
        install / "plugin",          # where a release unpacks it
        config.DATA_DIR / "plugin",  # where an operator may have dropped it
        install / "plugin" / "dist", # a checkout
    ]
    found: list[pathlib.Path] = []
    for root in roots:
        try:
            # Case-insensitively, and both naming shapes. A release ships
            # `Risu.Elf.Plugin.js` - no version, because
            # releases/latest/download needs a name that does not change - and
            # a dev build is `risu-elf-<ver>.js`. Matching one of them meant
            # /plugin.js served nothing on exactly the installs that had it.
            found.extend(f for f in root.glob("*.js")
                         if f.is_file() and f.name.lower().replace(".", "-").startswith("risu-elf"))
        except OSError:
            continue
    if not found:
        return None
    return max(found, key=lambda f: f.stat().st_mtime)


def h_plugin_info(arg: dict) -> dict:
    f = _plugin_file()
    if f is None:
        return {"available": False,
                "hint": "빌드된 플러그인 파일이 없습니다 (data/plugin/ 또는 plugin/dist/)"}
    version = ""
    try:
        head = f.read_text(encoding="utf-8", errors="replace")[:512]
        for line in head.splitlines():
            if line.startswith("//@version"):
                version = line.split(None, 1)[1].strip() if " " in line else ""
                break
    except OSError:
        pass
    return {"available": True, "file": f.name, "version": version,
            "size": f.stat().st_size, "url": "/plugin.js"}


async def h_plugin_js(arg: dict) -> Any:
    """Serve the built plugin so RisuAI's own updater can fetch it.

    Auth-exempt on purpose: the update check is made by RisuAI itself, which
    knows nothing about our bearer token. What it serves is the plugin the user
    already installed - it holds no key and no token, those live in RisuAI's
    plugin storage - so the exposure is the code, which they have anyway.
    Binding stays loopback by default regardless.
    """
    raise ApiError(500, "plugin.js must be dispatched directly")


def h_update_check(arg: dict) -> dict:
    return updater.check()


def h_update_apply(arg: dict) -> dict:
    """Install the latest release, then leave for the launcher to restart us.

    The response is sent before the exit: a client that gets no reply cannot
    tell "installed, restarting" from "crashed mid-install", and those need
    very different reactions.
    """
    try:
        out = updater.apply()
    except updater.UpdateError as e:
        raise ApiError(400, str(e))
    if out.get("updated"):
        _schedule_restart()
    return out


def _schedule_restart() -> None:
    """Exit shortly, so the HTTP response is flushed first."""
    import threading
    threading.Timer(1.5, updater.restart_now).start()


def h_clientlog(arg: dict) -> dict:
    """Plugin-side events, funnelled into the server log.

    The plugin runs in a sandboxed iframe whose console the developer cannot
    see without the user opening devtools and copying it out. Routing its
    errors and notable actions here is what makes a bug report a log line
    instead of a screenshot.
    """
    level = str(arg.get("level") or "info").lower()
    event = str(arg.get("event") or "")[:200]
    detail = arg.get("detail")
    line = f"[plugin] {event}" + (f" {log.shape(detail)}" if detail is not None else "")
    if level == "error":
        log.error(line)
        if isinstance(detail, dict) and detail.get("stack"):
            log.error("[plugin] stack: %s", str(detail["stack"])[:2000])
    elif level == "warn":
        log.warn(line)
    elif level == "debug":
        log.debug(line)
    else:
        log.info(line)
    return {"ok": True}


# --- agent ------------------------------------------------------------------

def h_session_create(arg: dict) -> dict:
    tk = _chat(arg)
    return session.create(tk, str(arg.get("title") or ""))


def h_session_get(arg: dict) -> dict:
    """Session state for the agent panel.

    One response shape for both branches. The first version returned early when
    no session existed yet and that branch omitted `agentReady`, so the panel
    read undefined as false and announced "credentials not configured" on every
    first open - while the settings tab's connection test passed, because it
    asked a different endpoint.
    """
    tk = _chat(arg)
    want = str(arg.get("sessionId") or "")
    s = session.load(want) if want else session.latest(tk)
    if want and s is not None:
        s = db.one("SELECT * FROM sessions WHERE id = ?", (want,))
    out: dict[str, Any] = {
        "session": None,
        "messages": [],
        "staged": staging.pending(tk),
        "agentReady": agent_ready(),
        "webSearch": websearch.configured(),
    }
    if s is not None:
        out["session"] = {"sessionId": s["id"], "chatKey": s["chat_key"], "title": s["title"]}
        out["messages"] = session.messages(s["id"])
    return out


async def h_chat(arg: dict) -> Any:
    """Streaming is handled in the dispatcher; this only validates."""
    raise ApiError(500, "streaming route must be dispatched directly")


def h_sessions(arg: dict) -> dict:
    """All agent conversations for this chat."""
    return {"sessions": session.list_all(_chat(arg))}


def h_staged(arg: dict) -> dict:
    return {"staged": staging.pending(_chat(arg))}


def h_approve(arg: dict) -> dict:
    tk = _chat(arg)
    approve = arg.get("approve") is not False
    if arg.get("batchId"):
        n = staging.decide_batch(str(arg["batchId"]), approve)
    elif isinstance(arg.get("ids"), list):
        n = staging.decide([str(i) for i in arg["ids"]], approve)
    elif arg.get("all"):
        n = staging.decide([i["id"] for i in staging.pending(tk)], approve)
    else:
        raise ApiError(400, "ids[] · batchId · all 중 하나가 필요합니다")

    if not approve:
        return {"decided": n, "approved": False}

    # Approval and application are one user action, so applying here keeps the
    # client from having to sequence two calls and handle a half-done state.
    _checkpoint(tk, "에이전트 제안 적용 직전")
    out = staging.apply_approved(tk)
    if out["conflicts"]:
        raise ApiError(409, "승인 이후 턴이 바뀌어서 적용하지 않았습니다", conflicts=out["conflicts"])
    return {"decided": n, "approved": True, **out}


def h_staged_clear(arg: dict) -> dict:
    return {"cleared": staging.clear(_chat(arg))}


def h_cost(arg: dict) -> dict:
    tk = _chat(arg)
    rows = db.query(
        "SELECT model, SUM(in_tokens) AS i, SUM(out_tokens) AS o, SUM(cost_usd) AS c, "
        "COUNT(*) AS n, SUM(priced) AS p FROM cost_ledger WHERE chat_key = ? GROUP BY model",
        (tk,),
    )
    return {"byModel": [dict(r) for r in rows]}


# --- workspace files --------------------------------------------------------

def h_files(arg: dict) -> dict:
    return files.listing(_char(arg))


def h_file_read(arg: dict) -> dict:
    try:
        return files.read(_char(arg), str(arg.get("path") or ""))
    except files.FileError as e:
        raise ApiError(400, str(e))


def h_file_upload(arg: dict) -> dict:
    try:
        return files.upload(
            _char(arg), str(arg.get("name") or ""),
            text=arg.get("text") if isinstance(arg.get("text"), str) else None,
            base64_data=arg.get("base64") if isinstance(arg.get("base64"), str) else None,
            into=str(arg.get("dir") or ""),
        )
    except files.FileError as e:
        raise ApiError(400, str(e))


def h_file_mkdir(arg: dict) -> dict:
    try:
        return files.mkdir(_char(arg), str(arg.get("path") or ""))
    except files.FileError as e:
        raise ApiError(400, str(e))


def h_file_move(arg: dict) -> dict:
    try:
        return files.move(_char(arg), str(arg.get("from") or ""), str(arg.get("to") or ""))
    except files.FileError as e:
        raise ApiError(400, str(e))


def h_file_delete(arg: dict) -> dict:
    try:
        return files.delete(_char(arg), str(arg.get("path") or ""))
    except files.FileError as e:
        raise ApiError(400, str(e))


def h_file_clean(arg: dict) -> dict:
    raw = arg.get("areas")
    areas = [str(a) for a in raw] if isinstance(raw, list) else None
    return files.clean(_char(arg), areas)


def h_presets(arg: dict) -> dict:
    """The whole list, plus which one is selected.

    `selected` is repeated at the top level so the panel can render the current
    preset without scanning the list - that is the only thing it shows until
    the user opens the picker.
    """
    return {
        "presets": presets.list_all(),
        "selected": presets.selected("general"),
        # The search agent's, or null: it is allowed to have none.
        "selectedSearch": presets.selected("search"),
        "kinds": list(presets.KINDS),
        "keys": keys.list_all(),
        "keepSentinel": config.KEEP,
        "reasoningLevels": list(presets.REASONING_LEVELS),
        "maxInstructions": presets.MAX_INSTRUCTIONS,
    }


def h_preset_select(arg: dict) -> dict:
    try:
        return presets.select(str(arg.get("id") or ""))
    except presets.PresetError as e:
        raise ApiError(404, str(e))


def h_preset_save(arg: dict) -> dict:
    """Create or update a preset from an explicit payload."""
    values = arg.get("values")
    try:
        return {"preset": presets.save(
            str(arg.get("name") or ""),
            values if isinstance(values, dict) else {},
            str(arg.get("id") or "") or None,
        )}
    except presets.PresetError as e:
        raise ApiError(400, str(e))


def h_preset_capture(arg: dict) -> dict:
    """Save whatever the agent is configured with right now under a name."""
    try:
        return {"preset": presets.capture(str(arg.get("name") or ""), str(arg.get("kind") or "general"))}
    except presets.PresetError as e:
        raise ApiError(400, str(e))


def h_preset_apply(arg: dict) -> dict:
    try:
        return presets.apply(str(arg.get("id") or ""))
    except presets.PresetError as e:
        raise ApiError(404, str(e))


def h_preset_delete(arg: dict) -> dict:
    try:
        return presets.delete(str(arg.get("id") or ""))
    except presets.PresetError as e:
        # "the last preset cannot go" is a rule, not a missing row.
        raise ApiError(404 if "없는" in str(e) else 400, str(e))


def h_preset_deselect(arg: dict) -> dict:
    try:
        return presets.deselect(str(arg.get("kind") or "search"))
    except presets.PresetError as e:
        raise ApiError(400, str(e))


# --- API keys ---------------------------------------------------------------------

def h_keys(arg: dict) -> dict:
    return {"keys": keys.list_all(), "keepSentinel": config.KEEP}


def h_key_save(arg: dict) -> dict:
    values = arg.get("values")
    try:
        return {"key": keys.save(values if isinstance(values, dict) else {}, str(arg.get("id") or "") or None)}
    except keys.KeyError_ as e:
        raise ApiError(400, str(e))


def h_key_delete(arg: dict) -> dict:
    try:
        return keys.delete(str(arg.get("id") or ""))
    except keys.KeyError_ as e:
        raise ApiError(404 if "없는" in str(e) else 400, str(e))


# --- model catalog (models.dev) -------------------------------------------------------

def h_models_catalog(arg: dict) -> dict:
    return catalog.search(str(arg.get("q") or ""), provider=str(arg.get("provider") or ""),
                          refresh=str(arg.get("refresh") or "") in ("1", "true"))


# --- OpenAI subscription (codex) login ----------------------------------------------

def h_codex_status(arg: dict) -> dict:
    return codexauth.status()


def h_codex_login_start(arg: dict) -> dict:
    return codexauth.start_login()


def h_codex_login_status(arg: dict) -> dict:
    return codexauth.login_status(str(arg.get("state") or ""))


def h_codex_login_complete(arg: dict) -> dict:
    try:
        return codexauth.complete_login(str(arg.get("redirect") or arg.get("code") or ""),
                                        str(arg.get("state") or ""))
    except codexauth.CodexError as e:
        raise ApiError(400, str(e))


def h_codex_logout(arg: dict) -> dict:
    return codexauth.logout()


def h_skills(arg: dict) -> dict:
    return skills.listing()


def h_skill_get(arg: dict) -> dict:
    sk = skills.get(str(arg.get("id") or arg.get("slug") or ""))
    if sk is None:
        raise ApiError(404, "없는 스킬입니다")
    return {"skill": sk}


def h_skill_save(arg: dict) -> dict:
    """Create or rewrite a skill's SKILL.md: name, description (the trigger), body."""
    try:
        return {"skill": skills.save(
            str(arg.get("name") or ""),
            str(arg.get("description") or ""),
            str(arg.get("body") or ""),
            slug=str(arg.get("id") or arg.get("slug") or "") or None,
            always=bool(arg.get("always")),
            enabled=(None if arg.get("enabled") is None else bool(arg.get("enabled"))),
            sort_order=arg.get("sortOrder") if isinstance(arg.get("sortOrder"), int) else None,
        )}
    except skills.SkillError as e:
        raise ApiError(400, str(e))


def _upload_bytes(arg: dict) -> bytes:
    body = arg.get("body")
    if arg.get("base64"):
        import base64
        try:
            return base64.b64decode(str(body or ""), validate=True)
        except (ValueError, TypeError):
            raise ApiError(400, "base64 본문이 아닙니다")
    return str(body or "").encode("utf-8")


def h_skill_upload(arg: dict) -> dict:
    """Import a skill from a file.

    A .zip is a whole skill folder (SKILL.md plus its files). Anything else
    is one file that becomes a skill of its own: a .py as the script of a new
    skill, a long .md as its reference, a short .md as its body - the shapes
    skills started out in, still accepted so nothing the user has stops
    working.
    """
    name = str(arg.get("filename") or "").strip()
    if not name:
        raise ApiError(400, "filename is required")
    try:
        if name.lower().endswith(".zip"):
            return {"skill": skills.import_zip(name, _upload_bytes(arg))}
        data = _upload_bytes(arg)
        return {"skill": skills.import_file(name, data.decode("utf-8", errors="replace"))}
    except skills.SkillError as e:
        raise ApiError(400, str(e))


def h_skill_file_put(arg: dict) -> dict:
    """Add or replace one file inside an existing skill folder."""
    try:
        return skills.put_file(str(arg.get("id") or arg.get("slug") or ""),
                               str(arg.get("path") or arg.get("filename") or ""),
                               _upload_bytes(arg))
    except skills.SkillError as e:
        raise ApiError(400, str(e))


def h_skill_file_get(arg: dict) -> dict:
    try:
        return skills.read_file(str(arg.get("id") or arg.get("slug") or ""), str(arg.get("path") or ""))
    except skills.SkillError as e:
        raise ApiError(404, str(e))


def h_skill_file_delete(arg: dict) -> dict:
    try:
        return skills.delete_file(str(arg.get("id") or arg.get("slug") or ""), str(arg.get("path") or ""))
    except skills.SkillError as e:
        raise ApiError(404, str(e))


def h_skill_toggle(arg: dict) -> dict:
    try:
        return {"skill": skills.set_enabled(str(arg.get("id") or arg.get("slug") or ""), bool(arg.get("enabled")))}
    except skills.SkillError as e:
        raise ApiError(404, str(e))


def h_skill_delete(arg: dict) -> dict:
    try:
        return skills.delete(str(arg.get("id") or arg.get("slug") or ""))
    except skills.SkillError as e:
        raise ApiError(404, str(e))


def h_skill_preview(arg: dict) -> dict:
    """Exactly what gets appended to the instructions, so it is inspectable.

    "Why did it not follow my skill" is otherwise unanswerable without server
    log access - the catalog could be empty, truncated, or the skill disabled.
    What a load_skill call would return is previewable too, by name.
    """
    want = str(arg.get("name") or arg.get("id") or "")
    if want:
        text = skills.load(want)
        return {"prompt": text, "chars": len(text), "loaded": want}
    block = skills.prompt()
    return {"prompt": block, "chars": len(block)}


def h_workspace_list(arg: dict) -> dict:
    return {"workspaces": workspace.list_all()}


def h_workspace_create(arg: dict) -> dict:
    return {"workspace": workspace.materialize(arg, force=bool(arg.get("force")))}


def h_workspace_get(arg: dict) -> dict:
    return {"workspace": workspace.info(_char(arg))}


def h_turns(arg: dict) -> dict:
    return store.turns(_chat(arg), start=_int(arg, "start", 0), limit=_int(arg, "limit", 100))


def h_turn_edit(arg: dict) -> dict:
    tk = _chat(arg)
    msg_id = str(arg.get("msgId") or "")
    if not msg_id:
        raise ApiError(400, "msgId is required")
    if "after" not in arg:
        raise ApiError(400, "after is required")
    expect = arg.get("before")
    try:
        store.set_body(tk, msg_id, "" if arg["after"] is None else str(arg["after"]),
                       expect=None if expect is None else str(expect))
    except LookupError as e:
        raise ApiError(409, str(e), msgId=msg_id)
    except ValueError as e:
        raise ApiError(409, str(e), msgId=msg_id)
    return {"ok": True, "msgId": msg_id}


def h_turn_insert(arg: dict) -> dict:
    tk = _chat(arg)
    try:
        mid = store.insert_turn(
            tk,
            str(arg.get("afterMsgId") or "") or None,
            str(arg.get("role") or "char"),
            str(arg.get("body") or ""),
            arg.get("name"),
        )
    except LookupError as e:
        raise ApiError(409, str(e))
    return {"ok": True, "msgId": mid}


def h_turn_delete(arg: dict) -> dict:
    tk = _chat(arg)
    if arg.get("msgIds"):
        ids = [str(m) for m in arg["msgIds"] if m]
        return {"ok": True, "deleted": store.delete_turns(tk, ids)}
    if arg.get("fromSeq") is not None or arg.get("toSeq") is not None:
        start = _int(arg, "fromSeq", 0)
        end = _int(arg, "toSeq", start)
        if end < start:
            raise ApiError(400, "toSeq must be >= fromSeq")
        return {"ok": True, "deleted": store.delete_range(tk, start, end)}
    raise ApiError(400, "msgIds[] or fromSeq/toSeq is required")


def h_turn_split(arg: dict) -> dict:
    tk = _chat(arg)
    msg_id = str(arg.get("msgId") or "")
    if not msg_id:
        raise ApiError(400, "msgId is required")
    try:
        return {"ok": True, "newMsgId": store.split_turn(tk, msg_id, _int(arg, "at", 0))}
    except LookupError as e:
        raise ApiError(409, str(e))


def h_turn_merge(arg: dict) -> dict:
    tk = _chat(arg)
    ids = [str(m) for m in (arg.get("msgIds") or []) if m]
    if len(ids) < 2:
        raise ApiError(400, "msgIds[] needs at least two entries")
    try:
        return {"ok": True, "msgId": store.merge_turns(tk, ids, str(arg.get("separator") or "\n\n"))}
    except LookupError as e:
        raise ApiError(409, str(e))


def h_turn_bulk(arg: dict) -> dict:
    """Preview or apply a replacement across many turns.

    Defaults to a dry run: a bulk edit is the operation most likely to do more
    than intended, so the caller has to ask for the write explicitly.
    """
    tk = _chat(arg)
    try:
        return store.bulk_replace(
            tk,
            str(arg.get("pattern") or ""),
            str(arg.get("replacement") or ""),
            regex=bool(arg.get("regex")),
            seq_from=None if arg.get("fromSeq") in (None, "") else _int(arg, "fromSeq", 0),
            seq_to=None if arg.get("toSeq") in (None, "") else _int(arg, "toSeq", 0),
            role=str(arg.get("role") or "") or None,
            dry_run=not bool(arg.get("apply")),
            limit=_int(arg, "limit", 5000),
        )
    except ValueError as e:
        raise ApiError(400, str(e))


def h_turn_bulk_set(arg: dict) -> dict:
    tk = _chat(arg)
    edits = arg.get("edits")
    if not isinstance(edits, list):
        raise ApiError(400, "edits[] is required")
    out = store.bulk_set(tk, edits, expect=arg.get("expect") is not False)
    if out["conflicts"]:
        # All-or-nothing: a batch computed against a stale read is rejected
        # whole rather than applied halfway.
        raise ApiError(409, "일부 턴이 읽은 뒤에 바뀌었습니다 — 전체를 적용하지 않았습니다",
                       conflicts=out["conflicts"])
    return out


def h_search(arg: dict) -> dict:
    ck = _char(arg)
    q = str(arg.get("q") or arg.get("query") or "")
    if not q.strip():
        raise ApiError(400, "q is required")
    raw = arg.get("chatKeys")
    if isinstance(raw, str):
        raw = [k for k in raw.split(",") if k]
    keys = [str(k) for k in raw] if isinstance(raw, list) else None
    return {"query": q, "hits": store.search(ck, q, keys, limit=_int(arg, "limit", 40))}


def _char_of_chat(tk: str) -> str:
    return str((store.chat_row(tk) or {}).get("char_key") or "")


def h_patch(arg: dict) -> dict:
    """Everything one write-back sends, in one response.

    Turns, this chat's lorebook and its memory all follow the same shape -
    working copy against a baseline - and RisuAI holds all three on the same
    chat object, so the plugin writes them in one `setChatToIndex`. Fetching
    them separately invited the state the lorebook tab was in: a write path
    for two of the three and a message claiming the third came along.
    """
    tk = _chat(arg)
    ck = _char_of_chat(tk)
    out = store.patch(tk)
    lore = store.lore_changes(ck, tk)
    out["lore"] = {
        "localLore": [e["entry"] for e in store.lore(ck, "local") if e["chatKey"] == tk],
        "changed": lore["total"],
        **{k: lore[k] for k in ("added", "edited", "deleted")},
    }
    m = mem.patch(tk)
    out["memory"] = {"data": m["memory"], "changed": m["changed"]}
    return out


def h_changes(arg: dict) -> dict:
    """What is pending on this chat, as counts - the shared bar's one line."""
    tk = _chat(arg)
    ck = _char_of_chat(tk)
    p = store.patch(tk)
    turns = {
        "edited": len(p["edits"]), "added": len(p["added"]), "removed": len(p["removed"]),
        "reordered": bool(p["reordered"]), "structural": bool(p["structural"]),
    }
    turns["total"] = turns["edited"] + turns["added"] + turns["removed"] + (1 if p["reordered"] else 0)
    lore = store.lore_changes(ck, tk)
    memory = mem.changes(tk)
    return {
        "chatKey": tk,
        "turns": turns,
        "lore": lore,
        "memory": memory,
        "total": turns["total"] + lore["total"] + memory["total"],
        "staged": len(staging.pending(tk)),
        "actions": len(actions.pending(tk)),
        "warnings": p["warnings"],
    }


def h_commit(arg: dict) -> dict:
    """Mark the working state as shipped; every baseline moves to match.

    The client calls this only after RisuAI confirmed the write, so a failed
    write-back leaves the diff intact and retryable. Turns, lorebook and memory
    move together because they were written together.
    """
    tk = _chat(arg)
    ck = _char_of_chat(tk)
    _checkpoint(tk, str(arg.get("label") or "반영 직전"))
    out = store.rebase_original(tk)
    out["lore"] = store.rebase_lore(ck, tk)
    out["memory"] = mem.rebase(tk)
    log.info("commit chat=%s baseline %s -> %s lore=%s memory=%s",
             tk, out["previousBaseline"], out["newBaseline"], out["lore"], out["memory"])
    return out


def h_reset(arg: dict) -> dict:
    tk = _chat(arg)
    _checkpoint(tk, "reset 직전")
    store.reset_working(tk)
    return {"ok": True, "chatKey": tk}


def h_lore_list(arg: dict) -> dict:
    return {"lore": store.lore(_char(arg), arg.get("scope") or None)}


def h_lore_add(arg: dict) -> dict:
    ck = _char(arg)
    entry = arg.get("entry")
    if not isinstance(entry, dict):
        raise ApiError(400, "entry must be an object")
    scope = str(arg.get("scope") or "global")
    if scope not in ("global", "local"):
        raise ApiError(400, "scope must be global or local")
    tk = str(arg.get("chatKey") or "") or None
    if scope == "local" and not tk:
        raise ApiError(400, "scope=local needs chatKey")
    # Global rows live under chat_key IS NULL; a chatKey that rode along in the
    # payload must not leak into them, or char-level queries never see the row.
    return {"ok": True, "id": store.add_lore(ck, entry, scope, tk if scope == "local" else None)}


def h_lore_update(arg: dict) -> dict:
    _char(arg)
    lid = str(arg.get("id") or "")
    entry = arg.get("entry")
    if not lid:
        raise ApiError(400, "id is required")
    if not isinstance(entry, dict):
        raise ApiError(400, "entry must be an object")
    try:
        return {"ok": True, **store.update_lore(lid, entry)}
    except LookupError as e:
        raise ApiError(404, str(e))


def h_lore_move(arg: dict) -> dict:
    _char(arg)
    try:
        return {"ok": True, **store.move_lore(str(arg.get("id") or ""), _int(arg, "toSeq", 0))}
    except LookupError as e:
        raise ApiError(404, str(e))


def h_lore_get(arg: dict) -> dict:
    _char(arg)
    got = store.lore_entry(str(arg.get("id") or ""))
    if got is None:
        raise ApiError(404, "없는 로어북 항목입니다")
    return got


def h_lore_delete(arg: dict) -> dict:
    _char(arg)
    lid = str(arg.get("id") or "")
    if not lid:
        raise ApiError(400, "id is required")
    return {"ok": True, "deleted": store.delete_lore(lid)}


def h_lore_patch(arg: dict) -> dict:
    """What the plugin writes back for lorebooks.

    globalLore goes through setCharacterToIndex and localLore through
    setChatToIndex; both persist only for the selected character, which is why
    the workspace is character-scoped in the first place.
    """
    ck = _char(arg)
    entries = store.lore(ck)
    return {
        "charKey": ck,
        "globalLore": [e["entry"] for e in entries if e["scope"] == "global"],
        "localLore": [
            {"chatKey": e["chatKey"], "entry": e["entry"]}
            for e in entries if e["scope"] == "local"
        ],
        "added": sum(1 for e in entries if e["origin"] == "added"),
    }


# --- long-term memory -------------------------------------------------------

def h_memory_list(arg: dict) -> dict:
    return mem.listing(_chat(arg))


def h_memory_update(arg: dict) -> dict:
    _chat(arg)
    try:
        return {"item": mem.update(
            str(arg.get("id") or ""),
            str(arg.get("body") or ""),
            arg.get("title") if isinstance(arg.get("title"), str) else None,
        )}
    except LookupError as e:
        raise ApiError(404, str(e))


def h_memory_add(arg: dict) -> dict:
    tk = _chat(arg)
    row = store.chat_row(tk)
    try:
        return {"item": mem.add(
            row["char_key"], tk,
            str(arg.get("kind") or "hypaV3Data"),
            str(arg.get("body") or ""),
            str(arg.get("title") or ""),
        )}
    except ValueError as e:
        raise ApiError(400, str(e))


def h_memory_delete(arg: dict) -> dict:
    _chat(arg)
    try:
        return mem.delete(str(arg.get("id") or ""))
    except LookupError as e:
        raise ApiError(404, str(e))


def h_memory_patch(arg: dict) -> dict:
    """What the plugin writes back into the chat's memory fields."""
    return mem.patch(_chat(arg))


def h_memory_commit(arg: dict) -> dict:
    """Move the baseline after RisuAI accepted the write."""
    return {"rebased": mem.rebase(_chat(arg))}


def h_export_risuchat(arg: dict) -> dict:
    tk = _chat(arg)
    return {"filename": f"{tk}.risuchat.json", "envelope": store.export_envelope(tk)}


def h_export_md(arg: dict) -> dict:
    tk = _chat(arg)
    md = store.export_markdown(tk)
    row = store.chat_row(tk) or {}
    if arg.get("save"):
        ck = workspace.chat_owner(tk)
        if ck:
            workspace.write_out(ck, f"{row.get('name') or tk}.md", md)
    return {"filename": f"{row.get('name') or tk}.md", "markdown": md}


# --- the card (bot editing) -------------------------------------------------
#
# The char-key twins of the chat pipeline: rows, patch, changes, commit,
# reset, checkpoints. Same contracts - commit only after the host confirmed
# the write, reset snapshots first, checkpoint restore is itself undoable.

# Pending-action kinds that belong to the bot bar rather than the chat bar.
_CARD_KINDS = ("card_", "script_", "host_card_", "host_clone_")


def _card_actions_pending(ck: str) -> int:
    rows = db.query(
        "SELECT kind FROM pending_actions WHERE char_key = ? AND status = 'pending'", (ck,))
    return sum(1 for r in rows if str(r["kind"]).startswith(_CARD_KINDS))


def h_card(arg: dict) -> dict:
    return cardmod.listing(_char(arg))


def h_card_scripts(arg: dict) -> dict:
    ck = _char(arg)
    kind = str(arg.get("kind") or "customscript")
    try:
        return {"charKey": ck, "kind": kind, "items": cardmod.scripts(ck, kind)}
    except ValueError as e:
        raise ApiError(400, str(e))


def h_card_assets_rename(arg: dict) -> dict:
    """Bulk-rename asset references in the working card (assets tab tools)."""
    ck = _char(arg)
    fields = arg.get("fields")
    try:
        return cardmod.rename_assets(
            ck, str(arg.get("mode") or "strip-ext"), str(arg.get("pattern") or ""),
            str(arg.get("repl") or ""),
            tuple(str(f) for f in fields) if isinstance(fields, list) and fields else None)
    except ValueError as e:
        raise ApiError(400, str(e))


def h_card_field(arg: dict) -> dict:
    _char(arg)
    fid = str(arg.get("id") or "")
    if not fid:
        raise ApiError(400, "id is required")
    try:
        return {"ok": True, "item": cardmod.update_field(fid, str(arg.get("body") or ""))}
    except LookupError as e:
        raise ApiError(404, str(e))


def h_card_greeting_add(arg: dict) -> dict:
    return {"ok": True, "item": cardmod.add_greeting(_char(arg), str(arg.get("body") or ""))}


def h_card_greeting_delete(arg: dict) -> dict:
    _char(arg)
    try:
        return {"ok": True, **cardmod.delete_greeting(str(arg.get("id") or ""))}
    except LookupError as e:
        raise ApiError(404, str(e))


def h_card_script_update(arg: dict) -> dict:
    _char(arg)
    sid = str(arg.get("id") or "")
    entry = arg.get("entry")
    if not sid:
        raise ApiError(400, "id is required")
    if not isinstance(entry, dict):
        raise ApiError(400, "entry must be an object")
    try:
        return {"ok": True, **cardmod.update_script(sid, entry)}
    except LookupError as e:
        raise ApiError(404, str(e))


def h_card_script_add(arg: dict) -> dict:
    ck = _char(arg)
    entry = arg.get("entry")
    if not isinstance(entry, dict):
        raise ApiError(400, "entry must be an object")
    try:
        return {"ok": True, "id": cardmod.add_script(ck, str(arg.get("kind") or ""), entry)}
    except ValueError as e:
        raise ApiError(400, str(e))


def h_card_script_delete(arg: dict) -> dict:
    _char(arg)
    return {"ok": True, "deleted": cardmod.delete_script(str(arg.get("id") or ""))}


def h_card_script_move(arg: dict) -> dict:
    _char(arg)
    try:
        return {"ok": True, **cardmod.move_script(str(arg.get("id") or ""), _int(arg, "toSeq", 0))}
    except LookupError as e:
        raise ApiError(404, str(e))


def h_card_patch(arg: dict) -> dict:
    return cardmod.patch(_char(arg))


def h_card_changes(arg: dict) -> dict:
    ck = _char(arg)
    out = cardmod.changes(ck)
    out["charKey"] = ck
    out["full"] = cardmod.is_full(ck)
    out["actions"] = _card_actions_pending(ck)
    return out


def h_card_commit(arg: dict) -> dict:
    ck = _char(arg)
    snapshots.create_card(ck, str(arg.get("label") or "반영 직전"))
    out = cardmod.rebase(ck)
    out["lore"] = store.rebase_lore_global(ck)
    log.info("card commit char=%s %s", ck, out)
    return {"charKey": ck, **out}


def h_card_reset(arg: dict) -> dict:
    ck = _char(arg)
    snapshots.create_card(ck, "reset 직전")
    out = cardmod.reset_working(ck)
    out["lore"] = store.reset_lore_global(ck)
    return {"ok": True, "charKey": ck, **out}


def h_card_checkpoint_create(arg: dict) -> dict:
    return {"id": snapshots.create_card(_char(arg), str(arg.get("label") or ""))}


def h_card_checkpoint_list(arg: dict) -> dict:
    return {"checkpoints": snapshots.listing_card(_char(arg))}


def h_card_checkpoint_restore(arg: dict) -> dict:
    try:
        return snapshots.restore_card(_char(arg), str(arg.get("id") or ""))
    except LookupError as e:
        raise ApiError(404, str(e))


# --- checkpoints ------------------------------------------------------------

def _checkpoint(tk: str, label: str) -> str:
    """Kept as the local name; the implementation lives in snapshots.py so the
    action executor and this handler cannot drift apart."""
    return snapshots.create(tk, label)


def h_checkpoint_create(arg: dict) -> dict:
    return {"id": _checkpoint(_chat(arg), str(arg.get("label") or ""))}


def h_checkpoint_list(arg: dict) -> dict:
    return {"checkpoints": snapshots.listing(_chat(arg))}


def h_checkpoint_restore(arg: dict) -> dict:
    try:
        return snapshots.restore(_chat(arg), str(arg.get("id") or ""))
    except LookupError as e:
        raise ApiError(404, str(e))


# --- the approval queue -----------------------------------------------------

def h_actions(arg: dict) -> dict:
    return {"actions": actions.pending(_chat(arg))}


def h_action_decide(arg: dict) -> dict:
    _chat(arg)
    try:
        return actions.decide(str(arg.get("id") or ""), arg.get("approve") is not False)
    except actions.ActionError as e:
        raise ApiError(400, str(e))


def h_action_complete(arg: dict) -> dict:
    """The plugin reporting back on an action only it could carry out."""
    _chat(arg)
    try:
        return actions.complete(
            str(arg.get("id") or ""),
            arg.get("ok") is not False,
            str(arg.get("detail") or ""),
        )
    except actions.ActionError as e:
        raise ApiError(404, str(e))


def h_actions_clear(arg: dict) -> dict:
    return {"cleared": actions.clear(_chat(arg))}


ROUTES: dict[str, Handler] = {
    "GET /health": h_health,

    "POST /clientlog": h_clientlog,
    "GET /logs": h_logs,
    "GET /plugin": h_plugin_info,
    "POST /update/check": h_update_check,
    "POST /update/apply": h_update_apply,
    "GET /plugin.js": h_plugin_js,
    "GET /diag": h_diag,
    "POST /diag/asset-echo": h_diag_asset_echo,
    "GET /diag/rs-probe": h_diag_rs_probe,

    "POST /assets/manifest": h_assets_manifest,
    "POST /assets/upload": h_assets_upload,
    "POST /assets/fail": h_assets_fail,
    "GET /assets/status": h_assets_status,
    "GET /assets/list": h_assets_list,
    "POST /assets/gc": h_assets_gc,
    "GET /assets/blob": h_assets_blob,
    "GET /charx/preview": h_charx_preview,
    "POST /charx/build": h_charx_build,
    "GET /files/download": h_file_download,
    "POST /assets/adopt": h_assets_adopt,

    "GET /config": h_config_get,
    "POST /config": h_config_set,
    "POST /config/test": h_config_test,

    "GET /presets": h_presets,
    "POST /presets/save": h_preset_save,
    "POST /presets/capture": h_preset_capture,
    "POST /presets/apply": h_preset_apply,
    "POST /presets/deselect": h_preset_deselect,
    "GET /keys": h_keys,
    "POST /keys/save": h_key_save,
    "POST /keys/delete": h_key_delete,
    "GET /models/catalog": h_models_catalog,
    "GET /codex/status": h_codex_status,
    "POST /codex/login/start": h_codex_login_start,
    "GET /codex/login/status": h_codex_login_status,
    "POST /codex/login/complete": h_codex_login_complete,
    "POST /codex/logout": h_codex_logout,
    "POST /presets/select": h_preset_select,
    "POST /presets/delete": h_preset_delete,

    "GET /skills": h_skills,
    "GET /skills/get": h_skill_get,
    "GET /skills/preview": h_skill_preview,
    "POST /skills/save": h_skill_save,
    "POST /skills/upload": h_skill_upload,
    "POST /skills/toggle": h_skill_toggle,
    "POST /skills/delete": h_skill_delete,
    "POST /skills/file": h_skill_file_put,
    "GET /skills/file": h_skill_file_get,
    "POST /skills/file/delete": h_skill_file_delete,

    "GET /files": h_files,
    "GET /files/read": h_file_read,
    "POST /files/upload": h_file_upload,
    "POST /files/delete": h_file_delete,
    "POST /files/mkdir": h_file_mkdir,
    "POST /files/move": h_file_move,
    "POST /files/clean": h_file_clean,

    "GET /workspace": h_workspace_list,
    "POST /workspace": h_workspace_create,
    "GET /workspace/get": h_workspace_get,

    "GET /turns": h_turns,
    "POST /turn": h_turn_edit,
    "POST /turn/insert": h_turn_insert,
    "POST /turn/delete": h_turn_delete,
    "POST /turn/split": h_turn_split,
    "POST /turn/merge": h_turn_merge,
    "POST /turn/bulk": h_turn_bulk,
    "POST /turn/bulk-set": h_turn_bulk_set,

    "GET /search": h_search,
    "GET /patch": h_patch,
    "GET /changes": h_changes,
    "POST /commit": h_commit,

    "POST /chat": h_chat,
    "POST /session": h_session_create,
    "GET /session": h_session_get,
    "GET /sessions": h_sessions,
    "GET /staged": h_staged,
    "POST /approve": h_approve,
    "POST /staged/clear": h_staged_clear,
    "GET /cost": h_cost,
    "POST /reset": h_reset,

    "GET /lore": h_lore_list,
    "POST /lore": h_lore_add,
    "GET /lore/get": h_lore_get,
    "POST /lore/update": h_lore_update,
    "POST /lore/delete": h_lore_delete,
    "POST /lore/move": h_lore_move,

    "GET /memory": h_memory_list,
    "POST /memory/update": h_memory_update,
    "POST /memory/add": h_memory_add,
    "POST /memory/delete": h_memory_delete,
    "GET /memory/patch": h_memory_patch,
    "POST /memory/commit": h_memory_commit,
    "GET /lore/patch": h_lore_patch,

    "GET /card": h_card,
    "GET /card/scripts": h_card_scripts,
    "POST /card/field": h_card_field,
    "POST /card/greeting": h_card_greeting_add,
    "POST /card/greeting/delete": h_card_greeting_delete,
    "POST /card/script": h_card_script_update,
    "POST /card/script/add": h_card_script_add,
    "POST /card/script/delete": h_card_script_delete,
    "POST /card/script/move": h_card_script_move,
    "POST /card/assets/rename": h_card_assets_rename,
    "GET /card/patch": h_card_patch,
    "GET /card/changes": h_card_changes,
    "POST /card/commit": h_card_commit,
    "POST /card/reset": h_card_reset,
    "POST /card/checkpoint": h_card_checkpoint_create,
    "GET /card/checkpoints": h_card_checkpoint_list,
    "POST /card/checkpoint/restore": h_card_checkpoint_restore,

    "GET /export/risuchat": h_export_risuchat,
    "GET /export/md": h_export_md,

    "POST /checkpoint": h_checkpoint_create,
    "GET /checkpoints": h_checkpoint_list,
    "POST /checkpoint/restore": h_checkpoint_restore,

    "GET /actions": h_actions,
    "POST /actions/decide": h_action_decide,
    "POST /actions/complete": h_action_complete,
    "POST /actions/clear": h_actions_clear,
}

# /plugin.js is fetched by RisuAI's updater, which cannot know our token.
AUTH_EXEMPT = {"GET /health", "GET /plugin.js"}

_MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
    "webp": "image/webp", "avif": "image/avif", "svg": "image/svg+xml", "bmp": "image/bmp",
    "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4",
    "mp4": "video/mp4", "webm": "video/webm", "json": "application/json",
}


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def _log(method: str, path: str, status: int, started: float, note: str = "") -> None:
    """One line per request. Response size is included because payload size is
    itself a failure mode at these transcript sizes."""
    ms = int((time.time() - started) * 1000)
    line = f"{method} {path} -> {status} {ms}ms{(' ' + note) if note else ''}"
    if status >= 500:
        log.error(line)
    elif status >= 400:
        log.warn(line)
    else:
        log.info(line)


@app.api_route("/{path:path}", methods=["GET", "POST", "OPTIONS"])
async def dispatch(path: str, request: Request) -> Response:
    started = time.time()
    origin = request.headers.get("origin")

    if request.method == "OPTIONS":
        return Response(
            status_code=204,
            headers={**config.cors_headers(origin), "Access-Control-Max-Age": "86400"},
        )

    pathname = "/" + path
    key = f"{request.method} {pathname}"
    handler = ROUTES.get(key)

    # 404 before auth: otherwise an unauthenticated caller could map the API by
    # watching 401 vs 404.
    if handler is None:
        _log(request.method, pathname, 404, started)
        return _json(404, {"error": f"no route: {key}"}, origin)

    addr = request.client.host if request.client else ""
    if key not in AUTH_EXEMPT:
        if _rate_limited(addr):
            _log(request.method, pathname, 429, started, addr)
            return _json(429, {"error": "too many failed attempts"}, origin)
        ok, addr = _authorized(request)
        if not ok:
            _auth_fails[addr].append(time.time())
            _log(request.method, pathname, 401, started, addr)
            # Never echo the presented or expected token.
            return _json(401, {"error": "unauthorized"}, origin)

    arg: dict[str, Any] = {"_addr": addr}
    arg.update(dict(request.query_params))

    if key == "GET /plugin.js":
        f = _plugin_file()
        if f is None:
            return _json(404, {"error": "no built plugin available"}, origin)
        _log(request.method, pathname, 200, started, f.name)
        return Response(
            content=f.read_bytes(),
            media_type="application/javascript; charset=utf-8",
            headers={**config.cors_headers(origin), "Cache-Control": "no-cache"},
        )

    if key == "GET /files/download":
        # A workspace file as bytes, for things the JSON preview cannot carry
        # - a charx, an image the agent made. Streamed: a 150MB charx must not
        # be read into memory to be served.
        try:
            ck = _char(arg)
            target = files._resolve(ck, str(arg.get("path") or ""))
        except ApiError as e:
            _log(request.method, pathname, e.status, started, str(e))
            return _json(e.status, e.payload, origin)
        except files.FileError as e:
            _log(request.method, pathname, 400, started, str(e))
            return _json(400, {"error": str(e)}, origin)
        if not target.is_file():
            _log(request.method, pathname, 404, started, str(arg.get("path") or ""))
            return _json(404, {"error": "no such file", "path": arg.get("path")}, origin)
        size = target.stat().st_size
        _log(request.method, pathname, 200, started, f"{target.name} {size // 1024}KB")
        quoted = urllib.parse.quote(target.name)

        def _iter(p: pathlib.Path, chunk: int = 1 << 20):
            with p.open("rb") as fh:
                while True:
                    block = fh.read(chunk)
                    if not block:
                        break
                    yield block
        return StreamingResponse(
            _iter(target),
            media_type=_MIME.get(target.suffix.lower().lstrip("."), "application/octet-stream"),
            headers={
                **config.cors_headers(origin),
                "Content-Length": str(size),
                "Content-Disposition": f"attachment; filename*=UTF-8''{quoted}",
                "Cache-Control": "no-store",
            },
        )

    if key == "GET /assets/blob":
        # Raw bytes, same special case as /plugin.js: the JSON envelope would
        # base64 a 5MB image into 7MB of text for nothing.
        akey = str(arg.get("key") or "")
        found = assets.read_bytes(akey) if assets.key_ok(akey) else None
        if found is None:
            _log(request.method, pathname, 404, started, akey)
            return _json(404, {"error": "asset not in store", "key": akey}, origin)
        data, ext = found
        _log(request.method, pathname, 200, started, f"{len(data) // 1024}KB")
        return Response(
            content=data,
            media_type=_MIME.get(ext, "application/octet-stream"),
            headers={**config.cors_headers(origin), "Cache-Control": "private, max-age=86400"},
        )

    if key == "POST /chat":
        raw = await request.body()
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            return _json(400, {"error": "body is not valid JSON"}, origin)
        sid = str(body.get("sessionId") or "")
        prompt = str(body.get("prompt") or "")
        if not sid or not prompt:
            return _json(400, {"error": "sessionId 와 prompt 가 필요합니다"}, origin)
        mode = str(body.get("mode") or "")
        log.info("POST /chat session=%s prompt=%sB mode=%s", sid, len(prompt), mode or "-")
        return StreamingResponse(
            session.run(sid, prompt, mode),
            media_type="application/x-ndjson; charset=utf-8",
            headers={
                **config.cors_headers(origin),
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    if request.method == "POST":
        raw = await request.body()
        if len(raw) > config.MAX_BODY_BYTES:
            return _json(413, {"error": "body too large", "limit": config.MAX_BODY_BYTES}, origin)
        if raw:
            try:
                parsed = json.loads(raw)
            except ValueError:
                return _json(400, {"error": "body is not valid JSON"}, origin)
            if not isinstance(parsed, dict):
                return _json(400, {"error": "body must be a JSON object"}, origin)
            arg.update(parsed)
            log.debug("%s body %s", key, log.shape(parsed))

    try:
        if inspect.iscoroutinefunction(handler):
            out = await handler(arg)
        else:
            out = await run_in_threadpool(handler, arg)
    except ApiError as e:
        _log(request.method, pathname, e.status, started, str(e))
        return _json(e.status, e.payload, origin)
    except (workspace.WorkspaceError, chatfmt.ChatFormatError) as e:
        _log(request.method, pathname, 400, started, str(e))
        return _json(400, {"error": str(e)}, origin)
    except Exception as e:  # noqa: BLE001 - the dispatcher is the last line
        # A 500 is a bug in us; the traceback is the only thing that makes it
        # diagnosable after the fact, and it goes to the log, never to the client.
        log.exception(f"unhandled in {key} arg={log.shape(arg)}")
        _log(request.method, pathname, 500, started, f"{type(e).__name__}: {e}")
        return _json(500, {"error": f"{type(e).__name__}: {e}"}, origin)

    payload = out if out is not None else {"ok": True}
    res = _json(200, payload, origin)
    size = len(res.body or b"")
    _log(request.method, pathname, 200, started, f"{size // 1024}KB" if size > 4096 else "")
    return res


@app.on_event("startup")
async def _startup() -> None:
    config.load()
    config.ensure_token()
    await run_in_threadpool(db.connect)
    await run_in_threadpool(config.migrate_once, db.has_migration, db.mark_migration)
    # Rows first, then seeds: an old install's rows become folders, and the
    # seed step (already marked there) leaves them alone.
    await run_in_threadpool(skills.migrate_rows_once)
    await run_in_threadpool(skills.seed_once)
    # There is always a selected preset; on an existing install it is seeded
    # from whatever config.json already holds, so nothing appears to be lost.
    await run_in_threadpool(presets.ensure_default)
    log.info("ready port=%s agent=%s", config.PORT, "on" if agent_ready() else "off")


@app.on_event("shutdown")
async def _shutdown() -> None:
    # A clean stop folds the WAL away, so data/ at rest is one file.
    await run_in_threadpool(db.close)
