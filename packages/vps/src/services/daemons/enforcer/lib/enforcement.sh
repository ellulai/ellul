#!/bin/bash
# Enforcer Enforcement Functions
# Settings enforcement (local settings.json application).
#
# Phase 4 cleanup: The following command handlers were moved to the
# sovereign-shield bridge and are no longer processed by the enforcer:
#   - execute_kill_orders()   -- terminal session kills
#   - handle_security_action() -- tier switching, shield updates
#   - handle_git_action()     -- git setup/push/pull/teardown
#   - kill_dev_ports()        -- dev port process killing
# These are now handled via WebSocket bridge commands routed through
# sovereign-shield (port 3005) instead of heartbeat polling.

# Enforce tier-based settings
enforce_settings() {
  local TERMINAL_ENABLED="$1"
  local SSH_ENABLED="$2"

  # Get current security tier
  local TIER=$(detect_security_tier)

  # Enforce tier-based rules (override platform settings if needed)
  case "$TIER" in
    standard)
      SSH_ENABLED="false"
      TERMINAL_ENABLED="true"
      ;;
    web_locked|private_locked)
      TERMINAL_ENABLED="true"
      # Check root-owned authorized_keys (read by AuthorizedKeysCommand as root)
      local AUTH_KEYS="/etc/ssh/authorized_keys/${SVC_USER}"
      if [ -f "$AUTH_KEYS" ] && [ -s "$AUTH_KEYS" ]; then
        SSH_ENABLED="true"
      else
        SSH_ENABLED="false"
      fi
      ;;
  esac

  # Standard tier: SSH is always disabled (no SSH support).
  # Web locked tier: SSH is enabled only if keys are present (checked above).
  # No safety override -- standard tier servers use web terminal only.

  # ── SSH infrastructure integrity enforcement ──
  # Enforces permissions AND immutability on every heartbeat cycle.
  # Any tampering (even by a compromised root service) is auto-remediated.

  # 1. AuthorizedKeysCommand script: 0700 root:root + immutable
  local SSH_CMD="/usr/local/bin/ellul-ssh-authorized-keys"
  if [ -f "$SSH_CMD" ]; then
    local CMD_PERMS=$(stat -c '%a:%U:%G' "$SSH_CMD" 2>/dev/null)
    if [ "$CMD_PERMS" != "700:root:root" ]; then
      chattr -i "$SSH_CMD" 2>/dev/null || true
      chown root:root "$SSH_CMD"
      chmod 700 "$SSH_CMD"
      chattr +i "$SSH_CMD" 2>/dev/null || true
      log "SECURITY: AuthorizedKeysCommand permissions enforced (was: $CMD_PERMS)"
    fi
    # Ensure immutable flag is set
    if ! lsattr "$SSH_CMD" 2>/dev/null | grep -q '^\S*i'; then
      chattr +i "$SSH_CMD" 2>/dev/null || true
    fi
  fi

  # 2. sshd config drop-in: immutable (prevents swapping AuthorizedKeysCommand back to AuthorizedKeysFile)
  local SSHD_CONF="/etc/ssh/sshd_config.d/ellul.conf"
  if [ -f "$SSHD_CONF" ]; then
    if ! lsattr "$SSHD_CONF" 2>/dev/null | grep -q '^\S*i'; then
      chattr +i "$SSHD_CONF" 2>/dev/null || true
      log "SECURITY: sshd config immutable flag restored"
    fi
  fi

  # 3. authorized_keys directory: 0770 root:shield
  # shield group allows sovereign-shield (shield-runner) to manage key files
  # for web_locked tier SSH key management. The agent user is NOT in the shield
  # group, so it still has zero access.
  local AUTH_KEYS_DIR="/etc/ssh/authorized_keys"
  if [ -d "$AUTH_KEYS_DIR" ]; then
    local DIR_PERMS=$(stat -c '%a:%U:%G' "$AUTH_KEYS_DIR" 2>/dev/null)
    if [ "$DIR_PERMS" != "770:root:shield" ]; then
      chown root:shield "$AUTH_KEYS_DIR"
      chmod 770 "$AUTH_KEYS_DIR"
      log "SECURITY: authorized_keys dir permissions enforced (was: $DIR_PERMS)"
    fi
  fi

  # 4. authorized_keys file: 0660 root:shield
  # shield group allows sovereign-shield to manage keys for web_locked SSH.
  # sshd reads via AuthorizedKeysCommand (as root). Agent user has no access.
  local AUTH_KEYS="/etc/ssh/authorized_keys/${SVC_USER}"
  if [ -f "$AUTH_KEYS" ]; then
    local KEY_PERMS=$(stat -c '%a:%U:%G' "$AUTH_KEYS" 2>/dev/null)
    if [ "$KEY_PERMS" != "660:root:shield" ]; then
      chown root:shield "$AUTH_KEYS"
      chmod 660 "$AUTH_KEYS"
      log "SECURITY: authorized_keys file permissions enforced (was: $KEY_PERMS)"
    fi
  fi

  # 5. web_locked: .ssh dir root-owned to prevent agent creating authorized_keys2 or symlinks
  if [ "$TIER" = "web_locked" ] || [ "$TIER" = "private_locked" ] && [ -d "${SVC_HOME}/.ssh" ]; then
    local DIR_OWNER=$(stat -c '%U' "${SVC_HOME}/.ssh" 2>/dev/null)
    if [ "$DIR_OWNER" != "root" ]; then
      chown root:root "${SVC_HOME}/.ssh"
      chmod 700 "${SVC_HOME}/.ssh"
      [ -f "${SVC_HOME}/.ssh/authorized_keys" ] && chown root:root "${SVC_HOME}/.ssh/authorized_keys" && chmod 600 "${SVC_HOME}/.ssh/authorized_keys"
      log "SSH .ssh/ locked to root (web_locked tier)"
    fi
  fi

  # Enforce SSH state
  if [ "$SSH_ENABLED" = "false" ]; then
    fw_is_allowed 22 && fw_deny 22
  elif [ "$SSH_ENABLED" = "true" ]; then
    fw_is_allowed 22 || fw_allow 22 'SSH'
  fi

  local TERMINAL_DISABLED_MARKER="/etc/ellul/shield-data/.terminal-disabled"
  if [ -f "$TERMINAL_DISABLED_MARKER" ]; then
    stop_all_terminals
  elif [ "$TERMINAL_ENABLED" = "false" ]; then
    stop_all_terminals
  elif [ "$TERMINAL_ENABLED" = "true" ]; then
    if [ -f /etc/ellul/jwt-secret ] || [ "$TIER" != "standard" ]; then
      start_all_terminals
    fi
  fi

  # 6. shield-data: shield-runner:shield-ipc 2710 — bridge reads cross-project config via group traverse
  local SD_PERMS=$(stat -c '%a:%G' /etc/ellul/shield-data 2>/dev/null)
  if [ "$SD_PERMS" != "2710:shield-ipc" ]; then
    chown shield-runner:shield-ipc /etc/ellul/shield-data 2>/dev/null
    chmod 2710 /etc/ellul/shield-data 2>/dev/null
  fi
  for _cf in /etc/ellul/shield-data/cross-project-access.json /etc/ellul/shield-data/preview-ports.json; do
    [ -f "$_cf" ] && [ "$(stat -c '%G' "$_cf" 2>/dev/null)" != "shield-ipc" ] && chgrp shield-ipc "$_cf" 2>/dev/null
  done

  echo "{\"terminalEnabled\": $TERMINAL_ENABLED, \"sshEnabled\": $SSH_ENABLED, \"tier\": \"$TIER\", \"enforcedAt\": \"$(date -Iseconds)\"}" > "$STATE_FILE"
}

