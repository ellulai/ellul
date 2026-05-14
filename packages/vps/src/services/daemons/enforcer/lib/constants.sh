#!/bin/bash
# Enforcer Constants
# Configuration variables and paths for the state enforcer daemon.

# ─── Platform Detection ──────────────────────────────────────
# Detect once at startup; every helper branches on IS_MACOS.
IS_MACOS=false
if [ "$(uname -s)" = "Darwin" ]; then
  IS_MACOS=true
fi

# API_URL resolution: config file > environment > baked-in value from bundle.ts
# This ensures the enforcer works even if the script was installed with stale/placeholder values
if [ -f /etc/ellul/api-url ]; then
  API_URL="$(cat /etc/ellul/api-url 2>/dev/null | tr -d '\n')"
fi
API_URL="${API_URL:-}"
TOKEN="${ELLUL_AI_TOKEN:-}"
# Derive service user from PS_USER (loaded by systemd EnvironmentFile from /etc/default/ellul)
SVC_USER="${PS_USER:-dev}"
if [ "$IS_MACOS" = true ]; then
  SVC_HOME="/Users/${SVC_USER}"
else
  SVC_HOME="/home/${SVC_USER}"
fi
ENV_FILE="${SVC_HOME}/.ellul-cli-env"
STATE_FILE="/etc/ellul/access-state.json"
STATUS_FILE="${SVC_HOME}/.ellul/server-status.json"
LOG_FILE="/var/log/ellul-enforcer.log"
SOVEREIGN_MARKER="/etc/ellul/.sovereign-mode"
SOVEREIGN_KEYS_LOCK="/etc/ellul/shield-data/.sovereign-keys"
OWNER_LOCK_FILE="/etc/ellul/owner.lock"
HEARTBEAT_FAILURE_FILE="/etc/ellul/.heartbeat-failures"
HEARTBEAT_INTERVAL=10
ENFORCER_PID_FILE="/run/ellul-enforcer.pid"

# ─── Agent Manifest Self-Update System ──────────────────────
# See packages/vps/src/services/daemons/enforcer/lib/agent-sync.sh.
AGENT_RELEASES_ROOT="/opt/ellul/releases"
AGENT_STAGE_ROOT="/opt/ellul/staging"
AGENT_MANIFEST_VERSION_FILE="/etc/ellul/shield-data/.agent-manifest-version"
AGENT_INSTALLED_FILE="/etc/ellul/shield-data/.agent-versions.json"
AGENT_UPDATE_LOCK="/var/lock/ellul-agent-update.lock"
# Sovereignty: when `false`, VPS stages + verifies updates but refuses to
# apply them without an explicit `apply-pending-update` signed command
# (enqueued via the dashboard "Update" button). Default true.
AGENT_AUTO_UPDATE_FILE="/etc/ellul/shield-data/.agent-auto-update"
# Staged-but-not-applied manifest payload (when auto-update=false).
# Consumed by the apply-pending-update DIRECT command handler.
AGENT_PENDING_MANIFEST_FILE="/etc/ellul/shield-data/.agent-pending-manifest.json"
# Written by _apply_self_update before exec; deleted by the new daemon
# after its first successful heartbeat. If a new daemon boots and finds
# a stale marker (older than AGENT_COMMIT_WINDOW_SEC), it reverts to
# the recorded previous version.
AGENT_PENDING_COMMIT_FILE="/etc/ellul/shield-data/.agent-pending-commit.json"
AGENT_COMMIT_WINDOW_SEC=120

