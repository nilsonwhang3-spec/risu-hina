"""Fetch the latest RisuAI / PocketRisu source and search it (skill: RisuAI 소스 대조 검증).

Load inside run_python:
    exec(open('skills/<slug>/scripts/risu_sources.py', encoding='utf-8').read())
then call:
    fetch_sources('risuai')                      # or 'pocketrisu'; one repo per run_python call
    grep_source('setdefaultvar', 'risuai')       # substring (regex=True for a pattern)
    show_source('src/ts/cbs.ts', 810, 'risuai')  # numbered lines around a line
    key_files('risuai')                          # where the usual answers live

Sources land in hina/.sources/<repo>/ (a hidden agent folder shared by every
bot; read_file can open them by path). Only src/, docs/ and a few top-level
files are kept. A copy whose commit matches upstream is reused, so calling
fetch_sources again is cheap. Nothing here edits a bot.
"""
import fnmatch
import json
import os
import re
import shutil
import time
import urllib.request
import zipfile

REPOS = {"risuai": "kwaroran/RisuAI", "pocketrisu": "PocketRisu/PocketRisu"}
KEEP = ("src/", "docs/", "plugins.md", "README.md", "package.json")
TEXT_SUFFIXES = (".ts", ".tsx", ".svelte", ".js", ".mjs", ".md", ".json", ".lua")
KEY_FILES = {
    "CBS tags (registry)": "src/ts/cbs.ts",
    "CBS parser, blocks, asset tags": "src/ts/parser/parser.svelte.ts",
    "chat variables, defaults": "src/ts/parser/chatVar.svelte.ts",
    "{{? }} math": "src/ts/process/infunctions.ts",
    "Lua API, listenEdit, access tiers": "src/ts/process/scriptings.ts",
    "triggers (V1/V2 legacy, triggerlua)": "src/ts/process/triggers.ts",
    "send order (sendChat)": "src/ts/process/index.svelte.ts",
    "regex scripts, flags": "src/ts/process/scripts.ts",
    "lorebook matching, decorators": "src/ts/process/lorebook.svelte.ts",
    "modules": "src/ts/process/modules.ts",
    "slash commands": "src/ts/process/command.ts",
    "buttons, risu-trigger": "src/lib/ChatScreens/Chat.svelte",
    "input box, onInput": "src/lib/ChatScreens/DefaultChatScreen.svelte",
    "alerts": "src/ts/alert.ts",
    "UI strings (deprecation notes)": "src/lang/en.ts",
}


def _dest(dest=None):
    if dest:
        return os.path.abspath(dest)
    return os.path.join(os.environ.get("RISUHINA_WORKSPACE", "."), "hina", ".sources")


def _get(url, timeout=30, accept=None):
    req = urllib.request.Request(url, headers={"User-Agent": "risu-hina-source-check",
                                               **({"Accept": accept} if accept else {})})
    return urllib.request.urlopen(req, timeout=timeout)


def latest_sha(which="risuai", ref="main"):
    """Upstream commit of `ref`, or None when GitHub cannot be asked (rate limit, offline)."""
    try:
        with _get(f"https://api.github.com/repos/{REPOS[which]}/commits/{ref}",
                  accept="application/vnd.github.sha") as r:
            sha = r.read().decode().strip()
        return sha if re.fullmatch(r"[0-9a-f]{40}", sha) else None
    except Exception:  # noqa: BLE001 - the caller falls back to the cached copy
        return None


