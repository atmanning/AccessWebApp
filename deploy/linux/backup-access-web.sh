#!/usr/bin/env bash
# Safe online backup of Access Web's data (run as root, e.g. daily from cron):
#   0 2 * * * /opt/access-web/deploy/linux/backup-access-web.sh /var/backups/access-web
set -euo pipefail
umask 077   # backups contain password hashes: root-only
DATA_DIR="${DATA_DIR:-/var/lib/access-web}"
DEST="${1:-/var/backups/access-web}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$DEST"
stamp="$(date +%Y%m%d-%H%M%S)"
# sqlite3's .backup is consistent even while the app is running.
sqlite3 "$DATA_DIR/access-web.db" ".backup '$DEST/access-web-$stamp.db'"
gzip "$DEST/access-web-$stamp.db"
# The MySQL password key, if the app created one (not needed when CONNECTION_SECRET is set).
[[ -f "$DATA_DIR/connection.key" ]] && install -m 600 "$DATA_DIR/connection.key" "$DEST/connection.key"
find "$DEST" -name 'access-web-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "Backed up to $DEST/access-web-$stamp.db.gz"
