#!/usr/bin/env bash
# Install Risu Hina: virtualenv, dependencies, and optionally keep it running.
#
#   ./setup.sh                          set up and start
#   ./setup.sh --port 6030              a different port
#   ./setup.sh --service                keep it running via pm2, across reboots
#   ./setup.sh --data-dir /srv/elfdata  put the data somewhere else
#   ./setup.sh --python /usr/bin/python3.11
#   ./setup.sh --no-start               just install
#
# One entry point rather than a folder of scripts. What a person does here is
# "install it" and "get rid of it"; everything else is a flag.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$HERE/app" ]; then SERVER="$HERE"; else SERVER="$HERE/pyserver"; fi
[ -d "$SERVER/app" ] || { echo "cannot find app/ - looked in $HERE and $HERE/pyserver" >&2; exit 2; }
ROOT="$(dirname "$SERVER")"

PYTHON=""; DATA_DIR=""; PORT=6020; SERVICE=0; START=1; NAME="risu-hina"
while [ $# -gt 0 ]; do
  case "$1" in
    --python)   PYTHON="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --port)     PORT="${2:-}"; shift 2 ;;
    --name)     NAME="${2:-}"; shift 2 ;;
    --service)  SERVICE=1; shift ;;
    --no-start) START=0; shift ;;
    -h|--help)  sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- interpreter ------------------------------------------------------------
#
# 3.10 is the floor: pydantic-ai requires it. Whichever is picked is printed,
# because a wrong pick surfaces much later as an import error that says nothing
# about which python was used.
find_python() {
  if [ -n "$PYTHON" ]; then
    [ -x "$PYTHON" ] || { echo "no interpreter at $PYTHON" >&2; exit 2; }
    echo "$PYTHON"; return
  fi
  for c in python3.13 python3.12 python3.11 python3.10 python3 python; do
    p="$(command -v "$c" 2>/dev/null || true)"
    if [ -n "$p" ] && "$p" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)' 2>/dev/null; then
      echo "$p"; return
    fi
  done
  # pyenv's shims are not on PATH in a non-login shell, which is exactly how a
  # deploy script runs, so look at its versions directly.
  for p in "$HOME"/.pyenv/versions/*/bin/python3; do
    if [ -x "$p" ] && "$p" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)' 2>/dev/null; then
      echo "$p"; return
    fi
  done
  cat >&2 <<'EOF'
no Python 3.10 or newer found.

  Ubuntu 20.04 ships 3.8, which is too old. Either:
    sudo add-apt-repository ppa:deadsnakes/ppa && sudo apt install python3.11-venv
    pyenv install 3.11 && ./setup.sh --python ~/.pyenv/versions/3.11.*/bin/python3
EOF
  exit 2
}

VENV="$SERVER/.venv"
BUNDLED="$SERVER/python/bin/python3"

# These two can point any Python at another installation's stdlib, and a user
# who set them for some other program would see "No module named encodings"
# from ours with no hint why. start.sh clears them for the server; this does
# the same for the checks below.
unset PYTHONHOME PYTHONPATH

if [ -x "$BUNDLED" ]; then
  # Nothing to install: the interpreter and every dependency came in the
  # archive, hash-pinned. Just prove they load.
  echo "setup: bundled Python $("$BUNDLED" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
  "$BUNDLED" -c "import fastapi, uvicorn, httpx, pydantic_ai; print('setup: fastapi', fastapi.__version__, 'uvicorn', uvicorn.__version__)" || {
    echo >&2
    echo 'the bundled interpreter failed - the message above says why.' >&2
    echo 'If it mentions GLIBC: this build needs glibc 2.28+ (Debian 10 / Ubuntu 20.04 or newer).' >&2
    exit 2
  }
  RUNPY="$BUNDLED"
else
PY="$(find_python)"
echo "setup: no bundled python - building a venv with $PY ($("$PY" --version 2>&1))"

if [ ! -x "$VENV/bin/python" ]; then
  echo 'setup: creating venv'
  # python3-venv is a separate package on Debian/Ubuntu and its absence is the
  # commonest failure here, so name it rather than letting ensurepip's own
  # message scroll past.
  "$PY" -m venv "$VENV" || {
    echo >&2
    echo 'creating the venv failed. On Debian/Ubuntu you may need:' >&2
    echo '  sudo apt install python3-venv    (or python3.11-venv to match)' >&2
    exit 2
  }
fi

echo 'setup: installing dependencies'
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$SERVER/requirements.in"
"$VENV/bin/python" -c "import fastapi, uvicorn, httpx; print('setup: fastapi', fastapi.__version__, 'uvicorn', uvicorn.__version__)"
RUNPY="$VENV/bin/python"
fi

# --- data directory ---------------------------------------------------------
PIN="$SERVER/datadir.txt"
if [ -n "$DATA_DIR" ]; then
  case "$DATA_DIR" in /*) ;; *) echo '--data-dir must be an absolute path' >&2; exit 2 ;; esac
  mkdir -p "$DATA_DIR"
  # printf, not echo: this file is read as a path, so no BOM and no stray bytes.
  printf '%s' "$DATA_DIR" > "$PIN"
  echo "setup: pinned data dir in $PIN"
else
  rm -f "$PIN"
  DATA_DIR="$ROOT/data"
  mkdir -p "$DATA_DIR"
fi
echo "setup: data dir $DATA_DIR"
chmod +x "$ROOT"/*.sh "$SERVER"/start.sh 2>/dev/null || true
# A zip extracted by a tool that drops permission bits leaves the interpreter
# non-executable; putting it back is cheaper than explaining the error.
[ -d "$SERVER/python/bin" ] && chmod +x "$SERVER"/python/bin/* 2>/dev/null || true

# --- run it -----------------------------------------------------------------
if [ "$SERVICE" = "1" ]; then
  command -v pm2 >/dev/null 2>&1 || {
    echo >&2
    echo 'pm2 not found:  npm install -g pm2' >&2
    echo 'Without it, ./start.sh works on its own - the restart loop is in it.' >&2
    exit 2
  }
  pm2 describe "$NAME" >/dev/null 2>&1 && {
    echo "pm2 already has '$NAME'. Remove it first:  ./uninstall.sh --name $NAME" >&2
    exit 2
  }
  echo "setup: registering with pm2 as '$NAME'"
  # --interpreter bash: pm2 assumes node for anything it does not recognise and
  # would try to run the launcher as JavaScript.
  #
  # pm2 runs start.sh, never run.py. Exit 75 means "an update was installed,
  # come back up", and the loop that understands it lives in the launcher.
  pm2 start "$SERVER/start.sh" --name "$NAME" --interpreter bash -- "$PORT" >/dev/null
  pm2 save >/dev/null
  echo
  echo 'To survive a reboot, run the sudo command that this prints, then `pm2 save`:'
  pm2 startup 2>&1 | grep -E '^sudo' || true
elif [ "$START" = "1" ]; then
  echo "setup: starting on port $PORT"
  # setsid so it outlives this shell and does not hold an ssh session open.
  setsid "$SERVER/start.sh" "$PORT" >/dev/null 2>&1 < /dev/null &
fi

if [ "$START" = "1" ] || [ "$SERVICE" = "1" ]; then
  sleep 6
  echo
  if command -v curl >/dev/null 2>&1; then
    echo "health: $(curl -sS --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo 'not up yet - see pyserver/server.log')"
  fi
fi

echo
echo "token (only needed from another machine):  $(cat "$DATA_DIR/token.txt" 2>/dev/null || echo '(issued on first start)')"
echo "remove with:  $ROOT/uninstall.sh"
