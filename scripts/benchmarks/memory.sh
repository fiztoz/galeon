#!/usr/bin/env bash
# Sample RSS of a running process (macOS + Linux `ps` compatible).
#
# Usage: scripts/benchmarks/memory.sh <pid> [seconds, default 30]
# Protocol: record once with the app idling on an empty bucket, once with
# the 50k listing loaded (see `bench.sh seed-50k`), and compare peak/avg.
# See docs/BENCHMARKS.md.
set -euo pipefail
PID="${1:-}"
DUR="${2:-30}"
[ -n "$PID" ] || { echo "usage: memory.sh <pid> [seconds]"; exit 1; }
ps -p "$PID" >/dev/null 2>&1 || { echo "no such process: $PID"; exit 1; }

SAMPLES=$(mktemp)
trap 'rm -f "$SAMPLES"' EXIT
end=$(( $(date +%s) + DUR ))
while [ "$(date +%s)" -lt "$end" ]; do
  rss=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ' || true)
  [ -z "$rss" ] && { echo "process $PID exited during sampling"; exit 1; }
  echo "$rss" >> "$SAMPLES"
  sleep 0.5
done
awk '{s+=$1; if ($1+0>m) m=$1; n++} END {printf "samples: %d\navg RSS: %.1f MiB\npeak RSS: %.1f MiB\n", n, s/n/1024, m/1024}' "$SAMPLES"
