"""Sign in with ChatGPT (the ChatGPT plan as the agent's backend), no network.

OpenAI's endpoints are faked at httpx; the ID tokens are really RS256-signed
with a test key published through the fake JWKS, so the signature check runs.
What is checked is what developers.openai.com/siwc asks of an OSS client:
dynamic registration, host id, 127.0.0.1 callback, resource + scopes, ID-token
validation, plan-permission gating, rotating refresh, revoke on sign-out, the
public Responses route with its refused fields.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

TMP = tempfile.mkdtemp(prefix="risuhina-codexauth-")
os.environ["RISUHINA_DATA_DIR"] = TMP
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pyserver"))

import rsa  # noqa: E402

from app import codexauth as C  # noqa: E402

fails = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global fails
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" - {detail}" if detail and not ok else ""))
    if not ok:
        fails += 1


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


PUB, PRIV = rsa.newkeys(1024)
OTHER_PUB, OTHER_PRIV = rsa.newkeys(1024)
JWK = {"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "k1",
       "n": b64(PUB.n.to_bytes((PUB.n.bit_length() + 7) // 8, "big")),
       "e": b64(PUB.e.to_bytes((PUB.e.bit_length() + 7) // 8, "big"))}


def jwt(claims: dict, priv=PRIV, kid="k1") -> str:
    h = b64(json.dumps({"alg": "RS256", "kid": kid, "typ": "JWT"}).encode())
    p = b64(json.dumps(claims).encode())
    sig = rsa.sign(f"{h}.{p}".encode(), priv, "SHA-256")
    return f"{h}.{p}.{b64(sig)}"


class Resp:
    def __init__(self, status: int, body: object = None):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body) if body is not None else ""
        self.content = self.text.encode()

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


ISSUED = "oaiapp_test123"
SUB = "user-sub-1"
calls: list[tuple[str, dict]] = []
token_script: list = []   # what the next token-endpoint call returns


def id_token(nonce: str, aud: str = ISSUED, sub: str = SUB, **kw) -> str:
    return jwt({"iss": "https://auth.openai.com", "aud": aud, "sub": sub, "nonce": nonce,
                "email": "user@example.com", "exp": time.time() + 3600, "iat": time.time(), **kw})


def access(exp_in: float = 3600) -> str:
    return jwt({"sub": SUB, "aud": "https://api.openai.com/v1", "client_id": ISSUED,
                "exp": time.time() + exp_in})


def fake_get(url, **kw):
    calls.append(("GET " + url, kw))
    if url.endswith("/.well-known/openid-configuration"):
        return Resp(200, {"issuer": C.ISSUER, "authorization_endpoint": C.AUTH_URL, "token_endpoint": C.TOKEN_URL,
                          "revocation_endpoint": C.REVOKE_URL, "jwks_uri": C.JWKS_URL})
    if url == C.JWKS_URL:
        return Resp(200, {"keys": [JWK]})
    if url == C.API_BASE + "/models":
        return Resp(200, {"models": [{"slug": "gpt-a", "display_name": "GPT A", "visibility": "list"},
                                     {"slug": "hidden", "display_name": "H", "visibility": "hide"}]})
    return Resp(404, {"error": "nope"})


def fake_post(url, **kw):
    calls.append(("POST " + url, kw))
    if url == C.TOKEN_URL:
        nxt = token_script.pop(0)
        return nxt(kw["data"]) if callable(nxt) else nxt
    if url == C.REVOKE_URL:
        return Resp(200)
    return Resp(404, {"error": "nope"})


def posts(to: str) -> list[dict]:
    return [kw["data"] for u, kw in calls if u == "POST " + to]


with patch("httpx.get", side_effect=fake_get), patch("httpx.post", side_effect=fake_post):
    print("test_first_registration_url")
    hid = C.host_id()
    check("host id is a urn:uuid, stable", hid.startswith("urn:uuid:") and C.host_id() == hid, hid)
    r = C.start_login()
    q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(r["url"]).query).items()}
    check("authorize endpoint", r["url"].startswith("https://auth.openai.com/api/accounts/authorize?"), r["url"][:60])
    check("dynamic registration with the app's name",
          q.get("client_id") == "dynamic_agent_client" and q.get("agent_name_hint") == "Risu Hina", str(q)[:200])
    check("host id, resource, plan scopes",
          q.get("ext_agent_host_id") == hid and q.get("resource") == "https://api.openai.com/v1"
          and set(q.get("scope", "").split()) == {"openid", "profile", "email", "offline_access",
                                                  "resource.invoke", "chatgpt.tokens.use.direct"}, str(q)[:300])
    check("PKCE S256, state, nonce",
          q.get("code_challenge_method") == "S256" and q.get("code_challenge") and q.get("state") and q.get("nonce"))
    check("127.0.0.1 loopback redirect, /auth/callback",
          q.get("redirect_uri", "").startswith("http://127.0.0.1:") and q["redirect_uri"].endswith("/auth/callback"),
          q.get("redirect_uri"))
    check("no Codex CLI leftovers", not ({"originator", "codex_cli_simplified_flow", "id_token_add_organizations"} & q.keys()))
    state, nonce, redirect = q["state"], q["nonce"], q["redirect_uri"]

    print("test_callback_needs_issued_client_id")
    try:
        C.complete_login(f"{redirect}?code=abc&state={state}")
        check("a new registration without client_id is refused", False)
    except C.CodexError as e:
        check("a new registration without client_id is refused", "client_id" in str(e), str(e))
    try:
        C.complete_login(f"{redirect}?error=access_denied&state={state}")
        check("access_denied stops", False)
    except C.CodexError as e:
        check("access_denied stops without exchanging", "거절" in str(e) and not posts(C.TOKEN_URL), str(e))

    print("test_bad_id_tokens_are_refused")
    for label in ("wrong nonce", "wrong audience", "forged signature", "expired"):
        r = C.start_login()
        q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(r["url"]).query).items()}
        good_nonce = q["nonce"]
        built = {"wrong nonce": id_token("other"),
                 "wrong audience": id_token(good_nonce, aud="oaiapp_else"),
                 "forged signature": jwt({"iss": C.ISSUER, "aud": ISSUED, "sub": SUB, "nonce": good_nonce,
                                          "exp": time.time() + 60}, priv=OTHER_PRIV),
                 "expired": id_token(good_nonce, exp=time.time() - 3600)}[label]
        token_script.append(Resp(200, {"access_token": access(), "refresh_token": "r0", "id_token": built,
                                       "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
                                       "expires_in": 3600, "token_type": "Bearer"}))
        try:
            C.complete_login(f"{q['redirect_uri']}?code=abc&state={q['state']}&client_id={ISSUED}")
            check(f"{label} is refused", False)
        except C.CodexError as e:
            check(f"{label} is refused", not C.logged_in(), str(e))

    print("test_registration_completes")
    calls.clear()
    r = C.start_login()
    q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(r["url"]).query).items()}
    token_script.append(Resp(200, {"access_token": access(), "refresh_token": "r1", "id_token": id_token(q["nonce"]),
                                   "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
                                   "expires_in": 3600, "token_type": "Bearer", "earliest_refresh_at": None}))
    # The paste fallback, schemeless, exactly as a phone would copy it.
    st = C.complete_login(f"{q['redirect_uri'].split('://')[1]}?code=abc&scope=x&state={q['state']}&client_id={ISSUED}")
    ex = posts(C.TOKEN_URL)[-1]
    check("code exchange uses the issued id, PKCE, same redirect, resource",
          ex["client_id"] == ISSUED and ex["grant_type"] == "authorization_code" and ex["code_verifier"]
          and ex["redirect_uri"] == q["redirect_uri"] and ex["resource"] == "https://api.openai.com/v1", str(ex)[:200])
    check("signed in with plan usage", st["loggedIn"] and st["planEnabled"] and st["email"] == "user@example.com", str(st)[:200])
    check("models come from /v1/models, list-visible only",
          st["models"] == ["gpt-a"] and st["modelNames"] == {"gpt-a": "GPT A"}, str(st.get("models")))
    check("the first sign-in notice is due once", st["welcome"] is True)
    check("and gone after it is acknowledged", C.acknowledge_welcome()["welcome"] is False)
    saved = json.loads(C.AUTH_PATH.read_text(encoding="utf-8"))
    rec = saved["accounts"][ISSUED]
    check("the record keeps the documented fields",
          {"client_id", "subject", "email", "id_token", "access_token", "refresh_token", "scopes",
           "ext_agent_host_id", "saved_at"} <= rec.keys() and rec["subject"] == SUB and saved["active"] == ISSUED,
          str(sorted(rec)))

    print("test_refresh_rotates")
    rec["access_token"] = access(exp_in=60)  # inside the refresh margin
    C.AUTH_PATH.write_text(json.dumps(saved), encoding="utf-8")
    token_script.append(Resp(200, {"access_token": access(), "refresh_token": "r2",
                                   "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
                                   "expires_in": 3600}))
    tok = C.access_token()
    rf = posts(C.TOKEN_URL)[-1]
    check("refresh form: issued id, refresh token, resource, no scope",
          rf == {"grant_type": "refresh_token", "client_id": ISSUED, "refresh_token": "r1",
                 "resource": "https://api.openai.com/v1"}, str(rf))
    rec2 = json.loads(C.AUTH_PATH.read_text(encoding="utf-8"))["accounts"][ISSUED]
    check("the rotated refresh token replaces the old", rec2["refresh_token"] == "r2" and rec2["access_token"] == tok)
    n = len(posts(C.TOKEN_URL))
    C.access_token()
    check("a fresh token is not refreshed again", len(posts(C.TOKEN_URL)) == n)

    print("test_reauthorization_url")
    r = C.start_login()
    q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(r["url"]).query).items()}
    check("reuses the issued client id, hints, same host, no name hint",
          q.get("client_id") == ISSUED and q.get("id_token_hint") and q.get("login_hint") == "user@example.com"
          and q.get("ext_agent_host_id") == hid and "agent_name_hint" not in q, str({k: q[k][:20] for k in q})[:300])
    try:
        C.complete_login(f"{q['redirect_uri']}?code=abc&state={q['state']}&client_id=oaiapp_other")
        check("a different client id on reauth is refused", False)
    except C.CodexError as e:
        check("a different client id on reauth is refused", "client_id" in str(e), str(e))
    r = C.start_login()
    q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(r["url"]).query).items()}
    token_script.append(Resp(200, {"access_token": access(), "refresh_token": "r3",
                                   "id_token": id_token(q["nonce"], sub="someone-else"),
                                   "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"}))
    try:
        C.complete_login(f"{q['redirect_uri']}?code=abc&state={q['state']}")
        check("another account on reauth does not replace this one", False)
    except C.CodexError as e:
        rec3 = json.loads(C.AUTH_PATH.read_text(encoding="utf-8"))["accounts"][ISSUED]
        check("another account on reauth does not replace this one", rec3["refresh_token"] == "r2", str(e))

    print("test_client_request_shape")
    seen: dict = {}

    async def fake_create(**kw):
        seen.clear()
        seen.update(kw)

        async def gen():
            yield NS(type="response.output_item.done", item=NS(type="message", text="hi"))
            yield NS(type="response.completed", response=NS(output=[], error=None))
        return gen()

    c = C.client()
    check("public Responses API base", str(c.base_url).rstrip("/") == "https://api.openai.com/v1", str(c.base_url))
    # Swap the SDK call underneath the wrapper: client() captures the bound
    # method at build time, so patch the class before building.
    async def fake_any(*a, **kw):
        return await fake_create(**kw)
    with patch.object(type(c.responses), "create", side_effect=fake_any):
        c2 = C.client()
        out = asyncio.run(c2.responses.create(
            model="gpt-a", instructions="x", temperature=0.5, max_output_tokens=10, top_p=1, user="u",
            metadata={"a": 1}, previous_response_id="r", service_tier="flex", prompt_cache_key="k",
            input=[{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}]))
    check("stream on, store off", seen.get("stream") is True and seen.get("store") is False, str(seen)[:200])
    check("refused fields dropped, prompt_cache_key kept",
          not ({"temperature", "max_output_tokens", "top_p", "user", "metadata", "previous_response_id",
                "service_tier"} & seen.keys()) and seen.get("prompt_cache_key") == "k", str(sorted(seen)))
    check("system items become developer items", seen["input"][0]["role"] == "developer", str(seen.get("input")))
    check("the folded response carries the streamed items", out.output and out.output[0].text == "hi")

    print("test_errors_are_explained")
    said = C.explain("Error code: 429 - {'error': {'code': 'subscription_sharing_usage_limit_exceeded'}}")
    check("usage limit points at ChatGPT usage settings", said and "chatgpt.com/settings/usage" in said, said)
    check("401 says sign in again, not API key", "로그인" in (C.explain("Error code: 401") or ""))
    check("unrelated text is left alone", C.explain("some other failure") is None)

    print("test_plan_scope_missing")
    r = C.start_login("new")
    q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(r["url"]).query).items()}
    check("adding an account registers anew", q.get("client_id") == "dynamic_agent_client")
    token_script.append(Resp(200, {"access_token": access(), "refresh_token": "x1",
                                   "id_token": id_token(q["nonce"], aud="oaiapp_two", sub="sub-2"),
                                   "scope": "openid profile email offline_access"}))
    st = C.complete_login(f"{q['redirect_uri']}?code=abc&state={q['state']}&client_id=oaiapp_two")
    check("signed in without plan permission is not ready", st["signedIn"] and not st["planEnabled"] and not st["loggedIn"],
          str(st)[:200])
    check("both registrations are kept", {a["clientId"] for a in st["accounts"]} == {ISSUED, "oaiapp_two"})
    r = C.start_login("", consent=True)
    q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(r["url"]).query).items()}
    check("re-enabling asks for consent again with the full scopes",
          q.get("prompt") == "consent" and "chatgpt.tokens.use.direct" in q.get("scope", "")
          and q.get("client_id") == "oaiapp_two", str(q)[:200])
    C._stop_listener()

    print("test_dead_refresh_and_logout")
    d = json.loads(C.AUTH_PATH.read_text(encoding="utf-8"))
    d["active"] = ISSUED
    d["accounts"][ISSUED]["access_token"] = access(exp_in=-10)
    C.AUTH_PATH.write_text(json.dumps(d), encoding="utf-8")
    token_script.append(Resp(400, {"error": "refresh_token_reused"}))
    try:
        C.access_token()
        check("a dead refresh token asks for sign-in", False)
    except C.CodexError as e:
        rec4 = json.loads(C.AUTH_PATH.read_text(encoding="utf-8"))["accounts"][ISSUED]
        check("a dead refresh token asks for sign-in, registration kept",
              "다시 로그인" in str(e) and "refresh_token" not in rec4 and rec4["client_id"] == ISSUED, str(e))
    d = json.loads(C.AUTH_PATH.read_text(encoding="utf-8"))
    d["accounts"][ISSUED].update({"access_token": access(), "refresh_token": "r9"})
    C.AUTH_PATH.write_text(json.dumps(d), encoding="utf-8")
    token_script.append(Resp(503, {"detail": "busy"}))
    d["accounts"][ISSUED]["access_token"] = access(exp_in=-10)
    C.AUTH_PATH.write_text(json.dumps(d), encoding="utf-8")
    try:
        C.access_token()
    except C.CodexError:
        pass
    rec5 = json.loads(C.AUTH_PATH.read_text(encoding="utf-8"))["accounts"][ISSUED]
    check("a server failure keeps the credentials", rec5.get("refresh_token") == "r9")
    out = C.logout()
    rv = posts(C.REVOKE_URL)[-1]
    rec6 = json.loads(C.AUTH_PATH.read_text(encoding="utf-8"))["accounts"][ISSUED]
    check("sign-out revokes the refresh token with the issued id",
          rv == {"token": "r9", "token_type_hint": "refresh_token", "client_id": ISSUED} and out["revoked"], str(rv))
    check("tokens cleared, registration and host id kept",
          not ({"access_token", "refresh_token", "id_token"} & rec6.keys()) and rec6["client_id"] == ISSUED
          and C.host_id() == hid, str(sorted(rec6)))

    print("test_legacy_login_is_reported")
    C.AUTH_PATH.write_text(json.dumps({"access_token": "old", "account_id": "acc"}), encoding="utf-8")
    st = C.status()
    check("a Codex CLI record reads as legacy, logged out", st["legacy"] and not st["loggedIn"] and not st["registered"])

print("PASS - Sign in with ChatGPT" if not fails else f"FAIL - {fails} check(s)")
sys.exit(1 if fails else 0)
