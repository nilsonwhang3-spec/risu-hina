#!/usr/bin/env bash
# Remove the backend from PM2, leaving the install and its data alone.
#
#   ./service-uninstall.sh [name]
#
# This unregisters the process and nothing else. The code stays, the data stays,
# and start.sh still works by hand. Deleting the install is a separate,
# deliberate act - see docs/05-install.md.
set -eu

NAME="${1:-risu-elf}"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found - nothing to remove" >&2
  exit 0
fi

if ! pm2 describe "$NAME" >/dev/null 2>&1; then
  echo "pm2 has no process called '$NAME' - nothing to remove"
  exit 0
fi

echo "--- stopping and removing '$NAME' ---"
pm2 delete "$NAME"

# Without this the saved list still names it, and the next reboot brings back a
# process this script just removed.
echo "--- saving the process list ---"
pm2 save

echo
if [ "$(pm2 jlist 2>/dev/null | tr -d '[:space:]')" = "[]" ]; then
  cat <<'EOF'
pm2 now manages nothing. If it was only ever used for this, you can drop its
boot hook too:

  pm2 unstartup      # prints a sudo command; run it yourself
EOF
fi

echo
echo "the install and its data are untouched. start.sh still works by hand."
