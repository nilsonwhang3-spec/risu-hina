"""Vertex service-account parsing and endpoint construction (no network)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

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
print("PASS - Vertex service-account credentials")
