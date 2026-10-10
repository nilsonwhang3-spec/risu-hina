"""A fake NovelAI image API for the browser harness.

    python tools/fake_nai.py --port 8799 [--steps-delay 0.15] [--drop-at N]

Then start the harness with RISUHINA_NAI_BASE=http://127.0.0.1:8799 and any
NovelAI key (the fake accepts every token). It answers what the studio asks:

- GET  /user/subscription          an Opus account, 10000 Anlas
- POST /ai/generate-image-stream   msgpack frames as measured against the real
                                   service (2026-10-10, 28 steps): intermediate
                                   step_ix 0..steps-2 with a small blurry PNG,
                                   then one `final` with the full image
- POST /ai/generate-image          the ZIP path (one PNG in a zip)

`--drop-at N` ends the stream after intermediate N with no final frame - the
torn stream the backend falls back to ZIP for. Nothing here talks to the net.
"""
from __future__ import annotations

import argparse
import io
import json
import struct
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import msgpack
from PIL import Image, ImageDraw, ImageFilter

ARGS = argparse.Namespace()


def picture(w: int, h: int, step: int, total: int, small: bool) -> bytes:
    im = Image.new("RGB", (w, h), (40, 60, 90))
    d = ImageDraw.Draw(im)
    d.ellipse((w // 4, h // 6, 3 * w // 4, h // 2), fill=(230, 190, 160))
    d.rectangle((w // 3, h // 2, 2 * w // 3, h - h // 8), fill=(200, 60, 80))
    d.text((20, 20), f"step {step + 1}/{total}" if small else "FINAL", fill=(255, 255, 255))
    if small:
        im = im.resize((max(1, w // 8), max(1, h // 8))).filter(ImageFilter.GaussianBlur(2))
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


def frame(m: dict) -> bytes:
    b = msgpack.packb(m, use_bin_type=True)
    return struct.pack(">I", len(b)) + b


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):  # noqa: N802 - quiet
        print("[fake-nai]", fmt % a, flush=True)

    def _json(self, code: int, obj: dict) -> None:
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/user/subscription"):
            return self._json(200, {"tier": 3, "active": True,
                                    "trainingStepsLeft": {"fixedTrainingStepsLeft": 10000, "purchasedTrainingSteps": 0},
                                    "usage": {"percent": 0, "isNegative": False}})
        return self._json(404, {"message": "not here"})

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        p = body.get("parameters") or {}
        w, h = int(p.get("width") or 832), int(p.get("height") or 1216)
        steps = int(p.get("steps") or 28)
        if self.path.startswith("/ai/generate-image-stream"):
            self.send_response(200)
            self.send_header("Content-Type", "application/x-msgpack")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            def send(b: bytes) -> None:
                self.wfile.write(f"{len(b):x}\r\n".encode() + b + b"\r\n")
                self.wfile.flush()
            time.sleep(ARGS.first_delay)
            for ix in range(steps - 1):
                send(frame({"event_type": "intermediate", "samp_ix": 0, "step_ix": ix,
                            "gen_id": "x", "sigma": 1.0, "image": picture(w, h, ix, steps, True)}))
                if ARGS.drop_at >= 0 and ix >= ARGS.drop_at:
                    self.wfile.write(b"0\r\n\r\n")
                    return
                time.sleep(ARGS.steps_delay)
            send(frame({"event_type": "final", "samp_ix": 0, "gen_id": "x",
                        "image": picture(w, h, steps, steps, False)}))
            self.wfile.write(b"0\r\n\r\n")
            return
        if self.path.startswith("/ai/generate-image"):
            time.sleep(ARGS.first_delay + ARGS.steps_delay * steps)
            z = io.BytesIO()
            with zipfile.ZipFile(z, "w") as zf:
                zf.writestr("image_0.png", picture(w, h, steps, steps, False))
            b = z.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        return self._json(404, {"message": "not here"})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--steps-delay", type=float, default=0.15)
    ap.add_argument("--first-delay", type=float, default=1.0)
    ap.add_argument("--drop-at", type=int, default=-1)
    ap.parse_args(namespace=ARGS)
    print(f"[fake-nai] http://127.0.0.1:{ARGS.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", ARGS.port), H).serve_forever()


if __name__ == "__main__":
    main()
