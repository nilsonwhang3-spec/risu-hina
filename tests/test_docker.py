"""Black-box smoke test of an already built Docker image; no model credentials.

    docker build --platform linux/amd64 -t risu-hina:test .
    python tests/test_docker.py --image risu-hina:test

Creates its own random container and volume, and removes only those resources.
A local Docker daemon and Python 3.10+ are required. No third-party test packages.
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def docker(*args: str) -> str:
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError(f"docker {args[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def request(base: str, path: str, token: str = "", payload: dict | None = None) -> tuple[int, object]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers)
    try:
        response = HTTP.open(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        body = json.loads(raw) if "application/json" in response.headers.get("Content-Type", "") else raw
        return response.status, body


def start(image: str, name: str, volume: str) -> str:
    docker("run", "--detach", "--name", name, "--init", "--read-only", "--tmpfs", "/tmp",
           "--publish", "127.0.0.1::6020", "--mount", f"type=volume,source={volume},target=/data", image)
    port = json.loads(docker("inspect", "--format", '{{json .NetworkSettings.Ports}}', name))["6020/tcp"][0]["HostPort"]
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 75
    while time.monotonic() < deadline:
        state = json.loads(docker("inspect", "--format", "{{json .State}}", name))
        require(state["Running"], "container exited before becoming healthy")
        if state.get("Health", {}).get("Status") == "healthy":
            status, health = request(base, "/health")
            require(status == 200 and health.get("service") == "risu-hina" and health.get("ok"), "health response")
            require(health.get("tokenRequired") is True, "bridge requests must require a token")
            return base
        time.sleep(1)
    raise AssertionError("container did not become healthy within 75 seconds")


def stop(name: str, image: str, volume: str) -> None:
    started = time.monotonic()
    docker("stop", "--time", "20", name)
    elapsed = time.monotonic() - started
    require(elapsed < 18, "server should stop before the forced-kill timeout")
    # Uvicorn 0.34 re-raises SIGTERM after graceful shutdown (exit 128 + 15).
    exit_code = docker("inspect", "--format", "{{.State.ExitCode}}", name)
    require(exit_code in ("0", "143"), f"server should stop on SIGTERM without SIGKILL (exit {exit_code})")
    # The application's shutdown hook checkpoints SQLite before closing it.
    docker("run", "--rm", "--read-only", "--entrypoint", "python", "--mount",
           f"type=volume,source={volume},target=/data", image, "-c",
           'from pathlib import Path; wal = Path("/data/risuhina.db-wal"); '
           'assert not wal.exists() or wal.stat().st_size == 0, "uncheckpointed WAL after stop"')
    print(f"ok: SIGTERM exit={exit_code} in {elapsed:.2f}s; SQLite WAL checkpoint complete")
    docker("rm", name)


def run(image: str) -> None:
    name = "risuhina-smoke-" + uuid.uuid4().hex[:12]
    volume = name + "-data"
    docker("volume", "create", "--label", "risu-hina.test=smoke", volume)
    try:
        base = start(image, name, volume)
        token = docker("exec", name, "cat", "/data/token.txt")
        require(bool(token), "first startup should generate a token")
        require(docker("exec", name, "id", "-u") == "10001", "server must run as non-root")
        require(request(base, "/config")[0] == 401, "missing token must be refused")
        require(request(base, "/config", "incorrect-token")[0] == 401, "wrong token must be refused")
        status, _ = request(base, "/config", token)
        require(status == 200, "authenticated configuration read")
        print("ok: healthy non-root startup and authenticated API")

        status, plugin = request(base, "/plugin.js")
        require(status == 200 and b"//@name risu-hina" in plugin[:512], "plugin bundle is served without authentication")
        status, info = request(base, "/plugin", token)
        _, health = request(base, "/health")
        require(status == 200 and info.get("available"), "plugin metadata is available")
        require(info["version"].split(".")[:2] == health["version"].split(".")[:2], "plugin and backend major.minor must match")
        status, skills = request(base, "/skills", token)
        require(status == 200 and skills.get("skills"), "bundled skill assets should be available")
        print("ok: plugin bundle, version compatibility, and bundled skills")

        status, settings = request(base, "/config", token, {"config": {"python": {"timeoutSeconds": 45}}})
        require(status == 200 and settings["config"]["python"]["timeoutSeconds"] == 45, "persist settings")
        status, body = request(base, "/workspace", token, {
            "charId": "docker-smoke", "card": {"name": "Docker smoke", "chaId": "docker-smoke"},
            "chats": [{"chatIndex": 0, "chat": {"id": "smoke-chat", "name": "Smoke", "message": [
                {"chatId": "smoke-message", "role": "char", "data": "original"},
            ]}}],
        })
        require(status == 200, "create workspace")
        chat_key = body["workspace"]["chats"][0]["chatKey"]
        status, _ = request(base, "/turn", token, {"chatKey": chat_key, "msgId": "smoke-message", "before": "original", "after": "persisted"})
        require(status == 200, "edit a persisted chat turn")
        status, uploaded = request(base, "/assets/upload", token, {"items": [
            {"key": "assets/docker-smoke.png", "data": base64.b64encode(PNG).decode()},
        ]})
        require(status == 200 and uploaded.get("stored") == 1, "store an image asset")

        # The release is still looked up (a Docker backend must hear about a
        # newer one); only the install is refused. Offline, the check reports
        # its network error instead - either way nothing is installed.
        status, result = request(base, "/update/check", token, {})
        require(status == 200, "update check answers")
        if result.get("ok"):
            require(result.get("installable") is False and "Docker" in (result.get("reason") or ""),
                    "the check says why it cannot install and how to update the image")
        status, result = request(base, "/update/apply", token, {})
        require((status == 400 and ("Docker" in result.get("error", "") or not result.get("updated")))
                or (status == 200 and result.get("updated") is False),
                f"self-update must never install in the image ({status} {result})")
        _, health = request(base, "/health")
        require(health.get("installKind") == "docker", "health names the image-managed install")
        require(request(base, "/health")[0] == 200, "refusing self-update should leave the server running")
        print("ok: image-managed update refusal (read-only root filesystem)")

        stop(name, image, volume)
        base = start(image, name, volume)
        require(docker("exec", name, "cat", "/data/token.txt") == token, "token must survive container replacement")
        status, settings = request(base, "/config", token)
        require(status == 200 and settings["config"]["python"]["timeoutSeconds"] == 45, "settings must survive container replacement")
        status, turns = request(base, "/turns?" + urllib.parse.urlencode({"chatKey": chat_key}), token)
        require(status == 200 and turns["turns"][0]["body"] == "persisted", "edited chat must survive container replacement")
        status, asset = request(base, "/assets/blob?key=assets/docker-smoke.png", token)
        require(status == 200 and asset == PNG, "image bytes must survive container replacement")
        stop(name, image, volume)
        print("ok: clean shutdown and recreated-container token/settings/chat/asset persistence")
    finally:
        # Names are unique to this invocation. Never prune unrelated Docker resources.
        existing = docker("container", "ls", "--all", "--quiet", "--filter", f"name=^/{name}$")
        if existing:
            docker("rm", "--force", name)
        docker("volume", "rm", volume)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="risu-hina:test", help="already built image to exercise")
    run(parser.parse_args().image)
