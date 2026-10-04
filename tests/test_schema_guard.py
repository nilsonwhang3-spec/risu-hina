"""A database from a NEWER backend is refused, not migrated down (§1-91).

An older backend opening a newer data dir (a rolled-back Docker image, an old
release unpacked over new data) used to run its migrations and stamp its own,
lower schema number into `meta` - and the next upgrade would replay one-time
migrations on data that already had them. Now the server comes up only to say
why: /health answers with ok=false and the reason, every other route is 503,
and the database is left exactly as it was.

    python tests/test_schema_guard.py
"""
from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYSERVER = ROOT / "pyserver"
sys.path.insert(0, str(PYSERVER))
from app import db  # noqa: E402

TOKEN = "schema-guard-token"
failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else f" - {detail}"))
    if not cond:
        failures.append(name)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def call(port: int, method: str, path: str) -> tuple[int, dict]:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                 data=b"{}" if method == "POST" else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def serve(data: Path, extra_env: dict[str, str] | None = None) -> tuple[subprocess.Popen, int]:
    port = free_port()
    py = os.environ.get("RISUHINA_TEST_PY") or str(PYSERVER / ".venv" / "Scripts" / "python.exe")
    env = {**os.environ, "RISUHINA_PORT": str(port), "RISUHINA_HOST": "127.0.0.1",
           "RISUHINA_DATA_DIR": str(data), "RISUHINA_TOKEN": TOKEN, "RISUHINA_REQUIRE_TOKEN": "1",
           "PYTHONIOENCODING": "utf-8", **(extra_env or {})}
    env.pop("RISUHINA_DISABLE_SELF_UPDATE", None) if not extra_env else None
    # To a file, not a pipe: an unread pipe fills on a first boot's log and
    # the server blocks writing to it.
    log = open(data.parent / (data.name + f"-{port}.log"), "wb")
    proc = subprocess.Popen([py, str(PYSERVER / "run.py")], cwd=str(PYSERVER), env=env,
                            stdout=log, stderr=subprocess.STDOUT)
    deadline = time.time() + 150   # a fresh data dir seeds skills and studio defaults first
    while time.time() < deadline:
        try:
            status, body = call(port, "POST", "/health")
            if body.get("service") == "risu-hina":
                return proc, port
        except OSError:
            pass
        time.sleep(0.3)
    proc.kill()
    raise SystemExit("server did not come up - see " + log.name)


def stop(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


def stored_schema(path: Path) -> int:
    conn = sqlite3.connect(str(path))
    try:
        return int(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0])
    finally:
        conn.close()


def main() -> int:
    newer = db.SCHEMA_VERSION + 5
    with tempfile.TemporaryDirectory(prefix="risuhina-schema-", ignore_cleanup_errors=True) as tmp:
        data = Path(tmp)
        dbfile = data / "risuhina.db"
        conn = sqlite3.connect(str(dbfile))
        conn.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO meta VALUES('schema_version', ?)", (str(newer),))
        conn.commit()
        conn.close()

        print("test_newer_database_is_refused")
        proc, port = serve(data)
        try:
            status, health = call(port, "POST", "/health")
            check("/health still answers with the signature", status == 200 and health.get("service") == "risu-hina")
            check("and says it is not ok, with the reason",
                  health.get("ok") is False and str(newer) in str(health.get("error")), json.dumps(health, ensure_ascii=False)[:200])
            status, body = call(port, "GET", "/config")
            check("other routes refuse with 503 and the same reason",
                  status == 503 and str(newer) in str(body.get("error")), f"{status} {body}")
            status, _ = call(port, "GET", "/workspace")
            check("including the ones that would touch the database", status == 503, str(status))
        finally:
            stop(proc)
        check("the database's schema number is left as it was", stored_schema(dbfile) == newer, str(stored_schema(dbfile)))

    print("test_normal_database_and_install_kind")
    with tempfile.TemporaryDirectory(prefix="risuhina-schema-", ignore_cleanup_errors=True) as tmp:
        proc, port = serve(Path(tmp))
        try:
            status, health = call(port, "POST", "/health")
            check("a fresh data dir is fine", health.get("ok") is True and not health.get("error"))
            check("a standard install says so", health.get("installKind") == "standard", str(health.get("installKind")))
            check("and works", call(port, "GET", "/config")[0] == 200)
        finally:
            stop(proc)
        check("its schema is this backend's", stored_schema(Path(tmp) / "risuhina.db") == db.SCHEMA_VERSION)
        proc, port = serve(Path(tmp), {"RISUHINA_DISABLE_SELF_UPDATE": "1"})
        try:
            check("an image-managed install says docker", call(port, "POST", "/health")[1].get("installKind") == "docker")
        finally:
            stop(proc)

    print("\n" + ("PASS - a newer database is refused and left alone" if not failures else f"FAIL - {len(failures)} check(s)"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
