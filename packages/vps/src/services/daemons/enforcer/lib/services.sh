#!/bin/bash
# Enforcer Services Functions
# Monitor and restart critical services.

# One-time boot validation -- catches provisioning failures early.
# Runs once at enforcer startup before the main heartbeat loop.
validate_full_stack() {
  # Skip when LUKS volume is locked (sovereign mode, post-migration awaiting PRF unlock).
  # Services can't start without the vault. Boot validation would spend 3-5 minutes
  # on failed service checks, exceeding TimeoutStartSec=300 and killing the enforcer
  # before it reaches the heartbeat loop — preventing wake-mount delivery.
  if [ -f /etc/ellul-bootstrap/volume-was-encrypted ] && [ ! -b /dev/mapper/luks-home ]; then
    log "Boot validation skipped (LUKS locked — sovereign awaiting PRF unlock)"
    return
  fi

  local FAILURES=0
  local FAILURE_LIST=""

  # Check warden if firewall mode requires it (Linux only -- macOS BYOS uses relaxed mode)
  FIREWALL_MODE=$(cat /etc/ellul/firewall-mode 2>/dev/null)
  if [ "$FIREWALL_MODE" = "partial_ironclad" ] || [ "$FIREWALL_MODE" = "full_ironclad" ]; then
    if ! svc_is_active ellul-warden; then
      log "BOOT VALIDATION FAILED: warden not running"
      svc_start ellul-warden
      sleep 2
      FAILURES=$((FAILURES + 1))
      FAILURE_LIST="${FAILURE_LIST}warden_not_running\n"
    else
      WARDEN_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" -m 3 http://localhost:8081/_health 2>/dev/null || echo "000")
      if [ "$WARDEN_HEALTH" != "200" ]; then
        log "BOOT VALIDATION FAILED: warden health check returned $WARDEN_HEALTH"
        svc_restart ellul-warden
        sleep 2
        FAILURES=$((FAILURES + 1))
        FAILURE_LIST="${FAILURE_LIST}warden_health_failed\n"
      fi
    fi

    # Verify dev user has outbound internet (catches warden misconfiguration)
    if ! run_as_user 'curl -sS --connect-timeout 5 -o /dev/null https://1.1.1.1' 2>/dev/null; then
      log "BOOT VALIDATION FAILED: $SVC_USER has no outbound internet"
      svc_restart ellul-warden
      sleep 3
      FAILURES=$((FAILURES + 1))
      FAILURE_LIST="${FAILURE_LIST}no_outbound_internet\n"
    fi
  fi

  # Check sovereign-shield
  if ! curl -s --connect-timeout 3 -o /dev/null http://127.0.0.1:3005/_auth/health 2>/dev/null; then
    log "BOOT VALIDATION FAILED: sovereign-shield not responding"
    svc_restart ellul-sovereign-shield
    sleep 2
    FAILURES=$((FAILURES + 1))
    FAILURE_LIST="${FAILURE_LIST}shield_not_responding\n"
  fi

  # Check PostgreSQL -- use pg_isready with timeout as ground truth
  if svc_is_enabled postgresql 2>/dev/null; then
    if ! timeout 5 sudo -u postgres pg_isready -q 2>/dev/null; then
      log "BOOT VALIDATION FAILED: postgresql not ready"
      # Run full recovery (WAL reset, ownership fix, stale PID cleanup)
      if [ -x /usr/local/bin/ellul-pg-recovery ]; then
        /usr/local/bin/ellul-pg-recovery 2>/dev/null || true
      fi
      chown -R postgres:postgres /var/lib/postgresql 2>/dev/null || true
      # Reset failed state on the cluster unit so systemd allows restart
      for unit in $(systemctl list-units --type=service --all --plain --no-legend 2>/dev/null | awk '/^postgresql@/{print $1}'); do
        systemctl reset-failed "$unit" 2>/dev/null || true
      done
      svc_restart postgresql
      sleep 5
      # Verify recovery worked
      if timeout 5 sudo -u postgres pg_isready -q 2>/dev/null; then
        log "BOOT VALIDATION: postgresql recovered after recovery"
      else
        log "BOOT VALIDATION: postgresql still not ready after recovery attempt"
      fi
      FAILURES=$((FAILURES + 1))
      FAILURE_LIST="${FAILURE_LIST}postgresql_not_ready\n"
    fi
  fi

  # Check billing-tier config exists (provisioning must write this)
  if [ ! -f /etc/ellul/billing-tier ]; then
    log "BOOT VALIDATION FAILED: /etc/ellul/billing-tier missing -- sovereign-shield running in permissive mode"
    FAILURES=$((FAILURES + 1))
    FAILURE_LIST="${FAILURE_LIST}billing_tier_missing\n"
  fi

  # Check product config exists (provisioning must write this)
  if [ ! -f /etc/ellul/product ]; then
    log "BOOT VALIDATION WARNING: /etc/ellul/product missing -- sovereign-shield defaulting to cloud_platform"
    FAILURES=$((FAILURES + 1))
    FAILURE_LIST="${FAILURE_LIST}product_missing\n"
  fi

  # Check agent-bridge (only if provisioned — governance tier skips it)
  if svc_is_enabled ellul-agent-bridge 2>/dev/null; then
    if ! svc_is_active ellul-agent-bridge; then
      log "BOOT VALIDATION FAILED: agent-bridge not running"
      svc_restart ellul-agent-bridge
      sleep 2
      FAILURES=$((FAILURES + 1))
      FAILURE_LIST="${FAILURE_LIST}agent_bridge_not_running\n"
    fi
  fi

  # ZeroClaw: per-project daemons are spawned on-demand by agent-bridge.
  # No global daemon to validate at boot — just check binary exists.
  if svc_is_enabled ellul-agent-bridge 2>/dev/null; then
    if [ ! -x /usr/local/bin/zeroclaw ]; then
      log "BOOT VALIDATION WARNING: ZeroClaw binary not found"
    fi
  fi

  if [ $FAILURES -eq 0 ]; then
    log "Boot validation passed -- all critical services operational"
    rm -f /etc/ellul/boot-failures
  else
    log "Boot validation completed with $FAILURES failures -- remediation attempted"
    mkdir -p /etc/ellul
    printf "%b" "$FAILURE_LIST" | head -20 > /etc/ellul/boot-failures
  fi
}

