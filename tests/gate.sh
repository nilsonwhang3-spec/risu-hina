#!/usr/bin/env bash
# Pre-deploy gate. Prints ALL GREEN or BLOCKED and nothing in between.
#
# Same shape as active-recall's gate: one command, one verdict, no partial
# credit. A suite that "mostly passes" is a suite nobody reads.
set -u

cd "$(dirname "$0")/.." || exit 1

PY="${RISUELF_TEST_PY:-pyserver/.venv/Scripts/python.exe}"
[ -x "$PY" ] || PY="$(command -v python3 || command -v python)"

fail=0
run() {
  echo "=== $1 ==="
  shift
  if "$@"; then
    echo "--- ok"
  else
    echo "--- FAILED"
    fail=1
  fi
  echo
}

run "chatfmt round-trip"      "$PY" tests/test_roundtrip.py
run "backend HTTP (black-box)" "$PY" tests/test_http.py
# Runs real Python through the real runner: the confinement claims in
# sandbox.py are only worth stating if something checks them each time.
run "workspace confinement" "$PY" tests/test_sandbox.py
# Real model, real tool loop. Skips itself when no credentials are configured,
# so the gate stays runnable offline.
run "agent end-to-end (real model)" "$PY" tests/test_agent.py

if [ -d plugin/node_modules ]; then
  run "plugin typecheck" node plugin/node_modules/typescript/bin/tsc -p plugin/tsconfig.json --noEmit
  run "plugin build"     node plugin/build.config.mjs
  run "plugin smoke (real DOM + real backend)" node tests/plugin_smoke.mjs
else
  echo "=== plugin ==="
  echo "--- skipped (run 'npm install' in plugin/)"
  echo
fi

if [ "$fail" -eq 0 ]; then
  echo "ALL GREEN"
  exit 0
fi
echo "BLOCKED - not deploying"
exit 1
