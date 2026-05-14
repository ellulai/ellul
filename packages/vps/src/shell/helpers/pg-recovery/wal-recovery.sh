# ── F10: Attempt tracking (persistent across restarts) ────────────
ATTEMPT_FILE="$STATE_DIR/attempt-count"
ATTEMPT_TS_FILE="$STATE_DIR/attempt-timestamp"
ATTEMPT_WINDOW=300  # 5 minutes -- reset counter after this

# Read current attempt count; reset if window expired
ATTEMPT_COUNT=0
if [ -f "$ATTEMPT_FILE" ] && [ -f "$ATTEMPT_TS_FILE" ]; then
  LAST_TS=$(cat "$ATTEMPT_TS_FILE" 2>/dev/null || echo 0)
  NOW_TS=$(date +%s)
  ELAPSED=$(( NOW_TS - LAST_TS ))
  if [ "$ELAPSED" -lt "$ATTEMPT_WINDOW" ]; then
    ATTEMPT_COUNT=$(cat "$ATTEMPT_FILE" 2>/dev/null || echo 0)
  fi
fi

# Increment and persist
ATTEMPT_COUNT=$(( ATTEMPT_COUNT + 1 ))
echo "$ATTEMPT_COUNT" > "$ATTEMPT_FILE"
date +%s > "$ATTEMPT_TS_FILE"

log "Recovery attempt $ATTEMPT_COUNT (window: ${ATTEMPT_WINDOW}s)"

# ── F10: Give up after too many attempts ──────────────────────────
if [ "$ATTEMPT_COUNT" -gt 6 ]; then
  log "FATAL: $ATTEMPT_COUNT recovery attempts exhausted -- giving up to avoid infinite loop"
  log "FATAL: Manual intervention required. Data dir: $PG_DATA"
  report_recovery_event "give_up" "fatal" "$ATTEMPT_COUNT"
  # Exit 0 so systemd doesn't count this as StartPre failure and block future start attempts
  exit 0
fi

# ── Read cluster state ────────────────────────────────────────────
CONTROL_OUTPUT=$(sudo -u postgres "$PG_BIN/pg_controldata" "$PG_DATA" 2>&1) || true
DB_STATE=$(echo "$CONTROL_OUTPUT" | grep "Database cluster state:" | sed 's/.*: *//')
log "Cluster state: '$DB_STATE'"

# ── Recovery functions ────────────────────────────────────────────

run_resetwal() {
  log "Running pg_resetwal -f on $PG_DATA"
  # Stale postmaster.pid defense: pg_resetwal refuses to run while a
  # postmaster.pid exists ("lock file exists; is a server running?"),
  # even when postgres is NOT actually running. This is the exact
  # failure mode that wedged a test server for hours — the recovery
  # loop retried resetwal every 25s forever because the stale pid
  # was never cleaned up. Before resetting WAL, verify that no
  # postgres process is actually running and, if so, delete the stale
  # pid file. This is ONLY safe because pg-recovery runs as
  # ExecStartPre — systemd guarantees the cluster isn't running at
  # this point, so any postmaster.pid we see is by definition stale
  # (it survived a crash, not a clean shutdown).
  if [ -f "$PG_DATA/postmaster.pid" ]; then
    if pgrep -u postgres -f "postgres -D $PG_DATA" >/dev/null 2>&1; then
      log "REFUSING to clear postmaster.pid — a postgres process is running as postgres with this data dir"
      return 1
    fi
    log "Deleting stale postmaster.pid (no matching postgres process)"
    rm -f "$PG_DATA/postmaster.pid" 2>/dev/null || true
  fi
  local output
  output=$(sudo -u postgres "$PG_BIN/pg_resetwal" -f "$PG_DATA" 2>&1) || {
    log "pg_resetwal -f failed: $output"
    return 1
  }
  log "pg_resetwal succeeded: $output"
  return 0
}

run_resetwal_aggressive() {
  # Remove all WAL segments first, then resetwal
  log "Aggressive recovery: removing all WAL segments before pg_resetwal"
  find "$PG_DATA/pg_wal" -maxdepth 1 -type f -name '0*' -delete 2>/dev/null || true
  rm -f "$PG_DATA/pg_wal/archive_status/"* 2>/dev/null || true
  run_resetwal
}

