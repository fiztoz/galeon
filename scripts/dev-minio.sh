#!/usr/bin/env bash
# Local MinIO loop for Galeon development and transfer benchmarking.
#
#   scripts/dev-minio.sh up      # start MinIO  (S3: localhost:9000, console: localhost:9001)
#   scripts/dev-minio.sh seed    # create 'galeon-test' bucket with small/medium/large test files
#   scripts/dev-minio.sh status  # show container + bucket contents
#   scripts/dev-minio.sh down    # stop container (data volume survives)
#   scripts/dev-minio.sh reset   # stop container and wipe the data volume
#
# Connect from Galeon (dev credentials only — never reuse anywhere real):
#   Endpoint:   http://localhost:9000     Region: us-east-1
#   Access Key: galeon                    Secret: galeon-dev-secret
#   Bucket:     galeon-test               (path-style routing: ON)

set -euo pipefail

NAME=galeon-minio
NET=galeon-net
VOLUME=galeon-minio-data
ACCESS_KEY=galeon
SECRET_KEY=galeon-dev-secret
BUCKET=galeon-test
MINIO_IMAGE=quay.io/minio/minio
MC_IMAGE=quay.io/minio/mc

mc_run() {
  docker run --rm --network "$NET" --entrypoint sh "$MC_IMAGE" -c \
    "mc alias set local http://$NAME:9000 $ACCESS_KEY $SECRET_KEY >/dev/null && $1"
}

case "${1:-}" in
  up)
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
    if docker ps --format '{{.Names}}' | grep -q "^$NAME$"; then
      echo "✔ $NAME already running"
    else
      docker rm "$NAME" >/dev/null 2>&1 || true
      docker run -d --name "$NAME" --network "$NET" \
        -p 9000:9000 -p 9001:9001 \
        -e MINIO_ROOT_USER="$ACCESS_KEY" -e MINIO_ROOT_PASSWORD="$SECRET_KEY" \
        -v "$VOLUME":/data \
        "$MINIO_IMAGE" server /data --console-address ':9001' >/dev/null
      until curl -sf http://localhost:9000/minio/health/live >/dev/null; do sleep 0.5; done
      echo "✔ MinIO up — S3 http://localhost:9000 · console http://localhost:9001 ($ACCESS_KEY / $SECRET_KEY)"
    fi
    ;;
  seed)
    # files are generated inside the container: host bind mounts are not
    # shared into the VM on every Docker flavor (Colima/OrbStack/Desktop)
    mc_run "
      mkdir -p /seed/media /seed/backups &&
      i=1; while [ \$i -le 20 ]; do echo \"galeon test file \$i\" > /seed/notes-\$i.txt; i=\$((i+1)); done &&
      dd if=/dev/urandom of=/seed/media/photo-5mb.bin bs=1048576 count=5 2>/dev/null &&
      dd if=/dev/urandom of=/seed/backups/archive-100mb.bin bs=1048576 count=100 2>/dev/null &&
      mc mb -p local/$BUCKET >/dev/null &&
      mc cp --recursive /seed/ local/$BUCKET/ >/dev/null
    "
    echo "✔ seeded: 20 small files, media/photo-5mb.bin, backups/archive-100mb.bin → $BUCKET"
    ;;
  status)
    docker ps --filter "name=$NAME" --format 'container: {{.Names}} ({{.Status}})' || true
    mc_run "mc ls --recursive local/$BUCKET" || echo "bucket not seeded yet"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "✔ stopped (volume kept)" || echo "not running"
    ;;
  reset)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    echo "✔ stopped and wiped"
    ;;
  *)
    sed -n '2,15p' "$0"; exit 1
    ;;
esac
