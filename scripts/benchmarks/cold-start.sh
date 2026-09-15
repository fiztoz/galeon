#!/usr/bin/env bash
# Cold-start launch latency of the built Galeon binary.
#
# Desktop-only: needs a WindowServer/display. In CI or over SSH it prints
# SKIP and exits 0. Launches the release binary if present (else debug),
# waits until RSS stabilises ("settled"), reports wall time + binary size,
# then quits what it started (by PID — never touches your real instance).
# "Settled" is an approximation, not first-paint; see docs/BENCHMARKS.md.
#
# Usage: scripts/benchmarks/cold-start.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [ "$(uname)" = "Darwin" ]; then
  pgrep -x WindowServer >/dev/null 2>&1 || { echo "SKIP: no display (headless macOS)"; exit 0; }
else
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || { echo "SKIP: no display (headless Linux)"; exit 0; }
fi

if pgrep -x Galeon >/dev/null 2>&1 || pgrep -x galeon >/dev/null 2>&1; then
  echo "ABORT: a Galeon instance is already running — quit it first so timings are honest."
  exit 1
fi

BIN=""
[ -x "$ROOT/src-tauri/target/release/galeon" ] && BIN="$ROOT/src-tauri/target/release/galeon"
[ -z "$BIN" ] && [ -x "$ROOT/src-tauri/target/release/Galeon" ] && BIN="$ROOT/src-tauri/target/release/Galeon"
[ -z "$BIN" ] && [ -x "$ROOT/src-tauri/target/debug/galeon" ] && BIN="$ROOT/src-tauri/target/debug/galeon"
[ -z "$BIN" ] && { echo "no built binary — run 'bun run tauri build' (or dev-build) first."; exit 1; }
echo "binary: $BIN ($(du -sh "$BIN" | cut -f1))"

START=$(python3 -c 'import time; print(int(time.time()*1000))')
"$BIN" >/dev/null 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT

stable=0
last=0
elapsed=0
while [ "$elapsed" -lt 60000 ]; do
  sleep 0.1
  rss=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ' || true)
  [ -z "$rss" ] && { echo "app exited during launch (exit before settle)"; exit 1; }
  if [ "$last" != "0" ]; then
    lo=$(( last * 98 / 100 )); hi=$(( last * 102 / 100 + 1 ))
    if [ "$rss" -ge "$lo" ] && [ "$rss" -le "$hi" ]; then
      stable=$((stable+1))
    else
      stable=0
    fi
  fi
  last=$rss
  elapsed=$(( $(python3 -c 'import time; print(int(time.time()*1000))') - START ))
  [ "$stable" -ge 10 ] && break
done

echo "time-to-settled: ${elapsed} ms (RSS $(awk -v r="$last" 'BEGIN {printf "%.1f", r/1024}') MiB)"
