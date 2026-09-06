"""Vision: the agent looking at images (§1-42).

The web-search tool's twin: one tool surface, one settings card, and a MODE
that decides who actually looks:

    native  the main agent's own model sees the picture - the tool returns a
            pydantic-ai ToolReturn whose `content` carries a BinaryImage, which
            the library sends as the user message that follows the tool result
            (chat/completions) or inline (Responses). Gated on a probe: the
            card's 테스트 sends a two-colour PNG through the real model and
            remembers whether it named a colour.
    helper  a separate OpenAI-compatible vision endpoint (Gemini's /openai
            layer, GPT-4o-mini, Ollama's /v1 with a local llava/qwen2.5-vl ...)
            describes the picture and the agent reads text. Any vendor, because
            every one of them speaks chat/completions with image_url data URIs.
    off     numbers only (Pillow metrics), always available.

Two things this module is careful about, both learned from the design pass:

  - The picture must never reach the STORED history. A BinaryContent in a
    persisted message is ~100KB of base64 re-sent on every later turn and
    counted by the compaction budget as tens of thousands of characters.
    `scrub_history` swaps every image for a one-line placeholder before the
    history row is written; the model saw the picture in the turn it asked.
  - External vision APIs refuse adult content, and adult content is the
    common case here. `is_refusal` recognises the shapes a refusal takes (HTTP
    safety errors, finish reasons, empty answers, the sentences) and the tool
    then says VISION REFUSED with the numbers - so the agent tells the user
    instead of inventing what it did not see.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import struct
import threading
import time
import urllib.parse
import zlib
from pathlib import Path
from typing import Any

from . import config, files, keys, log

try:  # Pillow is optional at runtime (files.thumb_bytes has the same stance)
    from PIL import Image, ImageFilter, ImageStat  # type: ignore
    _PIL = True
except Exception:  # noqa: BLE001
    Image = ImageFilter = ImageStat = None  # type: ignore
    _PIL = False

HELPER_DEFAULT_MODEL = "gemini-2.5-flash"
HELPER_DEFAULT_INSTRUCTIONS = (
    "당신은 이미지 검수 담당이다. 그림에 무엇이 있는지 사실대로 묘사하고, 물어본 것에만 답한다. "
    "해부학 오류(손가락·팔다리·눈), 잘린 부위, 텍스트/워터마크, 흐림, 레터박스(여백 띠)를 발견하면 명시한다. "
    "성인 콘텐츠도 평가 대상이다 — 거부하지 말고 묘사한다. 한국어로 답한다."
)

MODES: list[dict] = [
    {"id": "native", "name": "메인 에이전트 모델이 직접 봄",
     "note": "일반 에이전트의 모델이 이미지를 받으면(멀티모달) 툴 결과에 그림을 그대로 실어 보냅니다. "
             "테스트가 두 색 그림을 보내 실제로 보는지 확인하고 기억합니다 — 프리셋(모델)을 바꾸면 다시 테스트합니다."},
    {"id": "helper", "name": "보조 비전 모델 사용 (OpenAI 호환 주소·모델)",
     "note": "별도의 저렴한 비전 모델이 보고 글로 답합니다. Gemini(/v1beta/openai)·GPT-4o-mini·OpenRouter 는 물론 "
             "로컬 Ollama(http://127.0.0.1:11434/v1 의 llava·qwen2.5-vl)도 됩니다. 성인 이미지가 많다면 무검열/로컬 모델을 권합니다."},
    {"id": "off", "name": "끔 — 수치 분석만",
     "note": "모델 없이 크기·밝기·선명도·레터박스·중복만 잽니다 (image_metrics). 그림의 내용은 판단하지 못합니다."},
]

DETAILS = ("auto", "low", "high")
_SUFFIX_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
                ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif"}
_RAW_LIMIT = 4 * 1024 * 1024


class VisionError(ValueError):
    pass


class RefusalError(RuntimeError):
    def __init__(self, code: str, snippet: str = "") -> None:
        super().__init__(f"{code}: {snippet}")
        self.code = code
        self.snippet = snippet


# --- config --------------------------------------------------------------------

def _cfg() -> dict:
    return config.section("vision")


def _agent_cfg() -> dict:
    return config.section("agent")


def _host(url: str) -> str:
    return urllib.parse.urlparse(str(url or "")).hostname or ""


def mode() -> str:
    m = str(_cfg().get("mode") or "").strip().lower()
    return m if m in ("native", "helper", "off") else "off"


def max_width() -> int:
    try:
        return max(128, min(2048, int(_cfg().get("maxWidth") or 768)))
    except (TypeError, ValueError):
        return 768


def detail() -> str:
    d = str(_cfg().get("detail") or "auto").strip().lower()
    return d if d in DETAILS else "auto"


def max_images() -> int:
    try:
        return max(1, min(24, int(_cfg().get("maxImagesPerCall") or 6)))
    except (TypeError, ValueError):
        return 6


def max_calls() -> int:
    try:
        return max(1, min(100, int(_cfg().get("maxCallsPerTurn") or 12)))
    except (TypeError, ValueError):
        return 12


def timeout_s() -> float:
    try:
        return max(5.0, float(_cfg().get("timeoutSeconds") or 60))
    except (TypeError, ValueError):
        return 60.0


def _helper() -> tuple[str, str, str]:
    """(base_url, api_key, model) the helper runs with."""
    c = _cfg()
    base, key = keys.resolve(str(c.get("helperBaseUrl") or "").strip(),
                             str(c.get("helperApiKey") or "").strip(),
                             str(c.get("helperKeyRef") or "").strip())
    return base.rstrip("/"), key, (str(c.get("helperModel") or "").strip() or HELPER_DEFAULT_MODEL)


def helper_instructions() -> str:
    return str(_cfg().get("helperInstructions") or "").strip() or HELPER_DEFAULT_INSTRUCTIONS


def agent_model_name() -> str:
    a = _agent_cfg()
    return str(a.get("model") or "")


def native_probe() -> dict:
    p = _cfg().get("nativeProbe")
    return p if isinstance(p, dict) else {}


def native_ok() -> bool:
    """The probe passed for the model the agent runs NOW."""
    p = native_probe()
    return bool(p.get("ok")) and str(p.get("model") or "") == agent_model_name() and bool(agent_model_name())


def ready() -> bool:
    m = mode()
    if m == "native":
        return native_ok()
    if m == "helper":
        base, key, model = _helper()
        # A local endpoint (Ollama) has no key; require the address and model.
        return bool(base and model) and (bool(key) or _host(base) in ("127.0.0.1", "localhost"))
    return True


def why_not() -> str:
    m = mode()
    if m == "native":
        p = native_probe()
        if not agent_model_name():
            return "일반 에이전트의 모델이 없습니다 (⚙ → 에이전트 → 일반 에이전트)"
        if p.get("model") and p.get("model") != agent_model_name():
            return f"모델이 바뀌었습니다({p.get('model')} → {agent_model_name()}) — ⚙ → 에이전트 → 비전 툴에서 다시 테스트하세요"
        if p and not p.get("ok"):
            return f"이 모델은 이미지를 보지 못했습니다: {str(p.get('error') or '')[:120]} — 보조 비전 모델로 바꾸세요"
        return "아직 확인되지 않았습니다 — ⚙ → 에이전트 → 비전 툴에서 테스트를 누르세요"
    if m == "helper":
        base, key, model = _helper()
        if not base:
            return "보조 비전 모델의 주소가 없습니다 (⚙ → 에이전트 → 비전 툴)"
        if not key and _host(base) not in ("127.0.0.1", "localhost"):
            return "보조 비전 모델의 API 키가 없습니다 (⚙ → 에이전트 → 비전 툴)"
        return ""
    return "비전 툴이 꺼져 있습니다 (수치 분석만 됩니다) — ⚙ → 에이전트 → 비전 툴"


def status() -> dict:
    c = _cfg()
    base, key, model = _helper()
    a = _agent_cfg()
    p = native_probe()
    return {
        "modes": MODES,
        "mode": mode(),
        "agent": {"model": agent_model_name(),
                  "host": ("codex" if (a.get("provider") or "") == "codex" else _host(str(a.get("baseUrl") or "")))},
        "nativeProbe": p,
        "nativeProbeStale": bool(p) and str(p.get("model") or "") != agent_model_name(),
        "helper": {
            "baseUrl": str(c.get("helperBaseUrl") or ""), "model": model, "defaultModel": HELPER_DEFAULT_MODEL,
            "keyRef": str(c.get("helperKeyRef") or ""), "apiKeySet": bool(str(c.get("helperApiKey") or "").strip()),
            "instructions": str(c.get("helperInstructions") or ""), "defaultInstructions": HELPER_DEFAULT_INSTRUCTIONS,
            "effectiveHost": _host(base),
        },
        "maxWidth": max_width(), "detail": detail(), "maxImagesPerCall": max_images(),
        "maxCallsPerTurn": max_calls(), "timeoutSeconds": timeout_s(),
        "pillow": _PIL,
        "ready": ready(),
        "whyNot": "" if ready() else why_not(),
    }


# --- per-turn budget --------------------------------------------------------------

_CALLS: dict[str, int] = {}
_CALLS_LOCK = threading.Lock()


def reset_turn(session_id: str | None) -> None:
    if not session_id:
        return
    with _CALLS_LOCK:
        _CALLS.pop(session_id, None)


def _take_call(session_id: str | None) -> int | None:
    """Count one call; the number used, or None when the turn's cap is hit."""
    if not session_id:
        return 0
    with _CALLS_LOCK:
        n = _CALLS.get(session_id, 0) + 1
        if n > max_calls():
            return None
        _CALLS[session_id] = n
        return n