# ─── Liveness ping ──────────────────
# Separate channel from the manifest sync loop. agent_ping() fires
# unconditionally every PING_INTERVAL_TICKS heartbeat ticks, reporting
# {agentVersion, installedVersions, manifestVersion, autoUpdate, systemdHealth}
# so the dashboard has a live "last seen" signal even when the manifest sync
# is 304-ing. Server response may push a new cadence back at runtime.
PING_INTERVAL_TICKS=3
# Runtime-tunable; agent_ping writes the server-pushed interval back
# into this file so it survives enforcer restarts. Honoured on next boot.
AGENT_PING_TICK_FILE="/etc/ellul/shield-data/.agent-ping-tick"
# Sentinel marking "no ping has ever succeeded this boot". In /run
# (tmpfs) so it resets on reboot — guarantees at least one ping attempt
# per boot even if the cadence file says something absurd.
AGENT_PING_BOOT_MARKER="/run/ellul-agent-ping-boot"

# All terminal services - used for lockdown and health checks
if [ "$IS_MACOS" = true ]; then
  # macOS: terminals are dynamic (agent-bridge managed), no systemd template units
  ALL_TERMINALS=""
else
  ALL_TERMINALS="ttyd@main ttyd@opencode ttyd@claude ttyd@codex ttyd@cursor ttyd@git ttyd@branch ttyd@save ttyd@ship ttyd@undo ttyd@logs ttyd@clean"
fi

# ─── Platform-Aware Service Helpers ──────────────────────────
# Abstract systemctl (Linux) vs launchctl (macOS).
# macOS launchd labels: ai.ellul.<name> (from provisioning plists)
# Linux systemd units:  ellul-<name> (from provisioning .service files)

# Map a systemd unit name to a launchd label.
# e.g. "ellul-file-api" → "ai.ellul.file-api"
#      "ttyd@main"         → "" (no macOS equivalent)
_launchd_label() {
  local svc="$1"
  case "$svc" in
    ellul-*) echo "ai.ellul.${svc#ellul-}" ;;
    ttyd@*)    echo "" ;; # No macOS equivalent -- terminals are dynamic
    *)         echo "$svc" ;;
  esac
}

# Check if a service is running
svc_is_active() {
  local svc="$1"
  if [ "$IS_MACOS" = true ]; then
    local label=$(_launchd_label "$svc")
    [ -z "$label" ] && return 1
    launchctl print "system/$label" &>/dev/null 2>&1
  else
    systemctl is-active --quiet "$svc" 2>/dev/null
  fi
}

# Check if a service is enabled (auto-start)
svc_is_enabled() {
  local svc="$1"
  if [ "$IS_MACOS" = true ]; then
    local label=$(_launchd_label "$svc")
    [ -z "$label" ] && return 1
    # launchd: if plist exists in LaunchDaemons and is loaded, it's "enabled"
    launchctl print "system/$label" &>/dev/null 2>&1
  else
    systemctl is-enabled --quiet "$svc" 2>/dev/null
  fi
}

# Start a service
svc_start() {
  local svc="$1"
  if [ "$IS_MACOS" = true ]; then
    local label=$(_launchd_label "$svc")
    [ -z "$label" ] && return 0
    launchctl kickstart "system/$label" 2>/dev/null || true
  else
    systemctl start "$svc" 2>/dev/null
  fi
}

# Stop a service
svc_stop() {
  local svc="$1"
  if [ "$IS_MACOS" = true ]; then
    local label=$(_launchd_label "$svc")
    [ -z "$label" ] && return 0
    launchctl kill SIGTERM "system/$label" 2>/dev/null || true
  else
    systemctl stop "$svc" 2>/dev/null
  fi
}

# Restart a service (stop + start)
svc_restart() {
  local svc="$1"
  if [ "$IS_MACOS" = true ]; then
    local label=$(_launchd_label "$svc")
    [ -z "$label" ] && return 0
    launchctl kickstart -k "system/$label" 2>/dev/null || true
  else
    systemctl restart "$svc" 2>/dev/null
  fi
}

# Enable a service (auto-start on boot)
svc_enable() {
  local svc="$1"
  if [ "$IS_MACOS" = true ]; then
    # launchd: RunAtLoad in plist handles this; load if not already loaded
    local label=$(_launchd_label "$svc")
    [ -z "$label" ] && return 0
    launchctl load "/Library/LaunchDaemons/${label}.plist" 2>/dev/null || true
  else
    systemctl enable "$svc" 2>/dev/null
  fi
}

