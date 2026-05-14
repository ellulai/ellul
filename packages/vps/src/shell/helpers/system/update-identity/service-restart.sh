
# ============================================================
# SERVICE RESTART
# ============================================================
#
# Two modes:
#
# 1. STANDALONE (SKIP_ENFORCER_RESTART=0, default):
#    Called by sudo from file-api or manual invocation.
#    Restarts enforcer → sovereign-shield → caddy reload.
#
# 2. ENFORCER-INLINE (SKIP_ENFORCER_RESTART=1):
#    Called from the enforcer's DIRECT update-identity handler.
#    Does NOT restart any services — the enforcer's deferred restart
#    handles everything via the production boot sequence:
#      vault bind mount check → ownership fix → iptables restore
#      → start_services_idempotent(force_restart)
#    This is the only path that correctly handles post-migration state
#    (LUKS open, vault bind mounts, stale service detection).
#    Restarting services here would race with the deferred restart
#    and start them before vault mounts are verified.
#
# Safety invariant: Caddy must NEVER be left stopped. If this
# script crashes mid-restart, the EXIT trap restarts Caddy so
# the server stays reachable.
# ============================================================

# Trap: if the script exits for ANY reason (crash, OOM kill signal,
# set -e failure), make sure Caddy is running. A stopped Caddy means
# the server is completely unreachable -- no SSH, no bridge, nothing.
cleanup() {
  if ! systemctl is-active --quiet caddy 2>/dev/null; then
    log "EXIT TRAP: Caddy is not running -- forcing restart"
    systemctl restart caddy 2>/dev/null || systemctl start caddy 2>/dev/null || true
  fi
}
trap cleanup EXIT

# When called from the enforcer (migration path), skip all service restarts.
# The enforcer's deferred restart runs the full boot sequence which:
#   1. Verifies vault bind mounts (restore_server_state / boot vault check)
#   2. Fixes ownership and permissions
#   3. Restores iptables
#   4. Starts all services with force_restart
# This is the battle-tested path that handles every lifecycle event
# (wake, block-migrate, resize, reboot). Restarting services here
# would bypass vault verification and start them with wrong config.
if [ "${SKIP_ENFORCER_RESTART:-0}" = "1" ]; then
  log "Enforcer-inline mode: skipping service restart (deferred restart handles full boot sequence)"
  echo '{"success":true,"serverId":"'$SERVER_ID'"}'
  exit 0
fi

# --- Standalone mode: restart services directly ---

# Restart a systemd service with retry + stabilization check.
# Args: <service-name> <max-attempts> <stabilize-seconds>
# Returns 0 if service is confirmed active, 1 if all attempts failed.
restart_svc() {
  local svc=$1
  local max_attempts=${2:-3}
  local stabilize=${3:-5}
  local attempt=1

  while [ $attempt -le $max_attempts ]; do
    log "Restarting $svc (attempt $attempt/$max_attempts)"

    # timeout prevents hanging if service is stuck in stop/start phase
    if timeout 30 systemctl restart "$svc" >/dev/null 2>&1; then
      # systemctl restart returned 0, but the process could crash instantly.
      # Poll is-active to catch immediate crashes before declaring success.
      local elapsed=0
      while [ $elapsed -lt $stabilize ]; do
        sleep 1
        elapsed=$((elapsed + 1))
        if ! systemctl is-active --quiet "$svc" 2>/dev/null; then
          log "WARNING: $svc crashed ${elapsed}s after start"
          break
        fi
      done

      if systemctl is-active --quiet "$svc" 2>/dev/null; then
        log "$svc is active (stable for ${stabilize}s)"
        return 0
      fi
    else
      log "WARNING: systemctl restart $svc failed (attempt $attempt)"
    fi

    attempt=$((attempt + 1))
    if [ $attempt -le $max_attempts ]; then
      log "Retrying in 3s..."
      sleep 3
    fi
  done

  log "ERROR: $svc failed after $max_attempts attempts"
  return 1
}

# 1. Enforcer -- heartbeat signing, independent of Caddy
restart_svc ellul-enforcer 3 3 || FAILURES="${FAILURES} enforcer"

# 2. Sovereign-shield -- main site forward_auth depends on this
restart_svc ellul-sovereign-shield 3 5 || FAILURES="${FAILURES} shield"

# 3. Reload Caddy (graceful, no connection drop)
if [ "$CADDY_REGEN" = "true" ] || [ -n "$DOMAIN" ]; then
  log "Reloading Caddy with new config..."
  if caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock >/dev/null 2>&1; then
    sleep 2
    if systemctl is-active --quiet caddy 2>/dev/null; then
      log "Caddy reloaded successfully"
    else
      log "WARNING: Caddy not active after reload, restarting..."
      restart_svc caddy 3 3 || FAILURES="${FAILURES} caddy"
    fi
  else
    log "WARNING: Caddy reload failed, falling back to restart..."
    restart_svc caddy 3 3 || FAILURES="${FAILURES} caddy"
  fi
fi

# --- Final verification ---
FAILED_SVCS=""
for svc in ellul-enforcer ellul-sovereign-shield caddy; do
  if ! systemctl is-active --quiet "$svc" 2>/dev/null; then
    FAILED_SVCS="${FAILED_SVCS} $svc"
  fi
done

if [ -n "$FAILED_SVCS" ]; then
  log "CRITICAL: services not running after restart:$FAILED_SVCS"
  echo '{"success":true,"serverId":"'$SERVER_ID'","warnings":"services not active:'$FAILED_SVCS'"}'
else
  log "All services verified active"
  echo '{"success":true,"serverId":"'$SERVER_ID'"}'
fi
