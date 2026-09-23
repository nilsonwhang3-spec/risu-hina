"""Vertex AI service-account credentials for OpenAI-compatible requests."""
from __future__ import annotations

import hashlib
import importlib
import json
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_lock = threading.Lock()
_cache: dict[str, tuple[str, datetime]] = {}
# Keep in sync with pyserver/requirements.in; the file itself wins when present.
GOOGLE_AUTH_PIN = "google-auth==2.40.3"
_repair_tried = False


class VertexAuthError(ValueError):
    pass


def service_account_info(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as e:
        raise VertexAuthError("Vertex 서비스 계정 JSON 형식이 올바르지 않습니다") from e
    if not isinstance(data, dict):
        raise VertexAuthError("Vertex 서비스 계정 JSON은 객체여야 합니다")
    missing = [k for k in ("project_id", "client_email", "private_key") if not str(data.get(k) or "").strip()]
    if missing:
        raise VertexAuthError("Vertex 서비스 계정 JSON에 필수 항목이 없습니다: " + ", ".join(missing))
    return data


def base_url(project_id: str, region: str = "global") -> str:
    project = project_id.strip()
    location = (region or "global").strip().lower()
    if not project or not location or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in location):
        raise VertexAuthError("Vertex 프로젝트 ID와 리전을 확인해 주세요")
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    return f"https://{host}/v1/projects/{project}/locations/{location}/endpoints/openapi"


def _pkg_dir() -> Path:
    """The install's pyserver/ directory (app/ lives inside it)."""
    return Path(__file__).resolve().parent.parent


def _pin() -> str:
    """The pinned google-auth requirement. requirements.in ships with every
    update, so reading it keeps the repair on the release's own version."""
    try:
        for line in (_pkg_dir() / "requirements.in").read_text(encoding="utf-8").splitlines():
            name = line.strip()
            if name.lower().startswith("google-auth"):
                return name
    except OSError:
        pass
    return GOOGLE_AUTH_PIN


def _import_auth() -> tuple[Any, Any] | None:
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
    except ImportError:
        return None
    return Request, service_account


def _why_missing() -> str:
    """Why a release that ships google-auth can still be running without it.

    The updater replaces app/ in place but cannot replace the interpreter it is
    running on, so it stages the new one as python.new for the launcher to swap
    in on the next start. An install that is started some other way - run.py
    directly, or a .venv from a source checkout - keeps its old site-packages
    and gains the new code without the new dependencies.
    """
    pkg = _pkg_dir()
    if (pkg / "python.new").is_dir():
        return ("새 인터프리터가 python.new 로 대기 중입니다. 백엔드를 런처(start.bat / start.sh)로 "
                "완전히 재시작하면 교체되면서 해결됩니다.")
    if ".venv" in sys.executable.replace("\\", "/").lower():
        return ("소스 설치(.venv)로 실행 중입니다. 그 가상환경에 의존성을 다시 설치해 주세요: "
                "pip install -r pyserver/requirements.in")
    return ("설치본의 인터프리터가 예전 것입니다. 릴리스 패키지를 다시 풀어 설치하면 함께 들어갑니다.")


def _google_auth() -> tuple[Any, Any]:
    """google-auth, installing it once if this interpreter is missing it.

    It is a pinned first-party dependency that every release bundles; when it
    is absent the install updated its code without its interpreter (see
    _why_missing), and the person configuring Vertex has no way to fix that
    from the panel. So the first Vertex request repairs it with the bundled
    pip, the same package the installer would have put there, and says so in
    the log. Only once per process, and only this one package.
    """
    global _repair_tried
    mod = _import_auth()
    if mod:
        return mod
    if not _repair_tried:
        _repair_tried = True
        from . import log, permits
        pin = _pin()
        log.warn("vertex: google-auth missing on %s - installing %s", sys.executable, pin)
        result = permits.pip_install([pin], timeout_s=180)
        if result.get("code") == 0:
            importlib.invalidate_caches()
            mod = _import_auth()
            if mod:
                log.info("vertex: google-auth installed, continuing")
                return mod
        log.warn("vertex: google-auth install failed: %s",
                 (str(result.get("stderr") or result.get("stdout") or "")[-300:]).strip())
    raise VertexAuthError(
        "Vertex JSON 인증에 필요한 google-auth가 설치되지 않았습니다. 자동 설치도 실패했습니다.\n"
        + _why_missing()
        + f"\n수동 설치: \"{sys.executable}\" -m pip install {_pin()}")


def access_token(raw: str) -> str:
    info = service_account_info(raw)
    cache_key = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    with _lock:
        cached = _cache.get(cache_key)
        if cached and cached[1] > now + timedelta(minutes=5):
            return cached[0]
        Request, service_account = _google_auth()
        try:
            credentials = service_account.Credentials.from_service_account_info(info, scopes=[SCOPE])
            credentials.refresh(Request())
        except Exception as e:
            raise VertexAuthError(f"Vertex 액세스 토큰을 발급하지 못했습니다: {e}") from e
        if not credentials.token:
            raise VertexAuthError("Vertex가 빈 액세스 토큰을 반환했습니다")
        expiry = credentials.expiry or (now + timedelta(minutes=50))
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        _cache[cache_key] = (str(credentials.token), expiry)
        return str(credentials.token)
