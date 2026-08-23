#!/usr/bin/env bash
# Register the backend with PM2 so it survives a reboot.
#
#   ./service-install.sh [port] [name]
#
# PM2 runs start.sh, not run.py directly. That matters: exit code 75 means "an
# update was installed, come back up", and the loop that understands it lives in
# the launcher. Pointing a supervisor straight at run.py works until the day
# someone updates from the plugin, and then it stops silently.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-6020}"
NAME="${2:-risu-elf}"

LAUNCHER="$HERE/start.sh"
[ -f "$LAUNCHER" ] || { echo "cannot find start.sh next to this script ($HERE)" >&2; exit 2; }
chmod +x "$LAUNCHER" 2>/dev/null || true

if ! command -v pm2 >/dev/null 2>&1; then
  cat >&2 <<'EOF'
pm2 not found.

  npm install -g pm2

If you would rather not use PM2 at all, start.sh works on its own - the restart
loop is in it, not in the supervisor. A systemd unit calling start.sh is the
other reasonable option.
EOF
  exit 2
fi

if pm2 describe "$NAME" >/dev/null 2>&1; then
  echo "pm2 already has a process called '$NAME'." >&2
  echo "Remove it first:  ./service-uninstall.sh $NAME" >&2
  exit 2
fi

echo "--- starting under pm2 ---"
# --interpreter bash, because pm2 assumes node for anything it does not
# recognise and would try to run the launcher as JavaScript.
pm2 start "$LAUNCHER" --name "$NAME" --interpreter bash -- "$PORT"

echo "--- saving the process list ---"
pm2 save

echo "--- boot persistence ---"
# `pm2 startup` does not install anything itself: it prints a sudo command for
# this init system and expects a human to run it. Printing that is the honest
# thing to do - silently running a sudo command someone did not read is not.
if pm2 startup 2>&1 | tee /tmp/pm2-startup.$$ | grep -q 'sudo'; then
  echo
  echo "Run the sudo command printed above to survive a reboot, then:  pm2 save"
fi
rm -f "/tmp/pm2-startup.$$"

echo
sleep 4
if command -v curl >/dev/null 2>&1; then
  echo "health: $(curl -sS --max-time 5 "http://127.0.0.1:${PORT}/health" || echo 'unreachable yet')"
fi
echo
echo "manage it with:  pm2 status|logs|restart|stop $NAME"
echo "remove it with:  ./service-uninstall.sh $NAME"
