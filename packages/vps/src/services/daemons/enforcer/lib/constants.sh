#!/bin/bash
# Enforcer Constants
# Configuration variables and paths for the state enforcer daemon.

# API_URL resolution: config file > environment > baked-in value from bundle.ts
# This ensures the enforcer works even if the script was installed with stale/placeholder values
if [ -f /etc/ellul/api-url ]; then
  API_URL="$(cat /etc/ellul/api-url 2>/dev/null | tr -d '\n')"
fi
API_URL="${API_URL:-}"
TOKEN="${ELLUL_AI_TOKEN:-}"
# Derive service user from PS_USER (loaded by systemd EnvironmentFile from /etc/default/ellul)
SVC_USER="${PS_USER:-dev}"
SVC_HOME="/home/${SVC_USER}"
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
ALL_TERMINALS="ttyd@main ttyd@opencode ttyd@claude ttyd@codex ttyd@cursor ttyd@git ttyd@branch ttyd@save ttyd@ship ttyd@undo ttyd@logs ttyd@clean"

# ─── Service Helpers ──────────────────────────────────────

svc_is_active() {
  systemctl is-active --quiet "$1" 2>/dev/null
}

svc_is_enabled() {
  systemctl is-enabled --quiet "$1" 2>/dev/null
}

svc_start() {
  systemctl start "$1" 2>/dev/null
}

svc_stop() {
  systemctl stop "$1" 2>/dev/null
}

svc_restart() {
  systemctl restart "$1" 2>/dev/null
}

svc_enable() {
  systemctl enable "$1" 2>/dev/null
}

svc_disable() {
  systemctl disable "$1" 2>/dev/null
}

svc_reset_failed() {
  systemctl reset-failed $@ 2>/dev/null || true
}

# ─── System Helpers ───────────────────────────────────────

run_as_user() {
  runuser -l "$SVC_USER" -c "$@"
}

get_listening_ports() {
  ss -tlnH 2>/dev/null | awk '{print $4}' | awk -F: '{print $NF}' | sort -n | uniq | tr '\n' ',' | sed 's/,$//'
}

get_public_ip() {
  local ip
  ip=$(curl -sf --connect-timeout 2 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null \
    || curl -sf --connect-timeout 2 "http://169.254.169.254/hetzner/v1/metadata/public-ipv4" 2>/dev/null)
  if [ -z "$ip" ]; then
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
  fi
  echo "$ip"
}

fw_allow() {
  local port="$1"
  local comment="${2:-}"
  ufw allow "$port/tcp" comment "$comment" 2>/dev/null || true
}

fw_deny() {
  local port="$1"
  ufw delete allow "$port/tcp" 2>/dev/null || true
}

fw_is_allowed() {
  local port="$1"
  ufw status | grep -q "${port}/tcp.*ALLOW"
}

file_mtime() {
  stat -c %Y "$1" 2>/dev/null || echo 0
}

sed_inplace() {
  sed -i "$@"
}

b64_encode() {
  base64 -w0
}

b64_encode_file() {
  base64 -w0 "$1"
}

b64_decode() {
  base64 -d
}
