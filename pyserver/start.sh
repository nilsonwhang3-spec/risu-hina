#!/usr/bin/env bash
# Risu Elf backend launcher.
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

PORT="${1:-${RISUELF_PORT:-6020}}"
LOG="${RISUELF_LOG:-$ROOT/server.log}"

export RISUELF_PORT="$PORT"
export RISUELF_HOST="${RISUELF_HOST:-127.0.0.1}"
export PYTHONIOENCODING=utf-8

PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY="$ROOT/.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="$(command -v python3 || command -v python)"

while true; do
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