# Enforce gbrain/gstack feature state from features.json.
# Ensures systemd service state matches the persisted toggle.
enforce_features() {
  local FEATURES_FILE="/etc/ellul/agent-bridge/features.json"
  [ -f "$FEATURES_FILE" ] || return 0

  local GBRAIN_ENABLED=$(jq -r '.gbrain.enabled // false' "$FEATURES_FILE" 2>/dev/null || echo "false")

  if [ "$GBRAIN_ENABLED" = "true" ]; then
    if [ -f /opt/ellul/gbrain/src/cli.ts ]; then
      # Run init only if credentials are missing (avoids psql forks every heartbeat).
      if [ -x /usr/local/bin/ellul-gbrain-init ] && [ ! -f /etc/ellul/gbrain/env ]; then
        /usr/local/bin/ellul-gbrain-init 2>/dev/null || log "WARNING: gbrain init failed"
      fi
      if ! systemctl is-active --quiet ellul-gbrain.service 2>/dev/null; then
        systemctl enable --now ellul-gbrain.service 2>/dev/null && log "Features: gbrain started from persisted state" || log "WARNING: gbrain start failed"
      fi
    fi
  else
    if systemctl is-active --quiet ellul-gbrain.service 2>/dev/null; then
      systemctl disable --now ellul-gbrain.service 2>/dev/null && log "Features: gbrain stopped (disabled in features.json)"
    fi
  fi
}

# VPS-DRIVEN SECURITY: SSH keys are NEVER accepted from the platform.
# All SSH key management happens on the VPS via:
# - Standard tier: N/A (SSH disabled)
# - Web Locked tier: Via passkey-protected UI (/_auth/keys)
handle_keys() {
  local INSTALL_KEY="$1"
  [ -z "$INSTALL_KEY" ] || [ "$INSTALL_KEY" = "null" ] && return 0

  # BLOCKED: Platform should never push SSH keys
  log "SECURITY: Platform attempted SSH key injection. BLOCKED."
  log "  VPS is the source of truth for SSH keys. Manage keys via VPS only."
  return 0
}

# sync_secrets() -- REMOVED (Phase 2: secrets managed locally by sovereign-shield)
# Secrets are now sent directly from browser to VPS via /_auth/secrets endpoints.
# The enforcer no longer receives or processes encrypted secrets.
