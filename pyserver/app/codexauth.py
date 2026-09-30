"""The user's ChatGPT plan as an agent backend - Sign in with ChatGPT.

What this is
------------
OpenAI's documented flow for open-source, locally hosted apps to use a
ChatGPT plan (docs: developers.openai.com/siwc/token-sharing-open-source).
The user signs in in the browser, registers "Risu Hina" as an agent of
their account and consents to plan usage; the backend then calls the public
Responses API (`https://api.openai.com/v1/responses`) with the OAuth access
token as the bearer - the plan pays, no API key. A preset says
`provider: codex` (the id is kept for existing presets) instead of carrying
a base URL and key.

Until 2026-09 this module copied Codex CLI's private login (its client id,
chatgpt.com/backend-api/codex). Those tokens do not work here; a saved
record of that kind is reported as `legacy` and asks for one new sign-in.

The flow (sign-in, §2-§5 of the docs)
-------------------------------------
1. This host has a stable `ext_agent_host_id` (urn:uuid, data/codex-host.json),
   chosen before its first sign-in and kept across sign-outs.
2. start_login(): fresh state + OIDC nonce + PKCE -> authorization URL on
   auth.openai.com/api/accounts/authorize. A new account registers with
   client_id=dynamic_agent_client + agent_name_hint; a saved account reuses
   its issued client id (+ id_token_hint / login_hint). A one-shot listener
   on 127.0.0.1 (1455, or any free port) catches the callback when the
   browser runs on this machine; otherwise the user pastes the address the
   browser was redirected to (an unreachable 127.0.0.1 page) into the plugin.
3. The callback's issued client id (new registration) is kept; the code is
   exchanged with PKCE + resource; the ID token is verified (RS256 against
   OpenAI's JWKS, issuer, audience, expiry, nonce); plan usage counts only
   when the granted scopes carry `chatgpt.tokens.use.direct`.
4. data/codex-auth.json holds one record per issued client id (0600 where
   the OS honours it); tokens rotate on refresh and are revoked on sign-out,
   the registration itself is kept for the next sign-in.
5. client() is an AsyncOpenAI on api.openai.com/v1 whose `responses.create`
   forces stream=True / store=False, drops the fields this route refuses,
   takes a fresh bearer per call, and folds the stream back into one
   Response for callers that did not ask for a stream.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import socket
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from . import config, log

ISSUER = "https://auth.openai.com"
DISCOVERY_URL = ISSUER + "/.well-known/openid-configuration"
# From the discovery document; these are its values, used when it is unreachable.
AUTH_URL = ISSUER + "/api/accounts/authorize"
TOKEN_URL = ISSUER + "/api/accounts/oauth/token"
REVOKE_URL = ISSUER + "/api/accounts/oauth/revoke"
JWKS_URL = ISSUER + "/.well-known/jwks.json"

DYNAMIC_CLIENT = "dynamic_agent_client"
AGENT_NAME = "Risu Hina"
RESOURCE = "https://api.openai.com/v1"
API_BASE = "https://api.openai.com/v1"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
SCOPE = "openid profile email offline_access resource.invoke " + PLAN_SCOPE
CALLBACK_HOST = "127.0.0.1"
CALLBACK_PORT = 1455
CALLBACK_PATH = "/auth/callback"
USAGE_URL = "https://chatgpt.com/settings/usage"

AUTH_PATH = config.DATA_DIR / "codex-auth.json"
HOST_PATH = config.DATA_DIR / "codex-host.json"
PENDING_TTL_S = 15 * 60
# Refresh this long before the access token's exp.
REFRESH_MARGIN_S = 5 * 60
MODELS_TTL_S = 10 * 60
# Refresh failures that mean the token set is dead (docs: Refresh errors).
DEAD_REFRESH = ("invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
                "refresh_token_invalidated", "refresh_token_reused")
# Responses fields this route refuses (docs: Preview limitations), plus the
# service-tier override. prompt_cache_key is not among them and is kept.
UNSUPPORTED_FIELDS = ("background", "conversation", "max_output_tokens", "max_tool_calls", "metadata",
                      "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier",
                      "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id",
                      "service_tier", "prompt_cache_options")


class CodexError(Exception):
    pass


_lock = threading.RLock()
_pending: dict[str, Any] = {}      # state -> attempt (see start_login)
_listener: dict[str, Any] = {}     # {server, thread, state}
_meta: dict[str, Any] = {}         # discovery + JWKS, cached for the process
_models: dict[str, Any] = {}       # client_id -> (fetched_at, [{slug, name}])


def _ua() -> dict:
    return {"User-Agent": f"{config.APP_NAME}/{config.VERSION}"}


# --- storage -----------------------------------------------------------------

def _write(path: Any, d: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.part")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    tmp.replace(path)


def _read(path: Any) -> dict:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _load() -> dict:
    """{version, active, accounts: {client_id: record}}; a pre-SIWC file
    (Codex CLI tokens) loads as empty with `legacy` set."""
    d = _read(AUTH_PATH)
    if d.get("version") == 2 and isinstance(d.get("accounts"), dict):
        return d
    return {"version": 2, "active": "", "accounts": {}, "legacy": bool(d.get("access_token"))}


def _save(d: dict) -> None:
    d = {k: v for k, v in d.items() if k != "legacy"}
    _write(AUTH_PATH, d)


def host_id() -> str:
    """This host's ext_agent_host_id: made once, kept for the host's life -
    sign-out and re-registration do not change it."""
    with _lock:
        d = _read(HOST_PATH)
        hid = str(d.get("ext_agent_host_id") or "")
        if not hid.startswith("urn:uuid:"):
            hid = "urn:uuid:" + str(uuid.uuid4())
            _write(HOST_PATH, {"ext_agent_host_id": hid, "created_at": time.time()})
        return hid


def _active(d: dict | None = None) -> dict:
    d = d or _load()
    rec = d["accounts"].get(d.get("active") or "")
    return rec if isinstance(rec, dict) else {}


def _jwt_parts(token: str) -> tuple[dict, dict, bytes, bytes]:
    try:
        h, p, s = token.split(".")
        dec = lambda x: base64.urlsafe_b64decode((x + "=" * (-len(x) % 4)).encode("ascii"))  # noqa: E731
        header, payload = json.loads(dec(h)), json.loads(dec(p))
        if not isinstance(header, dict) or not isinstance(payload, dict):
            raise ValueError
        return header, payload, f"{h}.{p}".encode("ascii"), dec(s)
    except (ValueError, TypeError):
        raise CodexError("토큰 형식이 올바르지 않습니다") from None


def _jwt_claims(token: str) -> dict:
    try:
        return _jwt_parts(token)[1]
    except CodexError:
        return {}


def plan_enabled(rec: dict) -> bool:
    return PLAN_SCOPE in (rec.get("scopes") or [])


def logged_in() -> bool:
    rec = _active()
    return bool(rec.get("access_token") and rec.get("refresh_token") and plan_enabled(rec))


def _expires_at(rec: dict) -> float:
    exp = _jwt_claims(rec.get("access_token") or "").get("exp")
    try:
        if exp:
            return float(exp)
        return float(rec.get("saved_at") or 0) + float(rec.get("expires_in") or 0)
    except (TypeError, ValueError):
        return 0.0


def status() -> dict:
    d = _load()
    rec = _active(d)
    with _lock:
        pending = [s for s, p in _pending.items() if time.time() - p["created"] < PENDING_TTL_S]
        listening = bool(_listener.get("server"))
        redirect = str(_listener.get("redirect") or f"http://{CALLBACK_HOST}:{CALLBACK_PORT}{CALLBACK_PATH}")
    models: list[dict] = []
    models_error = ""
    if logged_in():
        try:
            models = list_models()
        except CodexError as e:
            models_error = str(e)
    return {
        "loggedIn": logged_in(),
        "registered": bool(rec.get("client_id")),
        "signedIn": bool(rec.get("access_token")),
        "planEnabled": plan_enabled(rec),
        "email": str(rec.get("email") or ""),
        "expiresAt": _expires_at(rec) if rec.get("access_token") else 0,
        "accounts": [{"clientId": cid, "email": str(r.get("email") or ""), "active": cid == d.get("active"),
                      "signedIn": bool(r.get("access_token"))} for cid, r in d["accounts"].items()],
        "legacy": bool(d.get("legacy")),
        "welcome": bool(logged_in() and not rec.get("welcomed")),
        "pending": bool(pending),
        "listening": listening,
        "models": [m["slug"] for m in models],
        "modelNames": {m["slug"]: m["name"] for m in models},
        "modelsError": models_error,
        "base": API_BASE,
        "usageUrl": USAGE_URL,
        "redirectUri": redirect,
    }


def acknowledge_welcome() -> dict:
    """The first-sign-in notice ("You're using your ChatGPT plan") is shown
    once per account; this records that it was."""
    with _lock:
        d = _load()
        rec = _active(d)
        if rec:
            rec["welcomed"] = True
            _save(d)
    return status()


# --- discovery and ID-token verification -----------------------------------------

def _discovery() -> dict:
    with _lock:
        if _meta.get("discovery") and time.time() - _meta.get("discovery_at", 0) < 3600:
            return _meta["discovery"]
    import httpx
    try:
        r = httpx.get(DISCOVERY_URL, timeout=15, headers=_ua())
        r.raise_for_status()
        doc = r.json()
    except Exception as e:  # noqa: BLE001 - the documented values stand in
        log.warn("codex: discovery unavailable (%s) - using documented endpoints", e)
        doc = {}
    doc = {"authorization_endpoint": AUTH_URL, "token_endpoint": TOKEN_URL,
           "revocation_endpoint": REVOKE_URL, "jwks_uri": JWKS_URL, **(doc if isinstance(doc, dict) else {})}
    with _lock:
        _meta.update({"discovery": doc, "discovery_at": time.time()})
    return doc


def _jwks(force: bool = False) -> list[dict]:
    with _lock:
        if not force and _meta.get("jwks") and time.time() - _meta.get("jwks_at", 0) < 3600:
            return _meta["jwks"]
    import httpx
    try:
        r = httpx.get(str(_discovery()["jwks_uri"]), timeout=15, headers=_ua())
        r.raise_for_status()
        keys = [k for k in (r.json().get("keys") or []) if isinstance(k, dict)]
    except Exception as e:  # noqa: BLE001
        raise CodexError(f"OpenAI 서명 키(JWKS)를 가져오지 못했습니다: {type(e).__name__}: {e}")
    with _lock:
        _meta.update({"jwks": keys, "jwks_at": time.time()})
    return keys


def _rsa() -> Any:
    try:
        import rsa
    except ImportError:
        # rsa comes with google-auth; the Vertex repair installs that pair.
        from . import vertexauth
        vertexauth._google_auth()
        import rsa
    return rsa


def _b64int(v: str) -> int:
    return int.from_bytes(base64.urlsafe_b64decode(v + "=" * (-len(v) % 4)), "big")


def verify_id_token(token: str, client_id: str, nonce: str) -> dict:
    """The ID token's claims, after checking what the docs require: RS256
    signature against OpenAI's published keys, issuer, audience = the issued
    client id, expiry and this attempt's nonce."""
    header, claims, signed, sig = _jwt_parts(token)
    if header.get("alg") != "RS256":
        raise CodexError(f"지원하지 않는 ID 토큰 서명 방식입니다: {header.get('alg')}")
    kid = header.get("kid")
    key = next((k for k in _jwks() if k.get("kid") == kid), None) \
        or next((k for k in _jwks(force=True) if k.get("kid") == kid), None)
    if key is None or key.get("kty") != "RSA":
        raise CodexError("ID 토큰의 서명 키를 OpenAI 공개 키에서 찾지 못했습니다")
    rsa = _rsa()
    try:
        rsa.verify(signed, sig, rsa.PublicKey(_b64int(key["n"]), _b64int(key["e"])))
    except Exception:  # noqa: BLE001 - rsa.VerificationError and malformed keys alike
        raise CodexError("ID 토큰 서명 검증에 실패했습니다") from None
    if claims.get("iss") != ISSUER:
        raise CodexError(f"ID 토큰 발급자가 다릅니다: {claims.get('iss')}")
    aud = claims.get("aud")
    if client_id not in (aud if isinstance(aud, list) else [aud]):
        raise CodexError("ID 토큰의 대상(audience)이 이 등록과 다릅니다")
    try:
        if float(claims.get("exp") or 0) < time.time() - 60:
            raise CodexError("ID 토큰이 만료됐습니다. 로그인을 다시 시작해 주세요")
    except (TypeError, ValueError):
        raise CodexError("ID 토큰의 만료 시각이 올바르지 않습니다") from None
    if not nonce or claims.get("nonce") != nonce:
        raise CodexError("ID 토큰의 nonce 가 이 로그인 요청과 다릅니다")
    if not claims.get("sub"):
        raise CodexError("ID 토큰에 계정 식별자(sub)가 없습니다")
    return claims


