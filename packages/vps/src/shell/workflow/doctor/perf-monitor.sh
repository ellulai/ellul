#!/bin/bash

# Performance monitor for ellul.ai
# - Writes status to JSON file for dashboard to display
# - Reports active listening ports (for "Ghost Process" detection)
# - **Breaks OOM loops** by killing user workloads when memory pressure is
#   sustained or the kernel OOM-killer has fired repeatedly. The host is
#   NEVER rebooted — user workloads are structurally expendable, the
#   control plane is not.

STATUS_FILE="/var/lib/ellul.ai/perf-status.json"
OOM_STATE_DIR="/var/lib/ellul.ai/perf-oom"
PRESSURE_START_FILE="$OOM_STATE_DIR/pressure-start"
LAST_KILL_FILE="$OOM_STATE_DIR/last-kill"
# Breadcrumb set by agent-sync.sh while a bundle apply is in progress.
# A parallel-restart cascade of the core-runtime subcomponents legitimately
# spikes memory pressure for 60-120s; killing into that window would destroy
# a healthy apply.
# While this file is present, the OOM-loop breaker is suppressed.
APPLY_LOCK_FILE="/run/ellul-apply-in-progress"
APPLY_LOCK_MAX_AGE_SEC=600
# Tier-change lock — same shape as APPLY_LOCK, written by sovereign-shield's
# executeTierSwitch. /run/shield is shield-runner's RuntimeDirectory (tmpfs).
TIER_CHANGE_LOCK_FILE="/run/shield/tier-change-in-progress"
TIER_CHANGE_LOCK_MAX_AGE_SEC=120
mkdir -p /var/lib/ellul.ai "$OOM_STATE_DIR"

# OOM-loop breaker thresholds. Reads PSI "full" (every task stalled) —
# "some" trips on every cold-start. 60% over 5 min outlasts a tier
# toggle + heavy build but catches a wedged host inside ~6 min total.
PRESSURE_LIMIT_PCT=60
PRESSURE_DURATION_SEC=300
OOM_KILL_WINDOW_SEC=300
OOM_KILL_THRESHOLD=3
KILL_COOLDOWN_SEC=900

# Targeted workload killer. Escalates through user-workload cgroups.
# NEVER reboots — the server must remain reachable no matter what user
# workloads do.
trigger_workload_kill() {
  local reason="$1"
  local now last cooldown_elapsed
  now=$(date +%s)
  if [ -f "$LAST_KILL_FILE" ]; then
    last=$(cat "$LAST_KILL_FILE" 2>/dev/null || echo 0)
    cooldown_elapsed=$(( now - last ))
    if [ "$cooldown_elapsed" -lt "$KILL_COOLDOWN_SEC" ]; then
      logger -t ellul-perf-moni "OOM breaker: cooldown active (${cooldown_elapsed}s < ${KILL_COOLDOWN_SEC}s), skipping kill. Reason: $reason"
      return 0
    fi
  fi
  echo "$now" > "$LAST_KILL_FILE"
  logger -t ellul-perf-moni "OOM breaker FIRING: $reason — killing user workloads (NOT rebooting)"

  # Stage 1: SIGTERM the entire user-workload slice (previews, installs, CLI pools)
  systemctl kill --signal=SIGTERM ellul-user-workload.slice 2>/dev/null
  # Also stop any transient install scopes
  systemctl stop 'ellul-install-*' 2>/dev/null

  sleep 3

  # Stage 2: check if pressure resolved
  local post_psi
  post_psi=$(read_psi_full_avg60)
  if [ "${post_psi:-0}" -lt "$PRESSURE_LIMIT_PCT" ] 2>/dev/null; then
    logger -t ellul-perf-moni "OOM breaker: pressure resolved after SIGTERM (psi=${post_psi}%)"
    return 0
  fi

  # Stage 3: SIGKILL the slice — no mercy
  logger -t ellul-perf-moni "OOM breaker: SIGTERM insufficient (psi=${post_psi}%), escalating to SIGKILL"
  systemctl kill --signal=SIGKILL ellul-user-workload.slice 2>/dev/null
  systemctl kill --signal=SIGKILL ellul-user-workload-previews.slice 2>/dev/null

  sleep 2

  # Stage 4: if still under pressure, kill ALL processes for the service user
  post_psi=$(read_psi_full_avg60)
  if [ "${post_psi:-0}" -ge "$PRESSURE_LIMIT_PCT" ] 2>/dev/null; then
    local svc_user
    svc_user=$(id -nu 1000 2>/dev/null || echo "dev")
    logger -t ellul-perf-moni "OOM breaker: slice kill insufficient (psi=${post_psi}%), killing all ${svc_user} processes"
    pkill -9 -u "$svc_user" 2>/dev/null
  fi

  # Final check — log critical if still pressured (control plane is protected
  # by its own slice cap, so the system is stable even if pressure persists briefly)
  sleep 5
  post_psi=$(read_psi_full_avg60)
  if [ "${post_psi:-0}" -ge "$PRESSURE_LIMIT_PCT" ] 2>/dev/null; then
    logger -t ellul-perf-moni -p daemon.crit "OOM breaker: pressure STILL elevated (psi=${post_psi}%) after killing all user processes — NOT rebooting, system will self-heal via kernel OOM on capped slices"
  else
    logger -t ellul-perf-moni "OOM breaker: pressure resolved (psi=${post_psi}%)"
  fi
}

