#!/usr/bin/env bash
# Pre-deploy gate. Prints ALL GREEN or BLOCKED and nothing in between.
#
# Same shape as active-recall's gate: one command, one verdict, no partial
# credit. A suite that "mostly passes" is a suite nobody reads.
set -u

cd "$(dirname "$0")/.." || exit 1

PY="${RISUHINA_TEST_PY:-pyserver/.venv/Scripts/python.exe}"
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
run "provider plan & hints"   "$PY" tests/test_providers.py
run "history thinking ids"    "$PY" tests/test_history.py
run "partial replace"         "$PY" tests/test_textedit.py
run "three-way merge"         "$PY" tests/test_merge.py
run "edit-session lifecycle"  "$PY" tests/test_lifecycle.py
run "backend HTTP (black-box)" "$PY" tests/test_http.py
# Runs real Python through the real runner: the confinement claims in
# sandbox.py are only worth stating if something checks them each time.
run "workspace confinement" "$PY" tests/test_sandbox.py
# The studio is a second file scope on the same code path; the wall between it
# and a bot workspace is the thing worth re-checking on every change.
run "studio scope isolation" "$PY" tests/test_studio.py
# The global space: upload targets, per-bot cleanup, and searches that must
# state what they clipped.
run "global file space" "$PY" tests/test_files.py
# Side events (artifact / images) and the artifact writer's file rules.
run "stream side events" "$PY" tests/test_stream_events.py
# Gemini thought signatures round-trip through the OpenAI-compatible client.
run "tool signatures"       "$PY" tests/test_toolsigs.py
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