# --- loading a picture -------------------------------------------------------------

class Loaded:
    __slots__ = ("rel", "data", "mime", "w", "h", "orig_w", "orig_h", "orig_bytes", "note")

    def __init__(self, rel: str, data: bytes, mime: str, w: int, h: int,
                 orig_w: int, orig_h: int, orig_bytes: int, note: str = "") -> None:
        self.rel, self.data, self.mime = rel, data, mime
        self.w, self.h, self.orig_w, self.orig_h, self.orig_bytes, self.note = w, h, orig_w, orig_h, orig_bytes, note


def _dims_stdlib(data: bytes) -> tuple[int, int]:
    """Width/height from the header alone (PNG, JPEG, WebP, GIF, BMP)."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", data[16:24])
            return int(w), int(h)
        if data[:6] in (b"GIF87a", b"GIF89a"):
            w, h = struct.unpack("<HH", data[6:10])
            return int(w), int(h)
        if data[:2] == b"BM":
            w, h = struct.unpack("<ii", data[18:26])
            return abs(int(w)), abs(int(h))
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            tag = data[12:16]
            if tag == b"VP8X":
                w = 1 + int.from_bytes(data[24:27], "little")
                h = 1 + int.from_bytes(data[27:30], "little")
                return w, h
            if tag == b"VP8L":
                b = data[21:25]
                w = 1 + ((b[1] & 0x3F) << 8 | b[0])
                h = 1 + ((b[3] & 0x0F) << 10 | b[2] << 2 | b[1] >> 6)
                return w, h
            if tag == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return w & 0x3FFF, h & 0x3FFF
        if data[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return int(w), int(h)
                seg = struct.unpack(">H", data[i + 2:i + 4])[0]
                i += 2 + seg
    except Exception:  # noqa: BLE001
        pass
    return 0, 0


def _resolve_image(rel: str) -> tuple[Path, str]:
    r = (rel or "").replace("\\", "/").strip("/")
    if not r:
        raise VisionError("경로가 비어 있습니다")
    try:
        target = files._resolve(files.SPACE, r)
    except files.FileError as e:
        raise VisionError(str(e)) from e
    if not target.is_file():
        raise VisionError(f"파일이 없습니다: {r}")
    if target.suffix.lower() not in files._IMAGE_SUFFIXES:
        raise VisionError(f"이미지 파일이 아닙니다: {r}")
    return target, r


def load_image(rel: str, width: int | None = None) -> Loaded:
    """The picture as the model will see it: a WebP thumbnail at most `width`
    on the long side (files.thumb_bytes, disk-cached), or the original bytes
    when it cannot be thumbed and is small enough."""
    target, r = _resolve_image(rel)
    width = width or max_width()
    raw = target.read_bytes()
    ow, oh = _dims_stdlib(raw)
    data, mime = files.thumb_bytes(target, width)
    note = ""
    if mime is None:
        suf = target.suffix.lower()
        if suf not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
            raise VisionError(f"이 형식은 보낼 수 없습니다 ({suf}); PNG/JPEG/WebP 로 변환하세요")
        if len(raw) > _RAW_LIMIT:
            raise VisionError("썸네일을 만들지 못했고 원본이 4MB 를 넘습니다 (Pillow 설치 필요)")
        data, mime = raw, _SUFFIX_MIME.get(suf, "image/png")
        note = "원본 그대로 (썸네일 불가)"
        w, h = ow, oh
    else:
        w, h = _dims_stdlib(data)
        if not w and _PIL:
            try:
                with Image.open(io.BytesIO(data)) as im:
                    w, h = im.size
            except Exception:  # noqa: BLE001
                pass
    if not ow and _PIL:
        try:
            with Image.open(io.BytesIO(raw)) as im:
                ow, oh = im.size
        except Exception:  # noqa: BLE001
            pass
    return Loaded(r, data, mime, w or ow, h or oh, ow, oh, len(raw), note)


# --- metrics (no model) -----------------------------------------------------------

_DHASH_CACHE: dict[str, tuple[int, str]] = {}


def _dhash(im: Any) -> str:
    g = im.convert("L").resize((9, 8), Image.LANCZOS)
    px = list(g.getdata())
    bits = 0
    for row in range(8):
        for col in range(8):
            l, r = px[row * 9 + col], px[row * 9 + col + 1]
            bits = (bits << 1) | (1 if l > r else 0)
    return f"{bits:016x}"


def _hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def _letterbox(im: Any) -> dict:
    """Near-uniform bands at the edges, in pixels of the original."""
    g = im.convert("L")
    w, h = g.size
    if w < 8 or h < 8:
        return {"top": 0, "bottom": 0, "left": 0, "right": 0}
    px = g.load()

    def row(y: int) -> tuple[bool, float]:
        vals = [px[x, y] for x in range(0, w, max(1, w // 64))]
        return max(vals) - min(vals) < 12, sum(vals) / len(vals)

    def col(x: int) -> tuple[bool, float]:
        vals = [px[x, y] for y in range(0, h, max(1, h // 64))]
        return max(vals) - min(vals) < 12, sum(vals) / len(vals)

    # A band is a run of flat lines that share the EDGE line's tone: a flat
    # orange picture inside black bars must stop at the orange, even though
    # every one of its rows is flat too.
    def run(count: int, at) -> int:
        ok0, tone = at(0)
        if not ok0:
            return 0
        n = 0
        while n < count // 2:
            ok, t = at(n)
            if not ok or abs(t - tone) >= 12:
                break
            n += 1
        return n

    top = run(h, lambda i: row(i))
    bottom = run(h, lambda i: row(h - 1 - i))
    left = run(w, lambda i: col(i))
    right = run(w, lambda i: col(w - 1 - i))
    # A single edge row that happens to be flat is not a band.
    return {"top": top if top >= 4 else 0, "bottom": bottom if bottom >= 4 else 0,
            "left": left if left >= 4 else 0, "right": right if right >= 4 else 0}


def metrics(rel: str) -> dict:
    """Numbers about one image, no model: what the agent can always get."""
    target, r = _resolve_image(rel)
    raw = target.read_bytes()
    w, h = _dims_stdlib(raw)
    out: dict[str, Any] = {"path": r, "format": target.suffix.lower().lstrip("."), "width": w, "height": h,
                           "bytes": len(raw), "pillow": _PIL}
    if target.suffix.lower() == ".png":
        try:
            from . import nai
            rc = nai.recipe(raw)
            if rc:
                keep = {k: rc[k] for k in ("prompt", "uc", "negative_prompt", "seed", "model", "steps", "scale", "sampler")
                        if k in rc}
                if keep:
                    out["recipe"] = keep
        except Exception:  # noqa: BLE001
            pass
    if not _PIL:
        out["note"] = "Pillow 없음 — 밝기·선명도·레터박스·중복 분석 생략"
        return out
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.load()
            if not w:
                out["width"], out["height"] = im.size
            out["transparent"] = im.mode in ("RGBA", "LA") or "transparency" in im.info
            out["frames"] = int(getattr(im, "n_frames", 1) or 1)
            small = im.convert("RGB")
            small.thumbnail((512, 512))
            grey = small.convert("L")
            st = ImageStat.Stat(grey)
            out["brightness"] = round(st.mean[0], 1)
            out["contrast"] = round(st.stddev[0], 1)
            edges = grey.filter(ImageFilter.FIND_EDGES)
            gw, gh = edges.size
            if gw > 8 and gh > 8:
                edges = edges.crop((2, 2, gw - 2, gh - 2))   # the border rows are kernel artefacts
            var = ImageStat.Stat(edges).var[0]
            out["sharpness"] = round(var, 1)
            out["sharpnessLabel"] = "흐림" if var < 40 else ("무름" if var < 120 else "선명")
            lb = _letterbox(im)
            out["letterbox"] = lb
            out["dhash"] = _dhash(small)
            st_m = target.stat().st_mtime_ns
            _DHASH_CACHE[str(target)] = (st_m, out["dhash"])
    except Exception as e:  # noqa: BLE001
        out["note"] = f"분석 실패: {type(e).__name__}: {str(e)[:120]}"
    return out


def near_duplicates(rel: str, max_distance: int = 6) -> list[dict]:
    """Siblings in the same folder whose dhash is within `max_distance`."""
    if not _PIL:
        return []
    target, r = _resolve_image(rel)
    me = _cached_hash(target)
    if not me:
        return []
    out = []
    folder = target.parent
    n = 0
    for p in sorted(folder.iterdir()):
        if p == target or not p.is_file() or p.suffix.lower() not in files._IMAGE_SUFFIXES:
            continue
        n += 1
        if n > 200:
            break
        hh = _cached_hash(p)
        if not hh:
            continue
        d = _hamming(me, hh)
        if d <= max_distance:
            out.append({"path": p.relative_to(files._root(files.SPACE)).as_posix(), "distance": d})
    return sorted(out, key=lambda x: x["distance"])


def _cached_hash(p: Path) -> str:
    try:
        st_m = p.stat().st_mtime_ns
    except OSError:
        return ""
    hit = _DHASH_CACHE.get(str(p))
    if hit and hit[0] == st_m:
        return hit[1]
    try:
        with Image.open(p) as im:
            im.load()
            small = im.convert("RGB")
            small.thumbnail((512, 512))
            hh = _dhash(small)
    except Exception:  # noqa: BLE001
        return ""
    _DHASH_CACHE[str(p)] = (st_m, hh)
    return hh


def fmt_metrics(m: dict, dupes: list[dict] | None = None) -> str:
    """One compact block the agent can read at a glance."""
    lines = [f"측정: {m.get('path')} · {m.get('format', '').upper()} {m.get('width')}×{m.get('height')} · {int(m.get('bytes') or 0) // 1024}KB"]
    if "brightness" in m:
        b = m["brightness"]
        bl = "어두움" if b < 60 else ("밝음" if b > 200 else "보통")
        lines.append(f"밝기 {b}/255 ({bl}) · 대비 {m.get('contrast')} · 선명도 {m.get('sharpness')} ({m.get('sharpnessLabel')})")
        lb = m.get("letterbox") or {}
        bands = [f"{k} {v}px" for k, v in (("상", lb.get("top")), ("하", lb.get("bottom")),
                                            ("좌", lb.get("left")), ("우", lb.get("right"))) if v]
        lines.append("레터박스 " + (", ".join(bands) if bands else "없음")
                     + (" · 투명 배경" if m.get("transparent") else "")
                     + (f" · 프레임 {m['frames']} (첫 프레임만 봄)" if int(m.get("frames") or 1) > 1 else ""))
    if m.get("note"):
        lines.append(m["note"])
    rc = m.get("recipe")
    if rc:
        pr = str(rc.get("prompt") or "")
        lines.append("NAI 프롬프트: " + (pr[:300] + ("…" if len(pr) > 300 else "")))
        neg = str(rc.get("uc") or rc.get("negative_prompt") or "")
        if neg:
            lines.append("NAI 네거티브: " + neg[:160] + ("…" if len(neg) > 160 else ""))
        if rc.get("seed") is not None:
            lines.append(f"seed {rc.get('seed')} · {rc.get('model', '')} · steps {rc.get('steps', '')} · scale {rc.get('scale', '')}")
    if dupes:
        lines.append("근접 중복: " + ", ".join(f"{d['path'].split('/')[-1]} (거리 {d['distance']})" for d in dupes[:6]))
    return "\n".join(lines)


# --- refusal detection ------------------------------------------------------------

_REFUSAL_RE = re.compile(
    r"^\W*(i[’']?m sorry|i can(?:no|[’'])t|i am unable|i[’']?m unable|i won[’']?t|i[’']?m not able|"
    r"i cannot|sorry, (but )?i|as an ai)|"
    r"(can(?:no|[’'])t|unable to|not able to) (help|assist|describe|analy[sz]e|comply|provide|view)|"
    r"(content|usage|safety) (policy|policies|guidelines)|"
    r"(explicit|sexual|adult|nsfw) (content|material|imagery).{0,60}(cannot|can[’']t|won[’']t|not able|unable)|"
    r"도와드릴 수 없|답변할 수 없|묘사할 수 없|분석할 수 없|부적절한 (이미지|콘텐츠|내용)|정책상|제공할 수 없",
    re.I | re.S,
)
_SAFETY_BODY_RE = re.compile(r"safety|blocked|content_policy|content policy|PROHIBITED|inappropriate|flagged|moderation", re.I)


def is_refusal(text: str | None, *, status: int | None = None, body: str | None = None,
               finish_reason: str | None = None) -> str | None:
    """A reason code when the helper refused, else None. An HTTP error is a
    refusal only when its body talks about safety; any other error (a 500,
    a bad URL) is a failure, not a refusal - the empty-text rule below is
    for successful replies only."""
    if status is not None and int(status) >= 400:
        if status in (400, 403, 422) and body and _SAFETY_BODY_RE.search(body):
            return "http-safety"
        return None
    fr = str(finish_reason or "").lower()
    if fr in ("content_filter", "safety", "prohibited_content", "blocklist", "recitation"):
        return "finish-" + fr
    if body and '"blockReason"' in body:
        return "blocked"
    t = (text or "").strip()
    if not t:
        return "empty"
    head = t[:300]
    if _REFUSAL_RE.search(head):
        # A long, substantive description that merely contains a hedge is not
        # a refusal - refusals are short.
        if len(t) > 600 and not _REFUSAL_RE.match(head):
            return None
        return "text-refusal"
    return None


# --- the helper endpoint ------------------------------------------------------------

def _data_uri(img: Loaded) -> str:
    return f"data:{img.mime};base64," + base64.b64encode(img.data).decode("ascii")


async def describe_with_helper(images: list[Loaded], question: str, instructions: str | None = None) -> str:
    """One chat/completions call with the pictures inline. Raises RefusalError
    on a refusal, RuntimeError on any other failure."""
    import httpx
    base, key, model = _helper()
    if not base:
        raise RuntimeError("helper base URL not set")
    parts: list[dict] = [{"type": "text", "text": question}]
    for i, img in enumerate(images, 1):
        if len(images) > 1:
            parts.append({"type": "text", "text": f"[{i}] {img.rel}"})
        parts.append({"type": "image_url", "image_url": {"url": _data_uri(img), "detail": detail()}})
    body = {
        "model": model,
        "messages": [{"role": "system", "content": instructions or helper_instructions()},
                     {"role": "user", "content": parts}],
        "max_tokens": 1200,
        "temperature": 0.2,
    }
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    async with httpx.AsyncClient(timeout=timeout_s()) as c:
        r = await c.post(base + "/chat/completions", headers=headers, json=body)
    if r.status_code >= 400:
        code = is_refusal("", status=r.status_code, body=r.text)
        if code:
            raise RefusalError(code, r.text[:200])
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
    try:
        d = r.json()
        choice = (d.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            content = "".join(str(p.get("text") or "") for p in content if isinstance(p, dict))
        text = str(content or "").strip()
        code = is_refusal(text, finish_reason=str(choice.get("finish_reason") or ""), body=r.text[:2000])
        if code:
            raise RefusalError(code, text[:200])
        return text
    except RefusalError:
        raise
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"unexpected reply: {type(e).__name__}: {str(e)[:200]} :: {r.text[:200]}") from e


# --- what the tools return -----------------------------------------------------------

_SETTINGS_HINT = "⚙ → 에이전트 → 비전 툴 (an uncensored/local helper such as Ollama qwen2.5-vl can be set there)"


def _refused_text(code: str, who: str, blocks: list[str]) -> str:
    return (f"VISION REFUSED by {who} ({code}). You have NOT seen this image. Report only the measured "
            f"numbers below and tell the user the vision model declined; suggest {_SETTINGS_HINT}.\n\n"
            + "\n\n".join(blocks))


def _push(session_id: str | None, obj: dict) -> None:
    from . import session as session_mod
    session_mod.push_stream_event(session_id, obj)


def _image_content(images: list[Loaded]) -> list:
    """The `content` of a native-mode ToolReturn: a caption then each picture."""
    from pydantic_ai.messages import BinaryImage
    out: list = []
    for i, img in enumerate(images, 1):
        label = f"[{i}] " if len(images) > 1 else ""
        out.append(f"{label}This is image {img.rel} ({img.orig_w}×{img.orig_h}, shown at {img.w}×{img.h}):")
        out.append(BinaryImage(img.data, media_type=img.mime,
                               identifier=hashlib.sha1(img.rel.encode("utf-8")).hexdigest()[:8],
                               vendor_metadata={"detail": detail()}))
    return out


async def view(session_id: str | None, rels: list[str], question: str, *, label: str = "") -> Any:
    """The body of view_image / compare_images. Returns a str, or a ToolReturn
    (native mode) whose content carries the pictures. Never raises."""
    from pydantic_ai.messages import ToolReturn
    rels = [r for r in (rels or []) if str(r or "").strip()]
    if not rels:
        return "No image path given."
    if len(rels) > max_images():
        return f"At most {max_images()} images per call (got {len(rels)}). Split the call."
    n = _take_call(session_id)
    if n is None:
        return (f"Vision budget for this turn is used up ({max_calls()} calls). Say so to the user and continue "
                "with what you have; the budget resets next turn.")
    loaded: list[Loaded] = []
    blocks: list[str] = []
    for r in rels:
        try:
            img = load_image(r)
        except VisionError as e:
            blocks.append(f"{r}: cannot view — {e}")
            continue
        loaded.append(img)
        try:
            m = metrics(r)
            d = near_duplicates(r) if len(rels) == 1 else []
            blocks.append(fmt_metrics(m, d) + (f"\n({img.note})" if img.note else ""))
        except Exception as e:  # noqa: BLE001
            blocks.append(f"{r}: metrics failed — {type(e).__name__}: {str(e)[:120]}")
    if not loaded:
        return "\n".join(blocks) or "Nothing could be loaded."
    if len(loaded) > 1:
        pairs = []
        hs = [(img.rel, _DHASH_CACHE.get(str(files._resolve(files.SPACE, img.rel)), (0, ""))[1]) for img in loaded]
        for i in range(len(hs)):
            for j in range(i + 1, len(hs)):
                if hs[i][1] and hs[j][1]:
                    dist = _hamming(hs[i][1], hs[j][1])
                    if dist <= 6:
                        pairs.append(f"[{i + 1}]≈[{j + 1}] near-duplicate (distance {dist})")
        if pairs:
            blocks.append("\n".join(pairs))
    _push(session_id, {"type": "viewed", "paths": [img.rel for img in loaded],
                       "label": label or (f"보기: {question[:60]}" if question else "보기"), "mode": mode()})
    q = question.strip() or "Describe what is in the image: subject, pose, expression, clothing, background, and anything wrong (hands, eyes, cropping, text)."
    m = mode()
    numbers = "\n\n".join(blocks)
    if m == "off":
        return f"(vision is off — numbers only; {why_not()})\n\n{numbers}"
    if m == "helper":
        base, key, model = _helper()
        if not ready():
            return f"(vision helper not configured — numbers only; {why_not()})\n\n{numbers}"
        try:
            answer = await describe_with_helper(loaded, q)
        except RefusalError as e:
            log.warn("vision helper refused (%s): %s", e.code, e.snippet[:80])
            return _refused_text(e.code, f"helper {model}", blocks)
        except Exception as e:  # noqa: BLE001
            log.warn("vision helper failed: %s", e)
            return f"(vision helper failed: {type(e).__name__}: {str(e)[:200]} — numbers only)\n\n{numbers}"
        return f"[helper {model} · call {n}/{max_calls()}] {answer}\n\n{numbers}"
    # native
    if not native_ok():
        return f"(native vision not verified for this model — numbers only; {why_not()})\n\n{numbers}"
    return ToolReturn(
        return_value=(f"Image{'s' if len(loaded) > 1 else ''} attached below (call {n}/{max_calls()}). "
                      f"Question: {q}\n\n{numbers}"),
        content=_image_content(loaded),
    )


# --- history hygiene -------------------------------------------------------------------

def scrub_history(messages: list) -> list:
    """Replace every image inside a UserPromptPart with a placeholder, so the
    stored history never carries bytes. Pure; idempotent; other parts untouched."""
    from dataclasses import replace as _replace
    from pydantic_ai.messages import BinaryContent, ModelRequest, UserPromptPart
    out = []
    for m in messages:
        if not isinstance(m, ModelRequest):
            out.append(m)
            continue
        parts = []
        changed = False
        for p in m.parts:
            if isinstance(p, UserPromptPart) and isinstance(p.content, list):
                new: list = []
                dirty = False
                for item in p.content:
                    if isinstance(item, BinaryContent):
                        ident = getattr(item, "identifier", None) or ""
                        new.append(f"[image omitted from stored history{': ' + ident if ident else ''}; "
                                   "call view_image again if you need to see it]")
                        dirty = True
                    else:
                        new.append(item)
                if dirty:
                    merged: list = []
                    for item in new:
                        if isinstance(item, str) and merged and isinstance(merged[-1], str):
                            merged[-1] = merged[-1] + "\n" + item
                        else:
                            merged.append(item)
                    p = _replace(p, content=merged[0] if len(merged) == 1 and isinstance(merged[0], str) else merged)
                    changed = True
            parts.append(p)
        out.append(_replace(m, parts=parts) if changed else m)
    return out


def short_content(v: Any) -> Any:
    """What the agent log may show of a tool result: binary parts become a
    short label instead of their repr."""
    if hasattr(v, "media_type") and hasattr(v, "data"):
        try:
            return f"[{v.media_type} {len(v.data) // 1024}KB]"
        except Exception:  # noqa: BLE001
            return "[binary]"
    if isinstance(v, list):
        return [short_content(x) for x in v]
    if hasattr(v, "return_value"):
        return short_content(getattr(v, "return_value"))
    return v


# --- the probe and the card's test ---------------------------------------------------

def sample_png() -> bytes:
    """A 64×64 PNG, left half red, right half blue - a picture no model can
    refuse and every model can name."""
    w = h = 64
    rows = []
    for _y in range(h):
        row = bytearray([0])
        for x in range(w):
            row += bytes((220, 30, 30) if x < w // 2 else (30, 60, 220))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


_PROBE_Q = "Which two colours fill this image? Answer in one short line."
_COLOUR_RE = re.compile(r"red|blue|빨강|빨간|파랑|파란|청색|적색", re.I)


def _sample_loaded() -> Loaded:
    data = sample_png()
    return Loaded("(sample)", data, "image/png", 64, 64, 64, 64, len(data))


async def probe_native() -> dict:
    """Send the sample through the REAL agent model; remember the verdict."""
    from pydantic_ai import Agent
    from pydantic_ai.messages import BinaryImage
    from . import agent as agent_mod
    model_name = agent_model_name()
    rec: dict[str, Any] = {"model": model_name, "ok": False, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "error": ""}
    text = ""
    try:
        ag = Agent(agent_mod._model_for("agent"), instructions="Answer in one short line.")
        r = await ag.run([_PROBE_Q, BinaryImage(sample_png(), media_type="image/png", identifier="probe")])
        text = str(r.output or "")
        rec["ok"] = bool(_COLOUR_RE.search(text))
        if not rec["ok"]:
            rec["error"] = f"answered without naming a colour: {text[:120]}"
    except Exception as e:  # noqa: BLE001
        rec["error"] = f"{type(e).__name__}: {str(e)[:300]}"
    config.update({"vision": {"nativeProbe": rec}})
    rec["text"] = text[:300]
    return rec


async def test(path: str = "", question: str = "") -> dict:
    """The card's 테스트: exactly what the tool does, on a chosen image or the
    built-in sample. In native mode this is the probe."""
    t0 = time.time()
    m = mode()
    q = question.strip() or (_PROBE_Q if not path else "Describe this image in two sentences.")
    out: dict[str, Any] = {"ok": False, "mode": m, "detail": "", "path": path, "text": "", "metrics": None,
                           "refused": False, "ms": 0, "error": ""}
    try:
        if path:
            img = load_image(path)
            out["metrics"] = metrics(path)
        else:
            img = _sample_loaded()
        out["detail"] = f"{img.w}×{img.h}"
        if m == "off":
            out["ok"] = True
            out["text"] = "(off) 수치 분석만 됩니다." + ("" if path else " 경로를 주면 그 이미지의 수치를 보여줍니다.")
        elif m == "helper":
            base, key, model = _helper()
            if not ready():
                out["error"] = why_not()
            else:
                out["detail"] = f"{model} @ {_host(base)} · {img.w}×{img.h}"
                try:
                    out["text"] = await describe_with_helper([img], q)
                    out["ok"] = True
                except RefusalError as e:
                    out["refused"] = True
                    out["error"] = f"거절됨 ({e.code}): {e.snippet[:200]}"
        else:
            rec = await probe_native()
            out["detail"] = f"{rec.get('model')} · probe"
            out["ok"] = bool(rec.get("ok"))
            out["text"] = str(rec.get("text") or "")
            out["error"] = "" if rec.get("ok") else str(rec.get("error") or "")
            if path and rec.get("ok"):
                out["text"] += "\n(프로브 통과 — 실제 이미지는 에이전트 대화에서 view_image 로 보입니다)"
    except VisionError as e:
        out["error"] = str(e)
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {str(e)[:300]}"
    out["ms"] = int((time.time() - t0) * 1000)
    return out
