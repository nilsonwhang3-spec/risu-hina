"""The MCP add-on, black-box: install, the /mcp route, the panel bridge.

The server is a child process and MCP is spoken as raw JSON-RPC over HTTP -
the same bytes Claude Code sends - so nothing here imports the backend or the
`mcp` package.

The add-on install is real (pip, network) the first time and then cached in
`.cache/mcp-addon/<python tag>/`; later runs seed that copy into the test data
dir, which exercises the load-at-startup path instead. Delete the cache to
re-test the installer.

    python tests/test_mcp.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_http as th  # noqa: E402
from test_http import check, make_chat, payload, q  # noqa: E402

ROOT = th.ROOT
FAILURES = th.FAILURES


def py_tag(server_py: str) -> str:
    out = subprocess.run([server_py, "-c", "import sys;print(f'py{sys.version_info.major}{sys.version_info.minor}')"],
                         capture_output=True, text=True)
    return out.stdout.strip()


def server_python() -> str:
    import os
    py = os.environ.get("RISUHINA_TEST_PY") or str(th.PYSERVER / ".venv" / "Scripts" / "python.exe")
    return py if Path(py).exists() else sys.executable


class Mcp:
    """A minimal Streamable HTTP client: POST JSON-RPC, read JSON or SSE."""

    def __init__(self, port: int, token: str) -> None:
        self.url = f"http://127.0.0.1:{port}/mcp"
        self.token = token
        self.pv = ""
        self.n = 0

    def raw(self, body: dict, token: str | None = "__default__") -> tuple[int, dict | None, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        tok = self.token if token == "__default__" else token
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
        if self.pv:
            headers["MCP-Protocol-Version"] = self.pv
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                ctype = r.headers.get("content-type", "")
                text = r.read().decode("utf-8", "replace")
                status = r.status
        except urllib.error.HTTPError as e:
            return e.code, None, e.read().decode("utf-8", "replace")
        if "text/event-stream" in ctype:
            for line in text.splitlines():
                if line.startswith("data:"):
                    try:
                        msg = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if msg.get("id") == body.get("id"):
                        return status, msg, text
            return status, None, text
        try:
            return status, json.loads(text) if text.strip() else None, text
        except ValueError:
            return status, None, text

    def call(self, method: str, params: dict | None = None) -> dict:
        self.n += 1
        st, msg, text = self.raw({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}})
        assert st == 200 and msg is not None, f"{method}: {st} {text[:300]}"
        return msg

    def notify(self, method: str) -> int:
        st, _, _ = self.raw({"jsonrpc": "2.0", "method": method})
        return st

    def tool(self, name: str, args: dict | None = None) -> tuple[bool, str]:
        msg = self.call("tools/call", {"name": name, "arguments": args or {}})
        res = msg.get("result") or {}
        text = "\n".join(c.get("text", "") for c in res.get("content") or [] if c.get("type") == "text")
        return bool(res.get("isError")), text or json.dumps(msg)[:400]


def ensure_addon(s: th.Server, cache: Path) -> bool:
    st, body = s.get("/mcp/status")
    check("status route", st == 200 and "addon" in body, f"{st} {str(body)[:200]}")
    addon = body.get("addon") or {}
    if addon.get("installed"):
        check("cached add-on loads at startup", addon.get("loaded") is True, str(addon)[:300])
        return bool(addon.get("loaded"))
    print("  (installing the add-on for real - pip, network, ~1 min)")
    st, body = s.post("/mcp/install")
    check("install starts", st == 200 and body.get("started") is True, f"{st} {body}")
    deadline = time.time() + 900
    addon = {}
    while time.time() < deadline:
        time.sleep(2)
        _, body = s.get("/mcp/status")
        addon = body.get("addon") or {}
        if not (addon.get("job") or {}).get("running"):
            break
    job = addon.get("job") or {}
    check("install finishes ok", job.get("ok") is True, (job.get("error") or "") + "\n" + (job.get("output") or "")[-1500:])
    check("installed version is the pinned one", addon.get("version") == addon.get("wanted"), str(addon)[:200])
    check("loaded without a restart", addon.get("loaded") is True, str(addon)[:300])
    target = Path(addon.get("path") or "")
    # The bundle's own packages must not be duplicated into the target.
    check("shadowed duplicates pruned", not (target / "starlette").exists() and not (target / "pydantic").exists(),
          str([p.name for p in target.iterdir()][:40]) if target.is_dir() else "no target")
    if job.get("ok") and target.is_dir():
        shutil.rmtree(cache, ignore_errors=True)
        cache.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(target, cache)
    return bool(addon.get("loaded"))


def main() -> int:
    tag = py_tag(server_python())
    cache = ROOT / ".cache" / "mcp-addon" / tag
    s = th.Server()
    if cache.is_dir():
        dest = s.data / "addons" / "mcp" / tag
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(cache, dest)
    try:
        if not s.wait_ready():
            print("server failed to start:")
            print(s.drain()[:4000])
            return 1
        print("test_mcp_addon")
        _, h = s.get("/health")
        if not ensure_addon(s, cache):
            print(s.drain()[-4000:])
            return 1
        _, h = s.get("/health")
        check("health says mounted", (h.get("mcp") or {}).get("mounted") is True, str(h.get("mcp")))

        print("test_mcp_auth")
        st, tok = s.post("/mcp/token")
        token = tok.get("token") or ""
        check("token issued", st == 200 and token.startswith("hmcp_"), f"{st} {tok}")
        init = {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "test-client", "version": "0"}}}
        m = Mcp(s.port, token)
        st, _, _ = m.raw(init, token=None)
        check("no token -> 401 (even on loopback)", st == 401, str(st))
        st, _, _ = m.raw(init, token=s.token)
        check("backend token is not the MCP token", st == 401, str(st))
        st, _ = s.get("/mcp/status", token=None)
        check("REST side keeps the backend token", st == 401, str(st))

        print("test_mcp_protocol")
        r = m.call("initialize", init["params"])
        res = r.get("result") or {}
        m.pv = res.get("protocolVersion") or ""
        check("initialize answers", bool(m.pv) and (res.get("serverInfo") or {}).get("name") == "risu-hina", str(r)[:300])
        check("instructions sent", "MCP 연결" in (res.get("instructions") or ""), "")
        m.notify("notifications/initialized")
        r = m.call("tools/list")
        names = {t["name"] for t in (r.get("result") or {}).get("tools") or []}
        check("agent tools listed", {"read_card", "list_turns", "propose_lore_add", "run_python"} <= names,
              str(sorted(names))[:300])
        check("own tools listed", {"hina_status", "hina_guide", "approve_proposals", "approve_staged"} <= names, "")
        check("panel-only tools left out", not ({"run_shell", "pip_install", "propose_open_tab", "update_plan"} & names),
              str(sorted(names & {"run_shell", "pip_install", "propose_open_tab", "update_plan"})))
        schema = next(t for t in r["result"]["tools"] if t["name"] == "propose_lore_add").get("inputSchema") or {}
        check("input schema carried", "comment" in (schema.get("properties") or {}), str(schema)[:200])

        err, text = m.tool("list_turns")
        check("refused while the panel switch is off", err and "MCP 연결" in text, text[:200])
        err, text = m.tool("hina_status")
        check("hina_status works without the panel", not err and "비활성" in text, text[:200])
        err, text = m.tool("hina_guide")
        check("hina_guide needs the panel switch", err and "MCP 연결" in text, text[:200])

        print("test_mcp_bridge")
        st, body = s.post("/workspace", payload([make_chat("mcpA", "MCP 챗", 6)]))
        ws = body.get("workspace") or {}
        ck, tk = ws.get("charKey"), (ws.get("chats") or [{}])[0].get("chatKey")
        ctx = {"charKey": ck, "chatKey": tk, "botName": "테스트 봇", "chatName": "MCP 챗", "mode": "bot"}
        st, body = s.post("/mcp/bridge/activate", {"context": ctx})
        check("activate", st == 200 and body.get("active") is True, f"{st} {str(body)[:200]}")

        err, text = m.tool("hina_status")
        check("status names the open chat", not err and tk in text and "활성" in text, text[:300])
        err, text = m.tool("list_turns", {"start": 0, "count": 3})
        check("list_turns reads the open chat", not err and "턴 0" in text, text[:300])
        err, text = m.tool("read_card")
        check("read_card reads the working copy", not err and "테스트 봇" in text, text[:300])
        err, text = m.tool("list_turns", {"start": "x"})
        check("bad arguments come back as a tool error", err and "인자" in text, text[:200])

        err, text = m.tool("propose_lore_add", {"comment": "MCP 항목", "keys": "mcp", "content": "### MCP\n- 내용",
                                                "reason": "테스트", "scope": "global"})
        check("proposal accepted as a proposal", not err, text[:300])
        st, body = s.get(q("/actions", charKey=ck))
        acts = body.get("actions") or []
        check("proposal waits in the panel's queue", any("MCP 항목" in (a.get("summary") or "") for a in acts),
              str(acts)[:300])

        # The panel hears about it through its long poll (no turn stream).
        t0 = time.time()
        st, body = s.post("/mcp/bridge/poll", {"context": {**ctx, "pendingRev": "stale"}})
        check("poll reports pending proposals", st == 200 and (body.get("pending") or {}).get("actions", 0) >= 1,
              f"{st} {str(body)[:200]}")
        check("poll returns early on a changed rev", time.time() - t0 < 10, f"{time.time() - t0:.1f}s")

        st, body = s.get(q("/sessions", chatKey=tk))
        check("the MCP session is not a panel conversation",
              st == 200 and all(x.get("title") != "__mcp__" for x in body.get("sessions") or []), str(body)[:200])

        # A requested card save rides the long poll to the panel and waits
        # for its report, like the in-panel agent's save.
        out: dict = {}

        def save() -> None:
            out["r"] = m.tool("write_card_to_risu", {"reason": "사용자 요청"})

        th_save = threading.Thread(target=save)
        th_save.start()
        st, body = s.post("/mcp/bridge/poll", {"context": ctx})
        jobs = body.get("jobs") or []
        check("card save handed to the panel", st == 200 and jobs and jobs[0].get("type") == "card-writeback"
              and jobs[0].get("charKey") == ck, str(body)[:300])
        if jobs:
            st, _ = s.post("/actions/decide", {"chatKey": tk, "id": jobs[0]["id"], "approve": True})
            st, body = s.post("/actions/complete", {"chatKey": tk, "id": jobs[0]["id"], "ok": True, "detail": "테스트 반영"})
        th_save.join(timeout=60)
        err, text = out.get("r") or (True, "no result")
        check("the tool sees the panel's result", not err and "done" in text, text[:300])

        print("test_mcp_approvals")
        # Rejecting from the client: the proposal is closed, not applied.
        _, body = s.get(q("/actions", charKey=ck))
        gid = next((a["id"] for a in body.get("actions") or [] if "MCP 항목" in (a.get("summary") or "")), "")
        err, text = m.tool("approve_proposals", {"ids": gid, "approve": False})
        check("reject by id", not err and "거절" in text and gid in text, text[:300])
        _, body = s.get(q("/actions", charKey=ck))
        check("rejected proposal left the queue", not any(a["id"] == gid for a in body.get("actions") or []),
              str(body)[:200])

        # Approving from the client applies to the working copy.
        m.tool("propose_lore_add", {"comment": "MCP 챗 항목", "keys": "mcpc", "content": "### C\n- 챗 로어",
                                    "reason": "테스트", "scope": "local"})
        err, text = m.tool("approve_proposals")
        check("approve all applies", not err and "적용" in text, text[:300])
        _, body = s.get(q("/lore", charKey=ck, chatKey=tk))
        check("the lorebook entry is in the working copy", "MCP 챗 항목" in json.dumps(body, ensure_ascii=False),
              str(body)[:300])

        err, text = m.tool("stage_edit", {"msg_id": "mcpA-m1", "new_body": "턴 1: MCP 가 고친 턴.", "reason": "테스트"})
        check("turn edit staged", not err, text[:200])
        err, text = m.tool("approve_staged")
        check("approve_staged applies", not err and "1건을 작업본에 적용" in text, text[:300])
        _, body = s.get(q("/turns", chatKey=tk))
        t1 = next((t for t in body.get("turns") or [] if t.get("msgId") == "mcpA-m1"), {})
        check("the turn changed in the working copy", t1.get("body") == "턴 1: MCP 가 고친 턴." and t1.get("changed"),
              str(t1)[:200])

        # 반영 is a host action: the panel carries it out via the long poll.
        err, text = m.tool("propose_writeback", {"reason": "테스트 반영"})
        check("writeback proposed", not err, text[:200])
        res: dict = {}
        th_ap = threading.Thread(target=lambda: res.update(r=m.tool("approve_proposals")))
        th_ap.start()
        st, body = s.post("/mcp/bridge/poll", {"context": ctx})
        jobs = body.get("jobs") or []
        job = jobs[0] if jobs else {}
        check("host approval handed to the panel", job.get("type") == "host-action" and job.get("kind") == "host_writeback"
              and job.get("chatKey") == tk, str(body)[:300])
        if job:
            # What the plugin's decideAction does, with the MCP's empty mode.
            st, dec = s.post("/actions/decide", {"chatKey": tk, "id": job["id"], "approve": True, "mode": ""})
            check("decide hands back the host block", st == 200 and (dec.get("host") or {}).get("kind") == "host_writeback",
                  f"{st} {str(dec)[:200]}")
            s.post("/actions/complete", {"chatKey": tk, "id": job["id"], "ok": True, "detail": "3건을 RisuAI에 반영했습니다."})
        th_ap.join(timeout=60)
        err, text = res.get("r") or (True, "no result")
        check("the approval reports the panel's result", not err and "완료" in text and "RisuAI에 반영" in text, text[:300])

        print("test_mcp_review")
        import base64
        import io
        try:
            from PIL import Image
            buf = io.BytesIO()
            Image.new("RGB", (64, 96), (200, 120, 90)).save(buf, "PNG")
            png = buf.getvalue()
        except ImportError:
            png = b""
        if png:
            st, up = s.post("/files/upload", {"name": "a.png", "base64": base64.b64encode(png).decode(),
                                              "dir": "studio/output/mcptest"})
            check("test image uploaded", st == 200, f"{st} {str(up)[:200]}")
            # The client's model sees the picture itself, whatever our vision
            # mode is (off in this test backend), and past the per-turn cap.
            kinds, last_err = set(), ""
            for _ in range(14):
                msg = m.call("tools/call", {"name": "view_image", "arguments": {"path": "studio/output/mcptest/a.png"}})
                res = msg.get("result") or {}
                kinds = {c.get("type") for c in res.get("content") or []}
                if res.get("isError") or "image" not in kinds:
                    last_err = json.dumps(res, ensure_ascii=False)[:300]
                    break
            check("view_image hands the picture to the client, 14 times in a row",
                  "image" in kinds and not last_err, last_err or str(kinds))
        else:
            print("  (Pillow missing in the test runner - image checks skipped)")

        # studio_open reaches the panel through the long poll.
        out2: dict = {}
        th_open = threading.Thread(target=lambda: out2.update(r=m.tool("studio_open", {"folder": "studio/output/mcptest"})))
        th_open.start()
        th_open.join(timeout=30)
        st, body = s.post("/mcp/bridge/poll", {"context": ctx})
        jobs = body.get("jobs") or []
        check("studio_open is handed to the panel",
              any(j.get("type") == "open" and j.get("screen") == "inspect" and j.get("folder") == "studio/output/mcptest"
                  for j in jobs), str(body)[:300])

        print("test_mcp_window_closed")
        # A closing RisuAI window cannot say goodbye; it just drops the held
        # poll. The backend must notice that, not wait out the lease.
        import socket
        s.post("/mcp/bridge/activate", {"context": ctx})
        raw = json.dumps({"context": ctx}).encode()
        sock = socket.create_connection(("127.0.0.1", s.port), timeout=10)
        sock.sendall((f"POST /mcp/bridge/poll HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {s.token}\r\n"
                      f"Content-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n").encode() + raw)
        time.sleep(1.0)
        _, st1 = s.get("/mcp/status")
        check("a held poll keeps the lease", (st1.get("bridge") or {}).get("active") is True, str(st1.get("bridge"))[:200])
        sock.close()
        t0 = time.time()
        active = True
        while time.time() - t0 < 8:
            time.sleep(0.5)
            _, st2 = s.get("/mcp/status")
            active = (st2.get("bridge") or {}).get("active")
            if active is False:
                break
        check("the dropped poll ends the lease within seconds", active is False, f"{time.time() - t0:.1f}s")
        err, text = m.tool("read_card")
        check("tools refuse once the window is gone", err and "MCP 연결" in text, text[:200])
        err, text = m.tool("hina_status")
        check("and hina_status names no bot then", not err and tk not in text, text[:200])

        st, body = s.post("/mcp/bridge/deactivate")
        check("deactivate", st == 200 and body.get("active") is False, str(body)[:200])
        err, text = m.tool("read_card")
        check("refused again after deactivate", err and "MCP 연결" in text, text[:200])
        err, text = m.tool("approve_proposals")
        check("approvals need the panel switch too", err and "MCP 연결" in text, text[:200])
        err, text = m.tool("hina_status")
        check("switched off, hina_status names no bot or chat",
              not err and tk not in text and "테스트 봇" not in text and "MCP 챗" not in text, text[:300])
        _, st_off = s.get("/mcp/status")
        check("switching off forgets the context", not (st_off.get("bridge") or {}).get("context"),
              str(st_off.get("bridge"))[:200])

        st, tok2 = s.post("/mcp/token", {"rotate": True})
        st, _, _ = m.raw({"jsonrpc": "2.0", "id": 99, "method": "tools/list"})
        check("rotated token cuts off the old one", st == 401, str(st))
    finally:
        s.stop()
    print()
    print("ALL PASS" if not FAILURES else f"{len(FAILURES)} FAILED: {FAILURES}")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main())