# Read PSI "full avg60" — % time EVERY task stalled on memory in last 60s.
# Match the `^full` line and the `avg60=` field by name (not position) so
# kernel format quirks can't silently reintroduce a misread.
read_psi_full_avg60() {
  local val
  val=$(awk '/^full/ {
    for (i = 2; i <= NF; i++) {
      if ($i ~ /^avg60=/) { sub(/^avg60=/, "", $i); print $i; exit }
    }
  }' /proc/pressure/memory 2>/dev/null)
  # Round to nearest integer for threshold comparison. Default 0 on parse fail.
  awk -v v="$val" 'BEGIN { if (v == "") v = 0; printf "%.0f", v + 0 }'
}

# True while a signed-manifest apply is in progress — parallel service
# cold-starts spike memory-full PSI enough that the OOM breaker would
# treat a healthy apply as a thrashing host. Lock is owned by
# agent-sync.sh; we also enforce a max age so a crashed apply can't
# permanently disable the breaker.
apply_in_progress() {
  [ -f "$APPLY_LOCK_FILE" ] || return 1
  local lock_mtime now age
  lock_mtime=$(stat -c %Y "$APPLY_LOCK_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$(( now - lock_mtime ))
  if [ "$age" -gt "$APPLY_LOCK_MAX_AGE_SEC" ]; then
    # Stale — apply crashed or wedged. Clean up and resume OOM checks.
    rm -f "$APPLY_LOCK_FILE"
    logger -t ellul-perf-moni "apply-lock: stale (${age}s > ${APPLY_LOCK_MAX_AGE_SEC}s), cleared"
    return 1
  fi
  return 0
}

# Mirrors apply_in_progress. Written by sovereign-shield's executeTierSwitch.
tier_change_in_progress() {
  [ -f "$TIER_CHANGE_LOCK_FILE" ] || return 1
  local lock_mtime now age
  lock_mtime=$(stat -c %Y "$TIER_CHANGE_LOCK_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$(( now - lock_mtime ))
  if [ "$age" -gt "$TIER_CHANGE_LOCK_MAX_AGE_SEC" ]; then
    rm -f "$TIER_CHANGE_LOCK_FILE"
    logger -t ellul-perf-moni "tier-change-lock: stale (${age}s > ${TIER_CHANGE_LOCK_MAX_AGE_SEC}s), cleared"
    return 1
  fi
  return 0
}

# Count kernel OOM-kill events in the last OOM_KILL_WINDOW_SEC via journald.
# "Out of memory: Killed process" is the canonical kernel log line.
count_recent_oom_kills() {
  journalctl --dmesg --since "${OOM_KILL_WINDOW_SEC} seconds ago" --no-pager 2>/dev/null \
    | grep -c "Out of memory: Killed process" || echo 0
}

# System ports we don't report (not user processes)
# 22=SSH, 80/443=Caddy, 3002=FileAPI, 7681-7690=Terminal
SYSTEM_PORTS="22 80 443 3002 7681 7682 7683 7684 7685 7686 7687 7688 7689 7690"

is_system_port() {
  local port=$1
  for sp in $SYSTEM_PORTS; do
    [ "$port" = "$sp" ] && return 0
  done
  return 1
}

while true; do
  # Get memory stats
  TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
  USED_MEM=$(free -m | awk '/^Mem:/{print $3}')
  AVAIL_MEM=$(free -m | awk '/^Mem:/{print $7}')
  MEM_PCT=$((USED_MEM * 100 / TOTAL_MEM))

  # Get swap stats
  SWAP_USED=$(free -m | awk '/^Swap:/{print $3}')

  # Get load average
  LOAD=$(cat /proc/loadavg | awk '{print $1}')
  LOAD_INT=${LOAD%.*}

  # Get disk usage
  DISK_PCT=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')

  # Get active listening ports (user processes only)
  ACTIVE_PORTS=""
  ACTIVE_PORTS_JSON="[]"

  while read -r port; do
    if [ -n "$port" ] && ! is_system_port "$port"; then
      if [ -z "$ACTIVE_PORTS" ]; then
        ACTIVE_PORTS="$port"
        ACTIVE_PORTS_JSON="[$port"
      else
        ACTIVE_PORTS="$ACTIVE_PORTS,$port"
        ACTIVE_PORTS_JSON="$ACTIVE_PORTS_JSON,$port"
      fi
    fi
  done < <(ss -tlnp 2>/dev/null | awk 'NR>1 {split($4,a,":"); print a[length(a)]}' | sort -nu)

  [ -n "$ACTIVE_PORTS" ] && ACTIVE_PORTS_JSON="$ACTIVE_PORTS_JSON]" || ACTIVE_PORTS_JSON="[]"

  # Count active user ports
  PORT_COUNT=0
  [ -n "$ACTIVE_PORTS" ] && PORT_COUNT=$(echo "$ACTIVE_PORTS" | tr ',' '\n' | wc -l)

  # Determine status
  STATUS="good"
  REASON=""

  if [ "$SWAP_USED" -gt 500 ]; then
    STATUS="struggling"
    REASON="High swap usage (${SWAP_USED}MB)"
  elif [ "$LOAD_INT" -gt 2 ]; then
    STATUS="struggling"
    REASON="High CPU load (${LOAD})"
  elif [ "$MEM_PCT" -gt 90 ]; then
    STATUS="struggling"
    if [ "$PORT_COUNT" -gt 0 ]; then
      REASON="Low memory (${AVAIL_MEM}MB free) - ${PORT_COUNT} dev server(s) running"
    else
      REASON="Low memory (${AVAIL_MEM}MB free)"
    fi
  fi

  # ── OOM-loop breaker ──────────────────────────────────────────────────
  # Two independent signals, either triggers targeted workload killing:
  #   1. Sustained PSI memory pressure — the kernel is thrashing.
  #   2. Repeated kernel OOM-kill events — we're already in a loop.
  #
  # Response: kill user workloads in the ellul-user-workload.slice cgroup.
  # The server is NEVER rebooted. Control-plane services survive because
  # they live in a separate memory-capped slice with OOMScoreAdjust=-1000.
  NOW_SEC=$(date +%s)
  PSI_PCT=$(read_psi_full_avg60)
  if apply_in_progress || tier_change_in_progress; then
    # Apply or tier-switch in flight. Reset the clock so we don't trip
    # the moment the lock clears.
    rm -f "$PRESSURE_START_FILE"
  elif [ "${PSI_PCT:-0}" -ge "$PRESSURE_LIMIT_PCT" ] 2>/dev/null; then
    if [ -f "$PRESSURE_START_FILE" ]; then
      PRESSURE_START=$(cat "$PRESSURE_START_FILE" 2>/dev/null || echo "$NOW_SEC")
      PRESSURE_DURATION=$(( NOW_SEC - PRESSURE_START ))
      if [ "$PRESSURE_DURATION" -ge "$PRESSURE_DURATION_SEC" ]; then
        trigger_workload_kill "PSI memory-full avg60=${PSI_PCT}% sustained ${PRESSURE_DURATION}s"
        rm -f "$PRESSURE_START_FILE"
      fi
    else
      echo "$NOW_SEC" > "$PRESSURE_START_FILE"
    fi
  else
    rm -f "$PRESSURE_START_FILE"
  fi

  # OOM-kill counter — suppressed during apply or tier-change. A tier
  # toggle on a small VPS can briefly OOM-kill 4+ idle previews/CLIs
  # (recoverable, they restart) without the host being wedged. The
  # 120s tier-change lock and 600s apply lock cap how long we'll
  # ignore OOM kills; if either lock is genuinely stuck, the lock
  # ages past its TTL and the breaker resumes scanning.
  if ! apply_in_progress && ! tier_change_in_progress; then
    OOM_COUNT=$(count_recent_oom_kills)
    if [ "${OOM_COUNT:-0}" -gt "$OOM_KILL_THRESHOLD" ] 2>/dev/null; then
      trigger_workload_kill "kernel OOM-kill events ${OOM_COUNT} in last ${OOM_KILL_WINDOW_SEC}s"
    fi
  fi

  # Write status JSON
  cat > "$STATUS_FILE" << JSONEOF
{
  "timestamp": "$(date -Iseconds)",
  "status": "$STATUS",
  "reason": "$REASON",
  "memory": {
    "total": $TOTAL_MEM,
    "used": $USED_MEM,
    "available": $AVAIL_MEM,
    "percent": $MEM_PCT
  },
  "swap": {
    "used": $SWAP_USED
  },
  "load": "$LOAD",
  "disk": {
    "percent": $DISK_PCT
  },
  "activePorts": $ACTIVE_PORTS_JSON,
  "activePortCount": $PORT_COUNT
}
JSONEOF

  sleep 60
done
