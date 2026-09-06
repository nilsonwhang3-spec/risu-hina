"""The vision tools (§1-42): metrics without a model, refusal detection, the
history scrub, and the helper's wire shape against a fake OpenAI server.

Runs in-process on a temp data dir; Pillow is present in the dev venv, and the
Pillow-absent branch is exercised by flipping the module flag.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

TMP = tempfile.mkdtemp(prefix="risuhina-vision-")
os.environ["RISUHINA_DATA_DIR"] = TMP
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pyserver"))

from app import config, db, files, studio, vision, workspace  # noqa: E402
from app import agent as agent_mod  # noqa: E402

fails = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global fails
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" - {detail}" if detail and not ok else ""))
    if not ok:
        fails += 1


db.connect()
config.load()
space = workspace.ensure_space()
out = space / "studio" / "output" / "비전테스트"
out.mkdir(parents=True, exist_ok=True)

from PIL import Image, ImageDraw  # noqa: E402

grey = Image.new("RGB", (400, 600), (128, 128, 128))
grey.save(out / "grey.png")
checker = Image.new("RGB", (400, 600), (0, 0, 0))
d = ImageDraw.Draw(checker)
for y in range(0, 600, 20):
    for x in range(0, 400, 20):
        if (x // 20 + y // 20) % 2 == 0:
            d.rectangle([x, y, x + 19, y + 19], fill=(255, 255, 255))
checker.save(out / "checker.png")
boxed = Image.new("RGB", (400, 600), (0, 0, 0))
ImageDraw.Draw(boxed).rectangle([0, 64, 399, 535], fill=(200, 120, 80))
boxed.save(out / "boxed.png")
checker.save(out / "checker-copy.png")
shifted = Image.new("RGB", (400, 600), (0, 0, 0))
shifted.paste(boxed.crop((0, 0, 399, 600)), (1, 0))   # a low-frequency picture, one pixel over
shifted.save(out / "boxed-shift.png")
(out / "notes.png").write_text("this is text", encoding="utf-8")
REL = "studio/output/비전테스트"

print("test_metrics")
m = vision.metrics(f"{REL}/grey.png")
check("dimensions", m["width"] == 400 and m["height"] == 600, str(m))
check("a flat grey is blurry and mid-bright", m["sharpnessLabel"] == "흐림" and 120 <= m["brightness"] <= 136, str(m))
mc = vision.metrics(f"{REL}/checker.png")
check("a checkerboard is sharp", mc["sharpnessLabel"] == "선명", str(mc.get("sharpness")))
mb = vision.metrics(f"{REL}/boxed.png")
check("letterbox bands are measured", mb["letterbox"]["top"] == 64 and mb["letterbox"]["bottom"] == 64, str(mb["letterbox"]))
check("no bands on the checkerboard", not any(mc["letterbox"].values()), str(mc["letterbox"]))
dup = vision.near_duplicates(f"{REL}/checker.png")
names = {x["path"].split("/")[-1] for x in dup}
check("an identical copy is a near-duplicate", "checker-copy.png" in names, str(dup))
dup2 = vision.near_duplicates(f"{REL}/boxed.png")
check("a one-pixel shift still is", "boxed-shift.png" in {x["path"].split("/")[-1] for x in dup2}, str(dup2))
check("the grey one is not", "grey.png" not in names)
try:
    vision.metrics(f"{REL}/notes.png")
    check("text renamed .png is reported, not raised", "note" in vision.metrics(f"{REL}/notes.png"))
except Exception as e:  # noqa: BLE001
    check("text renamed .png is reported, not raised", False, str(e))
try:
    vision.metrics("studio/output/비전테스트/../../../data/config.json")
    check("a path outside the space is refused", False)
except vision.VisionError:
    check("a path outside the space is refused", True)
try:
    vision.metrics(f"{REL}/nope.txt")
    check("a non-image suffix is refused", False)
except vision.VisionError:
    check("a non-image suffix is refused", True)
txt = vision.fmt_metrics(mb, dup)
check("the summary reads as one block", "레터박스" in txt and "선명도" in txt, txt)

print("test_pillow_absent")
saved = vision._PIL
vision._PIL = False
try:
    m2 = vision.metrics(f"{REL}/grey.png")
    check("dimensions still come from the header", m2["width"] == 400 and m2["height"] == 600, str(m2))
    check("and the note says what is missing", "Pillow" in str(m2.get("note")), str(m2))
    check("no duplicates without Pillow", vision.near_duplicates(f"{REL}/checker.png") == [])
finally:
    vision._PIL = saved

print("test_load_image")
img = vision.load_image(f"{REL}/checker.png", 256)
check("a webp thumbnail at the asked width", img.mime == "image/webp" and img.w <= 256 and img.h <= 512, f"{img.mime} {img.w}x{img.h}")
check("original size is known", img.orig_w == 400 and img.orig_h == 600)

print("test_is_refusal")
pos = [
    ("I'm sorry, but I can't help with that.", {}),
    ("I cannot assist with this request.", {}),
    ("Sorry, I am unable to describe this image.", {}),
    ("As an AI, I can't analyze explicit content.", {}),
    ("This image contains sexual content that I cannot describe.", {}),
    ("I won't be able to provide a description of this.", {}),
    ("죄송하지만 이 이미지는 도와드릴 수 없습니다.", {}),
    ("부적절한 이미지라 답변할 수 없습니다.", {}),
    ("정책상 묘사할 수 없는 내용입니다.", {}),
    ("", {}),
    ("   ", {}),
    ("fine", {"finish_reason": "content_filter"}),
    ("fine", {"finish_reason": "SAFETY"}),
    ("", {"status": 400, "body": '{"error":{"message":"The request was blocked by the safety filter"}}'}),
    ("", {"body": '{"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}'}),
]
for t, kw in pos:
    check(f"refusal: {t[:30]!r} {kw}", vision.is_refusal(t, **kw) is not None)
neg = [
    "A woman in a green blazer stands by a window; she can't see the street from there.",
    "The character says 'I can't believe it' while holding a cup. Background: a classroom.",
    "Two figures. The left one is nude, the right one wears a coat. Lighting is warm.",
    "그림에는 교복을 입은 소녀가 있고, 손가락은 다섯 개로 정상입니다.",
    "Detailed: " + ("the subject is a red-haired girl in a school uniform, smiling; " * 12) + "I can't tell the shoe colour.",
    "Nothing wrong with the hands. The eyes are symmetric.",
    "The image shows an adult couple; explicit content is present and rendered clearly.",
    "OK.",
]
for t in neg:
    check(f"not a refusal: {t[:36]!r}", vision.is_refusal(t) is None)

print("test_scrub_history")
from pydantic_ai.messages import (BinaryImage, ModelMessagesTypeAdapter, ModelRequest, ModelResponse,  # noqa: E402
                                  TextPart, ToolCallPart, ToolReturnPart, UserPromptPart)
png = vision.sample_png()
hist = [
    ModelRequest(parts=[UserPromptPart(content="look at it")]),
    ModelResponse(parts=[ToolCallPart(tool_name="view_image", args={"path": "x.png"}, tool_call_id="c1")]),
    ModelRequest(parts=[ToolReturnPart(tool_name="view_image", content="numbers…", tool_call_id="c1"),
                        UserPromptPart(content=["This is image x.png:", BinaryImage(png, media_type="image/png", identifier="abc")])]),
    ModelResponse(parts=[TextPart(content="two colours")]),
]
scrubbed = vision.scrub_history(hist)
dumped = ModelMessagesTypeAdapter.dump_json(scrubbed).decode("utf-8")
b64 = base64.b64encode(png).decode("ascii")[:40]
check("no image bytes in the stored form", b64 not in dumped)
check("a placeholder names the image", "image omitted from stored history: abc" in dumped)
check("message count unchanged", len(scrubbed) == len(hist))
check("the tool return is untouched", scrubbed[2].parts[0] is hist[2].parts[0])
check("idempotent", ModelMessagesTypeAdapter.dump_json(vision.scrub_history(scrubbed)).decode("utf-8") == dumped)
check("_msg_chars sees a short line, not the bytes", agent_mod._msg_chars(hist[2]) < 400, str(agent_mod._msg_chars(hist[2])))
check("_msg_text says [이미지]", "[이미지]" in agent_mod._msg_text(hist[2]))
check("short_content labels a binary part", "image/png" in str(vision.short_content(hist[2].parts[1].content)))

print("test_modes")
check("default mode is off", vision.mode() == "off" and vision.ready())
config.update({"vision": {"mode": "helper"}})
check("helper without an address is not ready", not vision.ready() and "주소" in vision.why_not(), vision.why_not())
config.update({"vision": {"helperBaseUrl": "https://api.example.com/v1"}})
check("helper without a key is not ready", not vision.ready() and "키" in vision.why_not(), vision.why_not())
config.update({"vision": {"helperBaseUrl": "http://127.0.0.1:11434/v1"}})
check("a local address needs no key", vision.ready())
config.update({"vision": {"mode": "native"}, "agent": {"model": "test/pick"}})
check("native without a probe is not ready", not vision.ready() and "테스트" in vision.why_not(), vision.why_not())
config.update({"vision": {"nativeProbe": {"model": "other", "ok": True, "at": "", "error": ""}}})
check("a probe for another model is stale", not vision.ready() and "바뀌었습니다" in vision.why_not(), vision.why_not())
config.update({"vision": {"nativeProbe": {"model": "test/pick", "ok": True, "at": "", "error": ""}}})
check("a matching probe makes native ready", vision.ready())
st = vision.status()
check("status carries the modes and the probe", len(st["modes"]) == 3 and st["nativeProbe"]["ok"] and not st["nativeProbeStale"])

print("test_view_off_and_budget")
config.update({"vision": {"mode": "off", "maxCallsPerTurn": 2}})
r = asyncio.run(vision.view("s1", [f"{REL}/grey.png"], "what?"))
check("off mode returns the numbers", isinstance(r, str) and "vision is off" in r and "선명도" in r, str(r)[:120])
r2 = asyncio.run(vision.view("s1", [f"{REL}/grey.png"], "what?"))
r3 = asyncio.run(vision.view("s1", [f"{REL}/grey.png"], "what?"))
check("the per-turn cap trips on the third call", "budget" in str(r3), str(r3)[:100])
vision.reset_turn("s1")
r4 = asyncio.run(vision.view("s1", [f"{REL}/grey.png"], "what?"))
check("reset_turn restores the budget", "선명도" in str(r4))
config.update({"vision": {"maxCallsPerTurn": 12}})
r5 = asyncio.run(vision.view("s1", [f"{REL}/grey.png", f"{REL}/checker.png", f"{REL}/checker-copy.png"], "rank"))
check("compare reports near-duplicate pairs", "near-duplicate" in str(r5), str(r5)[-200:])
r6 = asyncio.run(vision.view("s1", [f"{REL}/nope.png"], "?"))
check("a missing file is a sentence, not an exception", "cannot view" in str(r6), str(r6))

print("test_native_returns_the_picture")
config.update({"vision": {"mode": "native", "nativeProbe": {"model": "test/pick", "ok": True, "at": "", "error": ""}}})
r7 = asyncio.run(vision.view("s2", [f"{REL}/checker.png"], "count squares"))
from pydantic_ai.messages import ToolReturn  # noqa: E402
check("native mode returns a ToolReturn", isinstance(r7, ToolReturn))
check("whose content carries the image", isinstance(r7, ToolReturn) and any(isinstance(x, BinaryImage) for x in (r7.content or [])))
check("and whose text has the numbers", isinstance(r7, ToolReturn) and "선명도" in str(r7.return_value))

print("test_helper_wire")
SEEN: list[dict] = []
REPLIES: list[tuple[int, dict | str]] = []


class Fake(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        SEEN.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        status, reply = REPLIES.pop(0) if REPLIES else (200, {"choices": [{"message": {"content": "ok"}}]})
        data = json.dumps(reply).encode("utf-8") if isinstance(reply, dict) else reply.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):  # noqa: D102
        pass


srv = HTTPServer(("127.0.0.1", 0), Fake)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
config.update({"vision": {"mode": "helper", "helperBaseUrl": f"http://127.0.0.1:{port}/v1", "helperApiKey": "sk-test",
                          "helperModel": "fake-vision", "detail": "low"}})
REPLIES[:] = [(200, {"choices": [{"message": {"content": "A grey rectangle. Nothing else."}, "finish_reason": "stop"}]})]
r8 = asyncio.run(vision.view("s3", [f"{REL}/grey.png"], "what is it?"))
check("the helper's answer is returned with the numbers", "[helper fake-vision" in str(r8) and "grey rectangle" in str(r8) and "선명도" in str(r8), str(r8)[:160])
req = SEEN[-1]
check("posted to chat/completions with the bearer key", req["path"].endswith("/v1/chat/completions") and req["auth"] == "Bearer sk-test", str(req["path"]))
parts = req["body"]["messages"][1]["content"]
img_part = next((p for p in parts if p.get("type") == "image_url"), None)
check("the image rides as a webp data URI with the detail", bool(img_part) and img_part["image_url"]["url"].startswith("data:image/webp;base64,")
      and img_part["image_url"]["detail"] == "low", str(img_part)[:80] if img_part else "none")
check("the model and a system instruction are sent", req["body"]["model"] == "fake-vision" and req["body"]["messages"][0]["role"] == "system")
REPLIES[:] = [(200, {"choices": [{"message": {"content": "I'm sorry, but I can't help with that."}, "finish_reason": "stop"}]})]
r9 = asyncio.run(vision.view("s3", [f"{REL}/grey.png"], "what is it?"))
check("a text refusal becomes VISION REFUSED with the numbers", str(r9).startswith("VISION REFUSED") and "선명도" in str(r9), str(r9)[:120])
REPLIES[:] = [(400, {"error": {"message": "Request blocked by safety filters", "code": "content_policy_violation"}})]
r10 = asyncio.run(vision.view("s3", [f"{REL}/grey.png"], "what is it?"))
check("an HTTP safety error too", str(r10).startswith("VISION REFUSED") and "http-safety" in str(r10), str(r10)[:120])
REPLIES[:] = [(500, "boom")]
r11 = asyncio.run(vision.view("s3", [f"{REL}/grey.png"], "what is it?"))
check("a server error degrades to numbers", "helper failed" in str(r11) and "선명도" in str(r11), str(r11)[:120])
REPLIES[:] = [(200, {"choices": [{"message": {"content": "The sample is red and blue."}, "finish_reason": "stop"}]})]
t = asyncio.run(vision.test())
check("the card's test uses the built-in sample", t["ok"] and "red" in t["text"] and t["mode"] == "helper", str(t)[:160])
config.update({"vision": {"helperApiKey": "__keep__"}})
check("KEEP leaves the helper key alone", vision._helper()[1] == "sk-test")
red = config.redacted()
check("the helper key is redacted in /config", red["vision"]["helperApiKey"] != "sk-test", str(red["vision"]["helperApiKey"]))
srv.shutdown()

print("test_selection_suggest")
folder = REL
sel = {"grey.png": {"use": True, "inpaint": False, "delete": False},
       "checker.png": {"use": False, "inpaint": False, "delete": False,
                       "suggest": {"verdict": "use", "reason": "sharp", "by": "fake", "at": "now"}},
       "boxed.png": {"use": False, "inpaint": False, "delete": False, "suggest": {"verdict": "bogus"}}}
studio.write_selection(folder, sel)
back = studio.read_selection(folder)
check("a valid suggestion survives the write", back["checker.png"].get("suggest", {}).get("verdict") == "use", str(back.get("checker.png")))
check("an invalid one is dropped", "suggest" not in back["boxed.png"])
check("plain entries keep the three-flag shape", set(back["grey.png"].keys()) == {"use", "inpaint", "delete"}, str(back["grey.png"]))
r = studio.merge_suggestions(folder, [{"file": "grey.png", "verdict": "delete", "reason": "flat"},
                                      {"file": "checker.png", "verdict": "none"},
                                      {"file": "ghost.png", "verdict": "use"}], by="fake")
back = studio.read_selection(folder)
check("merge keeps the user's flags", back["grey.png"]["use"] is True and back["grey.png"]["suggest"]["verdict"] == "delete", str(back["grey.png"]))
check("none clears a suggestion", "suggest" not in back["checker.png"] and r["cleared"] == 1, str(r))
check("unknown files are reported", r["unknown"] == ["ghost.png"], str(r))
g = studio.group(folder)
item = next((i for grp in g["groups"] for i in grp["items"] if i["filename"] == "grey.png"), None) \
    or next((i for i in g["unmatched"] if i["filename"] == "grey.png"), None)
check("group() hands the suggestion to the panel", bool(item) and item["selection"].get("suggest", {}).get("verdict") == "delete", str(item))

print()
print("PASS - the agent can look, measure, be refused, and forget the bytes" if not fails else f"FAIL - {fails} check(s)")
sys.exit(1 if fails else 0)
