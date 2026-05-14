#!/bin/bash
# ellul-mount-volume -- Mount a block volume at the service user's home.
# Called by file-api via sudo during wake from hibernation.
# Only allows mounting validated device paths to the home directory.
set -euo pipefail

# ERR trap: if any command fails under set -e, produce JSON error output.
# Without this, callers get empty output and can't diagnose the failure.
trap 'echo "{\"success\":false,\"error\":\"mount-volume exited at line $LINENO\"}" ; exit 1' ERR

ACTION="${1:-}"
DEVICE="${2:-}"

# Read LUKS passphrase from well-known tmpfs path if it exists.
# Written by file-api before calling this script; never passed as CLI arg (visible in ps).
# Deleted immediately after reading to minimize exposure window.
LUKS_KEY_PATH="/dev/shm/.luks-platform-key"
if [ -f "$LUKS_KEY_PATH" ]; then
  LUKS_PASSPHRASE=$(cat "$LUKS_KEY_PATH")
  rm -f "$LUKS_KEY_PATH"
fi

# Determine service user/home from ellul config
if [ -f /etc/default/ellul ]; then
  source /etc/default/ellul
fi
SVC_USER="${PS_USER:-dev}"
SVC_HOME="/home/${SVC_USER}"

case "$ACTION" in
  mount)
__DEVICE_MOUNT__
__VAULT_RESTORE__

    # ── LUKS boot markers (runs as root) ──
    # Set decrypted marker and clear pending so sovereign-shield exits locked-but-awake mode.
    # Sync encryption marker to boot volume for next reboot's LUKS boot script.
    if [ "$LUKS_OPENED" = "true" ] || [ -b /dev/mapper/luks-home ]; then
      rm -f /run/ellul-luks-pending 2>/dev/null || true
      touch /run/ellul-decrypted 2>/dev/null || true
      mkdir -p /etc/ellul-bootstrap 2>/dev/null
      echo 1 > /etc/ellul-bootstrap/volume-was-encrypted 2>/dev/null || true
    fi

    echo "{\"success\":true,\"firstBoot\":${FIRST_BOOT},\"vaultRestored\":${VAULT_RESTORED},\"luksOpened\":${LUKS_OPENED},\"device\":\"${DEVICE}\",\"mountPoint\":\"${SVC_HOME}\"}"
    ;;

__FLUSH_UNMOUNT__

  *)
    echo '{"success":false,"error":"Unknown action. Use: mount <device> | flush | force-unmount | luks-close"}'
    exit 1
    ;;
esac