# --- login --------------------------------------------------------------------

def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode("ascii").rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def auth_url(attempt: dict, challenge: str) -> str:
    q = {
        "response_type": "code",
        "client_id": attempt["client_id"],
        "redirect_uri": attempt["redirect_uri"],
        "scope": SCOPE,
        "resource": RESOURCE,
        "state": attempt["state"],
        "nonce": attempt["nonce"],
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "ext_agent_host_id": host_id(),
    }
    if attempt["client_id"] == DYNAMIC_CLIENT:
        q["agent_name_hint"] = AGENT_NAME
    else:
        if attempt.get("id_token_hint"):
            q["id_token_hint"] = attempt["id_token_hint"]
        if attempt.get("login_hint"):
            q["login_hint"] = attempt["login_hint"]
    if attempt.get("consent"):
        q["prompt"] = "consent"
    return str(_discovery()["authorization_endpoint"]) + "?" + urllib.parse.urlencode(q)


def start_login(account: str = "", consent: bool = False) -> dict:
    """A fresh authorization URL; the previous pending attempt is dropped.

    `account`: "" continues with the active account's registration (or
    registers one when there is none), "new" registers another account, a
    saved client id signs in to that one. `consent` asks again for plan
    usage after the user declined it (prompt=consent - an explicit choice,
    never on an ordinary sign-in).
    """
    d = _load()
    if account == "new":
        rec: dict = {}
    elif account:
        rec = d["accounts"].get(account) or {}
        if not rec:
            raise CodexError("저장된 계정이 아닙니다")
    else:
        rec = _active(d)
    verifier, challenge = _pkce()
    state = secrets.token_urlsafe(24)
    _stop_listener()
    srv = _bind()
    port = int(srv.server_address[1]) if srv else 0
    attempt = {
        "state": state, "nonce": secrets.token_urlsafe(24), "verifier": verifier,
        "client_id": str(rec.get("client_id") or DYNAMIC_CLIENT),
        "subject": str(rec.get("subject") or ""),
        "id_token_hint": str(rec.get("id_token") or ""),
        "login_hint": str(rec.get("email") or ""),
        "consent": bool(consent and rec),
        "redirect_uri": f"http://{CALLBACK_HOST}:{port or CALLBACK_PORT}{CALLBACK_PATH}",
        "created": time.time(), "done": False, "error": "",
    }
    with _lock:
        _pending.clear()
        _pending[state] = attempt
    if srv is not None:
        _serve(srv, state, attempt["redirect_uri"])
    return {"url": auth_url(attempt, challenge), "state": state, "listening": bool(port),
            "redirectUri": attempt["redirect_uri"], "newAccount": attempt["client_id"] == DYNAMIC_CLIENT}


