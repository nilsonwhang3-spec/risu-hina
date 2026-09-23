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

# --- the dependency the release ships, on an install that did not get it -----------
# An update replaces app/ but stages the interpreter for the launcher to swap in
# (updater.py), so a server started another way runs new code on old packages.
# The first Vertex request repairs that with the bundled pip; when even that
# fails the error has to name the cause and the manual command.
calls: list[list[str]] = []


def fake_pip(pkgs, timeout_s=600):
    calls.append(list(pkgs))
    return {"code": 1, "stdout": "", "stderr": "no network", "seconds": 0.1}


V._repair_tried = False
with patch.object(V, "_import_auth", return_value=None), \
     patch("app.permits.pip_install", side_effect=fake_pip):
    try:
        V._google_auth()
        raise AssertionError("a missing dependency must not pass silently")
    except V.VertexAuthError as e:
        text = str(e)
        assert "google-auth" in text, text
        assert "-m pip install" in text, text
        assert sys.executable in text, text
assert calls and calls[0][0].startswith("google-auth"), calls
assert calls[0][0] == V._pin(), (calls, V._pin())

# One attempt per process: a dead network must not add three minutes to every turn.
with patch.object(V, "_import_auth", return_value=None), \
     patch("app.permits.pip_install", side_effect=fake_pip):
    try:
        V._google_auth()
    except V.VertexAuthError:
        pass
assert len(calls) == 1, calls

# When the install succeeds, the request continues instead of failing.
V._repair_tried = False
imports = iter([None, ("Request", "service_account")])
with patch.object(V, "_import_auth", side_effect=lambda: next(imports)), \
     patch("app.permits.pip_install", return_value={"code": 0, "stdout": "ok", "stderr": ""}):
    assert V._google_auth() == ("Request", "service_account")
V._repair_tried = False

# The pin follows requirements.in, so a repair installs the release's version.
assert V._pin().startswith("google-auth"), V._pin()
assert "python.new" in V._why_missing() or "인터프리터" in V._why_missing() or ".venv" in V._why_missing()
with patch.object(V, "_pkg_dir", return_value=Path(__file__).resolve().parent):
    staged = Path(__file__).resolve().parent / "python.new"
    staged.mkdir(exist_ok=True)
    try:
        assert "python.new" in V._why_missing(), V._why_missing()
    finally:
        staged.rmdir()

print("PASS - Vertex service-account credentials, token renewal and the google-auth repair")
