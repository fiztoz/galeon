#!/usr/bin/env bash
# S3 PUT/GET throughput baseline against the dev MinIO loop.
#
# This measures the machine + local MinIO ceiling — not Galeon itself.
# Galeon's own transfer timings come from the integrity_e2e suite
# (docs/TEST_INFRA.md); compare the two to isolate app overhead.
# See docs/BENCHMARKS.md for the methodology.
#
# Usage: scripts/benchmarks/throughput.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIXDIR="$ROOT/src-tauri/target/bench"
NET=galeon-net
MINIO=galeon-minio
MC=galeon-bench-mc
MC_IMAGE=quay.io/minio/mc
BUCKET=galeon-test
PREFIX=bench/throughput
# Dev-only credentials — must match scripts/dev-minio.sh (never real secrets).
ACCESS_KEY=galeon
SECRET_KEY=galeon-dev-secret

command -v docker >/dev/null || { echo "missing: docker"; exit 1; }
command -v python3 >/dev/null || { echo "missing: python3"; exit 1; }

"$ROOT/scripts/dev-minio.sh" up >/dev/null

mkdir -p "$FIXDIR"
mkfixture() { # $1=name $2=bytes
  local f="$FIXDIR/$1"
  local size=0
  if [ -f "$f" ]; then size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f"); fi
  if [ "$size" = "$2" ]; then
    echo "reuse $1"
  else
    echo "generating $1 (this takes a while for 1 GiB)…"
    dd if=/dev/urandom of="$f" bs=1048576 count=$(( $2 / 1048576 )) 2>/dev/null
  fi
}
mkfixture fixture-100mb.bin 104857600
mkfixture fixture-1gb.bin 1073741824

# One long-lived mc container: per-call `docker run` startup (~1s) would
# dominate the 100 MB timings, so exec into a sleeper instead.
cleanup() { docker rm -f "$MC" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker rm -f "$MC" >/dev/null 2>&1 || true
docker run -d --name "$MC" --network "$NET" -v "$FIXDIR:/bench:ro" \
  --entrypoint sleep "$MC_IMAGE" infinity >/dev/null
docker exec "$MC" sh -c \
  "mc alias set local http://$MINIO:9000 $ACCESS_KEY $SECRET_KEY >/dev/null"

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# $1=label $2=mc-src $3=mc-dst $4=bytes — prints "<ms> <peak-minio-cpu>".
timed_mc() {
  local stats="$FIXDIR/.cpu"
  rm -f "$stats"
  ( while true; do
      docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' 2>/dev/null \
        | awk -v n="$MINIO" '$1==n {print $2}' >> "$stats" || true
      sleep 1
    done ) &
  local sampler=$!
  local s e ms
  s=$(now_ms)
  docker exec "$MC" mc cp "$2" "$3" >/dev/null
  e=$(now_ms)
  ms=$(( e - s ))
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  local cpu
  cpu=$(awk '{gsub(/%/,""); if ($1+0>m) m=$1} END {if (m=="") print "n/a"; else printf "%.1f%%", m}' "$stats")
  echo "$ms $cpu"
}

row() { # $1=op $2=label $3=bytes $4=src $5=dst
  local out ms cpu mib
  out=$(timed_mc "$1" "$4" "$5")
  ms=${out%% *}; cpu=${out##* }
  mib=$(awk -v b="$3" -v ms="$ms" 'BEGIN {printf "%.1f", b/(ms/1000)/1048576}')
  printf '| %s | %s | %s MiB | %s ms | %s MiB/s | %s |\n' \
    "$1" "$2" "$3" "$ms" "$mib" "$cpu" | tee -a "$RESULTS"
}

RESULTS="$FIXDIR/results-$(date +%Y%m%d-%H%M%S).md"
{
  echo "# throughput baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo '| op | fixture | size (bytes) | wall | throughput | peak minio cpu |'
  echo '|----|---------|--------------|------|------------|----------------|'
} | tee "$RESULTS"

row PUT 100mb 104857600 \
  /bench/fixture-100mb.bin "local/$BUCKET/$PREFIX/fixture-100mb.bin"
row GET 100mb 104857600 \
  "local/$BUCKET/$PREFIX/fixture-100mb.bin" /tmp/dl-100mb.bin
row PUT 1gb 1073741824 \
  /bench/fixture-1gb.bin "local/$BUCKET/$PREFIX/fixture-1gb.bin"
row GET 1gb 1073741824 \
  "local/$BUCKET/$PREFIX/fixture-1gb.bin" /tmp/dl-1gb.bin
docker exec "$MC" rm -f /tmp/dl-100mb.bin /tmp/dl-1gb.bin >/dev/null

echo
echo "results appended to $RESULTS"