# Disable a service
svc_disable() {
  local svc="$1"
  if [ "$IS_MACOS" = true ]; then
    local label=$(_launchd_label "$svc")
    [ -z "$label" ] && return 0
    launchctl bootout "system/$label" 2>/dev/null || true
  else
    systemctl disable "$svc" 2>/dev/null
  fi
}

# Reset failed state (Linux-only; no-op on macOS)
svc_reset_failed() {
  if [ "$IS_MACOS" = true ]; then
    return 0
  fi
  systemctl reset-failed $@ 2>/dev/null || true
}

# ─── Platform-Aware System Helpers ───────────────────────────

# Run a command as the service user
run_as_user() {
  if [ "$IS_MACOS" = true ]; then
    sudo -u "$SVC_USER" bash -c "$@"
  else
    runuser -l "$SVC_USER" -c "$@"
  fi
}

# Get all listening TCP ports
get_listening_ports() {
  if [ "$IS_MACOS" = true ]; then
    lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null | awk 'NR>1{print $9}' | awk -F: '{print $NF}' | sort -n | uniq | tr '\n' ',' | sed 's/,$//'
  else
    ss -tlnH 2>/dev/null | awk '{print $4}' | awk -F: '{print $NF}' | sort -n | uniq | tr '\n' ',' | sed 's/,$//'
  fi
}

# Get public IP address
get_public_ip() {
  local ip
  ip=$(curl -sf --connect-timeout 2 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null \
    || curl -sf --connect-timeout 2 "http://169.254.169.254/hetzner/v1/metadata/public-ipv4" 2>/dev/null)
  if [ -z "$ip" ]; then
    if [ "$IS_MACOS" = true ]; then
      ip=$(ipconfig getifaddr en0 2>/dev/null || route get default 2>/dev/null | awk '/interface:/{print $2}' | xargs ipconfig getifaddr 2>/dev/null)
    else
      ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
    fi
  fi
  echo "$ip"
}

# Firewall: allow a TCP port
fw_allow() {
  local port="$1"
  local comment="${2:-}"
  if [ "$IS_MACOS" = true ]; then
    # macOS BYOS uses relaxed mode -- Application Firewall doesn't block by port
    return 0
  else
    ufw allow "$port/tcp" comment "$comment" 2>/dev/null || true
  fi
}

# Firewall: deny/remove a TCP port rule
fw_deny() {
  local port="$1"
  if [ "$IS_MACOS" = true ]; then
    return 0
  else
    ufw delete allow "$port/tcp" 2>/dev/null || true
  fi
}

# Firewall: check if a TCP port is allowed
fw_is_allowed() {
  local port="$1"
  if [ "$IS_MACOS" = true ]; then
    # macOS BYOS: always allowed (relaxed mode)
    return 0
  else
    ufw status | grep -q "${port}/tcp.*ALLOW"
  fi
}

# Get file modification time as epoch seconds
file_mtime() {
  local file="$1"
  if [ "$IS_MACOS" = true ]; then
    stat -f %m "$file" 2>/dev/null || echo 0
  else
    stat -c %Y "$file" 2>/dev/null || echo 0
  fi
}

# In-place sed (macOS requires '' backup arg)
sed_inplace() {
  if [ "$IS_MACOS" = true ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# base64 encode without line wrapping
b64_encode() {
  if [ "$IS_MACOS" = true ]; then
    base64
  else
    base64 -w0
  fi
}

# base64 encode a file without line wrapping
b64_encode_file() {
  if [ "$IS_MACOS" = true ]; then
    base64 -i "$1"
  else
    base64 -w0 "$1"
  fi
}

# base64 decode from stdin
b64_decode() {
  if [ "$IS_MACOS" = true ]; then
    base64 -D
  else
    base64 -d
  fi
}
