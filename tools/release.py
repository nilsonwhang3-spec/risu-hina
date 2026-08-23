"""Build the release assets.

Three files, and the third is what makes the other two installable:

    risu-elf.js         the plugin, under the exact name //@update-url expects
    risu-elf-install-<ver>.zip   the whole install, laid out ready to run
    SHA256SUMS.txt      digests of both

`updater.py` refuses a release without `SHA256SUMS.txt`. That is not ceremony:
the downloaded archive becomes the running server, so an unverified download is
a remote-code-execution endpoint with extra steps.

The plugin asset is named `risu-elf.js` with no version in it, because
`releases/latest/download/<name>` needs a name that does not change. The
version lives inside the file, in the `//@version` header RisuAI reads.

## The archive unpacks ready to run

    risu-elf/
      pyserver/       code. an update replaces this wholesale
      plugin/         risu-elf.js, to install into RisuAI
      data/           yours. an update never touches it
      setup.bat       install and start          (Windows)
      uninstall.bat   stop and undo
      setup.sh        install and start          (Linux)
      uninstall.sh    stop and undo
      README.md       how to use all of the above

Extract it anywhere and it is an install - no "now make a folder called
pyserver and put these in it".

**Five files at the root, and they are the five a person touches.** Everything
else - the restart loop, the PowerShell that finds an interpreter and talks to
the service manager - lives in pyserver/ where it belongs. An install directory
that greets you with eleven scripts is one where you have to read all eleven to
find out which two matter.

Nothing from development ships: no docs/, tests/, tools/. GitHub attaches its
own "Source code" archives to every release and those do contain them, which is
worth knowing when someone downloads the wrong one.

    python tools/release.py            # build into release/
    python tools/release.py --check    # verify an existing release/
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "release"
PLUGIN_ASSET = "risu-elf.js"

# Not "risu-elf-<ver>.zip": GitHub attaches its own source archive to every
# release under exactly that name, and two identically named files on one page
# is the confusion this is trying to avoid. Not "backend" either - the archive
# carries the plugin too, so that name undersold it.
INSTALL_ASSET = "risu-elf-install-%s.zip"

# The tree's top-level folder, so the zip unpacks into one directory rather
# than scattering itself across wherever it was opened.
TREE = "risu-elf"

# Inside pyserver/. `run.py` and `app/` are replaced by an update; the
# launchers and manage.ps1 are not copied by the updater, so a start.bat that
# cmd is currently executing is never overwritten under it.
SERVER_FILES = ["run.py", "requirements.in", "start.bat", "start.sh", "manage.ps1"]
SERVER_DIRS = ["app"]

# At the install root - the four entry points and the readme, nothing else.
ROOT_FILES = ["setup.bat", "uninstall.bat", "setup.sh", "uninstall.sh"]

# Shipped as README.md at the root. The repository README is about the project;
# this one is about the copy someone just extracted.
RELEASE_README = "RELEASE_README.md"

# Never ship these, whatever happens to be on disk.
EXCLUDE_DIRS = {"__pycache__", ".venv", "data", "dist"}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".log", ".db"}
# datadir.txt belongs to one install; shipping one would point a fresh
# install at somebody else's data directory.
EXCLUDE_NAMES = {"datadir.txt", "server.log"}


def version() -> str:
    pkg = json.loads((ROOT / "plugin" / "package.json").read_text(encoding="utf-8"))
    return str(pkg["version"])


def build_plugin() -> Path:
    """Rebuild rather than trust dist/: a stale bundle is a silent wrong release."""
    subprocess.run([shutil.which("node") or "node", "build.config.mjs"],
                   cwd=ROOT / "plugin", check=True)
    built = ROOT / "plugin" / "dist" / f"risu-elf-{version()}.js"
    if not built.is_file():
        raise SystemExit(f"build produced no {built.name}")
    head = built.read_text(encoding="utf-8")[:512]
    # The two things RisuAI reads out of the first 512 bytes. Shipping without
    # them produces a plugin that installs and then never updates.
    for needed in ("//@version", "//@update-url"):
        if needed not in head:
            raise SystemExit(f"{needed} is missing from the first 512 bytes")
    dest = OUT / PLUGIN_ASSET
    shutil.copy2(built, dest)
    return dest


DATA_README = """이 폴더는 당신 것입니다.

데이터베이스, 설정, 토큰, 워크스페이스가 여기 들어갑니다.
업데이트는 pyserver/ 만 갈아끼우고 이 폴더는 건드리지 않습니다.

다른 위치에 두고 싶으면:
    risuelf_ctl.ps1 -Action setup -DataDir <절대경로>
"""


def build_backend(plugin: Path) -> Path:
    dest = OUT / (INSTALL_ASSET % version())
    src = ROOT / "pyserver"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in SERVER_FILES:
            f = src / name
            if f.is_file() and name not in EXCLUDE_NAMES:
                zf.write(f, f"{TREE}/pyserver/{name}")
        for name in SERVER_DIRS:
            for f in sorted((src / name).rglob("*")):
                if not f.is_file():
                    continue
                if any(part in EXCLUDE_DIRS for part in f.relative_to(src).parts):
                    continue
                if f.suffix in EXCLUDE_SUFFIXES or f.name in EXCLUDE_NAMES:
                    continue
                rel = str(f.relative_to(src)).replace("\\", "/")
                zf.write(f, f"{TREE}/pyserver/{rel}")

        for name in ROOT_FILES:
            f = src / name
            if f.is_file():
                zf.write(f, f"{TREE}/{name}")

        readme = src / RELEASE_README
        if readme.is_file():
            zf.write(readme, f"{TREE}/README.md")

        # The same plugin build as the standalone asset, so a local install can
        # serve it without the operator copying a file around.
        zf.write(plugin, f"{TREE}/plugin/{PLUGIN_ASSET}")

        # An empty directory in a zip is easy to lose; a file in it is not, and
        # this one says what the directory is for.
        zf.writestr(f"{TREE}/data/README.txt", DATA_README)
    return dest


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_sums(paths: list[Path]) -> Path:
    dest = OUT / "SHA256SUMS.txt"
    lines = [f"{sha256(p)}  {p.name}" for p in paths]
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return dest


def check() -> int:
    sums = OUT / "SHA256SUMS.txt"
    if not sums.is_file():
        print("no SHA256SUMS.txt - updater.py would refuse this release")
        return 1
    bad = 0
    for line in sums.read_text(encoding="utf-8").splitlines():
        want, _, name = line.partition("  ")
        f = OUT / name
        if not f.is_file():
            print(f"  MISSING {name}")
            bad += 1
            continue
        got = sha256(f)
        print(f"  {'ok  ' if got == want else 'BAD '} {name}")
        bad += got != want
    return 1 if bad else 0


def main() -> int:
    if "--check" in sys.argv:
        return check()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    plugin = build_plugin()
    backend = build_backend(plugin)
    sums = write_sums([plugin, backend])

    print(f"\nrelease v{version()}")
    for f in (plugin, backend, sums):
        print(f"  {f.name:<34} {f.stat().st_size:>9,} bytes")
    print(f"\n{OUT}")
    return check()


if __name__ == "__main__":
    sys.exit(main())
