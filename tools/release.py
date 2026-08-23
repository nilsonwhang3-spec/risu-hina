"""Build the release assets. Delegates to bundle.py.

    python tools/release.py            # both bundles + plugin + SHA256SUMS
    python tools/release.py --check    # verify an existing release/

The install archives carry their own interpreter - see tools/bundle.py for why
and how. This file exists so the release command stays the one people already
know; it no longer has a code path that produces an archive without a python
in it, because that is the archive that broke the rule this project started
with.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "release"


def check() -> int:
    import hashlib
    sums = next(iter(sorted(OUT.glob("SHA256SUMS*.txt"))), None)
    if sums is None:
        print("no SHA256SUMS - updater.py would refuse this release")
        return 1
    bad = 0
    for line in sums.read_text(encoding="utf-8").splitlines():
        want, _, name = line.partition("  ")
        f = OUT / name
        if not f.is_file():
            print(f"  MISSING {name}")
            bad += 1
            continue
        got = hashlib.sha256(f.read_bytes()).hexdigest()
        print(f"  {'ok  ' if got == want else 'BAD '} {name}")
        bad += got != want
    return 1 if bad else 0


def main() -> int:
    if "--check" in sys.argv:
        return check()
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "bundle.py")])
    if r.returncode:
        return r.returncode
    print()
    return check()


if __name__ == "__main__":
    sys.exit(main())
