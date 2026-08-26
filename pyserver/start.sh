#!/usr/bin/env bash
# Risu Hina backend launcher.
#
# The restart loop is the supervisor-agnostic update mechanism (plan section 8):
# exit code 75 means "a new version was installed, re-enter it". PM2, systemd,
# a terminal or a double-click all get the same behaviour because the loop is
# here rather than in the supervisor.
#
# Any other exit code leaves for real, so a crash stops rather than spinning.
set -u

# Works from either place: at the install root next to pyserver/, which is
# where a release unpacks it, or inside pyserver/ as older installs have it.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$HERE/app" ]; then
  ROOT="$HERE"
elif [ -d "$HERE/pyserver/app" ]; then
  ROOT="$HERE/pyserver"
else
  echo "cannot find app/ - looked in $HERE and $HERE/pyserver" >&2
  exit 2
fi

PORT="${1:-${RISUHINA_PORT:-6020}}"
LOG="${RISUHINA_LOG:-$ROOT/server.log}"

export RISUHINA_PORT="$PORT"
export RISUHINA_HOST="${RISUHINA_HOST:-127.0.0.1}"
export PYTHONIOENCODING=utf-8

# The bundled interpreter first. python-build-standalone is relocatable but
# does not honour a ._pth, so the two variables that could point it at another
# installation's stdlib or site-packages are cleared here instead.
unset PYTHONPATH PYTHONHOME
PY="$ROOT/python/bin/python3"
[ -x "$PY" ] || PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || command -v python)"

while true; do
  # An update staged a new interpreter as python.new (updater.py never
  # replaces the one it runs on); swap it in while nothing runs from it.
  if [ -d "$ROOT/python.new" ]; then
    rm -rf "$ROOT/python.old"
    [ -d "$ROOT/python" ] && mv "$ROOT/python" "$ROOT/python.old"
    mv "$ROOT/python.new" "$ROOT/python"
    echo "=== interpreter swapped in at $(date)" >> "$LOG"
  fi
  echo "=== start $(date -Is) port=$PORT" >> "$LOG"
  "$PY" "$ROOT/run.py" >> "$LOG" 2>&1
  code=$?
  if [ "$code" = "75" ]; then
    echo "=== update applied, restarting" >> "$LOG"
    continue
  fi
  echo "=== exit $code at $(date -Is)" >> "$LOG"
  exit "$code"
done
