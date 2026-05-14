#!/bin/bash
set -e

SSH_KEY="$1"

if [ -z "$SSH_KEY" ]; then
  echo "Usage: ellul-add-key 'ssh-ed25519 AAAA...'"
  exit 1
fi

if ! echo "$SSH_KEY" | grep -qE '^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp256) '; then
  echo "ERROR: Invalid SSH key format."
  echo "Key must start with: ssh-ed25519, ssh-rsa, or ecdsa-sha2-nistp256"
  exit 1
fi

# Refuse to write if /etc/ssh/authorized_keys is NOT a live bind mount.
# Without the bind mount the write goes to the underlying root filesystem,
# which gets hidden by the empty vault directory on the next reboot — the
# user's added key would silently disappear.
#
# This guard catches the case where the home-dev systemd mount unit isn't
# registered yet (early boot) or has failed (vault unreachable). If you
# see this error in production, the fix is to investigate why the vault
# bind mount isn't active before re-running the command — see
# /usr/local/bin/ellul-mount-volume and the wake-mount logic in the
# enforcer's heartbeat loop.
if ! mountpoint -q /etc/ssh/authorized_keys 2>/dev/null; then
  echo "ERROR: /etc/ssh/authorized_keys is not a live bind mount." >&2
  echo "Refusing to write — your key would be silently lost on the next reboot" >&2
  echo "when the bind mount overlays the vault directory." >&2
  echo "" >&2
  echo "Investigate: sudo systemctl status home-dev.mount; mount | grep authorized_keys" >&2
  exit 2
fi

AUTH_KEYS_FILE="/etc/ssh/authorized_keys/$(whoami)"
sudo chattr -i "$AUTH_KEYS_FILE"
echo "$SSH_KEY" | sudo tee -a "$AUTH_KEYS_FILE" > /dev/null
sudo chattr +i "$AUTH_KEYS_FILE"
echo "Key added and file re-locked."