def login_status(state: str) -> dict:
    with _lock:
        p = _pending.get(state)
        if p is None:
            return {"state": state, "known": False, "done": logged_in(), "error": ""}
        return {"state": state, "known": True, "done": bool(p.get("done")), "error": str(p.get("error") or ""),
                "loggedIn": logged_in()}


def parse_login_input(pasted: str, state_hint: str = "") -> dict:
    """A callback URL (schemeless 127.0.0.1/localhost too), its query, or a
    bare code -> {code, state, client_id, error}."""
    text = (pasted or "").strip().strip('\"\'')
    if not text:
        raise CodexError("콜백 URL 전체 또는 code 값을 입력해 주세요")
    out = {"code": "", "state": state_hint.strip(), "client_id": "", "error": ""}
    is_url = "://" in text or text.startswith(("localhost", "127.0.0.1", "[::1]", CALLBACK_PATH))
    if is_url or text.startswith(("?", "code=", "state=", "error=")):
        if is_url:
            parsed = urllib.parse.urlsplit(text if "://" in text or text.startswith("/") else "//" + text)
            query = parsed.query
        else:
            query = text.lstrip("?")
        qs = urllib.parse.parse_qs(query.replace("&amp;", "&"), keep_blank_values=True)
        if any(len(qs.get(key, [])) > 1 for key in ("code", "state", "client_id")):
            raise CodexError("code/state 값이 중복된 주소입니다")
        url_state = (qs.get("state") or [""])[0]
        if out["state"] and url_state and out["state"] != url_state:
            raise CodexError("다른 로그인 요청의 URL입니다 (state). 현재 요청의 URL을 입력해 주세요")
        out["state"] = url_state or out["state"]
        out["error"] = (qs.get("error") or [""])[0]
        out["code"] = (qs.get("code") or [""])[0]
        out["client_id"] = (qs.get("client_id") or [""])[0]
        if out["error"]:
            return out
    else:
        out["code"] = text
    if not out["code"]:
        raise CodexError("주소에 code 가 없습니다")
    if any(ch.isspace() for ch in out["code"]):
        raise CodexError("code 값에 공백이 있습니다. URL 전체 또는 원래 code 값을 입력해 주세요")
    return out