# Clean up orphaned preview-* PM2 processes whose project directory no longer exists.
# Runs with cooldown -- only checks every 5 minutes to avoid pm2 jlist + python3 on every heartbeat.
PREVIEW_GC_LAST=0
check_preview_processes() {
  local NOW
  NOW=$(date +%s)
  if [ $(( NOW - PREVIEW_GC_LAST )) -lt 300 ]; then
    return
  fi
  PREVIEW_GC_LAST=$NOW
  if ! command -v pm2 &>/dev/null 2>&1 && ! run_as_user 'command -v pm2' &>/dev/null 2>&1; then
    return
  fi
  ORPHANED=$(run_as_user 'pm2 jlist 2>/dev/null' 2>/dev/null | python3 -c "
import sys,json,os,re
try:
  raw=sys.stdin.read()
  m=re.search(r'\[\s*\{', raw)
  if not m: sys.exit(0)
  procs=json.loads(raw[m.start():])
  for p in procs:
    name=p.get('name','')
    if name.startswith('preview-'):
      project=name[len('preview-'):]
      project_dir=os.path.join('${SVC_HOME}/projects', project)
      if not os.path.isdir(project_dir):
        print(name)
except Exception:
  pass
" 2>/dev/null)
  if [ -n "$ORPHANED" ]; then
    echo "$ORPHANED" | while read -r pname; do
      # Sanitize PM2 process name to prevent shell injection (agent controls names)
      sanitized=$(echo "$pname" | tr -cd 'a-zA-Z0-9_.-')
      if [ -z "$sanitized" ] || [ "$sanitized" != "$pname" ]; then
        log "GC: skipping process with invalid name: $(echo "$pname" | head -c 50)"
        continue
      fi
      log "GC: stopping orphaned preview process $sanitized"
      run_as_user "pm2 delete '$sanitized' 2>/dev/null" || true
    done
  fi
}

# Suspend idle preview/deploy apps to free RAM.
# Dev servers (Next.js, Vite) can push a host over the OOM edge when multiple
# workspaces are active. Suspend after 30 min of no HTTP traffic.
# Wake-on-request is handled by Caddy's on_demand/lazy_load (returns 502 → user refreshes).
IDLE_APP_LAST=0
check_idle_apps() {
  local NOW
  NOW=$(date +%s)
  # Only check every 5 minutes
  if [ $(( NOW - IDLE_APP_LAST )) -lt 300 ]; then
    return
  fi
  IDLE_APP_LAST=$NOW

  local IDLE_THRESHOLD=1800  # 30 minutes

  # Require both pm2 and ss
  if ! run_as_user 'command -v pm2' &>/dev/null 2>&1; then return; fi
  if ! command -v ss &>/dev/null; then return; fi

  # Get running preview/deploy PM2 processes — pure bash + jq (no Python)
  local PM2_JSON
  PM2_JSON=$(run_as_user 'pm2 jlist 2>/dev/null' 2>/dev/null) || return

  # Require jq for reliable JSON parsing
  if ! command -v jq &>/dev/null; then return; fi

  # Extract: name, pid, port, status — only online preview-*/deploy-* processes
  echo "$PM2_JSON" | jq -r '
    .[] | select(.pm2_env.status == "online") |
    select(.name | test("^(preview|deploy)-")) |
    [.name, (.pid // 0 | tostring),
     ((.pm2_env.PORT // .pm2_env.env.PORT // "") | tostring)] |
    @tsv
  ' 2>/dev/null | while IFS=$'\t' read -r PNAME APP_PID PPORT; do
    # Validate name (alphanumeric + hyphen + dot only)
    case "$PNAME" in *[!a-zA-Z0-9._-]*) continue ;; esac
    [ -z "$PNAME" ] && continue
    [ -z "$APP_PID" ] || [ "$APP_PID" = "0" ] && continue
    [ ! -d "/proc/$APP_PID" ] && continue

    # Check process uptime via /proc/pid/stat field 22 (starttime in clock ticks)
    local STAT_LINE
    STAT_LINE=$(cat "/proc/$APP_PID/stat" 2>/dev/null) || continue
    # Extract starttime — field after the last ')' to avoid comm field with spaces
    local STAT_FIELDS
    STAT_FIELDS="${STAT_LINE##*) }"
    local STARTTIME
    STARTTIME=$(echo "$STAT_FIELDS" | awk '{print $20}') # field 22 minus 2 (pid + comm)
    [ -z "$STARTTIME" ] && continue

    local SYS_UPTIME
    SYS_UPTIME=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null) || continue
    local CLK_TCK
    CLK_TCK=$(getconf CLK_TCK 2>/dev/null) || CLK_TCK=100
    local PROC_AGE=$(( SYS_UPTIME - STARTTIME / CLK_TCK ))

    # Skip if process younger than idle threshold
    [ "$PROC_AGE" -lt "$IDLE_THRESHOLD" ] 2>/dev/null && continue

    # Check for established TCP connections on the port
    if [ -n "$PPORT" ] && [ "$PPORT" != "" ]; then
      local CONN_COUNT
      CONN_COUNT=$(ss -tnH "sport = :$PPORT" state established 2>/dev/null | wc -l)
      [ "$CONN_COUNT" -gt 0 ] && continue
    fi

    # Process is old + no connections → suspend
    log "IDLE: Suspending idle app $PNAME (pid=$APP_PID, age=${PROC_AGE}s, port=$PPORT)"
    run_as_user "pm2 stop '$PNAME' 2>/dev/null" || true
  done
}

# Check and restart critical services if needed
EGRESS_DOMAINS="opencode.ai api.cursor.com cursor.sh \
api2.cursor.sh repo42.cursor.sh \
agentn.global.api5.cursor.sh agentn.global.api2.cursor.sh \
models.dev \
anthropic.com api.anthropic.com console.anthropic.com \
claude.ai claude.com platform.claude.com \
openai.com api.openai.com auth.openai.com \
chatgpt.com \
generativelanguage.googleapis.com googleapis.com \
registry.npmjs.org pypi.org files.pythonhosted.org \
crates.io static.crates.io \
proxy.golang.org sum.golang.org rubygems.org \
github.com codeload.github.com raw.githubusercontent.com \
objects.githubusercontent.com ghcr.io \
docker.io docker.com registry-1.docker.io \
$(cat /etc/ellul/platform-zone 2>/dev/null) \
api.$(cat /etc/ellul/platform-zone 2>/dev/null) \
$(cat /etc/ellul/app-zone 2>/dev/null)"

# Reconcile the egress allowlist on existing fleet. Skip when every domain
# already has at least one entry in the marker block; otherwise rebuild
# (catches the case where the marker exists but a recently-added domain
# like api.ellul.ai is missing because the namespace setup pre-dated it).
ensure_egress_hosts() {
  if grep -q '^# === ELLUL_EGRESS_BEGIN ===' /etc/hosts 2>/dev/null; then
    local block missing=0
    block=$(awk '/^# === ELLUL_EGRESS_BEGIN ===/,/^# === ELLUL_EGRESS_END ===/' /etc/hosts)
    for d in $EGRESS_DOMAINS; do
      echo "$block" | grep -qE "[[:space:]]${d}\$" || { missing=1; break; }
    done
    [ "$missing" -eq 0 ] && return
  fi

  ipset list -n ellul-egress >/dev/null 2>&1 || \
    ipset create ellul-egress hash:ip family inet hashsize 1024 maxelem 65536 timeout 3600

  local tmp resolved=0
  tmp=$(mktemp /tmp/.ellul-hosts.XXXXXX)
  printf '# === ELLUL_EGRESS_BEGIN ===\n' > "$tmp"
  for d in $EGRESS_DOMAINS; do
    for ip in $(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | sort -u); do
      ipset add ellul-egress "$ip" -exist 2>/dev/null || true
      printf '%s %s\n' "$ip" "$d" >> "$tmp"
      resolved=$((resolved + 1))
    done
  done
  printf '# === ELLUL_EGRESS_END ===\n' >> "$tmp"

  if grep -q '^# === ELLUL_EGRESS_BEGIN ===' /etc/hosts 2>/dev/null; then
    awk '/^# === ELLUL_EGRESS_BEGIN ===/{skip=1} !skip{print} /^# === ELLUL_EGRESS_END ===/{skip=0}' \
      /etc/hosts > "${tmp}.merge"
    cat "$tmp" >> "${tmp}.merge"
    install -m 0644 -o root -g root "${tmp}.merge" /etc/hosts
    rm -f "${tmp}.merge"
  else
    cat "$tmp" >> /etc/hosts
  fi
  rm -f "$tmp"
  log "ensure_egress_hosts: populated /etc/hosts with $resolved entries"
}

check_critical_services() {
  # Skip during LUKS format — services are intentionally stopped
  if [ -f /run/ellul-luks-format.lock ]; then
    return
  fi
  # Skip when LUKS volume is locked (sovereign mode, post-migration awaiting PRF unlock).
  # Services need the vault — restarting them wastes time and blocks the heartbeat loop,
  # preventing the enforcer from picking up the wake-mount command that delivers the PRF key.
  if [ -f /etc/ellul-bootstrap/volume-was-encrypted ] && [ ! -b /dev/mapper/luks-home ]; then
    return
  fi
  if ! svc_is_active ellul-file-api; then
    log "CRITICAL: ellul-file-api is down, restarting..."
    svc_restart ellul-file-api
    sleep 2
    if svc_is_active ellul-file-api; then
      log "ellul-file-api recovered"
    else
      log "ERROR: ellul-file-api failed to restart"
    fi
  else
    # Skip health check during migration -- execFileSync blocks the event loop
    # while downloading the archive, making file-api unresponsive to health checks.
    # The lock file is created by file-api at migration start and removed on completion.
    if [ -f /tmp/ellul-migration.lock ]; then
      return
    fi
    # Accept 200, 401 (web_locked auth required), or 403
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 2 http://localhost:3002/api/tree 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "401" ] && [ "$HTTP_CODE" != "403" ]; then
      log "CRITICAL: ellul-file-api not responding, restarting..."
      svc_restart ellul-file-api
      sleep 2
    fi
  fi

  # Per-preview systemd units (ellul-preview@*.service) are managed by
  # file-api via the ellul-preview-ctl sudo wrapper. systemd's own
  # Restart=on-failure + StartLimitBurst handles dev-server crashes,
  # and file-api surfaces failed units to the UI as phase=crashed with
  # a Restart button. The enforcer has no central role here — the old
  # singleton ellul-preview.service is retired at rebuild-all time.

  # ttyd terminal services are LAZY — they start on-demand when the UI
  # opens a session via term-proxy, not eagerly on every heartbeat.
  # Eager-start previously caused many ttyd processes to accumulate from
  # restart loops, contributing to an OOM cascade that killed sshd.
  # The enforcer's job is to keep services that ARE supposed to be running
  # healthy — not to force-start ones nobody asked for. If a ttyd dies
  # after being legitimately started, systemd's Restart=on-failure brings
  # it back; if the user never opened it, we leave it alone.

  # Ensure term-proxy is running (only if provisioned)
  if svc_is_enabled ellul-term-proxy 2>/dev/null; then
    if ! svc_is_active ellul-term-proxy; then
      log "CRITICAL: ellul-term-proxy is down, restarting..."
      svc_restart ellul-term-proxy
    fi
  fi

  ensure_egress_hosts

  # ── Disk space monitoring ──
  DISK_ROOT=$(get_disk_usage "/" 2>/dev/null || echo "0")
  # PostgreSQL disk check (only if PostgreSQL is installed)
  if svc_is_enabled postgresql 2>/dev/null; then
    DISK_PG=$(get_disk_usage "/var/lib/postgresql" 2>/dev/null || echo "$DISK_ROOT")
    if [ "${DISK_PG:-0}" -ge 95 ] 2>/dev/null; then
      log "CRITICAL: PostgreSQL volume at ${DISK_PG}% -- database may crash. Cleaning WAL/temp files..."
      sudo -u postgres /usr/lib/postgresql/*/bin/pg_controldata /var/lib/postgresql/*/main 2>/dev/null | grep -q "shut down" || true
      sudo -u postgres psql -c "VACUUM FULL;" 2>/dev/null || true
    elif [ "${DISK_PG:-0}" -ge 90 ] 2>/dev/null; then
      log "WARN: PostgreSQL volume at ${DISK_PG}% -- approaching capacity"
    fi
  fi
  if [ "${DISK_ROOT:-0}" -ge 95 ] 2>/dev/null; then
    log "CRITICAL: Root filesystem at ${DISK_ROOT}% -- cleaning journal and tmp"
    journalctl --vacuum-size=50M 2>/dev/null || true
    find /tmp -type f -atime +7 -delete 2>/dev/null || true
  elif [ "${DISK_ROOT:-0}" -ge 90 ] 2>/dev/null; then
    log "WARN: Root filesystem at ${DISK_ROOT}% -- approaching capacity"
  fi

  # ── PostgreSQL health check (only if installed) ──────────────────────
  if ! svc_is_enabled postgresql 2>/dev/null; then
    return
  fi
  #
  # Architecture: postgresql.service is a meta-service (Type=oneshot, runs /bin/true).
  # The actual cluster runs as postgresql@<ver>-main.service (e.g. postgresql@16-main).
  # BUG FIXED: The parent meta-service can show "active (exited)" even when the cluster
  # has failed. We use pg_isready as the ground truth, NOT svc_is_active postgresql.
  #
  # Recovery strategy:
  #   1. pg_isready with timeout (ground truth check)
  #   2. Detect actual cluster unit name (not hardcoded -- handles version changes)
  #   3. If cluster failed/inactive → run recovery script + reset-failed + restart
  #   4. If cluster active but not responding → brief wait, then recovery + restart
  #   5. Cooldown: don't attempt PG recovery more than once per 30s (prevents storm)
  #   6. After recovery, restart sovereign-shield (depends on PG for app databases)
  #
  if svc_is_enabled postgresql; then
    if ! timeout 5 sudo -u postgres pg_isready -q 2>/dev/null; then
      # Detect the actual cluster service unit name dynamically.
      # This handles version upgrades (16→17) without code changes.
      PG_CLUSTER_UNIT=""
      for unit in $(systemctl list-units --type=service --all --plain --no-legend 2>/dev/null | awk '/^postgresql@/{print $1}'); do
        PG_CLUSTER_UNIT="$unit"
        break
      done
      # Fallback: try common name pattern
      if [ -z "$PG_CLUSTER_UNIT" ]; then
        PG_VER=$(ls /usr/lib/postgresql/ 2>/dev/null | sort -V | tail -1)
        if [ -n "$PG_VER" ]; then
          PG_CLUSTER_UNIT="postgresql@${PG_VER}-main.service"
        fi
      fi

      if [ -n "$PG_CLUSTER_UNIT" ]; then
        PG_CLUSTER_STATE=$(systemctl is-active "$PG_CLUSTER_UNIT" 2>/dev/null || echo "unknown")
      else
        PG_CLUSTER_STATE="unknown"
      fi

      if [ "$PG_CLUSTER_STATE" = "failed" ] || [ "$PG_CLUSTER_STATE" = "inactive" ] || [ "$PG_CLUSTER_STATE" = "unknown" ]; then
        log "CRITICAL: postgresql cluster '$PG_CLUSTER_UNIT' is $PG_CLUSTER_STATE, attempting recovery..."

        # Run the recovery script (handles WAL corruption, ownership, stale PID, etc.)
        if [ -x /usr/local/bin/ellul-pg-recovery ]; then
          /usr/local/bin/ellul-pg-recovery 2>/dev/null || true
        fi

        # Reset systemd failed state so it allows restart
        # Without this, systemd may refuse to restart a "failed" unit
        if [ -n "$PG_CLUSTER_UNIT" ] && [ "$PG_CLUSTER_STATE" = "failed" ]; then
          systemctl reset-failed "$PG_CLUSTER_UNIT" 2>/dev/null || true
        fi

        # Also fix ownership (belt-and-suspenders -- recovery script does this too)
        chown -R postgres:postgres /var/lib/postgresql 2>/dev/null || true

        svc_restart postgresql
        sleep 3

        if timeout 5 sudo -u postgres pg_isready -q 2>/dev/null; then
          log "postgresql recovered -- restarting sovereign-shield to reconnect"
          svc_restart ellul-sovereign-shield
        else
          log "ERROR: postgresql failed to restart -- check /var/log/ellul-pg-recovery.log"
        fi
      else
        # Cluster service is active/activating but pg_isready fails -- could be slow startup
        log "WARN: postgresql cluster $PG_CLUSTER_STATE but not accepting connections, waiting..."
        sleep 5
        if ! timeout 5 sudo -u postgres pg_isready -q 2>/dev/null; then
          log "CRITICAL: postgresql still not responding after 5s wait, running recovery + restart..."
          if [ -x /usr/local/bin/ellul-pg-recovery ]; then
            /usr/local/bin/ellul-pg-recovery 2>/dev/null || true
          fi
          # Reset failed state in case it transitioned to failed during our wait
          if [ -n "$PG_CLUSTER_UNIT" ]; then
            systemctl reset-failed "$PG_CLUSTER_UNIT" 2>/dev/null || true
          fi
          svc_restart postgresql
          sleep 3
          if timeout 5 sudo -u postgres pg_isready -q 2>/dev/null; then
            log "postgresql recovered after extended wait -- restarting sovereign-shield"
            svc_restart ellul-sovereign-shield
          fi
        fi
      fi
    fi
  fi

  # Ensure sovereign-shield is running (serves /_auth/* including capabilities, passkeys, session)
  if ! svc_is_active ellul-sovereign-shield; then
    log "CRITICAL: ellul-sovereign-shield is down, restarting..."
    svc_restart ellul-sovereign-shield
  fi

  # Ensure watchdog is running (agent process lifecycle -- paid tiers only)
  if svc_is_enabled ellul-watchdog; then
    if ! svc_is_active ellul-watchdog; then
      log "CRITICAL: ellul-watchdog is down, restarting..."
      svc_restart ellul-watchdog
    fi
  fi

  # Ensure warden is running (network enforcement proxy)
  if svc_is_enabled ellul-warden; then
    if ! svc_is_active ellul-warden; then
      log "CRITICAL: ellul-warden is down, restarting..."
      svc_restart ellul-warden
      sleep 2
      if svc_is_active ellul-warden; then
        log "ellul-warden recovered"
      else
        log "ERROR: ellul-warden failed to restart"
      fi
    else
      WARDEN_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" -m 2 http://localhost:8081/_health 2>/dev/null || echo "000")
      if [ "$WARDEN_HEALTH" != "200" ]; then
        log "CRITICAL: ellul-warden not responding on health port, restarting..."
        svc_restart ellul-warden
        sleep 2
      fi
    fi
  fi

  # Ensure agent-bridge is running (Workbench WebSocket)
  if ! svc_is_active ellul-agent-bridge; then
    log "CRITICAL: ellul-agent-bridge is down, restarting..."
    svc_restart ellul-agent-bridge
  fi

  # Ensure IDE (code-server) is running
  if ! svc_is_active ellul-ide; then
    log "CRITICAL: ellul-ide is down, restarting..."
    svc_restart ellul-ide
  fi

  # Clean up orphaned preview-* PM2 processes (project dir deleted while preview ran)
  check_preview_processes

  # Suspend idle preview/deploy apps to free RAM (30 min no connections)
  check_idle_apps

  # ── ZeroClaw Binary Management ──
  #
  # Per-project ZeroClaw daemons are spawned on-demand by agent-bridge
  # inside kernel namespaces (ports 18800-18899). No global daemon needed.
  # Enforcer only ensures the binary is installed.

  if [ ! -x /usr/local/bin/zeroclaw ]; then
    COOLDOWN_FILE="/tmp/zeroclaw-install-cooldown"
    if [ ! -f "$COOLDOWN_FILE" ] || [ "$(( $(date +%s) - $(file_mtime "$COOLDOWN_FILE") ))" -gt 600 ]; then
      log "ZeroClaw binary missing, attempting install..."
      touch "$COOLDOWN_FILE"
      ARCH=$(uname -m)
      case "$ARCH" in
        aarch64|arm64) ZC_ARCH="aarch64-unknown-linux-musl" ;;
        x86_64)        ZC_ARCH="x86_64-unknown-linux-musl" ;;
        *)             ZC_ARCH="" ;;
      esac
      if [ -n "$ZC_ARCH" ]; then
        ZC_VER=$(cat /etc/ellul/pinned-versions/zeroclaw 2>/dev/null || echo "")
        if [ -z "$ZC_VER" ]; then
          log "WARN: No pinned zeroclaw version found — skipping install"
          break
        fi
        curl -fsSL "https://github.com/zeroclaw-labs/zeroclaw/releases/download/v${ZC_VER}/zeroclaw-${ZC_ARCH}" \
          -o /usr/local/bin/zeroclaw 2>/dev/null && chmod +x /usr/local/bin/zeroclaw
      fi
    fi
  fi

}
