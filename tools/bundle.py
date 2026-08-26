"""Assemble a self-contained install: interpreter + dependencies + app.

The rule this exists to keep: **a user must not have to install Python.** That
was decided at the start and the first release broke it - setup.sh and
manage.ps1 went looking for a python and failed on a clean machine. Now the
interpreter is in the archive, and the launchers use it before they look
anywhere else.

    python tools/bundle.py                 # both targets -> release/
    python tools/bundle.py --target win    # one

## What "self-contained" means here

The bundled interpreter cannot pick up a stray Python by accident. On Windows
the embeddable's `._pth` file takes full control of sys.path - PYTHONPATH, the
registry, user site-packages are all ignored; what ships is what runs. On
Linux python-build-standalone is relocatable and has its own stdlib; a `._pth`
is not honoured there, so the launcher clears PYTHONPATH and PYTHONHOME
instead.

Dependencies come from a hash-pinned lock, wheels only, for the target's
platform and ABI - installed by *this* machine's pip with --platform rather
than by running the target interpreter. That is what lets a Windows box build
the Linux bundle.

## Two interpreters

    win-amd64     python.org embeddable zip. Small (11 MB), official, and the
                  ._pth mechanism is exactly what confinement needs.
    linux-x86_64  python-build-standalone (astral-sh). python.org ships no
                  relocatable Linux build; this is the one uv and others use.
                  Needs glibc 2.17+; tiktoken's wheel needs 2.28+ (Ubuntu 20.04
                  has 2.31, Debian 10 has 2.28).

Bumping either is deliberate: version, URL and digest move together, and the
install rehearsal is re-run before it ships.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "pyserver"
OUT = ROOT / "release"
CACHE = ROOT / ".cache"

TARGETS = {
    "win": {
        "label": "Windows.x64",
        "python": "3.11.9",
        "url": "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip",
        # python.org publishes no sidecar digest for the embeddable; this is the
        # digest of the file as fetched from python.org over TLS on 2026-08-23.
        "sha256": "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b",
        "lock": "locks/win-amd64-cp311.txt",
        "pip": {"platform": ["win_amd64"], "abi": ["cp311"], "pyver": "3.11"},
        "site": "python/Lib/site-packages",
    },
    "linux": {
        "label": "Linux.x64",
        "python": "3.11.13",
        "url": ("https://github.com/astral-sh/python-build-standalone/releases/download/"
                "20250818/cpython-3.11.13+20250818-x86_64-unknown-linux-gnu-install_only.tar.gz"),
        # Matches the release's published SHA256SUMS.
        "sha256": "b3d07471abdf1b3d2867dd44f095c891fb072bab5667b9322355546f9f9c5dda",
        "lock": "locks/linux-x86_64-cp311.txt",
        "pip": {"platform": ["manylinux2014_x86_64", "manylinux_2_17_x86_64",
                             "manylinux_2_28_x86_64", "linux_x86_64"],
                "abi": ["cp311", "abi3", "none"], "pyver": "3.11"},
        "site": "python/lib/python3.11/site-packages",
    },
}

# sys.path for the Windows embeddable, in order. `..` is pyserver/, where
# run.py and app/ live - the embeddable does not add a script's own directory,
# so without it the app is simply not importable.
PTH = "python311.zip\n.\nLib\\site-packages\n..\n\nimport site\n"

# What python3 and python become in the Linux bundle: an exec shim onto the one
# real binary. It is 52 MB and statically linked; copying it per link tripled
# the archive, and a zip cannot carry a symlink portably.
SHIM = '#!/bin/sh\nexec "$(dirname "$0")/python3.11" "$@"\n'

TREE = "risu-hina"
PLUGIN_ASSET = "Risu.Hina.Plugin.js"
ROOT_FILES = ["setup.bat", "uninstall.bat", "setup.sh", "uninstall.sh"]
SERVER_FILES = ["run.py", "requirements.in", "start.bat", "start.sh", "manage.ps1"]
EXCLUDE_DIRS = {"__pycache__", ".venv", "data", "dist", "locks", "tools", "python"}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".log", ".db"}
EXCLUDE_NAMES = {"datadir.txt", "server.log", "RELEASE_README.md"}


def version() -> str:
    import json
    return str(json.loads((ROOT / "plugin" / "package.json").read_text(encoding="utf-8"))["version"])


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str, digest: str) -> Path:
    dest = CACHE / Path(url).name
    if dest.exists() and sha256(dest.read_bytes()) == digest:
        print(f"  cached  {dest.name}")
        return dest
    print(f"  fetch   {url}")
    CACHE.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url) as r:
        data = r.read()
    got = sha256(data)
    if got != digest:
        # Refusing is the whole point of pinning. A changed interpreter is
        # either a republish worth looking at or something worse.
        raise SystemExit(f"checksum mismatch for {url}\n  expected {digest}\n  got      {got}")
    dest.write_bytes(data)
    print(f"  ok      sha256 {got[:16]}…")
    return dest


def build_plugin() -> Path:
    subprocess.run([shutil.which("node") or "node", "build.config.mjs"],
                   cwd=ROOT / "plugin", check=True, capture_output=True)
    built = ROOT / "plugin" / "dist" / f"risu-hina-{version()}.js"
    head = built.read_text(encoding="utf-8")[:512]
    for needed in ("//@version", "//@update-url"):
        if needed not in head:
            raise SystemExit(f"{needed} missing from the first 512 bytes")
    dest = OUT / PLUGIN_ASSET
    shutil.copy2(built, dest)
    # The copy RisuAI's update check actually reads: `//@update-url` points at
    # raw.githubusercontent.com/<repo>/master/plugin/Risu.Hina.Plugin.js, because
    # the release-asset URL has no CORS and a browser fetch from risu.xyz fails
    # on it (see plugin/build.config.mjs). This file is committed with the
    # release; the release commit is what makes the new version visible.
    shutil.copy2(built, ROOT / "plugin" / PLUGIN_ASSET)
    # Installs from before the rename check the old file name; they get the
    # renamed bundle from it once, and follow the new name from then on.
    shutil.copy2(built, ROOT / "plugin" / "Risu.Elf.Plugin.js")
    return dest


def _pip_wheel(pydir: Path) -> str:
    """Download the pip wheel next to the embedded interpreter; returns its
    file name ('' when the download fails - pip_install then says so)."""
    r = subprocess.run([sys.executable, "-m", "pip", "download", "pip", "--no-deps",
                        "--only-binary=:all:", "--disable-pip-version-check", "-q", "-d", str(pydir)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  warn    pip wheel not bundled: {r.stderr.strip()[:200]}")
        return ""
    found = sorted(pydir.glob("pip-*.whl"))
    if not found:
        return ""
    print(f"  pip     {found[-1].name}")
    return found[-1].name


def stage_interpreter(target: str, stage: Path) -> None:
    spec = TARGETS[target]
    print(f"[1/3] interpreter: CPython {spec['python']} ({spec['label']})")
    archive = fetch(spec["url"], spec["sha256"])
    pydir = stage / "pyserver" / "python"
    pydir.mkdir(parents=True)
    if target == "win":
        with zipfile.ZipFile(archive) as z:
            z.extractall(pydir)
        # The embeddable zip has no pip. The agent's pip_install runs
        # `python -m pip` on this interpreter, so a pip wheel goes on its
        # path - wheels are zip-importable, and `._pth` takes a file name.
        wheel = _pip_wheel(pydir)
        (pydir / "python311._pth").write_text(PTH.replace("python311.zip\n", f"python311.zip\n{wheel}\n", 1) if wheel else PTH,
                                               encoding="ascii")
    else:
        # The tarball has a single `python/` top level; strip it.
        with tarfile.open(archive, "r:gz") as t:
            for m in t.getmembers():
                parts = Path(m.name).parts
                if len(parts) < 2 or parts[0] != "python":
                    continue
                m.name = str(Path(*parts[1:]))
                t.extract(m, pydir)
        # The tarball links python3 -> python3.11 (and python -> python3).
        # A zip has no reliable symlink story, and the binary is 52 MB - it
        # is statically linked - so copying it per link tripled the bundle.
        # Each link becomes a two-line exec shim instead.
        bindir = pydir / "bin"
        for link in ("python3", "python"):
            lp = bindir / link
            if lp.is_symlink() or lp.exists():
                lp.unlink()
            # newline="": written from Windows, write_text would translate LF
            # to CRLF and the kernel would look for an interpreter called
            # "/bin/sh<CR>". That is exactly how the first Linux rehearsal
            # failed.
            lp.write_text(SHIM, encoding="ascii", newline="")
            lp.chmod(0o755)
        # Not shipped: tests, IDLE, tkinter and its libs, headers, and the
        # 53 MB shared libpython that only an embedding host would load - the
        # interpreter is statically linked and never opens it.
        for junk in ("lib/python3.11/test", "lib/python3.11/idlelib",
                     "lib/python3.11/tkinter", "lib/python3.11/turtledemo",
                     "lib/python3.11/lib2to3", "lib/python3.11/ensurepip",
                     "share", "include"):
            shutil.rmtree(pydir / junk, ignore_errors=True)
        for so in pydir.glob("lib/lib*.so*"):
            so.unlink()
        for f in list(bindir.iterdir()):
            if f.name not in ("python3.11", "python3", "python"):
                f.unlink()

    print("[2/3] dependencies (hash-pinned, wheels only)")
    # --no-compile: pip would otherwise byte-compile with *this* machine's
    # interpreter, leaving cpython-312 .pyc files in a 3.11 bundle - ignored at
    # runtime, and a few megabytes of nothing.
    cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
           "--no-compile", "--require-hashes", "--only-binary=:all:",
           "--python-version", spec["pip"]["pyver"], "--implementation", "cp",
           "--target", str(stage / "pyserver" / spec["site"]), "-r", str(SERVER / spec["lock"])]
    for p in spec["pip"]["platform"]:
        cmd += ["--platform", p]
    for a in spec["pip"]["abi"]:
        cmd += ["--abi", a]
    subprocess.run(cmd, check=True)
    # pip leaves its own bin/ and a *.dist-info for each; the scripts point at
    # the build machine's python and are never used.
    shutil.rmtree(stage / "pyserver" / spec["site"] / "bin", ignore_errors=True)


def stage_app(stage: Path, plugin: Path) -> None:
    print("[3/3] application")
    srv = stage / "pyserver"
    for name in SERVER_FILES:
        shutil.copy2(SERVER / name, srv / name)
    shutil.copytree(SERVER / "app", srv / "app",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.log"))
    for name in ROOT_FILES:
        shutil.copy2(SERVER / name, stage / name)
    shutil.copy2(SERVER / "RELEASE_README.md", stage / "README.md")
    (stage / "plugin").mkdir()
    shutil.copy2(plugin, stage / "plugin" / PLUGIN_ASSET)
    (stage / "data").mkdir()
    (stage / "data" / "README.txt").write_text(
        "이 폴더는 당신 것입니다.\n\n데이터베이스, 설정, 토큰, 워크스페이스가 여기 들어갑니다.\n"
        "업데이트는 pyserver/ 만 갈아끼우고 이 폴더는 건드리지 않습니다.\n",
        encoding="utf-8")


def pack(target: str, stage: Path) -> Path:
    spec = TARGETS[target]
    name = f"Risu.Hina.{version()}.{spec['label']}.Auto.Install.Package.zip"
    dest = OUT / name
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(stage.rglob("*")):
            if f.is_dir():
                continue
            if f.is_symlink():
                # Materialise: a zip cannot carry a symlink portably, and a
                # dangling one would be worse than a copy.
                target = f.resolve()
                f.unlink()
                shutil.copy2(target, f)
            rel = f.relative_to(stage)
            info = zipfile.ZipInfo(f"{TREE}/{rel.as_posix()}")
            info.compress_type = zipfile.ZIP_DEFLATED
            info.date_time = (2026, 1, 1, 0, 0, 0)
            # Executable bits survive into the zip so a Linux extract can run
            # the interpreter and the launchers without a chmod step.
            #
            # Two things have to be true for unzip to honour them, and the
            # first rehearsal had neither: the mode goes in the high 16 bits of
            # external_attr, AND create_system must say Unix (3). zipfile's
            # default is 0 = MS-DOS, under which unzip discards the bits and
            # the interpreter arrives as -rw-r--r--.
            executable = (
                rel.suffix == ".sh"
                or "bin" in rel.parts
                or rel.name in ("python3", "python3.11", "python")
            )
            mode = 0o755 if executable else 0o644
            info.external_attr = (mode & 0xFFFF) << 16
            info.create_system = 3
            zf.writestr(info, f.read_bytes())
    return dest


def write_sums(paths: list[Path]) -> Path:
    dest = OUT / f"SHA256SUMS-{version()}.txt"
    dest.write_text("".join(f"{sha256(p.read_bytes())}  {p.name}\n" for p in paths),
                    encoding="utf-8", newline="\n")
    return dest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["win", "linux", "all"], default="all")
    args = ap.parse_args()
    targets = ["win", "linux"] if args.target == "all" else [args.target]

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    plugin = build_plugin()

    assets = [plugin]
    for target in targets:
        print(f"\n=== {target} ===")
        stage = ROOT / ".build" / target
        if stage.exists():
            shutil.rmtree(stage)
        stage.mkdir(parents=True)
        stage_interpreter(target, stage)
        stage_app(stage, plugin)
        archive = pack(target, stage)
        assets.append(archive)
        shutil.rmtree(stage)
        print(f"      {archive.name}  ({archive.stat().st_size / 1024 / 1024:.0f} MB)")

    sums = write_sums(assets)
    print(f"\n{OUT}")
    for f in assets + [sums]:
        print(f"  {f.name:<48} {f.stat().st_size:>12,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
