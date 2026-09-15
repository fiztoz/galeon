#!/usr/bin/env bash
# Seed 50,000 small objects for the listing benchmark.
#
# 1,000 tiny local files copied into 50 distinct prefixes of the dev bucket
# (same bytes, distinct keys — listings only care about key count).
# Takes a few minutes; run once, then load the bucket root in Galeon and
# sample RSS with `bench.sh memory <pid>`. See docs/BENCHMARKS.md.
#
# Usage: scripts/benchmarks/seed-50k.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BATCH="$ROOT/src-tauri/target/bench/bulk-batch"
NET=galeon-net
MINIO=galeon-minio
MC=galeon-bench-mc
MC_IMAGE=quay.io/minio/mc
BUCKET=galeon-test
DEST_PREFIX=bench/50k
BATCHES=50
# Dev-only credentials — must match scripts/dev-minio.sh (never real secrets).
ACCESS_KEY=galeon
SECRET_KEY=galeon-dev-secret

command -v docker >/dev/null || { echo "missing: docker"; exit 1; }

"$ROOT/scripts/dev-minio.sh" up >/dev/null

mkdir -p "$BATCH"
if [ "$(ls "$BATCH" 2>/dev/null | wc -l | tr -d ' ')" != "1000" ]; then
  echo "generating 1,000-file batch…"
  rm -f "$BATCH"/*
  i=1; while [ "$i" -le 1000 ]; do echo "galeon listing bench file $i" > "$BATCH/file-$i.txt"; i=$((i+1)); done
else
  echo "reuse batch (1,000 files)"
fi

cleanup() { docker rm -f "$MC" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker rm -f "$MC" >/dev/null 2>&1 || true
docker run -d --name "$MC" --network "$NET" -v "$BATCH:/batch:ro" \
  --entrypoint sleep "$MC_IMAGE" infinity >/dev/null
docker exec "$MC" sh -c \
  "mc alias set local http://$MINIO:9000 $ACCESS_KEY $SECRET_KEY >/dev/null"

i=1; while [ "$i" -le "$BATCHES" ]; do
  printf '\rprefix %d/%d…' "$i" "$BATCHES"
  docker exec "$MC" mc cp --recursive /batch/ "local/$BUCKET/$DEST_PREFIX/batch-$i/" >/dev/null
  i=$((i+1))
done
printf '\n✔ 50,000 objects under s3://%s/%s/\n' "$BUCKET" "$DEST_PREFIX"