run_reinit() {
  # F10 last resort: re-initialize the cluster. ALL DATA LOST.
  log "LAST RESORT: Re-initializing PostgreSQL cluster (ALL APP DATA WILL BE LOST)"

  # Attempt emergency backup of base tables before destruction
  local backup_dir="/var/backups/ellul/postgres/emergency-$(date +%Y%m%d_%H%M%S)"
  mkdir -p "$backup_dir" 2>/dev/null || true
  if cp -a "$PG_DATA/base" "$backup_dir/base" 2>/dev/null; then
    log "Emergency backup of base/ saved to $backup_dir"
  fi

  # Stop any lingering PG processes
  pkill -u postgres 2>/dev/null || true
  sleep 1

  # Preserve config files (use mktemp to prevent symlink attacks in /tmp)
  local pg_conf="/etc/postgresql/$PG_VERSION/main/postgresql.conf"
  local hba_conf="/etc/postgresql/$PG_VERSION/main/pg_hba.conf"
  local conf_backup
  conf_backup=$(mktemp -d /tmp/pg-conf-backup.XXXXXXXXXX)
  chmod 700 "$conf_backup"
  cp "$pg_conf" "$conf_backup/" 2>/dev/null || true
  cp "$hba_conf" "$conf_backup/" 2>/dev/null || true

  # Re-init
  rm -rf "$PG_DATA"
  sudo -u postgres "$PG_BIN/initdb" -D "$PG_DATA" --auth-local=peer --auth-host=scram-sha-256 2>>"$LOGFILE" || {
    log "FATAL: initdb failed -- cluster is unrecoverable"
    return 1
  }

  # Restore config
  cp "$conf_backup/postgresql.conf" "$pg_conf" 2>/dev/null || true
  cp "$conf_backup/pg_hba.conf" "$hba_conf" 2>/dev/null || true
  chown postgres:postgres "$pg_conf" "$hba_conf" 2>/dev/null || true
  rm -rf "$conf_backup"

  log "Cluster re-initialized. App databases must be re-provisioned."
  return 0
}

# ── Decision logic ────────────────────────────────────────────────

recovery_needed=false

case "$DB_STATE" in
  "shut down"|"shut down in recovery")
    # State looks clean. On first attempt, trust it and let PG try normal start.
    # On attempt 2+, the previous "clean" start must have failed -- force resetwal.
    if [ "$ATTEMPT_COUNT" -le 1 ]; then
      log "Clean shutdown (state: $DB_STATE) -- allowing normal startup"
      exit 0
    else
      log "Clean state but attempt $ATTEMPT_COUNT -- previous startup must have failed"
      recovery_needed=true
    fi
    ;;
  "")
    # F7: Empty state = pg_controldata failed (corrupted/missing pg_control)
    log "WARN: pg_controldata returned empty state -- pg_control may be corrupted"
    recovery_needed=true
    ;;
  *)
    # Any non-clean state: "in production", "in archive recovery", "in crash recovery", etc.
    log "Unclean state: '$DB_STATE' -- recovery required"
    recovery_needed=true
    ;;
esac

if [ "$recovery_needed" = true ]; then
  # Escalation ladder based on attempt count
  if [ "$ATTEMPT_COUNT" -le 3 ]; then
    # Standard recovery: pg_resetwal -f
    if run_resetwal; then
      log "Standard recovery succeeded (attempt $ATTEMPT_COUNT)"
      report_recovery_event "resetwal" "success" "$ATTEMPT_COUNT"
      echo 0 > "$ATTEMPT_FILE"
    else
      log "Standard pg_resetwal failed (attempt $ATTEMPT_COUNT)"
      report_recovery_event "resetwal" "failed" "$ATTEMPT_COUNT"
      exit 1
    fi
  elif [ "$ATTEMPT_COUNT" -le 4 ]; then
    # Aggressive: wipe WAL segments + resetwal
    if run_resetwal_aggressive; then
      log "Aggressive recovery succeeded (attempt $ATTEMPT_COUNT)"
      report_recovery_event "resetwal_aggressive" "success" "$ATTEMPT_COUNT"
      echo 0 > "$ATTEMPT_FILE"
    else
      log "Aggressive recovery failed (attempt $ATTEMPT_COUNT)"
      report_recovery_event "resetwal_aggressive" "failed" "$ATTEMPT_COUNT"
      exit 1
    fi
  elif [ "$ATTEMPT_COUNT" -le 5 ]; then
    # Last resort: re-initialize cluster
    if run_reinit; then
      log "Cluster re-initialized (attempt $ATTEMPT_COUNT -- data loss occurred)"
      report_recovery_event "reinit" "data_loss" "$ATTEMPT_COUNT"
      echo 0 > "$ATTEMPT_FILE"
    else
      log "FATAL: Re-initialization failed (attempt $ATTEMPT_COUNT)"
      report_recovery_event "reinit" "failed" "$ATTEMPT_COUNT"
      exit 1
    fi
  fi
fi