def complete_login(pasted: str, state_hint: str = "") -> dict:
    """The paste fallback: the redirected URL, or a bare code (+ state)."""
    got = parse_login_input(pasted, state_hint)
    with _lock:
        state = got["state"]
        if not state and len(_pending) == 1:
            state = next(iter(_pending))
        p = _pending.get(state)
    if p is None:
        raise CodexError("진행 중인 로그인과 맞지 않습니다 (state). 로그인을 다시 시작해 주세요")
    _finish(p, got)
    return status()


def _finish(p: dict, got: dict) -> None:
    """Callback -> tokens -> verified identity -> saved record (docs §3-§5).
    Marks the attempt done or failed either way."""
    try:
        if got.get("error"):
            if got["error"] == "access_denied":
                raise CodexError("ChatGPT 에서 승인을 거절해 로그인을 멈췄습니다. 다시 시도하려면 로그인을 새로 시작해 주세요")
            raise CodexError(f"OpenAI 가 인증 오류를 돌려줬습니다: {got['error']}")
        issued = str(got.get("client_id") or "")
        if p["client_id"] == DYNAMIC_CLIENT:
            if not issued or issued == DYNAMIC_CLIENT:
                raise CodexError("등록이 끝나지 않았습니다: 콜백 주소에 발급된 client_id 가 없습니다. "
                                 "code 값만이 아니라 주소 전체를 붙여넣어 주세요")
            client_id = issued
        else:
            if issued and issued != p["client_id"]:
                raise CodexError("콜백의 client_id 가 선택한 계정의 등록과 다릅니다. 로그인을 다시 시작해 주세요")
            client_id = p["client_id"]
        tok = _token_request({"grant_type": "authorization_code", "code": got["code"],
                              "redirect_uri": p["redirect_uri"], "client_id": client_id,
                              "code_verifier": p["verifier"], "resource": RESOURCE}, "로그인")
        if not tok.get("id_token"):
            raise CodexError("토큰 응답에 id_token 이 없습니다")
        claims = verify_id_token(str(tok["id_token"]), client_id, p["nonce"])
        if p["subject"] and claims["sub"] != p["subject"]:
            raise CodexError("다른 ChatGPT 계정으로 로그인했습니다. 선택한 계정으로 다시 로그인하거나 '다른 계정 추가'를 써 주세요")
        with _lock:
            d = _load()
            rec = d["accounts"].get(client_id) or {}
            rec.update({"issuer": ISSUER, "subject": str(claims["sub"]), "client_id": client_id,
                        "email": str(claims.get("email") or rec.get("email") or ""),
                        "ext_agent_host_id": host_id()})
            _adopt(rec, tok)
            d["accounts"][client_id] = rec
            d["active"] = client_id
            _save(d)
            p["done"] = True
        _stop_listener()
        log.info("codex: signed in client=%s plan=%s", client_id[:12], plan_enabled(rec))
    except CodexError as e:
        with _lock:
            p["error"] = str(e)
        raise