def _info(path):
    try:
        with open(os.path.join(path, "SOURCE.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _extract(zpath, target):
    """Unpack only KEEP paths of a GitHub zip (whose names start with '<repo>-<sha>/')."""
    count = 0
    with zipfile.ZipFile(zpath) as z:
        for member in z.infolist():
            name = member.filename.split("/", 1)[1] if "/" in member.filename else ""
            if not name or member.is_dir() or ".." in name.split("/"):
                continue
            if not any(name == k or (k.endswith("/") and name.startswith(k)) for k in KEEP):
                continue
            out = os.path.join(target, *name.split("/"))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(member) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
            count += 1
    return count


def fetch_sources(which="risuai", ref="main", dest=None, force=False, max_age_hours=24):
    """Download (or reuse) the latest source of one repo. Returns its SOURCE.json dict."""
    if which not in REPOS:
        raise ValueError(f"which must be one of {sorted(REPOS)}")
    base = _dest(dest)
    path = os.path.join(base, which)
    os.makedirs(base, exist_ok=True)
    have = _info(path)
    sha = latest_sha(which, ref)
    if have and not force:
        fresh = (time.time() - have.get("fetchedAt", 0)) < max_age_hours * 3600
        if (sha and have.get("sha") == sha) or (not sha and fresh):
            print(f"{which}: reusing {path} (commit {have.get('sha', '?')[:10]}, "
                  f"{'matches upstream' if sha else 'upstream unknown, copy is recent'})")
            return have
    url = f"https://codeload.github.com/{REPOS[which]}/zip/{sha or 'refs/heads/' + ref}"
    part = os.path.join(base, f"{which}.zip.part")
    started = time.time()
    with _get(url, timeout=60) as r, open(part, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    staging = path + ".new"
    shutil.rmtree(staging, ignore_errors=True)
    count = _extract(part, staging)
    os.remove(part)
    info = {"repo": REPOS[which], "ref": ref, "sha": sha, "files": count,
            "fetchedAt": time.time(), "fetched": time.strftime("%Y-%m-%d %H:%M:%S"), "url": url}
    with open(os.path.join(staging, "SOURCE.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2)
    shutil.rmtree(path, ignore_errors=True)
    os.rename(staging, path)
    print(f"{which}: {count} files from commit {(sha or ref)[:10]} into {path} "
          f"in {time.time() - started:.0f}s")
    return info


def _root(which, dest):
    path = os.path.join(_dest(dest), which)
    if not os.path.isdir(path):
        raise FileNotFoundError(f"{path} is missing - run fetch_sources('{which}') first")
    return path


def grep_source(pattern, which="risuai", glob="src/*", regex=False, ignore_case=True,
                limit=60, dest=None):
    """Print `path:line: text` for matching lines (text files only, at most `limit`)."""
    root = _root(which, dest)
    flags = re.I if ignore_case else 0
    rx = re.compile(pattern if regex else re.escape(pattern), flags)
    shown = total = 0
    for folder, _dirs, names in os.walk(root):
        for name in sorted(names):
            if not name.endswith(TEXT_SUFFIXES):
                continue
            full = os.path.join(folder, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if glob and not fnmatch.fnmatch(rel, glob):
                continue
            with open(full, encoding="utf-8", errors="replace") as f:
                for n, line in enumerate(f, 1):
                    if rx.search(line):
                        total += 1
                        if shown < limit:
                            print(f"{rel}:{n}: {line.strip()[:200]}")
                            shown += 1
    print(f"-- {total} matches in {which}" + (f", first {shown} shown" if total > shown else ""))
    return total


def show_source(relpath, line=1, which="risuai", before=10, after=40, dest=None):
    """Print numbered lines of one source file around `line`."""
    full = os.path.join(_root(which, dest), *relpath.split("/"))
    with open(full, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    lo, hi = max(1, line - before), min(len(lines), line + after)
    for n in range(lo, hi + 1):
        print(f"{n:6}  {lines[n - 1]}")
    print(f"-- {relpath} lines {lo}-{hi} of {len(lines)} ({which})")


def key_files(which="risuai", dest=None):
    """Where the usual answers live; flags a path that moved upstream."""
    root = _root(which, dest)
    info = _info(root) or {}
    print(f"{which} commit {str(info.get('sha'))[:10]} fetched {info.get('fetched', '?')}")
    for topic, rel in KEY_FILES.items():
        ok = os.path.isfile(os.path.join(root, *rel.split("/")))
        print(f"  {'ok ' if ok else 'MOVED?'} {rel:48} {topic}")
