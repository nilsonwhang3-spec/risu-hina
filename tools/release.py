"""Build the release assets.

Three files, and the third is what makes the other two installable:

    risu-elf.js         the plugin, under the exact name //@update-url expects
    risu-elf-backend-<ver>.zip   the backend, laid out the way updater.py unpacks
    SHA256SUMS.txt      digests of both

`updater.py` refuses a release without `SHA256SUMS.txt`. That is not ceremony:
the downloaded archive becomes the running server, so an unverified download is
a remote-code-execution endpoint with extra steps.

The plugin asset is named `risu-elf.js` with no version in it, because
`releases/latest/download/<name>` needs a name that does not change. The
version lives inside the file, in the `//@version` header RisuAI reads.

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

# What the backend archive carries. `updater.py` looks for `app/` inside it and
# copies the rest alongside; anything not listed here is not part of a release.
BACKEND_FILES = ["run.py", "requirements.in", "start.bat", "start.sh", "risuelf_ctl.ps1"]
BACKEND_DIRS = ["app"]

# Never ship these, whatever happens to be on disk.
EXCLUDE_DIRS = {"__pycache__", ".venv", "data", "dist"}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".log", ".db"}


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


def build_backend() -> Path:
    dest = OUT / f"risu-elf-backend-{version()}.zip"
    src = ROOT / "pyserver"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in BACKEND_FILES:
            f = src / name
            if f.is_file():
                zf.write(f, name)
        for name in BACKEND_DIRS:
            for f in sorted((src / name).rglob("*")):
                if not f.is_file():
                    continue
                if any(part in EXCLUDE_DIRS for part in f.relative_to(src).parts):
                    continue
                if f.suffix in EXCLUDE_SUFFIXES:
                    continue
                zf.write(f, str(f.relative_to(src)).replace("\\", "/"))
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
    backend = build_backend()
    sums = write_sums([plugin, backend])

    print(f"\nrelease v{version()}")
    for f in (plugin, backend, sums):
        print(f"  {f.name:<34} {f.stat().st_size:>9,} bytes")
    print(f"\n{OUT}")
    return check()


if __name__ == "__main__":
    sys.exit(main())
