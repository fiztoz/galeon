#!/usr/bin/env bash
# Galeon benchmark harness entry point.
#
#   scripts/benchmarks/bench.sh throughput   # MinIO fixtures + PUT/GET baseline table
#   scripts/benchmarks/bench.sh seed-50k     # 50k objects for the listing benchmark
#   scripts/benchmarks/bench.sh cold-start   # app launch latency (macOS desktop only)
#   scripts/benchmarks/bench.sh memory PID   # sample RSS of a running app process
#
# Throughput and seeding are fully automatic (they only need Docker + the
# dev MinIO loop). Cold-start and memory need a display and a human driving
# the app. See docs/BENCHMARKS.md for the methodology.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  throughput) exec "$HERE/throughput.sh" ;;
  seed-50k) exec "$HERE/seed-50k.sh" ;;
  cold-start) exec "$HERE/cold-start.sh" ;;
  memory) exec "$HERE/memory.sh" "${2:-}" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
