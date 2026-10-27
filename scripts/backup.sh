#!/usr/bin/env bash
# Back up everything a study run produces: the database, and the uploaded clips
# and gaze chunks that live outside it. Both are needed — the database alone
# restores rows pointing at files that are gone.
#
#   scripts/backup.sh [destination]      # default: ./backups
#
# BACKUP_MEDIA_MODE=auto|local|compose; UPLOADS_DIR selects an explicit local directory.
set -euo pipefail
umask 077

DEST="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_URL="${DATABASE_URL:-postgresql://a04:a04@localhost:5434/a04}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPLOADS="${UPLOADS_DIR:-$ROOT/backend/uploads}"
MEDIA_MODE="${BACKUP_MEDIA_MODE:-auto}"
CONTAINER=""

if [ "$MEDIA_MODE" = auto ] || [ "$MEDIA_MODE" = compose ]; then
  if command -v docker >/dev/null 2>&1; then
    CONTAINER="$(docker compose -f "$ROOT/docker-compose.yml" ps -aq backend 2>/dev/null || true)"
  fi
fi
if [ "$MEDIA_MODE" = auto ]; then
  if [ -n "${UPLOADS_DIR:-}" ]; then
    MEDIA_MODE=local
  elif [ -n "$CONTAINER" ]; then
    MEDIA_MODE=compose
  else
    MEDIA_MODE=local
  fi
fi

case "$MEDIA_MODE" in
  local)
    if [ ! -d "$UPLOADS" ]; then
      echo "Uploads directory missing: $UPLOADS. Set UPLOADS_DIR or BACKUP_MEDIA_MODE=compose." >&2
      exit 1
    fi
    ;;
  compose)
    if [ -z "$CONTAINER" ]; then
      echo "No Compose backend container found; cannot locate its uploads volume." >&2
      exit 1
    fi
    MOUNT="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")"
    if [ -z "$MOUNT" ]; then
      echo "The Compose backend has no persistent /app/uploads mount." >&2
      exit 1
    fi
    IMAGE="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
    ;;
  *)
    echo "BACKUP_MEDIA_MODE must be auto, local or compose. Bucket backups use the cloud runbook." >&2
    exit 1
    ;;
esac

# pg_dump speaks postgresql://, not SQLAlchemy's postgresql+asyncpg://.
DB_URL="${DB_URL/+asyncpg/}"

mkdir -p "$DEST"
STAGING="$(mktemp -d "$DEST/.a04-backup-$STAMP.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

echo "==> database"
pg_dump --format=custom --no-owner --file "$STAGING/a04-$STAMP.dump" "$DB_URL"

echo "==> uploads ($MEDIA_MODE)"
if [ "$MEDIA_MODE" = compose ]; then
  # Use the existing container's mount, including when the backend is stopped.
  docker run --rm --network none --volumes-from "$CONTAINER:ro" --entrypoint tar "$IMAGE" \
    --create --gzip --file - -C /app uploads > "$STAGING/uploads-$STAMP.tar.gz"
else
  tar --create --gzip --file "$STAGING/uploads-$STAMP.tar.gz" \
    -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
fi
tar --list --gzip --file "$STAGING/uploads-$STAMP.tar.gz" >/dev/null
mv "$STAGING/a04-$STAMP.dump" "$STAGING/uploads-$STAMP.tar.gz" "$DEST/"

echo
echo "Wrote:"
ls -lh "$DEST/a04-$STAMP.dump" "$DEST/uploads-$STAMP.tar.gz"
echo
echo "A backup nobody has restored is a guess. See docs/OPERATIONS.md."