def _adopt(rec: dict, tok: dict) -> None:
    """Access token, rotated refresh token, scopes and expiry replace the old
    ones together (docs: Store credentials)."""
    if not tok.get("access_token"):
        raise CodexError("토큰 응답에 access_token 이 없습니다")
    rec["access_token"] = str(tok["access_token"])
    if tok.get("refresh_token"):
        rec["refresh_token"] = str(tok["refresh_token"])
    if tok.get("id_token"):
        rec["id_token"] = str(tok["id_token"])
    if tok.get("scope"):
        rec["scopes"] = sorted(str(tok["scope"]).split())
    rec["token_type"] = str(tok.get("token_type") or "Bearer")
    rec["expires_in"] = int(tok.get("expires_in") or 3600)
    rec["earliest_refresh_at"] = tok.get("earliest_refresh_at") or None
    rec["saved_at"] = time.time()


def _oauth_error(r: Any) -> str:
    try:
        body = r.json()
    except ValueError:
        return ""
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("code") or err.get("type") or "")
        return str(err or body.get("code") or "")
    return ""


def _token_request(form: dict, what: str) -> dict:
    import httpx
    try:
        r = httpx.post(str(_discovery()["token_endpoint"]), data=form, timeout=30, headers=_ua())
    except Exception as e:  # noqa: BLE001
        raise CodexError(f"{what} 토큰 요청 실패 (네트워크): {type(e).__name__}: {e}")
    if r.status_code != 200:
        code = _oauth_error(r)
        if what == "로그인" and code == "invalid_grant":
            raise CodexError("로그인 코드가 만료됐거나 이미 쓰였습니다. 로그인을 다시 시작해 주세요")
        err = CodexError(f"{what} 토큰 요청 거부 ({r.status_code}{', ' + code if code else ''}): {r.text[:300]}")
        err.oauth_code = code  # type: ignore[attr-defined]
        err.status = r.status_code  # type: ignore[attr-defined]
        raise err
    tok = r.json()
    if not isinstance(tok, dict):
        raise CodexError(f"{what} 토큰 응답 형식이 올바르지 않습니다")
    return tok


