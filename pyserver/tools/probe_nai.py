"""Measure NovelAI's image API before writing a line against it.

This repository started with `docs/01-phase0-results.md` - a probe run against
the real host, whose table the implementation was then written from - and the
asset studio starts the same way. Model ids and parameter names on an image
service move faster than anything else in this project, and a client written
from memory is a client that is quietly wrong.

    probe_nai.py                                   free: accounts, routes, schema
    probe_nai.py --models a,b,c                    free: do these model ids exist
    probe_nai.py --generate --model <id>           one image (free at Opus tier)
    probe_nai.py --vibe <png|zip> --model <id>     COSTS ANLAS: encode-vibe + director tools

**Free by default.** Measured 2026-08-29: plain generation costs nothing, an
`encode-vibe` costs 2 Anlas, and a director tool about 10 - so the calls that
spend anything sit behind `--vibe`, and it prints the balance either side of
each one. Everything else - who the token belongs to, what the subscription
holds, which endpoints answer, which model ids exist - is free.

The token is read from the `api_keys` row whose provider is `novelai`, or from
`--token`, or from `NAI_TOKEN`. It is never printed.

Raw bodies land in `--raw-dir` (default `data/nai-probe/`) so the shapes can be
read afterwards rather than guessed from a truncated line.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

from app import config  # noqa: E402

# Candidates, not conclusions. Each is tried and what came back is recorded;
# the report says which ones answered. Anything asserted here without a
# measurement behind it is exactly what this script exists to avoid.
HOSTS = ("https://image.novelai.net", "https://api.novelai.net")

# Cheap and side-effect free: identity, entitlement, and any published schema.
#
# Measured 2026-08-29: `api.novelai.net/user/*` answers 400 "Please refresh
# NovelAI.net. If using a third-party tool, update to the image URL." - so the
# account endpoints a third party may use live under image.novelai.net now.
# The api.novelai.net entries stay in the list precisely because that refusal
# is the finding; dropping them would lose the evidence on the next run.
READ_PROBES = (
    ("GET", "https://image.novelai.net/user/subscription", None),
    ("GET", "https://image.novelai.net/user/data", None),
    ("GET", "https://image.novelai.net/user/information", None),
    ("GET", "https://api.novelai.net/user/subscription", None),
    ("GET", "https://api.novelai.net/openapi.json", None),
    # Answers 200, but it is an "Observability API" for error tracking only -
    # there is no published schema for image generation. Kept as evidence.
    ("GET", "https://image.novelai.net/openapi.json", None),
)

# The model enum is not published anywhere, so it is drawn out of the
# validator: a model that cannot exist makes the service say what it accepts,
# if it says anything at all. Costs nothing - it never reaches generation.
ENUM_BAIT = "risu-hina-probe-not-a-model"

# Does the route exist at all? A POST with an empty object should come back as
# a validation error (422/400) if the route is real and a 404 if it is not -
# which is the distinction we need, without spending anything.
EXIST_PROBES = tuple(
    (h, p) for h in HOSTS
    for p in ("/ai/generate-image", "/ai/generate-image/stream",
              "/ai/augment-image", "/ai/annotate-image", "/ai/upscale")
)


ENV_NAMES = ("NAI_API_KEY", "NAI_TOKEN")
ENV_FILES = ("NAI_KEY.env", ".env")


def _from_env_file(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        if name.strip() in ENV_NAMES:
            return value.strip().strip('"').strip("'")
    return ""


def _from_keys_table() -> tuple[str, str]:
    """The api_keys row, opened READ-ONLY.

    Never `db.connect()` here: that runs schema migrations as a side effect, so
    a "read-only probe" would rewrite the store - and if the service is running
    against the same file, two writers. A probe measures; it does not migrate.
    """
    import sqlite3
    f = config.DATA_DIR / "risuhina.db"
    if not f.is_file():
        return "", ""
    try:
        con = sqlite3.connect(f"file:{f.as_posix()}?mode=ro", uri=True, timeout=5)
        try:
            con.execute("PRAGMA query_only = 1")
            for name, provider, api_key in con.execute(
                    "SELECT name, provider, api_key FROM api_keys"):
                if str(provider or "").lower() in ("novelai", "nai") and api_key:
                    return str(api_key), f"api_keys row {name!r} (read-only)"
        finally:
            con.close()
    except sqlite3.Error as e:
        print(f"  (api_keys not readable: {e})")
    return "", ""


def resolve_token(explicit: str, env_file: str) -> tuple[str, str]:
    """(token, where it came from). The token itself is never printed."""
    import os
    if explicit:
        return explicit, "--token"
    for name in ENV_NAMES:
        if os.environ.get(name):
            return os.environ[name], f"${name}"
    roots = [Path.cwd(), ROOT, ROOT.parent, ROOT.parent.parent]
    candidates = [Path(env_file)] if env_file else [
        r / n for r in roots for n in ENV_FILES]
    for p in candidates:
        value = _from_env_file(p)
        if value:
            return value, str(p)
    config.load()
    return _from_keys_table()


def describe(r: httpx.Response) -> str:
    ct = r.headers.get("content-type", "")
    n = len(r.content)
    if "json" in ct or ct.startswith("text/"):
        body = r.text[:400].replace("\n", " ")
        return f"{r.status_code} {ct} {n}B :: {body}"
    magic = r.content[:4].hex()
    kind = {"504b0304": "ZIP", "89504e47": "PNG"}.get(magic, "?")
    return f"{r.status_code} {ct} {n}B :: binary magic={magic} ({kind})"


_seq = 0


def save(raw_dir: Path, name: str, r: httpx.Response) -> None:
    # Numbered: several probes hit the same URL with different bodies, and
    # naming files by URL alone had the last one overwrite the interesting one.
    global _seq
    _seq += 1
    raw_dir.mkdir(parents=True, exist_ok=True)
    ext = ".json" if "json" in r.headers.get("content-type", "") else ".bin"
    (raw_dir / f"{_seq:02d}_{name}{ext}").write_bytes(r.content)


def slug(url: str) -> str:
    return url.split("://", 1)[-1].replace("/", "_").replace(".", "-")


def probe(client: httpx.Client, method: str, url: str, body, raw_dir: Path) -> httpx.Response | None:
    t0 = time.time()
    try:
        r = client.request(method, url, json=body) if body is not None else client.request(method, url)
    except Exception as e:
        print(f"  {method:4} {url}\n       FAIL {type(e).__name__}: {e}")
        return None
    ms = int((time.time() - t0) * 1000)
    print(f"  {method:4} {url}\n       {ms}ms  {describe(r)}")
    save(raw_dir, f"{method.lower()}_{slug(url)}", r)
    return r


def report_account(sub: dict) -> None:
    """Anlas and quota, named as the service actually names them.

    The panel is going to show "how much is left", so the field names matter as
    much as the numbers: they are what `nai.py` will read. Printed as the whole
    shape minus anything that looks like a credential, rather than as a guess at
    which three keys matter.
    """
    print("\n  account:")
    hide = ("token", "key", "secret", "password", "email", "auth")
    def walk(d, prefix=""):
        for k in sorted(d):
            v = d[k]
            if any(h in k.lower() for h in hide):
                print(f"    {prefix}{k}: <hidden>")
            elif isinstance(v, dict):
                walk(v, prefix + k + ".")
            elif isinstance(v, list):
                print(f"    {prefix}{k}: [{len(v)} items]")
            else:
                print(f"    {prefix}{k}: {v}")
    walk(sub)
    # The two the studio needs a name for. Reported as found/not found so the
    # answer is a measurement either way.
    for want in ("trainingStepsLeft", "fixedTrainingStepsLeft", "purchasedTrainingSteps"):
        hit = json.dumps(sub).find(want) >= 0
        print(f"    [anlas candidate] {want}: {'present' if hit else 'ABSENT'}")


def report_schema(spec: dict) -> None:
    """The jackpot case: a published schema names every parameter for us."""
    paths = spec.get("paths") or {}
    print(f"\n  schema: {len(paths)} paths")
    for p in sorted(paths):
        if "image" in p or "ai/" in p:
            print(f"    {p}  {sorted(paths[p].keys())}")
    schemas = ((spec.get("components") or {}).get("schemas") or {})
    for name in sorted(schemas):
        if "image" in name.lower() or "generat" in name.lower() or "param" in name.lower():
            props = (schemas[name].get("properties") or {})
            print(f"    schema {name}: {sorted(props)[:40]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default="", help="NAI persistent token (else api_keys / NAI_TOKEN)")
    ap.add_argument("--generate", action="store_true", help="also make ONE image (costs Anlas)")
    ap.add_argument("--model", default="", help="model id for --generate (measured ids are printed above)")
    ap.add_argument("--raw-dir", default="", help="where to write raw bodies (default data/nai-probe)")
    ap.add_argument("--env-file", default="", help="file holding NAI_API_KEY=... (default: search NAI_KEY.env / .env upward)")
    ap.add_argument("--models", default="", help="comma-separated model ids to test for existence (free)")
    ap.add_argument("--no-director", action="store_true",
                    help="with --vibe, skip the director tools (~10 Anlas each)")
    ap.add_argument("--vibe", default="", help="path to a PNG (or a saved response ZIP): probe encode-vibe and "
                                              "the director tools with it. COSTS ANLAS (see docs/09 7, 7b)")
    ap.add_argument("--charref", default="", help="path to a PNG (or a saved response ZIP): probe the DIRECTOR "
                                                 "REFERENCE (character reference) request shape. Generation-priced "
                                                 "(free at Opus tier); the balance is printed either side anyway")
    args = ap.parse_args()

    token, source = resolve_token(args.token, args.env_file)
    if not token:
        print("no NAI token found. Any of:")
        print("  --token <t> | NAI_API_KEY / NAI_TOKEN in the environment")
        print("  a NAI_KEY.env or .env file with NAI_API_KEY=... (cwd, pyserver, repo root, its parent)")
        print("  an api_keys row whose provider is 'novelai' (Settings -> API keys)")
        return 1
    print(f"token   : set ({len(token)} chars) from {source}")

    raw_dir = Path(args.raw_dir) if args.raw_dir else (config.DATA_DIR / "nai-probe")
    print(f"raw     : {raw_dir}")

    headers = {"Authorization": f"Bearer {token}",
               "Content-Type": "application/json",
               "User-Agent": f"{config.APP_NAME}/{config.VERSION}"}
    spec = None
    with httpx.Client(headers=headers, timeout=120, follow_redirects=True) as c:
        print("\n[1/3] identity, entitlement, published schema")
        for method, url, body in READ_PROBES:
            r = probe(c, method, url, body, raw_dir)
            if r is None or r.status_code != 200:
                continue
            if url.endswith("openapi.json") and spec is None:
                try:
                    spec = r.json()
                except Exception:
                    pass
            if url.endswith(("/user/subscription", "/user/data")):
                try:
                    report_account(r.json())
                except Exception:
                    pass
        if spec:
            report_schema(spec)

        print("\n[2/3] which routes exist (empty POST: 4xx validation = real, 404 = not)")
        for host, path in EXIST_PROBES:
            probe(c, "POST", host + path, {}, raw_dir)

        print("\n[2b/3] what the validator says about model / parameters")
        for host in HOSTS:
            for body in (
                {"input": "x", "model": ENUM_BAIT, "parameters": {}},
                {"input": "x", "model": ENUM_BAIT, "action": "generate", "parameters": {}},
            ):
                probe(c, "POST", host + "/ai/generate-image", body, raw_dir)
        # augment-image answered "Model doesn't support action", so the request
        # names a director action. `NOT_AN_ACTION` is the control: without it a
        # 500 on a real name proves nothing, because malformed input 500s too.
        # Only a DIFFERENT answer for the control makes the names a finding.
        for act in ("", "NOT_AN_ACTION_CONTROL", "bg-removal", "emotion",
                    "declutter", "lineart", "colorize"):
            probe(c, "POST", "https://image.novelai.net/ai/augment-image",
                  {"req_type": act, "model": ENUM_BAIT, "image": "", "parameters": {}}, raw_dir)

        if args.models:
            # Zero-Anlas existence oracle: the validator answers "model <id>
            # doesn't exist" before it charges anything, so a model id can be
            # checked for free. This is why the studio stores model ids as
            # data with a check button rather than shipping a list that goes
            # stale - the service itself is the list.
            print("\n[2c/3] model id existence (free - rejected before generation)")
            for m in [s.strip() for s in args.models.split(",") if s.strip()]:
                # 7x7 is the load-bearing part. With `parameters: {}` the
                # service fills in defaults and **generates** - measured
                # 2026-08-29, `nai-diffusion-3` answered 200 with a 513KB ZIP
                # from what was meant to be a free existence check. An
                # impossible size fails at generation setup (500) while the
                # model check (400 "doesn't exist") still runs first, so the
                # answer is the same and nothing is ever produced.
                r = probe(c, "POST", "https://image.novelai.net/ai/generate-image",
                          {"input": "x", "model": m,
                           "parameters": {"width": 7, "height": 7}}, raw_dir)
                if r is None:
                    continue
                text = r.text
                verdict = "ABSENT" if "doesn't exist" in text else "EXISTS (rejected later)"
                print(f"       -> {m}: {verdict}")

        if args.vibe:
            # The paid paths, measured one call at a time so the price is
            # attributable. Everything here is in docs/09 §7 and §7b; this is
            # what re-checks it when NovelAI changes something.
            import base64
            import zipfile
            import io as _io
            print("\n[2d/3] vibe transfer and director tools  (COSTS ANLAS)")

            def anlas() -> int:
                d = c.get("https://image.novelai.net/user/subscription").json()
                t = d.get("trainingStepsLeft") or {}
                return int(t.get("fixedTrainingStepsLeft", 0)) + int(t.get("purchasedTrainingSteps", 0))

            model = args.model or "nai-diffusion-4-5-full"
            seed_png = Path(args.vibe).read_bytes()
            if seed_png[:4].hex() == "504b0304":  # a saved response ZIP
                seed_png = zipfile.ZipFile(_io.BytesIO(seed_png)).read("image_0.png")
            img = base64.b64encode(seed_png).decode()

            a0 = anlas()
            r = probe(c, "POST", "https://image.novelai.net/ai/encode-vibe",
                      {"model": model, "image": img, "information_extracted": 1.0}, raw_dir)
            a1 = anlas()
            print(f"       -> encode-vibe cost {a0 - a1} Anlas ({a0} -> {a1})")
            if r is None or r.status_code >= 300:
                print("       encode failed; skipping the rest")
            else:
                enc = base64.b64encode(r.content).decode()
                print(f"       encoding is {len(r.content)} bytes")
                # A raw image here is a 500: the encode step is mandatory.
                for label, ref in (("encoded", enc), ("raw image (expect 500)", img)):
                    # The full set. A shorter one 500s: v4_negative_prompt and
                    # negative_prompt are not optional for the v4.5 models,
                    # which cost a probe run to find out.
                    neg = "blurry"
                    params = {
                        "params_version": 3, "width": 832, "height": 1216, "scale": 5,
                        "sampler": "k_euler_ancestral", "steps": 23, "n_samples": 1,
                        "seed": 999, "noise_schedule": "karras", "cfg_rescale": 0,
                        "ucPreset": 0, "qualityToggle": True, "negative_prompt": neg,
                        "v4_prompt": {"caption": {"base_caption": "a cat", "char_captions": []},
                                      "use_coords": False, "use_order": True},
                        "v4_negative_prompt": {"caption": {"base_caption": neg, "char_captions": []},
                                               "legacy_uc": False},
                        "reference_image_multiple": [ref],
                        "reference_information_extracted_multiple": [1.0],
                        "reference_strength_multiple": [0.6],
                    }
                    probe(c, "POST", "https://image.novelai.net/ai/generate-image",
                          {"input": "a cat", "model": model, "action": "generate",
                           "parameters": params}, raw_dir)
                    print(f"       -> {label}")
                a2 = anlas()
                print(f"       generation with a vibe cost {a1 - a2} Anlas")

            if args.no_director:
                print("\n       director tools: skipped (--no-director)")
                return 0
            print("\n       director tools (each ~10 Anlas):")
            b0 = anlas()
            for rt in ("emotion", "bg-removal", "lineart", "declutter", "colorize", "sketch"):
                probe(c, "POST", "https://image.novelai.net/ai/augment-image",
                      {"req_type": rt, "model": model, "image": img,
                       "width": 832, "height": 1216, "prompt": "happy"}, raw_dir)
            b1 = anlas()
            print(f"       -> six director calls cost {b0 - b1} Anlas ({b0} -> {b1})")

        if args.charref:
            # The director reference (캐릭터 레퍼런스), request shape as MEASURED
            # on 2026-08-30 (docs/09 §7d). Re-running re-checks every fact:
            #   - director_reference_strength_values is the request name (the
            #     PNG Comment echoes it back as director_reference_strengths);
            #   - descriptions are V4ConditionInput objects, not strings;
            #   - information_extracted must be EXACTLY 1.0 (the validator says
            #     so in words);
            #   - the image must be resized to the 1024x1536 / 1536x1024 bucket
            #     first - other sizes 400 inside the internal /encode-director
            #     service (the v5 hosts have no such service: v4.5-only);
            #   - COSTS 5 ANLAS per accepted generation, Opus included.
            import base64
            import zipfile
            import io as _io
            print("\n[2e/3] director reference (character reference) - COSTS ~5 ANLAS per 200")

            def anlas() -> int:
                d = c.get("https://image.novelai.net/user/subscription").json()
                t = d.get("trainingStepsLeft") or {}
                return int(t.get("fixedTrainingStepsLeft", 0)) + int(t.get("purchasedTrainingSteps", 0))

            def recipe_of(r: httpx.Response) -> dict:
                """The applied parameters, read back out of the returned PNG."""
                try:
                    png = zipfile.ZipFile(_io.BytesIO(r.content)).read("image_0.png")
                    from app import nai as _nai
                    return (_nai.recipe(png) or {}).get("parameters") or {}
                except Exception as e:  # noqa: BLE001
                    print(f"       (recipe unreadable: {type(e).__name__}: {e})")
                    return {}

            seed_png = Path(args.charref).read_bytes()
            if seed_png[:4].hex() == "504b0304":
                seed_png = zipfile.ZipFile(_io.BytesIO(seed_png)).read("image_0.png")
            # The bucket resize needs Pillow, which the release bundle never
            # ships - this is a dev tool, so a missing install is an instruction
            # rather than an import crash.
            try:
                from PIL import Image
            except ImportError:
                print("       Pillow is needed to fit the reference into the 1024x1536 bucket:")
                print("         pyserver/.venv/Scripts/python.exe -m pip install pillow")
                return 1
            im = Image.open(_io.BytesIO(seed_png)).convert("RGB")
            w, h = (1536, 1024) if im.width > im.height else (1024, 1536)
            want = w / h
            if im.width / im.height > want:
                nw = int(im.height * want)
                im = im.crop(((im.width - nw) // 2, 0, (im.width + nw) // 2, im.height))
            else:
                nh = int(im.width / want)
                im = im.crop((0, (im.height - nh) // 2, im.width, (im.height + nh) // 2))
            buf = _io.BytesIO()
            im.resize((w, h), Image.LANCZOS).save(buf, "PNG")
            img = base64.b64encode(buf.getvalue()).decode()
            print(f"       reference fitted to {w}x{h}")
            neg = "blurry"

            director = {
                "director_reference_images": [img],
                "director_reference_descriptions": [
                    {"caption": {"base_caption": "", "char_captions": []}, "legacy_uc": False}],
                "director_reference_information_extracted": [1.0],
                "director_reference_strength_values": [1.0],
            }
            params = {
                "params_version": 3, "width": 832, "height": 1216, "scale": 5,
                "sampler": "k_euler_ancestral", "steps": 23, "n_samples": 1,
                "seed": 999, "noise_schedule": "karras", "cfg_rescale": 0,
                "ucPreset": 0, "qualityToggle": True, "negative_prompt": neg,
                "v4_prompt": {"caption": {"base_caption": "1girl, standing", "char_captions": []},
                              "use_coords": False, "use_order": True},
                "v4_negative_prompt": {"caption": {"base_caption": neg, "char_captions": []},
                                       "legacy_uc": False},
                **director,
            }
            model = args.model or "nai-diffusion-4-5-full"
            a0 = anlas()
            print(f"       Anlas before: {a0}")
            r = probe(c, "POST", "https://image.novelai.net/ai/generate-image",
                      {"input": "1girl, standing", "model": model, "action": "generate",
                       "parameters": params}, raw_dir)
            a1 = anlas()
            print(f"       -> cost {a0 - a1} Anlas ({a0} -> {a1})")
            if r is not None and r.status_code < 300:
                applied = {k: v for k, v in recipe_of(r).items() if "director" in k.lower()}
                print("       applied director fields in the PNG Comment:")
                for k in sorted(applied):
                    print(f"         {k}: {json.dumps(applied[k], ensure_ascii=False)[:140]}")
            print("       any change from docs/09 §7d belongs in that file.")

        if not args.generate:
            print("\n[3/3] generation  SKIPPED (costs Anlas). Re-run with --generate --model <id>.")
            print("\nRead the raw bodies above into docs/09-nai-probe.md as a table of MEASURED facts.")
            return 0

        if not args.model:
            print("\n[3/3] generation  needs --model <id> (take one from the schema/subscription above).")
            return 1

        print(f"\n[3/3] one image, model={args.model}")
        # Deliberately minimal and deliberately literal: the point is to learn
        # which key names are accepted and what comes back, not to make a good
        # picture. A rejection here is a result, not a failure - the error body
        # is what names the fields this service actually wants.
        body = {
            "input": "a cat",
            "model": args.model,
            "action": "generate",
            "parameters": {"width": 512, "height": 512, "n_samples": 1, "steps": 1},
        }
        print("  request body keys: " + json.dumps(sorted(body)) +
              " / parameters: " + json.dumps(sorted(body["parameters"])))
        for host in HOSTS:
            r = probe(c, "POST", host + "/ai/generate-image", body, raw_dir)
            if r is not None and r.status_code < 300:
                print(f"  -> accepted by {host}; raw body saved. Unzip it if magic says ZIP.")
                break

    print("\nNow write docs/09-nai-probe.md from what is above and from the raw bodies.")
    print("Only facts that appear in this output belong in that file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
