#!/bin/bash
# ellul.ai State Enforcer Daemon (ellul-env)
# Rebuilt by rebuild-all

API_URL="__API_URL__"
TOKEN="$ELLUL_AI_TOKEN"
DAEMON_VERSION="$(jq -r '."ellul-env" // "unknown"' /etc/ellul/shield-data/.agent-versions.json 2>/dev/null || echo 'unknown')"

__SECTIONS__

# ============================================
# Main Daemon Loop
# ============================================

run_daemon() {
  log "============================================"
  log "ellul.ai Enforcer UPDATED - v${DAEMON_VERSION}"
  log "If you see this, the update was successful!"
  log "============================================"
  log "Starting state enforcer daemon v${DAEMON_VERSION} (heartbeat every ${HEARTBEAT_INTERVAL}s)..."

  agent_sync_recover_from_crash

  # Write PID file
  echo $$ > "$ENFORCER_PID_FILE"
  trap 'rm -f "$ENFORCER_PID_FILE"' EXIT

  WAKEUP=0
  trap 'WAKEUP=1' USR1

  # Clean up any stale lockdown markers from pre-Phase 4
  rm -f /etc/ellul/.emergency-lockdown /etc/ellul/.in_lockdown 2>/dev/null || true

  local HEARTBEAT_COUNT=0
  local SERVICE_CHECK_COUNT=0
  local CONSECUTIVE_FAILURES=0

  while true; do
    if heartbeat_raw 2>/dev/null; then
      # Heartbeat succeeded - reset failure counter
      if [ "$CONSECUTIVE_FAILURES" -gt 0 ]; then
        CONSECUTIVE_FAILURES=0
        reset_failure_count
      fi
      agent_sync_commit_pending
    else
      # Heartbeat failed -- log only, no lockdown
      CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
      save_failure_count "$CONSECUTIVE_FAILURES"
      log "WARN: Heartbeat failed ($CONSECUTIVE_FAILURES consecutive failures)"
    fi

    SERVICE_CHECK_COUNT=$((SERVICE_CHECK_COUNT + 1))
    if [ $SERVICE_CHECK_COUNT -ge 2 ]; then
      check_critical_services
      SERVICE_CHECK_COUNT=0
    fi

    # Phase 4: Version updates deferred to future self-update mechanism
    # (heartbeat response no longer carries version/update signals)

    # Interruptible sleep: SIGUSR1 interrupts wait immediately (zero latency)
    WAKEUP=0
    sleep $HEARTBEAT_INTERVAL &
    SLEEP_PID=$!
    wait $SLEEP_PID 2>/dev/null
    if [ $WAKEUP -eq 1 ]; then
      kill $SLEEP_PID 2>/dev/null
      wait $SLEEP_PID 2>/dev/null
      log "Push trigger received -- running immediate heartbeat"
    fi
  done
}

# ============================================
# CLI Handler
# ============================================

case "$1" in
  sync) sync_all ;;
  heartbeat) heartbeat ;;
  daemon) run_daemon ;;
  sessions) get_active_sessions ;;
  apps) get_deployed_apps ;;
  status)
    echo ""
    echo -e "\033[32mellul.ai Status\033[0m"
    echo ""
    echo "  Terminal Sessions:"
    for name in main opencode claude codex cursor git branch save ship undo logs clean; do
      STATUS=$(systemctl is-active "ttyd@$name" 2>/dev/null || echo "inactive")
      if [ "$STATUS" = "active" ]; then
        echo -e "    \033[32m*\033[0m $name"
      else
        echo -e "    \033[90mo\033[0m $name"
      fi
    done
    echo ""
    echo "  Deployed Apps:"
    APPS_DIR="__SVC_HOME__/.ellul/apps"
    if ls "$APPS_DIR"/*.json &>/dev/null; then
      for f in "$APPS_DIR"/*.json; do
        [ -f "$f" ] || continue
        APP_NAME=$(jq -r '.name' "$f")
        APP_URL=$(jq -r '.url' "$f")
        APP_PORT=$(jq -r '.port' "$f")
        echo -e "    \033[32m*\033[0m $APP_NAME (:$APP_PORT) -> $APP_URL"
      done
    else
      echo -e "    \033[90mo\033[0m (none deployed)"
    fi
    echo ""
    echo "  CPU Usage: $(get_cpu_usage)%"
    echo "  RAM Usage: $(get_ram_usage)%"
    echo -n "  SSH: "; ufw status | grep -q "22/tcp.*ALLOW" && echo "OPEN" || echo "CLOSED"
    echo ""
    ;;
  kill)
    SESSION="$2"
    if [ -z "$SESSION" ]; then
      echo "Usage: ellul-env kill <session>"
      exit 1
    fi
    log "Manually stopping session: $SESSION"
    systemctl stop "ttyd@$SESSION" 2>/dev/null
    echo "Stopped: $SESSION"
    ;;
  *) echo "Usage: ellul-env {sync|heartbeat|daemon|sessions|apps|status|kill <session>}" ;;
esac
