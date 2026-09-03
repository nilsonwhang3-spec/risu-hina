"""OpenAI subscription (ChatGPT Plus/Pro) as an agent backend, the Codex way.

What this is
------------
Codex CLI signs a ChatGPT account in with OAuth (PKCE) against
auth.openai.com and then talks to `https://chatgpt.com/backend-api/codex`
with the account's access token - the subscription pays, no API key. This
module does the same login and hands the agent an OpenAI client pointed at
that backend, so a preset can say `provider: codex` instead of carrying a
base URL and key.

What is known and what is not
-----------------------------
Endpoints, client id, scopes, headers and the "stream only, store false"
rule are what Codex CLI (codex-rs/login, codex-rs/core) uses, read in 2025.
None of it is a documented API. The OAuth client id is Codex CLI's public
app id - OpenAI issues no other for this flow, so there is nothing else to
present at the authorization server. Everything that is OURS to name says so:
the `originator` sent on the authorization URL and on every request is
"risu-hina", not another program's.
OpenAI can change or gate it; when that happens this stops working and the
error is surfaced as-is, never papered over. The user chose this knowing
that (docs/04 F.5).

The flow
--------
1. start_login(): PKCE verifier/challenge + state -> authorization URL. A
   one-shot listener on 127.0.0.1:1455 (Codex CLI's redirect port) catches
   the callback when the browser that logs in runs on this machine.
2. Otherwise the user pastes the address the browser was redirected to
   (`http://localhost:1455/auth/callback?code=...&state=...`, which shows
   as an unreachable page) into the plugin -> complete_login().
3. Tokens go to data/codex-auth.json (0600 where the OS honours it). The
   account id comes out of the id_token's `https://api.openai.com/auth`
   claim; the access token is refreshed with the refresh token when it is
   about to expire.
4. client() is an AsyncOpenAI whose `responses.create` forces stream=True
   and store=False (the backend refuses otherwise), refreshes the bearer
   per call, and - when the caller did not ask for a stream - folds the
   event stream back into the final Response so pydantic-ai's
   non-streaming path works too.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from . import config, log

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
AUTH_URL = "https://auth.openai.com/oauth/authorize"
TOKEN_URL = "https://auth.openai.com/oauth/token"
REDIRECT_URI = "http://localhost:1455/auth/callback"
CALLBACK_PORT = 1455
SCOPE = "openid profile email offline_access"
ORIGINATOR = "risu-hina"
CODEX_BASE = "https://chatgpt.com/backend-api/codex"
AUTH_CLAIM = "https://api.openai.com/auth"

AUTH_PATH = config.DATA_DIR / "codex-auth.json"
PENDING_TTL_S = 15 * 60
# Refresh this long before the access token's exp.
REFRESH_MARGIN_S = 5 * 60

# Models the codex backend is known to serve. Free text is allowed too.
KNOWN_MODELS = ("gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1", "gpt-5-codex", "gpt-5")


class CodexError(Exception):
    pass


_lock = threading.RLock()
_pending: dict[str, Any] = {}      # state -> {verifier, created, done, error}
_listener: dict[str, Any] = {}     # {server, thread, state}


# --- storage -----------------------------------------------------------------

def _load() -> dict:
    try:
        d = json.loads(AUTH_PATH.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict) -> None:
    AUTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = AUTH_PATH.with_suffix(".json.part")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(AUTH_PATH)
    try:
        os.chmod(AUTH_PATH, 0o600)
    except OSError:
        pass


def _jwt_claims(token: str) -> dict:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        d = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
        return d if isinstance(d, dict) else {}
    except (IndexError, ValueError, TypeError):
        return {}


def logged_in() -> bool:
    d = _load()
    return bool(d.get("access_token") and d.get("account_id"))


def status() -> dict:
    d = _load()
    claims = _jwt_claims(d.get("id_token") or "") if d else {}
    auth = claims.get(AUTH_CLAIM) if isinstance(claims.get(AUTH_CLAIM), dict) else {}
    with _lock:
        pending = [s for s, p in _pending.items() if time.time() - p["created"] < PENDING_TTL_S]
        listening = bool(_listener.get("server"))
    return {
        "loggedIn": logged_in(),
        "email": str(claims.get("email") or d.get("email") or ""),
        "accountId": str(d.get("account_id") or ""),
        "plan": str(auth.get("chatgpt_plan_type") or d.get("plan") or ""),
        "expiresAt": _access_exp(d),
        "pending": bool(pending),
        "listening": listening,
        "models": list(KNOWN_MODELS),
        "base": CODEX_BASE,
        "redirectUri": REDIRECT_URI,
    }


def logout() -> dict:
    try:
        AUTH_PATH.unlink()
    except OSError:
        pass
    _stop_listener()
    return {"loggedIn": False}


# --- login --------------------------------------------------------------------

def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode("ascii").rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def auth_url(state: str, challenge: str) -> str:
    q = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPE,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "state": state,
        "originator": ORIGINATOR,
    }
    return AUTH_URL + "?" + urllib.parse.urlencode(q)


def start_login() -> dict:
    """A fresh authorization URL. The previous pending attempt is dropped."""
    verifier, challenge = _pkce()
    state = secrets.token_urlsafe(24)
    with _lock:
        _pending.clear()
        _pending[state] = {"verifier": verifier, "created": time.time(), "done": False, "error": ""}
    listening = _start_listener(state)
    return {"url": auth_url(state, challenge), "state": state, "listening": listening,
            "redirectUri": REDIRECT_URI}


def login_status(state: str) -> dict:
    with _lock:
        p = _pending.get(state)
        if p is None:
            return {"state": state, "known": False, "done": logged_in(), "error": ""}
        return {"state": state, "known": True, "done": bool(p.get("done")), "error": str(p.get("error") or ""),
                "loggedIn": logged_in()}


def complete_login(pasted: str, state_hint: str = "") -> dict:
    """The paste fallback: the redirected URL, or a bare code (+ state)."""
    text = (pasted or "").strip()
    if not text:
        raise CodexError("리다이렉트된 주소를 붙여넣어 주세요")
    code, state = "", state_hint.strip()
    if "code=" in text:
        parsed = urllib.parse.urlparse(text if "://" in text else "http://x/?" + text.lstrip("?"))
        qs = urllib.parse.parse_qs(parsed.query)
        code = (qs.get("code") or [""])[0]
        state = (qs.get("state") or [state])[0]
    else:
        code = text
    if not code:
        raise CodexError("주소에 code 가 없습니다")
    with _lock:
        p = _pending.get(state) if state else (next(iter(_pending.values()), None) if len(_pending) == 1 else None)
    if p is None:
        raise CodexError("진행 중인 로그인과 맞지 않습니다 (state). 로그인을 다시 시작해 주세요")
    _exchange(code, p["verifier"], state)
    return status()


def _exchange(code: str, verifier: str, state: str) -> None:
    import httpx
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": CLIENT_ID,
        "code_verifier": verifier,
    }
    try:
        r = httpx.post(TOKEN_URL, data=form, timeout=30,
                       headers={"User-Agent": f"{config.APP_NAME}/{config.VERSION}"})
    except Exception as e:  # noqa: BLE001
        raise CodexError(f"토큰 교환 실패: {type(e).__name__}: {e}")
    if r.status_code != 200:
        raise CodexError(f"토큰 교환 거부 ({r.status_code}): {r.text[:300]}")
    _adopt_tokens(r.json())
    with _lock:
        p = _pending.get(state)
        if p:
            p["done"] = True
    _stop_listener()
    log.info("codex: logged in account=%s", _load().get("account_id", "")[:8])


def _adopt_tokens(tok: dict) -> None:
    if not isinstance(tok, dict) or not tok.get("access_token"):
        raise CodexError("토큰 응답에 access_token 이 없습니다")
    d = _load()
    d["access_token"] = tok["access_token"]
    if tok.get("refresh_token"):
        d["refresh_token"] = tok["refresh_token"]
    if tok.get("id_token"):
        d["id_token"] = tok["id_token"]
    claims = _jwt_claims(d.get("id_token") or "")
    auth = claims.get(AUTH_CLAIM) if isinstance(claims.get(AUTH_CLAIM), dict) else {}
    acc = auth.get("chatgpt_account_id") or _jwt_claims(d["access_token"]).get(AUTH_CLAIM, {}).get("chatgpt_account_id")
    if acc:
        d["account_id"] = str(acc)
    if claims.get("email"):
        d["email"] = str(claims["email"])
    if auth.get("chatgpt_plan_type"):
        d["plan"] = str(auth["chatgpt_plan_type"])
    d["saved_at"] = time.time()
    if not d.get("account_id"):
        raise CodexError("계정 id 를 찾지 못했습니다 (id_token 에 chatgpt_account_id 없음)")
    _save(d)


def _access_exp(d: dict) -> float:
    exp = _jwt_claims(d.get("access_token") or "").get("exp")
    try:
        return float(exp) if exp else 0.0
    except (TypeError, ValueError):
        return 0.0


def access_token() -> str:
    """A bearer that is good for at least REFRESH_MARGIN_S more seconds."""
    with _lock:
        d = _load()
        if not d.get("access_token"):
            raise CodexError("OpenAI 구독 로그인이 필요합니다 (설정 → 에이전트)")
        exp = _access_exp(d)
        if exp and time.time() > exp - REFRESH_MARGIN_S and d.get("refresh_token"):
            _refresh(d)
            d = _load()
        return str(d["access_token"])


def _refresh(d: dict) -> None:
    import httpx
    body = {"client_id": CLIENT_ID, "grant_type": "refresh_token",
            "refresh_token": d["refresh_token"], "scope": "openid profile email"}
    try:
        r = httpx.post(TOKEN_URL, json=body, timeout=30,
                       headers={"User-Agent": f"{config.APP_NAME}/{config.VERSION}"})
    except Exception as e:  # noqa: BLE001
        raise CodexError(f"토큰 갱신 실패: {type(e).__name__}: {e}")
    if r.status_code != 200:
        raise CodexError(f"토큰 갱신 거부 ({r.status_code}): {r.text[:200]} — 다시 로그인해 주세요")
    _adopt_tokens(r.json())
    log.info("codex: access token refreshed")


def account_id() -> str:
    return str(_load().get("account_id") or "")


# --- the callback listener --------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    state = ""

    def log_message(self, *_: Any) -> None:  # quiet
        return

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/auth/callback":
            self.send_response(404)
            self.end_headers()
            return
        qs = urllib.parse.parse_qs(parsed.query)
        code = (qs.get("code") or [""])[0]
        state = (qs.get("state") or [""])[0]
        ok, err = False, ""
        try:
            with _lock:
                p = _pending.get(state)
            if p is None or not code:
                raise CodexError("state 가 맞지 않습니다")
            _exchange(code, p["verifier"], state)
            ok = True
        except CodexError as e:
            err = str(e)
            with _lock:
                p = _pending.get(state)
                if p:
                    p["error"] = err
        body = ("<html><body style='font-family:sans-serif;padding:40px'>"
                + ("<h2>Risu Hina: OpenAI 로그인 완료</h2><p>이 창을 닫고 플러그인으로 돌아가셔도 됩니다.</p>" if ok
                   else f"<h2>로그인 실패</h2><p>{err}</p>")
                + "</body></html>").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _start_listener(state: str) -> bool:
    _stop_listener()
    try:
        srv = HTTPServer(("127.0.0.1", CALLBACK_PORT), _Handler)
    except OSError as e:
        log.warn("codex: callback port %s busy (%s) - paste fallback only", CALLBACK_PORT, e)
        return False
    srv.timeout = 1.0

    def run() -> None:
        deadline = time.time() + PENDING_TTL_S
        try:
            while time.time() < deadline:
                srv.handle_request()
                with _lock:
                    p = _pending.get(state)
                    if not p or p.get("done") or _listener.get("state") != state:
                        break
        finally:
            try:
                srv.server_close()
            except OSError:
                pass
            with _lock:
                if _listener.get("state") == state:
                    _listener.clear()

    t = threading.Thread(target=run, daemon=True, name="codex-callback")
    with _lock:
        _listener.update({"server": srv, "thread": t, "state": state})
    t.start()
    return True


def _stop_listener() -> None:
    with _lock:
        srv = _listener.get("server")
        _listener.clear()
    if srv is not None:
        try:
            srv.server_close()
        except OSError:
            pass


# --- the client the agent uses ------------------------------------------------------

def client() -> Any:
    """An AsyncOpenAI for the codex backend: bearer refreshed per call,
    streaming forced, store off, non-stream calls folded from the stream."""
    import openai
    acc = account_id()
    if not acc:
        raise CodexError("OpenAI 구독 로그인이 필요합니다 (설정 → 에이전트)")
    c = openai.AsyncOpenAI(
        base_url=CODEX_BASE,
        api_key=access_token(),
        default_headers={
            "chatgpt-account-id": acc,
            "OpenAI-Beta": "responses=experimental",
            "originator": ORIGINATOR,
        },
        timeout=float(config.section("agent").get("timeoutSeconds") or 300),
    )
    orig = c.responses.create

    async def create(**kw: Any) -> Any:
        c.api_key = access_token()
        wanted_stream = bool(kw.get("stream"))
        kw["stream"] = True
        kw["store"] = False
        # Not accepted by this backend: no tiers or caches to pick, and (seen in
        # the wild, 400 "Unsupported parameter: max_output_tokens") no output
        # cap either - the subscription decides.
        for k in ("service_tier", "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "user",
                  "max_output_tokens", "top_p"):
            kw.pop(k, None)
        stream = await orig(**kw)
        if wanted_stream:
            return stream
        final = None
        # This backend's `response.completed` carries an EMPTY `output`; the
        # items only ever arrive as `response.output_item.done` events. A
        # folded (non-stream) call that trusted the final object came back
        # with no text and no tool calls - the connection test read that as
        # "the model does not return tool_calls" while the agent, which
        # streams, worked. Collect the items and put them where the SDK's
        # `output_text` and every caller look for them.
        items: list[Any] = []
        async for ev in stream:
            t = getattr(ev, "type", "")
            if t == "response.output_item.done":
                item = getattr(ev, "item", None)
                if item is not None:
                    items.append(item)
            elif t == "response.completed":
                final = ev.response
                if final is not None and not getattr(final, "output", None) and items:
                    final.output = items
            elif t in ("response.failed", "response.incomplete"):
                final = getattr(ev, "response", None)
                err = getattr(final, "error", None)
                if err:
                    raise CodexError(f"codex: {getattr(err, 'message', err)}")
            elif t == "error":
                raise CodexError(f"codex: {getattr(ev, 'message', ev)}")
        if final is None:
            raise CodexError("codex: 응답이 완료되지 않았습니다")
        return final

    c.responses.create = create  # type: ignore[method-assign]
    return c
