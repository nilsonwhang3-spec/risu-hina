#!/usr/bin/env bash
# Create the virtualenv and install dependencies.
#
#   ./setup.sh
#   ./setup.sh --python /usr/bin/python3.11
#   ./setup.sh --data-dir /srv/backup/risu-elf-data
#
# The Linux half of `risuelf_ctl.ps1 -Action setup`. Without it the guide had to
# say "create a venv and pip install by hand", which is the step people get
# wrong - a global install, or the system python, or the wrong version.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$HERE/app" ]; then
  SERVER="$HERE"
elif [ -d "$HERE/pyserver/app" ]; then
  SERVER="$HERE/pyserver"
else
  echo "cannot find app/ - looked in $HERE and $HERE/pyserver" >&2
  exit 2
fi
ROOT="$(dirname "$SERVER")"

PYTHON=""
DATA_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --python)   PYTHON="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- find an interpreter ----------------------------------------------------
#
# 3.10 is the floor: pydantic-ai requires it. Reported either way, because a
# wrong pick shows up much later as an import error that says nothing about
# which python was used.
find_python() {
  if [ -n "$PYTHON" ]; then
    [ -x "$PYTHON" ] || { echo "no interpreter at $PYTHON" >&2; exit 2; }
    echo "$PYTHON"; return
  fi
  # pyenv's shims are not on PATH in a non-login shell, which is exactly how a
  # deploy script runs - so look for its versions directly.
  for c in python3.13 python3.12 python3.11 python3.10 python3 python; do
    p="$(command -v "$c" 2>/dev/null || true)"
    if [ -n "$p" ] && "$p" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)' 2>/dev/null; then
      echo "$p"; return
    fi
  done
  for p in "$HOME"/.pyenv/versions/*/bin/python3; do
    if [ -x "$p" ] && "$p" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)' 2>/dev/null; then
      echo "$p"; return
    fi
  done
  cat >&2 <<'EOF'
no Python 3.10 or newer found.

  Ubuntu 20.04 ships 3.8, which is too old. Options:
    sudo add-apt-repository ppa:deadsnakes/ppa && sudo apt install python3.11-venv
    pyenv install 3.11 && ./setup.sh --python ~/.pyenv/versions/3.11.*/bin/python3
EOF
  exit 2
}

PY="$(find_python)"
echo "setup: using $PY ($("$PY" --version 2>&1))"

VENV="$SERVER/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo 'setup: creating venv'
  # python3-venv is a separate package on Debian/Ubuntu and its absence is the
  # single most common failure here, so say what to install rather than letting
  # ensurepip's own message scroll past.
  "$PY" -m venv "$VENV" || {
    echo >&2
    echo "creating the venv failed. On Debian/Ubuntu you may need:" >&2
    echo "  sudo apt install python3-venv    (or python3.11-venv to match)" >&2
    exit 2
  }
fi

echo 'setup: installing dependencies'
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$SERVER/requirements.in"
"$VENV/bin/python" -c "import fastapi, uvicorn, httpx; print('setup: fastapi', fastapi.__version__, 'uvicorn', uvicorn.__version__)"

# --- data directory ---------------------------------------------------------
PIN="$SERVER/datadir.txt"
if [ -n "$DATA_DIR" ]; then
  case "$DATA_DIR" in
    /*) ;;
    *) echo "--data-dir must be an absolute path" >&2; exit 2 ;;
  esac
  mkdir -p "$DATA_DIR"
  # printf, not echo: a trailing newline is fine but a BOM or CRLF is not, and
  # this file is read as a path.
  printf '%s' "$DATA_DIR" > "$PIN"
  echo "setup: pinned data dir in $PIN"
else
  rm -f "$PIN"
  DATA_DIR="$ROOT/data"
  mkdir -p "$DATA_DIR"
fi
echo "setup: data dir $DATA_DIR"

chmod +x "$ROOT/start.sh" "$ROOT/service-install.sh" "$ROOT/service-uninstall.sh" 2>/dev/null || true
chmod +x "$SERVER/start.sh" 2>/dev/null || true

echo
echo "next:  $ROOT/start.sh [port]"
echo "  or:  $ROOT/service-install.sh [port]     # keep it running via pm2"
