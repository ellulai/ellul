#!/bin/bash
set -e

[ -f /etc/default/ellul ] && source /etc/default/ellul
SVC_USER="${PS_USER:-dev}"
SVC_HOME="/home/${SVC_USER}"

LOCK_FILE="/etc/ellul/shield-data/.sovereign-keys"
SSH_KEY="$1"

# Check if already locked
if [ -f "$LOCK_FILE" ]; then
  echo "ERROR: Sovereign Lock is active."
  echo "SSH key installation is permanently disabled via platform."
  echo ""
  echo "To add more keys via SSH:"
  echo "  ellul-add-key 'ssh-ed25519 AAAA...'"
  exit 1
fi

if [ -z "$SSH_KEY" ]; then
  echo "Usage: sudo setup-ssh-key \"ssh-ed25519 AAAA...\""
  exit 1
fi

if ! echo "$SSH_KEY" | grep -qE '^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp256) '; then
  echo "ERROR: Invalid SSH key format."
  echo "Key must start with: ssh-ed25519, ssh-rsa, or ecdsa-sha2-nistp256"
  exit 1
fi

# Install the key (root-owned path — agent cannot read, write, or execute).
#
# CRITICAL — vault bind-mount race. /etc/ssh/authorized_keys is a bind
# mount from $SVC_HOME/.ellul-vault/etc/ssh/authorized_keys (defined
# in fstab with `nofail`). At runtime the bind mount is normally active
# and writes to /etc/ssh/authorized_keys/$USER pass through to the vault.
# But during early provisioning — and any time `home-dev.mount` hasn't
# yet been registered as a systemd unit — the bind mount silently fails
# (nofail). Writes to the root-FS path then go to the underlying empty
# directory, which the next reboot's bind mount overlays and hides. The
# user sees their SSH key disappear after one reboot.
#
# The fix: ALWAYS write to the vault source path directly, never to the
# bind-mount target. The vault source is the source of truth; the bind
# mount surfaces it. Writes here survive any reboot, with or without
# the bind mount being active at write time.
AUTH_KEYS_BIND_TARGET="/etc/ssh/authorized_keys"
VAULT_AUTH_KEYS_DIR="$SVC_HOME/.ellul-vault/etc/ssh/authorized_keys"

# Pick the canonical write target: prefer the vault source if the vault
# exists; otherwise fall back to the bind target (fresh-bootstrap case
# where the vault hasn't been created yet — see vault-restore.sh, which
# also creates the directory if missing).
if [ -d "$SVC_HOME/.ellul-vault" ]; then
  AUTH_KEYS_DIR="$VAULT_AUTH_KEYS_DIR"
  mkdir -p "$AUTH_KEYS_DIR"
  # Vault is owned by root; the runtime bind mount is `root:shield 0770`.
  # Mirror those perms here so the chmod after the bind mount activates
  # has the right starting state.
  chown root:shield "$AUTH_KEYS_DIR" 2>/dev/null || chown root:root "$AUTH_KEYS_DIR"
  chmod 770 "$AUTH_KEYS_DIR"
else
  AUTH_KEYS_DIR="$AUTH_KEYS_BIND_TARGET"
  mkdir -p "$AUTH_KEYS_DIR"
  chmod 700 "$AUTH_KEYS_DIR"
fi

AUTH_KEYS_FILE="$AUTH_KEYS_DIR/$SVC_USER"
echo "$SSH_KEY" >> "$AUTH_KEYS_FILE"
chmod 600 "$AUTH_KEYS_FILE"
chown root:root "$AUTH_KEYS_FILE"

# If we wrote to the vault source AND the bind-mount target also has a
# stale copy from a previous broken provisioning (root-FS path that got
# hidden by the bind mount), remove it so the only source of truth is
# the vault. Otherwise on next boot, if the bind mount fails, sshd would
# fall back to the stale root-FS file and accept a key the user thought
# was gone.
if [ "$AUTH_KEYS_DIR" != "$AUTH_KEYS_BIND_TARGET" ] \
   && [ -f "$AUTH_KEYS_BIND_TARGET/$SVC_USER" ] \
   && ! mountpoint -q "$AUTH_KEYS_BIND_TARGET" 2>/dev/null; then
  rm -f "$AUTH_KEYS_BIND_TARGET/$SVC_USER" 2>/dev/null || true
fi

# Lock down authorized_keys (prevents tampering even by root)
chattr +i "$AUTH_KEYS_FILE" 2>/dev/null || true

# Create the sovereign lock (prevents future platform key injection)
touch "$LOCK_FILE"
chmod 400 "$LOCK_FILE"
chattr +i "$LOCK_FILE" 2>/dev/null || true

# Open port 22
ufw allow 22/tcp comment 'SSH' >/dev/null 2>&1
systemctl restart sshd 2>/dev/null || systemctl restart ssh

PUBLIC_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "SSH key installed successfully."
echo "Sovereign Lock engaged (no further keys can be added via platform)."
echo "authorized_keys locked (chattr +i). Use sudo chattr -i to modify."
echo "Port 22 opened."
echo ""
echo "Connect with: ssh $SVC_USER@$PUBLIC_IP"
