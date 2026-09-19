"""Vertex service-account parsing and endpoint construction (no network)."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))
from app import vertexauth as V  # noqa: E402

info = {"type": "service_account", "project_id": "my-project-123",
        "client_email": "hina@my-project-123.iam.gserviceaccount.com",
        "private_key": "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n"}
assert V.service_account_info(json.dumps(info))["project_id"] == "my-project-123"
assert V.base_url("my-project-123") == (
    "https://aiplatform.googleapis.com/v1/projects/my-project-123/locations/global/endpoints/openapi")
assert V.base_url("my-project-123", "asia-northeast3") == (
    "https://asia-northeast3-aiplatform.googleapis.com/v1/projects/my-project-123/locations/asia-northeast3/endpoints/openapi")
for bad in ("", "[]", '{"project_id":"p"}'):
    try:
        V.service_account_info(bad)
        raise AssertionError("invalid credentials accepted")
    except V.VertexAuthError:
        pass
# Simulate more than an hour of requests without credentials or network traffic.
raw = json.dumps(info)
clock = datetime(2026, 9, 19, tzinfo=timezone.utc)
issued = []

class Clock:
    @staticmethod
    def now(tz):
        return clock

class Credentials:
    token = None
    expiry = None

    def refresh(self, request):
        self.token = f"test-token-{len(issued) + 1}"
        self.expiry = clock + timedelta(hours=1)
        issued.append(self.token)

V._cache.clear()
with patch.object(V, "datetime", Clock), patch(
    "google.oauth2.service_account.Credentials.from_service_account_info",
    side_effect=lambda *args, **kwargs: Credentials(),
), patch("google.auth.transport.requests.Request", return_value=SimpleNamespace()):
    assert V.access_token(raw) == "test-token-1"
    clock += timedelta(minutes=30)
    assert V.access_token(raw) == "test-token-1"
    assert len(issued) == 1, "valid cached token should be reused"
    clock += timedelta(minutes=26)
    assert V.access_token(raw) == "test-token-2", "renew before expiry"
    clock += timedelta(minutes=70)
    assert V.access_token(raw) == "test-token-3", "renew after an idle expiry"
V._cache.clear()
print("PASS - Vertex service-account credentials and automatic token renewal")
