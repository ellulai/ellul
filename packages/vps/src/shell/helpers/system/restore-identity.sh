#!/bin/bash
set -euo pipefail

# Determine service user/home from ellul config
if [ -f /etc/default/ellul ]; then
  source /etc/default/ellul
fi
SVC_USER="${PS_USER:-dev}"
SVC_HOME="/home/${SVC_USER}"

BACKUP_DIR="${SVC_HOME}/.ellul-identity"
TARGET_DIR="/etc/ellul/shield-data"
RESTORED=false

if [ ! -d "$BACKUP_DIR" ]; then
  echo '{"success":true,"restored":false,"reason":"no_backup_dir"}'
  exit 0
fi

if [ ! -f "${BACKUP_DIR}/local-auth.db" ]; then
  echo '{"success":true,"restored":false,"reason":"no_backup_file"}'
  exit 0
fi

# Copy passkey DB files -- atomic: write to .tmp with correct perms, then mv into place.
# Prevents any window where the file exists with wrong ownership.
for dbfile in local-auth.db local-auth.db-wal local-auth.db-shm; do
  if [ -f "${BACKUP_DIR}/${dbfile}" ]; then
    cp -f "${BACKUP_DIR}/${dbfile}" "${TARGET_DIR}/${dbfile}.tmp"
    chown shield-runner:shield-runner "${TARGET_DIR}/${dbfile}.tmp"
    chmod 600 "${TARGET_DIR}/${dbfile}.tmp"
    mv "${TARGET_DIR}/${dbfile}.tmp" "${TARGET_DIR}/${dbfile}"
  fi
done

RESTORED=true

# Restore security tier marker if it was web_locked at backup time.
# IMPORTANT: Do NOT infer private_locked from LUKS state — all volumes are now
# LUKS-encrypted by default. The tier file is authoritative. Only set web_locked
# here; private_locked comes from the API via update-identity (which writes the
# tier file explicitly). If the tier file already says private_locked (restored
# from vault), do not overwrite it.
if [ -f "${BACKUP_DIR}/.web_locked_activated" ]; then
  local CURRENT_TIER
  CURRENT_TIER=$(cat /etc/ellul/security-tier 2>/dev/null | tr -d '[:space:]' || echo "")
  if [ "$CURRENT_TIER" != "private_locked" ]; then
    echo "web_locked" > /etc/ellul/security-tier
    chmod 644 /etc/ellul/security-tier
    chown root:root /etc/ellul/security-tier
  fi
fi

# Restart sovereign-shield to pick up restored passkey DB
systemctl restart ellul-sovereign-shield 2>/dev/null || true

echo "{\"success\":true,\"restored\":${RESTORED}}"