def access_token() -> str:
    """A bearer that is good for at least REFRESH_MARGIN_S more seconds.
    Refreshes are serialized: the refresh token rotates."""
    with _lock:
        d = _load()
        rec = _active(d)
        if not rec.get("access_token"):
            raise CodexError("ChatGPT 로그인이 필요합니다 (⚙ → API 키 → ChatGPT 요금제)")
        if not plan_enabled(rec):
            raise CodexError("이 계정은 ChatGPT 요금제 사용이 허용되지 않았습니다 (⚙ → API 키 → ChatGPT 요금제에서 허용)")
        now = time.time()
        exp = _expires_at(rec)
        try:
            earliest = float(rec.get("earliest_refresh_at") or 0)
        except (TypeError, ValueError):
            earliest = 0.0
        due = exp and now > exp - REFRESH_MARGIN_S and (now >= earliest or now >= exp)
        if due and rec.get("refresh_token"):
            _refresh(d, rec)
        return str(rec["access_token"])


def _refresh(d: dict, rec: dict) -> None:
    form = {"grant_type": "refresh_token", "client_id": rec["client_id"],
            "refresh_token": rec["refresh_token"], "resource": RESOURCE}
    try:
        tok = _token_request(form, "갱신")
    except CodexError as e:
        code = getattr(e, "oauth_code", "")
        if code in DEAD_REFRESH:
            # The session is gone (revoked, disconnected in ChatGPT, expired):
            # drop the tokens, keep the registration for the next sign-in.
            for k in ("access_token", "refresh_token", "id_token"):
                rec.pop(k, None)
            _save(d)
            log.warn("codex: refresh token unusable (%s) - sign-in needed", code)
            raise CodexError("ChatGPT 로그인이 만료됐거나 해제됐습니다. ⚙ → API 키 → ChatGPT 요금제에서 다시 로그인해 주세요") from None
        if code == "invalid_client":
            raise CodexError("ChatGPT 등록(client)이 거부됐습니다. '다른 계정 추가'로 새로 등록해 주세요") from None
        # A network or server failure keeps the credentials (docs: Disconnection).
        raise
    _adopt(rec, tok)
    _save(d)
    log.info("codex: access token refreshed")


def logout() -> dict:
    """Revoke the renewable session, then clear this account's tokens. The
    registration (client id, account) and the host id stay for next time."""
    _stop_listener()
    with _lock:
        d = _load()
        rec = _active(d)
        refresh = str(rec.get("refresh_token") or "")
        revoked = not refresh
        if refresh:
            import httpx
            url = str(_discovery()["revocation_endpoint"])
            for attempt in range(3):
                try:
                    r = httpx.post(url, data={"token": refresh, "token_type_hint": "refresh_token",
                                              "client_id": rec["client_id"]}, timeout=15, headers=_ua())
                    if r.status_code == 200:
                        revoked = True
                        break
                    if r.status_code < 500:
                        break
                except Exception as e:  # noqa: BLE001
                    log.warn("codex: revoke attempt %d failed: %s", attempt + 1, e)
                time.sleep(0.5 * (attempt + 1))
        for k in ("access_token", "refresh_token", "id_token", "earliest_refresh_at"):
            rec.pop(k, None)
        if rec:
            _save(d)
    return {"loggedIn": False, "revoked": revoked}


# --- models ---------------------------------------------------------------------------

def list_models() -> list[dict]:
    """The signed-in account's model catalog, as the docs ask: GET /v1/models
    with the same token, `visibility == "list"`, server order."""
    rec = _active()
    cid = str(rec.get("client_id") or "")
    with _lock:
        hit = _models.get(cid)
        if hit and time.time() - hit[0] < MODELS_TTL_S:
            return hit[1]
    import httpx
    try:
        r = httpx.get(API_BASE + "/models", timeout=15,
                      headers={**_ua(), "Authorization": f"Bearer {access_token()}"})
    except CodexError:
        raise
    except Exception as e:  # noqa: BLE001
        raise CodexError(f"모델 목록을 가져오지 못했습니다: {type(e).__name__}: {e}")
    if r.status_code != 200:
        raise CodexError(f"모델 목록 요청 거부 ({r.status_code}): {r.text[:200]}")
    body = r.json() if r.content else {}
    rows = body.get("models") if isinstance(body, dict) else None
    out = [{"slug": str(m.get("slug")), "name": str(m.get("display_name") or m.get("slug"))}
           for m in (rows or []) if isinstance(m, dict) and m.get("slug") and m.get("visibility", "list") == "list"]
    with _lock:
        _models[cid] = (time.time(), out)
    return out


