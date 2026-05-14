#!/bin/bash
# PostgreSQL WAL Recovery -- ellul.ai production
# See pg-recovery.ts for full documentation of failure modes handled.

# Intentionally NOT set -e: we handle errors explicitly per-command.
# set -u catches unbound variables, pipefail catches pipe errors.
set -uo pipefail

LOGFILE="/var/log/ellul-pg-recovery.log"
LOCKFILE="/run/ellul-pg-recovery.lock"
STATE_DIR="/var/lib/ellul-pg-recovery"
RECOVERY_EVENTS_FILE="/etc/ellul/pg-recovery-events"
touch "$LOGFILE" && chmod 640 "$LOGFILE" 2>/dev/null || true
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [pg-recovery] $*" >> "$LOGFILE"; }

# Report recovery events for heartbeat pickup (same pattern as boot-failures).
# Each event is one line: JSON object with timestamp, action, attempt, result.
report_recovery_event() {
  local action="$1" result="$2" attempt="$3"
  local ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  printf '{"ts":"%s","action":"%s","attempt":%s,"result":"%s"}\n' "$ts" "$action" "$attempt" "$result" >> "$RECOVERY_EVENTS_FILE" 2>/dev/null || true
}

# ── F9: Mutual exclusion via flock ────────────────────────────────────
# Prevents enforcer + systemd ExecStartPre from colliding.
# Non-blocking: if another instance holds the lock, exit cleanly (the
# other instance is already handling recovery).
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  log "Another recovery instance is running -- exiting"
  exit 0
fi

# ── Persistent state directory (root-only -- agent cannot manipulate counters) ──
mkdir -p "$STATE_DIR" 2>/dev/null || true
chmod 700 "$STATE_DIR" 2>/dev/null || true

__FAILURE_DETECTION__

__WAL_RECOVERY__

exit 0