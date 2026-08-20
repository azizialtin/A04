#!/usr/bin/env bash
# Back up everything a study run produces: the database, and the uploaded clips
# and gaze chunks that live outside it. Both are needed — the database alone
# restores rows pointing at files that are gone.
#
#   scripts/backup.sh [destination]      # default: ./backups
#
# Reads DATABASE_URL, or falls back to the local compose database.
set -euo pipefail

DEST="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_URL="${DATABASE_URL:-postgresql://a04:a04@localhost:5434/a04}"
UPLOADS="${UPLOADS_DIR:-backend/uploads}"

# pg_dump speaks postgresql://, not SQLAlchemy's postgresql+asyncpg://.
DB_URL="${DB_URL/+asyncpg/}"

mkdir -p "$DEST"

echo "==> database"
pg_dump --format=custom --no-owner --file "$DEST/a04-$STAMP.dump" "$DB_URL"

if [ -d "$UPLOADS" ]; then
  echo "==> uploads ($(du -sh "$UPLOADS" | cut -f1))"
  tar --create --gzip --file "$DEST/uploads-$STAMP.tar.gz" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
else
  echo "==> uploads: $UPLOADS not found, skipping"
fi

echo
echo "Wrote:"
ls -lh "$DEST" | grep "$STAMP"
echo
echo "A backup nobody has restored is a guess. See docs/OPERATIONS.md."