# --- errors -----------------------------------------------------------------------------

# docs: Errors and recovery -> what the user should do, in the panel's words.
_ERRORS = {
    "subscription_sharing_user_not_eligible":
        "이 ChatGPT 계정·워크스페이스에서는 요금제 사용이 허용되지 않습니다. 다른 계정이나 API 키를 써 주세요.",
    "subscription_sharing_usage_limit_exceeded":
        f"ChatGPT 요금제 사용 한도에 도달했습니다 (요금제 또는 이 앱의 한도). 사용량 관리: {USAGE_URL}",
    "subscription_sharing_usage_unavailable":
        "ChatGPT 사용량을 지금 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    "subscription_sharing_unsupported_capability":
        "이 요청에 ChatGPT 요금제 경로가 지원하지 않는 입력·도구·모델이 들어 있습니다",
    "subscription_sharing_route_not_supported":
        "ChatGPT 요금제로는 이 API 경로를 쓸 수 없습니다",
    "subscription_sharing_invalid_user":
        "ChatGPT 계정을 확인하지 못했습니다. ⚙ → API 키 → ChatGPT 요금제에서 다시 로그인해 주세요.",
    "chatpass_v2_scope_not_authorized":
        "이 로그인에는 해당 작업 권한이 없습니다. ⚙ → API 키 → ChatGPT 요금제에서 요금제 사용을 다시 허용해 주세요.",
    "chatpass_v2_invalid_authorization_context":
        "이 로그인에는 해당 작업 권한이 없습니다. ⚙ → API 키 → ChatGPT 요금제에서 요금제 사용을 다시 허용해 주세요.",
    "subscription_sharing_user_unavailable":
        "ChatGPT 계정 정보를 일시적으로 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
}


def explain(text: str) -> str | None:
    """A user-facing sentence for a ChatGPT-plan failure, or None. The code
    and the raw text stay attached (the docs ask to keep them)."""
    for code, say in _ERRORS.items():
        if code in text:
            return f"{say}\n({code}) {text[:300]}"
    low = text.lower()
    if "401" in text or "unauthorized" in low:
        return ("ChatGPT 요금제 인증이 거부됐습니다. ⚙ → API 키 → ChatGPT 요금제에서 계정과 권한을 확인하고, "
                f"필요하면 다시 로그인해 주세요.\n{text[:300]}")
    if "403" in text:
        return f"ChatGPT 요금제 요청이 정책·권한 확인에서 막혔습니다 (예: 지원 지역).\n{text[:300]}"
    if "503" in text:
        return f"ChatGPT 요금제 경로를 지금 쓸 수 없습니다. 잠시 후 다시 시도해 주세요.\n{text[:300]}"
    return None


# --- the callback listener --------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_: Any) -> None:  # quiet
        return

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != CALLBACK_PATH:
            self.send_response(404)
            self.end_headers()
            return
        ok, err = False, ""
        try:
            got = parse_login_input("?" + parsed.query)
            with _lock:
                p = _pending.get(got["state"])
            if p is None:
                raise CodexError("state 가 맞지 않습니다")
            _finish(p, got)
            ok = True
        except CodexError as e:
            err = str(e)
        import html
        body = ("<html><body style='font-family:sans-serif;padding:40px'>"
                + ("<h2>Risu Hina: ChatGPT 로그인 완료</h2><p>이 창을 닫고 플러그인으로 돌아가셔도 됩니다.</p>" if ok
                   else f"<h2>로그인 실패</h2><p>{html.escape(err)}</p>")
                + "</body></html>").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _bind() -> HTTPServer | None:
    """1455 when free, else any free loopback port (the docs allow the port,
    and only the port, to vary)."""
    for port in (CALLBACK_PORT, 0):
        try:
            return HTTPServer((CALLBACK_HOST, port), _Handler)
        except OSError as e:
            if port:
                log.warn("codex: callback port %s busy (%s) - trying another", port, e)
    return None


def _serve(srv: HTTPServer, state: str, redirect: str) -> None:
    """Answer callbacks for this attempt until it is done, replaced or stale."""
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
        except (OSError, ValueError, socket.error):
            pass
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
        _listener.update({"server": srv, "thread": t, "state": state, "redirect": redirect})
    t.start()


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

