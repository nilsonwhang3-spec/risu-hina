"""Layered configuration and the auth token bootstrap.

Shape follows active-recall's config.py because that layering has held up:
defaults dict -> merged per-section with data/config.json -> a template written
on first run -> never fatal on a parse error. An operator who breaks the JSON
should get a running server with defaults and a loud log line, not a service
that refuses to start.

Access policy (plan section 7.1), stated once here so the dispatcher does not
have to re-derive it:

  loopback client  -> token optional (RISUHINA_REQUIRE_TOKEN=1 forces it)
  any other client -> token REQUIRED, and this cannot be switched off

The second rule is not configurable on purpose. `run_python` has no permission
limits, so whoever holds the token can run arbitrary code on this machine;
exposing the port without auth would hand that out. Binding stays loopback by
default and the operator has to opt into anything else.
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import threading
from pathlib import Path
from typing import Any

APP_NAME = "risu-hina"
VERSION = "0.13.1"

# Renamed from REALOOC_* to RISUHINA_*. The old names are still honoured, and
# not as politeness: the launcher, the control script and any service wrapper
# already on a machine were written with the old prefix, and a rename that
# silently ignores REALOOC_PORT looks like the server binding the wrong port
# for no reason.
_OLD_PREFIXES = ("RISUELF_", "REALOOC_")
_NEW_PREFIX = "RISUHINA_"


def _ENV(name: str, default: Any = None) -> Any:
    value = os.environ.get(name)
    if value is not None:
        return value
    if name.startswith(_NEW_PREFIX):
        for old in _OLD_PREFIXES:
            legacy = os.environ.get(old + name[len(_NEW_PREFIX):])
            if legacy is not None:
                return legacy
    return default


def _env_flag(name: str, default: bool = False) -> bool:
    raw = _ENV(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    try:
        return int(str(_ENV(name)).strip())
    except (TypeError, ValueError):
        return default


# --- paths ------------------------------------------------------------------

# A one-line file next to run.py holding an absolute path. Written by the
# installer when the operator wants the data somewhere other than beside the
# code - on a different drive, or on a disk that gets backed up.
DATADIR_FILE = "datadir.txt"


def _default_data_dir() -> Path:
    """Where the database, config, token and workspaces live.

    Three sources, in order:

        RISUHINA_DATA_DIR      one launch, for testing
        pyserver/datadir.txt  this install, for good
        <install>/data        the default

    The file matters more than it looks. `Win32_Process.Create` - which is how
    the control script detaches the server from an ssh session - runs under the
    WMI service and does not inherit the caller's environment, so a data
    directory passed as an env var would silently not arrive. A file is also
    the honest semantic: where the data lives is a property of the install, and
    every supervisor (NSSM, PM2, a double-click) has to agree about it.

    The default sits outside the versioned package directory (plan section 8)
    so a self-update can swap versions/<v>/ wholesale without ever touching the
    database, config, token or workspaces.
    """
    explicit = _ENV("RISUHINA_DATA_DIR")
    if explicit:
        return Path(explicit).expanduser().resolve()

    here = Path(__file__).resolve().parent          # .../app
    pkg_root = here.parent                          # .../pyserver  or  versions/<v>

    pinned = pkg_root / DATADIR_FILE
    try:
        # utf-8-sig, because whatever wrote this may have added a BOM -
        # PowerShell 5.1's `Set-Content -Encoding utf8` does, and so does
        # Notepad. A BOM left in place becomes part of the path.
        text = pinned.read_text(encoding="utf-8-sig").strip().strip("\"'")
    except OSError:
        text = ""
    if text:
        candidate = Path(text).expanduser()
        if candidate.is_absolute():
            return candidate.resolve()
        # A relative path here would resolve against the service's working
        # directory, which on Windows is somewhere in System32. Refusing is
        # the only outcome that says what is wrong.
        print(f"[{APP_NAME}] {DATADIR_FILE} must hold an absolute path, "
              f"got {text!r} - ignoring it", file=sys.stderr)

    install_root = pkg_root.parent
    if install_root.name.lower() == "versions":
        install_root = install_root.parent
    return (install_root / "data").resolve()


DATA_DIR = _default_data_dir()
WORKSPACE_DIR = DATA_DIR / "workspace"
DB_PATH = DATA_DIR / "risuhina.db"
# What the database was called before the renames (newest first).
LEGACY_DB_PATHS = (DATA_DIR / "risuelf.db", DATA_DIR / "realooc.db")
LEGACY_DB_PATH = LEGACY_DB_PATHS[0]
CONFIG_PATH = DATA_DIR / "config.json"
TOKEN_PATH = DATA_DIR / "token.txt"

HOST = _ENV("RISUHINA_HOST", "127.0.0.1")
PORT = _env_int("RISUHINA_PORT", 6020)
REQUIRE_TOKEN = _env_flag("RISUHINA_REQUIRE_TOKEN", False)
ALLOWED_ORIGINS = (_ENV("RISUHINA_ALLOWED_ORIGINS") or "*").strip()

LOOPBACK_ADDRS = frozenset({"127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", "testclient"})

# Requests larger than this are refused before parsing. A 394-turn chat is
# around 4MB of text, so the cap has to clear that with room to spare while
# still refusing something obviously wrong.
MAX_BODY_BYTES = _env_int("RISUHINA_MAX_BODY_BYTES", 64 * 1024 * 1024)


# --- defaults ---------------------------------------------------------------

DEFAULTS: dict[str, Any] = {
    # On by default (the user's call, 2026-09-03; the settings card carries
    # the caveat). Only an operator editing config.json by hand can turn it
    # off - the settings API ignores non-section keys, so nothing the panel
    # sends can reach it. See CODEX_FLAG below.
    "OPENAI_CODEX": 1,
    "agent": {
        # OpenAI-compatible surface; a gateway normalises the providers behind
        # it. Same reasoning as active-recall's llm.py - the portability lives
        # at the gateway, not in our code.
        "baseUrl": "",
        "apiKey": "",
        "model": "",
        # None = not sent (presets.FIELDS has the reasoning); '' from the UI
        # means the same. "params" is request-parameter JSON, real field
        # names, null = do not send (providers.plan_for).
        "temperature": None,
        "params": "",
        # Output budget, and on reasoning models the thinking tokens come out of
        # it too - 8000 was exhausted by reasoning before a single visible token
        # appeared ("token limit exceeded before any response was generated").
        # An agent loop that reads several turns and then writes a proposal
        # needs room to think and to answer.
        "maxTokens": 32000,
        "timeoutSeconds": 300,
        # Reasoning effort. Empty means "send nothing": a gateway fronting a
        # non-reasoning model rejects the parameter rather than ignoring it, so
        # off has to mean absent, not a value meaning off.
        "reasoning": "",
        # Prompt caching and the flex service tier. Both are provider-specific
        # and both are opt-in for the same reason as above.
        "cache": False,
        "flex": False,
        # Extra instructions the user writes, appended after the built-in rules
        # and before the skills. Additive on purpose: a preset should be able to
        # change how the agent works without being able to revoke "never write
        # to the transcript".
        "instructions": "",
        # '' = baseUrl + apiKey above. 'codex' = the OpenAI subscription via
        # codexauth (login instead of a key; baseUrl/apiKey ignored).
        "provider": "",
        # When the stored conversation grows past this many characters
        # (~1/3 as many tokens), the older part is summarised by the model
        # once and replaced (agent._compact_history). 0 turns it off.
        "historyBudgetChars": 240000,
    },
    # The search agent: a second, smaller model the general agent hands a
    # research question to (agent.web_research). Same keys as `agent`;
    # presets of kind 'search' fill it. Empty = the general agent searches
    # on its own with the web_search tool, as before.
    "agent_search": {
        "baseUrl": "",
        "apiKey": "",
        "model": "",
        "temperature": None,
        "params": "",
        "maxTokens": 16000,
        "timeoutSeconds": 180,
        "reasoning": "",
        "cache": False,
        "flex": False,
        "instructions": "",
        "provider": "",
    },
    "websearch": {
        "mode": "",              # native | gemini | provider ('' = provider; see websearch.mode())
        "nativeShape": "",       # remembered by the native probe (codex | vercel | responses | ...)
        "geminiModel": "",       # '' = gemini-3.7-flash
        "geminiKeyRef": "",      # an api_keys row id, or
        "geminiApiKey": "",      # a key typed in (secret: KEEP-able, redacted)
        "geminiInstructions": "",
        "provider": "",          # duckduckgo | brave | tavily | serper | firecrawl | searxng
        "apiKey": "",
        "baseUrl": "",
        "maxResults": 5,
    },
    "python": {
        # Not a permission boundary - an explicit user decision (plan section 5.1).
        # These are reliability limits: a runaway loop must not wedge the server
        # and a runaway print must not blow up memory.
        "timeoutSeconds": 120,
        "maxOutputBytes": 256 * 1024,
    },
    "pricing": {
        # model id -> {"in": usd per 1M input tokens, "out": usd per 1M output}
        # Consulted only for models the agent runtime cannot price itself.
        # An unpriced model renders as "가격 미설정", never as $0.00.
    },
    "update": {
        # owner/repo on GitHub.
        "repo": "nilsonwhang3-spec/risu-hina",
        # Only for a private repo or to lift the anonymous rate limit.
        "githubToken": "",
    },
    "limits": {
        "maxTurnsPerWorkspace": 20000,
        "checkpointKeep": 50,
    },
    "assets": {
        # data/assets/<sha256>.<ext>, global across bots (assets.py).
        # One asset larger than this is refused; 0 disables the check.
        "maxItemBytes": 64 * 1024 * 1024,
        # `POST /assets/gc` only drops unreachable blobs older than this.
        "gcDays": 7,
        # Account-synced web bots: let the backend fetch from the RisuAI hub
        # itself instead of the browser reading each asset (M0: 862ms each).
        "hubPull": True,
        "hubWorkers": 6,
        "hubTimeoutSeconds": 30,
    },
    "pocketrisu": {
        # PocketRisu's save directory on THIS machine (the one holding
        # risuai.db). Set it and the importer reads assets straight out of
        # that database instead of through the plugin. Empty = off.
        "savePath": "",
        "serverUrl": "http://127.0.0.1:6001",
    },
    "studio": {
        # The asset studio library: prompts, presets and generated images.
        # Global, not per bot. Configurable because a few thousand generated
        # PNGs is a drive decision, not a data-folder decision; empty means
        # `<data>/studio`.
        "libraryPath": "",
    },
    "workspace": {
        # The ONE global file space every bot shares (projects/, studio/,
        # hina/). Configurable for the same drive reason as the studio;
        # empty means `<data>/space`. Files are never moved automatically
        # when this changes.
        "globalPath": "",
        # Automatic sweep of the agent's temporary files (§1-34): files in
        # every bot's hina/<봇>/scratch/ older than scratchDays, its
        # hina/<봇>/scripts/ older than scriptsDays, and stray upload
        # `.part` fragments older than a day. 0 turns a sweep off. Runs at
        # boot and every autoCleanHours.
        "autoClean": {"scratchDays": 7, "scriptsDays": 30, "everyHours": 6},
    },
}

_lock = threading.RLock()
_cache: dict[str, Any] | None = None
TOKEN = ""


def _deep_merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _write_template() -> None:
    try:
        CONFIG_PATH.write_text(
            json.dumps(DEFAULTS, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError as e:
        print(f"[{APP_NAME}] could not write config template: {e}", file=sys.stderr)


def load(refresh: bool = False) -> dict:
    global _cache
    with _lock:
        if _cache is not None and not refresh:
            return _cache
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
        if not CONFIG_PATH.exists():
            _write_template()
            _cache = dict(DEFAULTS)
            return _cache
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("config.json is not an object")
            _cache = _deep_merge(DEFAULTS, raw)
        except (OSError, ValueError) as e:
            # Loud, but not fatal: a typo in config.json must not take the
            # backend down and strand the user's chat mid-edit.
            print(f"[{APP_NAME}] config.json unreadable ({e}); using defaults", file=sys.stderr)
            _cache = dict(DEFAULTS)
        return _cache


def section(name: str) -> dict:
    return dict(load().get(name) or {})


# The OpenAI subscription path. Ships as 1 in the config template; an
# operator who wants it gone sets `"OPENAI_CODEX": 0` in config.json by hand -
# `update()` skips top-level non-section keys, so no settings patch from the
# panel can flip it either way. With it off the routes are not there, a
# preset cannot select it, and the settings page does not offer it.
CODEX_FLAG = "OPENAI_CODEX"


def codex_enabled() -> bool:
    return str(load().get(CODEX_FLAG, 1)).strip().lower() in ("1", "true", "yes", "on")


OLD_MAX_TOKENS_DEFAULT = 8000
MIGRATION_KEY = "cfg_maxtokens_32k"


def migrate_once(has_run, mark) -> None:
    """Raise a stored maxTokens that came from our old template.

    8000 was never a user decision - it was written into config.json by the
    first-run template, and it makes the agent fail before it says anything.
    Guarded by a marker so a user who later chooses 8000 deliberately keeps it.
    """
    if has_run(MIGRATION_KEY):
        return
    cur = load().get("agent") or {}
    if int(cur.get("maxTokens") or 0) == OLD_MAX_TOKENS_DEFAULT:
        update({"agent": {"maxTokens": DEFAULTS["agent"]["maxTokens"]}})
        print(f"[{APP_NAME}] agent.maxTokens {OLD_MAX_TOKENS_DEFAULT} -> "
              f"{DEFAULTS['agent']['maxTokens']} (old default raised)", flush=True)
    mark(MIGRATION_KEY)


# Fields never returned in full. The settings UI shows whether one is set and
# how long it is, which is enough to tell "configured" from "typo" without
# putting the credential back on the wire on every panel open.
#
# Matching is exact-or-suffix, not substring: a substring rule on "token"
# also swallowed `maxTokens`, which then reached the settings UI as
# {set, length} and could never be read or edited.
SECRET_NAMES = frozenset({"apikey", "token", "secret", "password", "authtoken", "accesstoken"})
# "token" singular only: `maxTokens`/`inputTokens` end in "tokens" and stay visible.
SECRET_SUFFIXES = ("apikey", "secret", "password", "token")

# What the UI sends back for a secret it did not touch. Without a sentinel the
# UI would have to choose between echoing the real key (so it can be resent) or
# wiping it every time the user saves an unrelated field.
KEEP = "__keep__"


def _is_secret(key: str) -> bool:
    k = key.lower()
    return k in SECRET_NAMES or k.endswith(SECRET_SUFFIXES)


def redacted() -> dict:
    out: dict[str, Any] = {}
    for name, sec in load().items():
        if not isinstance(sec, dict):
            out[name] = sec
            continue
        red: dict[str, Any] = {}
        for k, v in sec.items():
            if _is_secret(k):
                s = str(v or "")
                red[k] = {"set": bool(s), "length": len(s)}
            else:
                red[k] = v
        out[name] = red
    return out


def update(patch: dict) -> dict:
    """Merge a settings patch and persist it.

    A secret arriving as KEEP means "leave it alone"; an empty string means
    "clear it". Anything else replaces it.
    """
    if not isinstance(patch, dict):
        raise ValueError("patch must be an object")
    with _lock:
        current = json.loads(json.dumps(load()))
        for name, sec in patch.items():
            if not isinstance(sec, dict):
                continue
            target = current.setdefault(name, {})
            if not isinstance(target, dict):
                continue
            for k, v in sec.items():
                if _is_secret(k) and v == KEEP:
                    continue
                target[k] = v
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        global _cache
        _cache = _deep_merge(DEFAULTS, current)
    return redacted()


def ensure_token() -> str:
    """Read data/token.txt, creating it on first boot."""
    global TOKEN
    with _lock:
        if TOKEN:
            return TOKEN
        env = (_ENV("RISUHINA_TOKEN") or "").strip()
        if env:
            TOKEN = env
            return TOKEN
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        try:
            existing = TOKEN_PATH.read_text(encoding="utf-8").strip()
        except OSError:
            existing = ""
        if existing:
            TOKEN = existing
            return TOKEN
        TOKEN = secrets.token_urlsafe(32)
        try:
            TOKEN_PATH.write_text(TOKEN + "\n", encoding="utf-8")
        except OSError as e:
            print(f"[{APP_NAME}] could not persist token: {e}", file=sys.stderr)
        return TOKEN


def is_loopback(addr: str) -> bool:
    return (addr or "") in LOOPBACK_ADDRS


def token_required_for(addr: str) -> bool:
    """Non-loopback always requires a token; loopback only if configured."""
    if not is_loopback(addr):
        return True
    return REQUIRE_TOKEN


def cors_headers(origin: str | None = None) -> dict[str, str]:
    allow = "*"
    if ALLOWED_ORIGINS and ALLOWED_ORIGINS != "*":
        allowed = {o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()}
        allow = origin if (origin and origin in allowed) else "null"
    return {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Vary": "Origin",
    }
