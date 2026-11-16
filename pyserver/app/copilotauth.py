"""GitHub Copilot as an API key row (provider `github-copilot`), like Vertex.

The key row stores a GitHub token instead of an API key; the endpoint is the
account's Copilot API host. Everything else - presets picking the key, the
connection test, vision, the plan - is the ordinary OpenAI-compatible path:
`keys.runtime` swaps the GitHub token for a short Copilot token per request
(the way it swaps Vertex JSON for an OAuth token) and `providers.auto_headers`
adds the editor headers Copilot requires.

Getting the GitHub token is GitHub's OAuth device flow - the one VS Code and
the Copilot CLI use: the backend asks for a device code, the key form shows
the 8-letter user code (XXXX-XXXX) and github.com/login/device, the user
enters it on any device, and the backend polls until GitHub hands over the
token. No callback port and nothing to paste back, so it works when the
backend runs on another machine than the browser. The token never reaches
the panel: saving the key form sends `copilot-device:<state>` and keys.save
claims the token here.

The client id is the public one of GitHub's own Copilot editor integration,
which other open-source Copilot clients use too. Using Copilot outside
GitHub's editors is the user's call; the key form says so.
"""
from __future__ import annotations

import hashlib
import threading
import time
from typing import Any

from . import log

CLIENT_ID = "Iv1.b507a08c87ecfe98"
SCOPE = "read:user"
DEVICE_CODE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
VERIFY_URL = "https://github.com/login/device"
COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
USER_URL = "https://api.github.com/user"
DEFAULT_API = "https://api.githubcopilot.com"
HOST = "githubcopilot.com"
CLAIM_PREFIX = "copilot-device:"
REFRESH_MARGIN_S = 5 * 60

# What Copilot's API checks before it answers: an editor identity. Without
# Copilot-Integration-Id / Editor-Version it refuses the request.
EDITOR_HEADERS = {
    "Editor-Version": "vscode/1.99.3",
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "Copilot-Integration-Id": "vscode-chat",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "Openai-Intent": "conversation-panel",
}


class CopilotError(ValueError):
    pass


_lock = threading.RLock()
_pending: dict[str, dict] = {}     # state -> attempt
_sessions: dict[str, dict] = {}    # sha256(github token) -> {"token", "expires_at", "api"}


def is_copilot(base_url: str) -> bool:
    return HOST in (base_url or "").lower()


def is_github_token(key: str) -> bool:
    return (key or "").strip().startswith(("gho_", "ghu_", "github_pat_", "ghp_"))


def _ua() -> dict:
    from . import config
    return {"User-Agent": f"{config.APP_NAME}/{config.VERSION}", "Accept": "application/json"}


# --- device flow -------------------------------------------------------------------

def start_login() -> dict:
    """Ask GitHub for a device code; a background thread polls for the token."""
    import httpx
    try:
        r = httpx.post(DEVICE_CODE_URL, data={"client_id": CLIENT_ID, "scope": SCOPE}, headers=_ua(), timeout=20)
    except Exception as e:  # noqa: BLE001
        raise CopilotError(f"GitHub 에 연결하지 못했습니다: {type(e).__name__}: {e}")
    if r.status_code != 200:
        raise CopilotError(f"GitHub 기기 코드 요청 거부 ({r.status_code}): {r.text[:300]}")
    body = r.json()
    device = str(body.get("device_code") or "")
    if not device:
        raise CopilotError(f"GitHub 기기 코드 응답이 올바르지 않습니다: {str(body)[:300]}")
    expires = int(body.get("expires_in") or 900)
    state = hashlib.sha256(device.encode()).hexdigest()[:24]
    attempt = {
        "device_code": device,
        "user_code": str(body.get("user_code") or ""),
        "uri": str(body.get("verification_uri") or VERIFY_URL),
        "interval": max(5, int(body.get("interval") or 5)),
        "deadline": time.time() + expires,
        "token": "", "login": "", "api": "", "error": "", "cancelled": False,
    }
    with _lock:
        # Drop finished or abandoned attempts; a claimed token is gone already.
        for k in [k for k, p in _pending.items() if time.time() > p["deadline"] + 600]:
            _pending.pop(k, None)
        _pending[state] = attempt
    threading.Thread(target=_poll, args=(attempt,), daemon=True, name="copilot-device").start()
    log.info("copilot: device code issued (expires in %ss)", expires)
    return {"state": state, "userCode": attempt["user_code"], "verificationUri": attempt["uri"],
            "expiresIn": expires, "interval": attempt["interval"]}