# Set once the route has refused prompt_cache_key / plain top-level function
# tools (see create() below); kept for the process.
_NO_CACHE_KEY: list[str] = []
_NAMESPACE_TOOLS: list[str] = []
TOOL_NAMESPACE = "risu_hina"


def _developer_roles(items: Any) -> Any:
    """`system` message items are refused on this route; the docs say to use
    instructions or developer messages - same text, accepted role."""
    if not isinstance(items, list):
        return items
    out = []
    for it in items:
        if isinstance(it, dict) and it.get("role") == "system" and it.get("type", "message") == "message":
            it = {**it, "role": "developer"}
        out.append(it)
    return out


def _namespaced(kw: dict) -> dict:
    """Function tools grouped in one namespace (docs: Supported tools), for a
    route that refuses them at the top level. Hosted tools stay where they are."""
    tools = kw.get("tools")
    if not isinstance(tools, list):
        return kw
    fns = [t for t in tools if isinstance(t, dict) and t.get("type") in ("function", "custom")]
    if not fns:
        return kw
    rest = [t for t in tools if t not in fns]
    kw = {**kw, "tools": rest + [{"type": "namespace", "name": TOOL_NAMESPACE,
                                  "description": "Risu Hina editing tools", "tools": fns}]}
    if isinstance(kw.get("tool_choice"), dict):
        kw["tool_choice"] = "required"
    return kw


def _tools_refused(text: str) -> bool:
    low = text.lower()
    return "namespace" in low or ("subscription_sharing_unsupported_capability" in low and "tools" in low
                                  and "function" in low)


async def _bearer() -> str:
    import asyncio
    return await asyncio.to_thread(access_token)


def client() -> Any:
    """An AsyncOpenAI for the Responses API on the user's ChatGPT plan: fresh
    bearer per call, streaming forced, store off, refused fields dropped,
    non-stream calls folded from the stream."""
    import openai
    access_token()  # fail here, readably, when not signed in
    c = openai.AsyncOpenAI(
        base_url=API_BASE,
        api_key=_bearer,
        timeout=float(config.section("agent").get("timeoutSeconds") or 300),
    )
    orig = c.responses.create

    async def create(**kw: Any) -> Any:
        wanted_stream = bool(kw.get("stream"))
        kw["stream"] = True
        kw["store"] = False
        for k in UNSUPPORTED_FIELDS:
            kw.pop(k, None)
        if "input" in kw:
            kw["input"] = _developer_roles(kw["input"])
        if _NO_CACHE_KEY:
            kw.pop("prompt_cache_key", None)
        if _NAMESPACE_TOOLS:
            kw = _namespaced(kw)
        try:
            stream = await orig(**kw)
        except Exception as e:  # noqa: BLE001 - one field, one retry
            text = str(e)
            if "prompt_cache_key" in kw and "prompt_cache_key" in text.lower():
                _NO_CACHE_KEY.append(text[:200])
                log.warn("chatgpt plan route refused prompt_cache_key; dropped for this process: %s", text[:200])
                kw.pop("prompt_cache_key", None)
                stream = await orig(**kw)
            elif not _NAMESPACE_TOOLS and kw.get("tools") and _tools_refused(text):
                _NAMESPACE_TOOLS.append(text[:200])
                log.warn("chatgpt plan route refused top-level function tools; namespacing: %s", text[:200])
                stream = await orig(**_namespaced(kw))
            else:
                raise
        if wanted_stream:
            return stream
        final = None
        # A folded (non-stream) call reads the items from
        # `response.output_item.done` too: a `response.completed` with an
        # empty `output` (seen on the old backend) must not read as "no text
        # and no tool calls".
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
                resp = getattr(ev, "response", None)
                err = getattr(resp, "error", None)
                if err:
                    code = getattr(err, "code", "") or ""
                    raise CodexError(f"chatgpt: {code + ': ' if code else ''}{getattr(err, 'message', err)}")
                details = getattr(resp, "incomplete_details", None)
                raise CodexError(f"chatgpt: 응답이 완료되지 않았습니다 ({getattr(details, 'reason', t)})")
            elif t == "error":
                code = getattr(ev, "code", "") or ""
                raise CodexError(f"chatgpt: {code + ': ' if code else ''}{getattr(ev, 'message', ev)}")
        if final is None:
            raise CodexError("chatgpt: response.completed 없이 스트림이 끝났습니다")
        return final

    c.responses.create = create  # type: ignore[method-assign]
    return c
