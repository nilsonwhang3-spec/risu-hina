#!/usr/bin/env bash
# Stop Risu Hina and undo what setup.sh did.
#
#   ./uninstall.sh              stop it, unregister from pm2. Keeps everything.
#   ./uninstall.sh --purge      also delete the venv and the data
#
# Without --purge nothing is deleted: the code stays, the data stays, and
# ./start.sh still works by hand. Deleting someone's chats has to be something
# they asked for in so many words.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$HERE/app" ]; then SERVER="$HERE"; else SERVER="$HERE/pyserver"; fi
ROOT="$(dirname "$SERVER")"

NAME="risu-hina"; PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name)    NAME="${2:-}"; shift 2 ;;
    --purge)   PURGE=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- pm2 --------------------------------------------------------------------
if command -v pm2 >/dev/null 2>&1 && pm2 describe "$NAME" >/dev/null 2>&1; then
  echo "removing '$NAME' from pm2"
  pm2 delete "$NAME" >/dev/null
  # Without this the saved list still names it and the next reboot brings back
  # the process this just removed.
  pm2 save >/dev/null
  echo '  done'
else
  echo 'pm2: nothing registered'
fi

# --- any process still running out of this install --------------------------
if pgrep -f "$SERVER/run.py" >/dev/null 2>&1; then
  echo 'stopping the server'
  pkill -f "$SERVER/run.py" || true
  sleep 2
fi
# The launcher loop would restart a killed server, so kill it too.
pkill -f "$SERVER/start.sh" 2>/dev/null || true

echo 'stopped'

if [ "$PURGE" = "1" ]; then
  DATA="$ROOT/data"
  PIN="$SERVER/datadir.txt"
  [ -f "$PIN" ] && DATA="$(tr -d '\r\n' < "$PIN")"
  echo
  echo "purging:"
  [ -d "$SERVER/.venv" ] && echo "  $SERVER/.venv"
  echo "  $DATA"
  rm -rf "$SERVER/.venv"
  rm -rf "$DATA"
  rm -f "$PIN"
  echo 'purged. The code is still here; delete this folder to finish.'
else
  echo
  echo 'nothing deleted. To also remove the venv and the data:  ./uninstall.sh --purge'
  echo 'Your RisuAI chats are untouched either way - this tool only ever wrote'
  echo 'back edits you approved.'
fi
