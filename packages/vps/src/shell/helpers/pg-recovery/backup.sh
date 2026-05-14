#!/bin/bash
set -euo pipefail
BACKUP_DIR="/var/backups/ellul/postgres"
LOGFILE="/var/log/ellul-pg-backup.log"
RETENTION_DAYS=7

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [pg-backup] $1" >> "$LOGFILE"; }
touch "$LOGFILE" && chmod 640 "$LOGFILE" 2>/dev/null || true

# Get all shield_* databases
DBS=$(sudo -u postgres psql -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'shield_%' AND datistemplate = false;" 2>/dev/null)
if [ -z "$DBS" ]; then
  log "No shield_* databases found -- skipping backup"
  exit 0
fi

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
BACKED_UP=0

echo "$DBS" | while read -r DB; do
  [ -z "$DB" ] && continue
  OUTFILE="$BACKUP_DIR/${DB}_${TIMESTAMP}.sql.gz"
  if sudo -u postgres pg_dump "$DB" 2>/dev/null | gzip > "$OUTFILE"; then
    chmod 640 "$OUTFILE"
    chown root:shield "$OUTFILE" 2>/dev/null || true
    SIZE=$(stat -c%s "$OUTFILE" 2>/dev/null || echo "?")
    log "Backed up $DB -> $OUTFILE ($SIZE bytes)"
    BACKED_UP=$((BACKED_UP + 1))
  else
    log "WARN: Failed to backup $DB"
    rm -f "$OUTFILE"
  fi
done

# Prune old backups beyond retention period
PRUNED=$(find "$BACKUP_DIR" -name "shield_*.sql.gz" -mtime +$RETENTION_DAYS -delete -print 2>/dev/null | wc -l)
[ "$PRUNED" -gt 0 ] && log "Pruned $PRUNED backups older than $RETENTION_DAYS days"

log "Backup complete"
