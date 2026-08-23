"""Phase 0 probe backend — stdlib only, no venv, no dependencies.

Its whole job is to be a target the probe plugin can aim at, so that every
network claim in the plan gets checked against a real RisuAI instead of
against source reading. It deliberately does NOT import anything outside the
standard library: it must run under the server's system Python (3.11.9 on
test-server) before any venv exists.

    python probe_server.py [--host 127.0.0.1] [--port 6020] [--token <tok>]

Routes
    GET  /health        auth-exempt. Carries the signature the plugin uses to
                        decide "am I talking to the backend directly?"
    ANY  /echo          reflects what actually arrived — method, client IP and
                        every header. This is how a hub relay is detected: a
                        relayed request shows up with risu-url/risu-header and
                        a client IP that is not ours.
    GET  /stream?n=&ms= NDJSON, one object per line, flushed with a delay so a
                        buffering proxy is distinguishable from a streaming one.
    GET  /big?kb=       large body, for the RPC bridge's size behaviour.
    GET  /token-check   requires a bearer token even from loopback.
"""
import argparse
import json
import secrets
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.2.0"
SERVICE = "risu-elf-probe"

LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}

# Headers PocketRisu's /proxy2 and RisuAI's hub relay add. Seeing any of these
# means the request did not arrive directly from the browser.
RELAY_MARKERS = ("risu-url", "risu-header", "risu-auth", "risu-location", "x-target-url")

_log_lock = threading.Lock()
TOKEN = ""


def now():
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def log(*parts):
    with _log_lock:
        print(f"[{now()}]", *parts, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = f"{SERVICE}/{VERSION}"
    protocol_version = "HTTP/1.1"

    # ---- plumbing -------------------------------------------------------

    def log_message(self, fmt, *args):
        # Silence the default stderr logger; we do our own on the request line.
        pass

    def _client_ip(self):
        return self.client_address[0] if self.client_address else ""

    def _relay_markers(self):
        return [h for h in RELAY_MARKERS if h in {k.lower() for k in self.headers.keys()}]

    def _send(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        # Explicit charset: without it some clients decode UTF-8 as latin-1 and
        # Korean text comes back mangled.
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in CORS.items():
            self.send_header(k, v)
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        auth = self.headers.get("Authorization") or ""
        return bool(TOKEN) and secrets.compare_digest(auth, f"Bearer {TOKEN}")

    def _split_path(self):
        raw = self.path or "/"
        if "?" in raw:
            path, _, qs = raw.partition("?")
        else:
            path, qs = raw, ""
        query = {}
        for pair in qs.split("&"):
            if not pair:
                continue
            k, _, v = pair.partition("=")
            query[k] = v
        return path, query

    # ---- verbs ----------------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()
        log("OPTIONS", self.path, "from", self._client_ip())

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method):
        path, query = self._split_path()
        ip = self._client_ip()
        markers = self._relay_markers()
        has_auth = "authorization" in {k.lower() for k in self.headers.keys()}
        log(
            f"{method} {path}",
            f"from={ip}",
            f"loopback={ip in LOOPBACK}",
            f"auth={'yes' if has_auth else 'no'}",
            f"relay={markers or 'none'}",
        )

        if path == "/health":
            self._send(200, {
                "service": SERVICE,          # the signature the plugin checks
                "version": VERSION,
                "ok": True,
                "client_ip": ip,
                "loopback": ip in LOOPBACK,
                "relay_markers": markers,
                "saw_authorization": has_auth,
                "ts": time.time(),
            })
            return

        if path == "/echo":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
            self._send(200, {
                "service": SERVICE,
                "method": method,
                "path": path,
                "query": query,
                "client_ip": ip,
                "loopback": ip in LOOPBACK,
                "relay_markers": markers,
                "headers": {k: v for k, v in self.headers.items()},
                "body_preview": body[:2000],
                "body_len": length,
            })
            return

        if path == "/token-check":
            if not self._authorized():
                self._send(401, {"error": "unauthorized", "hint": "Authorization: Bearer <token>"})
                return
            self._send(200, {"service": SERVICE, "ok": True, "authorized": True, "client_ip": ip})
            return

        if path == "/big":
            kb = max(1, min(8192, int(query.get("kb") or 256)))
            blob = "x" * 1024
            self._send(200, {"service": SERVICE, "kb": kb, "data": blob * kb})
            return

        if path == "/stream":
            self._do_stream(query)
            return

        self._send(404, {"error": f"no route: {method} {path}"})

    def _do_stream(self, query):
        """Streamed body with real delays between flushes.

        Chunked transfer is written by hand because we need control over when
        each line hits the socket — a proxy that buffers the whole body looks
        identical to a streaming one if the server writes it all at once.

        `ct` selects the content type, because intermediaries special-case it:
        PocketRisu's compression filter exempts text/event-stream explicitly
        and application/x-ndjson defensively (server.cjs:731-742), so the same
        bytes can stream under one type and buffer under another.
        """
        n = max(1, min(500, int(query.get("n") or 10)))
        ms = max(0, min(5000, int(query.get("ms") or 200)))
        kind = (query.get("ct") or "ndjson").lower()
        ctype = {
            "sse": "text/event-stream; charset=utf-8",
            "text": "text/plain; charset=utf-8",
        }.get(kind, "application/x-ndjson; charset=utf-8")
        started = time.time()

        # Close the connection after a hand-rolled chunked response.
        #
        # BaseHTTPRequestHandler does not know we are framing chunks ourselves,
        # so under HTTP/1.1 keep-alive it leaves the socket open for reuse. Any
        # framing drift then corrupts the *next* response on that connection —
        # which is exactly what happened: four stream tests in a row left the
        # following /big request returning a truncated, unparseable body, and
        # the failure surfaced as "download looks wrong" rather than as a
        # streaming problem. Closing here keeps each stream self-contained.
        self.close_connection = True

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

        try:
            for i in range(n):
                payload = json.dumps({
                    "i": i,
                    "of": n,
                    "elapsed_ms": int((time.time() - started) * 1000),
                    "text": f"chunk {i + 1}/{n}",
                }, ensure_ascii=False)
                if kind == "sse":
                    # SSE frames need the blank-line terminator or the client
                    # never dispatches the event.
                    line = f"data: {payload}\n\n"
                else:
                    line = payload + "\n"
                data = line.encode("utf-8")
                self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
                self.wfile.write(data)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
                if i < n - 1 and ms:
                    time.sleep(ms / 1000.0)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            log("stream aborted by client")


def main():
    global TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=6020)
    ap.add_argument("--token", default="")
    args = ap.parse_args()

    TOKEN = args.token or secrets.token_urlsafe(24)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"{SERVICE} {VERSION}")
    print(f"  listening  http://{args.host}:{args.port}")
    print(f"  token      {TOKEN}")
    print(f"  routes     /health /echo /stream /big /token-check")
    print("  (Ctrl+C to stop)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
