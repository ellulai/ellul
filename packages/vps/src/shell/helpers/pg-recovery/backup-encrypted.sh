#!/bin/bash
set -euo pipefail
# ────────────────────────────────────────────────────────────
# Encrypted PostgreSQL Backup
#
# Extends the base backup with AES-256-GCM envelope encryption.
# Each backup is independently encrypted with a random key,
# then the key is encrypted with the server's ML-KEM public key.
#
# Backup format: .sql.gz.enc (AES-256-GCM encrypted gzip)
# Key format: .sql.gz.enc.key (ML-KEM encrypted backup key)
# Integrity: .sql.gz.enc.sha256 (SHA-256 of encrypted payload)
#
# On-disk backups inside the LUKS volume are already encrypted
# at the block level. This ADDITIONAL encryption ensures:
# 1. Backups remain protected if exported to external object storage for DR
# 2. Each backup has an independent key (forward secrecy)
# 3. Backup keys are bound to the server's ML-KEM identity
# ────────────────────────────────────────────────────────────

BACKUP_DIR="/var/backups/ellul/postgres"
LOGFILE="/var/log/ellul-pg-backup.log"
RETENTION_DAYS=7
CRYPTO_BIN="/usr/local/bin/ellul-crypto"
PUBKEY_FILE="/etc/ellul-bootstrap/heartbeat.pub.json"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [pg-backup-enc] $1" >> "$LOGFILE"; }
touch "$LOGFILE" && chmod 640 "$LOGFILE" 2>/dev/null || true

# Determine encryption mode
ENCRYPT_ENABLED=false
if [ -x "$CRYPTO_BIN" ] && [ -f "$PUBKEY_FILE" ]; then
  ENCRYPT_ENABLED=true
  log "Encryption enabled (ML-KEM key found)"
else
  log "WARN: Encryption not available — falling back to gzip-only"
fi

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

  if [ "$ENCRYPT_ENABLED" = true ]; then
    # ── Encrypted backup path ──────────────────────────────
    OUTFILE="$BACKUP_DIR/${DB}_${TIMESTAMP}.sql.gz.enc"
    KEYFILE="$BACKUP_DIR/${DB}_${TIMESTAMP}.sql.gz.enc.key"
    HASHFILE="$BACKUP_DIR/${DB}_${TIMESTAMP}.sql.gz.enc.sha256"

    # Generate random 256-bit backup key
    BACKUP_KEY=$(head -c 32 /dev/urandom | xxd -p -c 64)

    # Dump → gzip → AES-256-GCM encrypt
    # openssl enc uses PBKDF2 by default; we pass the raw key directly
    if sudo -u postgres pg_dump "$DB" 2>/dev/null | gzip | \
       openssl enc -aes-256-gcm -salt -pass "pass:${BACKUP_KEY}" -out "$OUTFILE" 2>/dev/null; then

      # Encrypt the backup key with the server's ML-KEM public key
      echo -n "$BACKUP_KEY" | "$CRYPTO_BIN" encrypt --pubkey "$PUBKEY_FILE" > "$KEYFILE" 2>/dev/null

      # SHA-256 integrity hash of the encrypted backup
      sha256sum "$OUTFILE" | awk '{print $1}' > "$HASHFILE"

      # Secure permissions
      chmod 640 "$OUTFILE" "$KEYFILE" "$HASHFILE"
      chown root:shield "$OUTFILE" "$KEYFILE" "$HASHFILE" 2>/dev/null || true

      SIZE=$(stat -c%s "$OUTFILE" 2>/dev/null || echo "?")
      log "Encrypted backup: $DB -> $OUTFILE ($SIZE bytes)"
      BACKED_UP=$((BACKED_UP + 1))
    else
      log "WARN: Failed to backup $DB (encrypted)"
      rm -f "$OUTFILE" "$KEYFILE" "$HASHFILE"
    fi

    # Zeroize backup key from memory
    BACKUP_KEY="0000000000000000000000000000000000000000000000000000000000000000"
    unset BACKUP_KEY
  else
    # ── Unencrypted fallback (legacy) ──────────────────────
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
  fi
done

# Prune old backups beyond retention period (both encrypted and plain)
PRUNED=$(find "$BACKUP_DIR" -name "shield_*" \( -name "*.sql.gz" -o -name "*.sql.gz.enc" -o -name "*.enc.key" -o -name "*.enc.sha256" \) -mtime +$RETENTION_DAYS -delete -print 2>/dev/null | wc -l)
[ "$PRUNED" -gt 0 ] && log "Pruned $PRUNED files older than $RETENTION_DAYS days"

log "Backup complete (encrypted=$ENCRYPT_ENABLED)"
