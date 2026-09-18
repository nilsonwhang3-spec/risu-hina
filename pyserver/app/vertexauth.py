"""Vertex AI service-account credentials for OpenAI-compatible requests."""
from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_lock = threading.Lock()
_cache: dict[str, tuple[str, datetime]] = {}


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


def access_token(raw: str) -> str:
    info = service_account_info(raw)
    cache_key = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    with _lock:
        cached = _cache.get(cache_key)
        if cached and cached[1] > now + timedelta(minutes=5):
            return cached[0]
        try:
            from google.auth.transport.requests import Request
            from google.oauth2 import service_account
        except ImportError as e:
            raise VertexAuthError("Vertex JSON 인증에 필요한 google-auth가 설치되지 않았습니다") from e
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