def _poll(attempt: dict) -> None:
    import httpx
    while not attempt["cancelled"] and time.time() < attempt["deadline"]:
        time.sleep(attempt["interval"])
        try:
            r = httpx.post(TOKEN_URL, headers=_ua(), timeout=20, data={
                "client_id": CLIENT_ID, "device_code": attempt["device_code"],
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
            body = r.json() if r.content else {}
        except Exception as e:  # noqa: BLE001 - a blip; keep polling
            log.warn("copilot: device poll failed: %s", e)
            continue
        err = str(body.get("error") or "")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            attempt["interval"] = int(body.get("interval") or attempt["interval"] + 5)
            continue
        if err:
            attempt["error"] = {
                "expired_token": "코드가 만료됐습니다. 로그인을 다시 시작해 주세요.",
                "access_denied": "GitHub 에서 승인을 거절했습니다.",
            }.get(err, f"GitHub 로그인 실패: {err} {body.get('error_description') or ''}".strip())
            return
        token = str(body.get("access_token") or "")
        if not token:
            continue
        # Prove the account has Copilot now, not on the first chat.
        try:
            sess = _exchange(token)
        except CopilotError as e:
            attempt["error"] = str(e)
            return
        login = ""
        try:
            u = httpx.get(USER_URL, headers={**_ua(), "Authorization": f"token {token}"}, timeout=15)
            if u.status_code == 200:
                login = str(u.json().get("login") or "")
        except Exception:  # noqa: BLE001 - the name is cosmetic
            pass
        attempt.update(token=token, login=login, api=sess["api"])
        log.info("copilot: device login done (%s)", login or "?")
        return
    if not attempt["cancelled"] and not attempt["token"]:
        attempt["error"] = "코드가 만료됐습니다. 로그인을 다시 시작해 주세요."


def login_status(state: str) -> dict:
    with _lock:
        att = _pending.get(state)
    if att is None:
        return {"known": False, "done": False, "error": "로그인 시도를 찾을 수 없습니다 (만료되었거나 백엔드가 재시작됨). 다시 시작해 주세요."}
    return {"known": True, "done": bool(att["token"]), "error": att["error"], "login": att["login"], "api": att["api"]}


def claim(state: str) -> tuple[str, str, str]:
    """(github_token, api_base, login) of a finished device login, once."""
    with _lock:
        att = _pending.get(state)
        if att is None or not att["token"]:
            raise CopilotError("GitHub 로그인이 아직 끝나지 않았습니다. 코드를 입력하고 승인한 뒤 저장해 주세요.")
        _pending.pop(state, None)
    return att["token"], att["api"] or DEFAULT_API, att["login"]


# --- the short Copilot token ----------------------------------------------------------

def _exchange(github_token: str) -> dict:
    import httpx
    try:
        r = httpx.get(COPILOT_TOKEN_URL, timeout=20, headers={
            **EDITOR_HEADERS, "Accept": "application/json", "Authorization": f"token {github_token}"})
    except Exception as e:  # noqa: BLE001
        raise CopilotError(f"Copilot 토큰 교환 실패 (네트워크): {type(e).__name__}: {e}")
    if r.status_code in (401, 403, 404):
        raise CopilotError(
            "이 GitHub 계정으로 Copilot 을 쓸 수 없습니다 (구독이 없거나, 조직 정책이 막았거나, 토큰이 해지됐습니다). "
            f"키를 수정해 GitHub 로그인을 다시 해 주세요. ({r.status_code}) {r.text[:200]}")
    if r.status_code != 200:
        raise CopilotError(f"Copilot 토큰 교환 거부 ({r.status_code}): {r.text[:300]}")
    body = r.json()
    token = str(body.get("token") or "")
    if not token:
        raise CopilotError(f"Copilot 토큰 응답이 올바르지 않습니다: {str(body)[:200]}")
    api = str(((body.get("endpoints") or {}).get("api")) or DEFAULT_API).rstrip("/")
    sess = {"token": token, "expires_at": float(body.get("expires_at") or time.time() + 1500), "api": api}
    with _lock:
        _sessions[hashlib.sha256(github_token.encode()).hexdigest()] = sess
    return sess


def access_token(github_token: str) -> str:
    """A Copilot bearer good for at least REFRESH_MARGIN_S more seconds."""
    k = hashlib.sha256(github_token.encode()).hexdigest()
    with _lock:
        s = _sessions.get(k)
        if s and time.time() < s["expires_at"] - REFRESH_MARGIN_S:
            return s["token"]
    return _exchange(github_token)["token"]


USER_URL_COPILOT = "https://api.github.com/copilot_internal/user"
USAGE_TTL_S = 60
_usage: dict[str, tuple[float, dict]] = {}


def usage(github_token: str, force: bool = False) -> dict:
    """The account's Copilot quotas, as GitHub's editors show them: chat,
    completions and premium requests (remaining / entitlement), the plan
    and the reset date. Cached a minute - the panel asks after every turn."""
    k = hashlib.sha256(github_token.encode()).hexdigest()
    with _lock:
        hit = _usage.get(k)
        if hit and not force and time.time() - hit[0] < USAGE_TTL_S:
            return hit[1]
    import httpx
    try:
        r = httpx.get(USER_URL_COPILOT, timeout=15,
                      headers={**EDITOR_HEADERS, "Accept": "application/json", "Authorization": f"token {github_token}"})
    except Exception as e:  # noqa: BLE001
        raise CopilotError(f"Copilot 사용량을 가져오지 못했습니다: {type(e).__name__}: {e}")
    if r.status_code != 200:
        raise CopilotError(f"Copilot 사용량 요청 거부 ({r.status_code}): {r.text[:200]}")
    b = r.json()
    quotas = {}
    for name, q in (b.get("quota_snapshots") or {}).items():
        if not isinstance(q, dict):
            continue
        quotas[name] = {"remaining": q.get("remaining"), "entitlement": q.get("entitlement"),
                        "unlimited": bool(q.get("unlimited")), "percentRemaining": q.get("percent_remaining"),
                        "overage": q.get("overage_count") or 0}
    out = {"plan": str(b.get("access_type_sku") or b.get("copilot_plan") or ""),
           "resetDate": str(b.get("quota_reset_date") or ""), "quotas": quotas,
           "usageUrl": "https://github.com/settings/copilot/features"}
    with _lock:
        _usage[k] = (time.time(), out)
    return out


def initiator(messages: Any) -> str:
    """Copilot bills a premium request per user-initiated call; the agent's
    tool rounds that follow are marked as the agent's, as editors do."""
    if not isinstance(messages, list) or not messages:
        return "user"
    last = messages[-1]
    role = last.get("role") if isinstance(last, dict) else getattr(last, "role", None)
    return "user" if role == "user" else "agent"
