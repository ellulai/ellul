#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ellul.ai. All rights reserved.
#
# Closed-loop verification harness for resource-v2 probe routing.
#
# Run against a live VPS to prove that probe spawns land OUTSIDE the
# bridge cgroup. Asserts the four invariants that Phase B + D + E + C
# together guarantee:
#
#   (A) ns.spawner.hostScope events fire — probes are wrapped in
#       ellul-spawn-scope.
#   (B) bridge cgroup.procs contains only the bridge node — no probe
#       processes inside.
#   (C) Every alive opencode/cursor/codex probe sits under
#       ellul-user-workload.slice / ellul-probe-<adapter>-<scope>.scope.
#   (D) memory.events.high derivative is bounded across two ticks.
#   (E) Inventory cache files exist for adapters that ran probes.
#
# Usage:
#   verify-probe-routing.sh                # local run on the bridge host
#   verify-probe-routing.sh --ssh dev@HOST # remote run via SSH
#
# Exit codes:
#   0 — all invariants hold
#   1 — at least one invariant violated (details printed to stderr)
#   2 — environment problem (no /sys/fs/cgroup, bridge not running, etc.)

set -euo pipefail

EVENTS_LOG="/var/log/ellul/agent-bridge-events.jsonl"
BRIDGE_CGROUP="/sys/fs/cgroup/ellul.slice/ellul-control.slice/ellul-control-plane.slice/ellul-agent-bridge.service"
INVENTORY_DIR="/etc/ellul/agent-bridge/inventory"

REMOTE=""
if [ "${1:-}" = "--ssh" ]; then
  REMOTE="$2"
  shift 2
fi

run() {
  if [ -n "$REMOTE" ]; then
    ssh -o LogLevel=ERROR -o BatchMode=yes "$REMOTE" "$1"
  else
    bash -c "$1"
  fi
}

color_red()   { printf "\033[31m%s\033[0m\n" "$*"; }
color_green() { printf "\033[32m%s\033[0m\n" "$*"; }
color_yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }

ENV_ERR=0
INVARIANT_FAIL=0

note() { printf "  %s\n" "$*"; }
ok()   { color_green "  ✓ $*"; }
fail() { color_red   "  ✗ $*"; INVARIANT_FAIL=1; }
warn() { color_yellow "  ⚠ $*"; }

# ── Environment check ───────────────────────────────────────────────

echo
echo "== Environment =="
if ! run "test -d '$BRIDGE_CGROUP'"; then
  color_red "Bridge cgroup not present at $BRIDGE_CGROUP — bridge isn't running in its production slice."
  ENV_ERR=1
fi
if ! run "test -f '$EVENTS_LOG'"; then
  color_red "Events log not present at $EVENTS_LOG — bridge hasn't started or you don't have read perms."
  ENV_ERR=1
fi
if [ "$ENV_ERR" -eq 1 ]; then
  exit 2
fi

BRIDGE_PID="$(run "systemctl show -p MainPID --value ellul-agent-bridge.service")"
note "Bridge PID: $BRIDGE_PID"
note "Cgroup path: $BRIDGE_CGROUP"
note "Events log: $EVENTS_LOG"

# ── Invariant A: routing events fire ────────────────────────────────

echo
echo "== A) ns.spawner.hostScope events fire on probe spawns =="
HOSTSCOPE_COUNT="$(run "grep -c 'ns.spawner.hostScope' '$EVENTS_LOG' 2>/dev/null || echo 0")"
HOSTBYPASS_COUNT="$(run "grep -c 'ns.spawner.hostBypass' '$EVENTS_LOG' 2>/dev/null || echo 0")"
LONG_LIVED_BLOCKED="$(run "grep -c 'ns.spawner.uncontainedLongLivedHost' '$EVENTS_LOG' 2>/dev/null || echo 0")"

note "ns.spawner.hostScope events: $HOSTSCOPE_COUNT"
note "ns.spawner.hostBypass events (short host commands): $HOSTBYPASS_COUNT"
note "ns.spawner.uncontainedLongLivedHost events (Phase E lockdown): $LONG_LIVED_BLOCKED"

if [ "$HOSTSCOPE_COUNT" -gt 0 ]; then
  ok "host-scope path is being exercised"
else
  warn "no ns.spawner.hostScope events yet — bridge may not have triggered an inventory probe yet (probes run every ~5 min)"
fi

if [ "$LONG_LIVED_BLOCKED" -gt 0 ]; then
  fail "Phase E lockdown tripped $LONG_LIVED_BLOCKED times — an adapter spawn skipped routing. Inspect:"
  run "grep 'ns.spawner.uncontainedLongLivedHost' '$EVENTS_LOG' | tail -3"
else
  ok "Phase E lockdown has not tripped (no leaks attempted)"
fi

# ── Invariant B: bridge cgroup contains only the bridge node ────────

echo
echo "== B) Bridge cgroup contains only the bridge node =="
BRIDGE_CGROUP_PROCS="$(run "cat '$BRIDGE_CGROUP/cgroup.procs' 2>/dev/null | sort -n")"
NUM_PIDS="$(echo "$BRIDGE_CGROUP_PROCS" | grep -cE '^[0-9]+$' || echo 0)"
note "PIDs in bridge cgroup: $NUM_PIDS"
echo "$BRIDGE_CGROUP_PROCS" | head -10 | sed 's/^/    /'

# Allow up to 2 transient wrappers (sudo → spawn-scope → systemd-run
# moving window). Anything beyond that is a violation.
if [ "$NUM_PIDS" -le 3 ]; then
  ok "bridge cgroup membership is bounded (≤3 includes bridge + ≤2 transient wrappers)"
else
  fail "$NUM_PIDS PIDs in bridge cgroup — expected ≤3. Foreign processes detected."
  echo "$BRIDGE_CGROUP_PROCS" | while read -r pid; do
    [ -z "$pid" ] && continue
    if [ "$pid" = "$BRIDGE_PID" ]; then continue; fi
    COMM="$(run "cat /proc/$pid/comm 2>/dev/null || echo '?'" | tr -d '\n')"
    CMDLINE="$(run "cat /proc/$pid/cmdline 2>/dev/null | tr '\\0' ' ' " | head -c 160)"
    echo "    pid=$pid comm=$COMM cmdline=$CMDLINE"
  done
fi

# ── Invariant C: probe processes live under user-workload slice ─────

echo
echo "== C) Probes are under ellul-user-workload.slice / ellul-probe-* =="
PROBE_PIDS="$(run "pgrep -af 'opencode\\s.*\\bserve\\b|cursor-agent\\b.*\\bacp\\b|codex\\b.*\\bapp-server\\b' 2>/dev/null | awk '{print \$1}'" || true)"
if [ -z "$PROBE_PIDS" ]; then
  warn "no probe processes alive right now — re-run after a probe interval (~5 min) or trigger manually"
else
  for pid in $PROBE_PIDS; do
    CG="$(run "cat /proc/$pid/cgroup 2>/dev/null | head -1")"
    if echo "$CG" | grep -q 'ellul-user-workload\.slice/ellul-probe-'; then
      ok "pid=$pid in $CG"
    else
      fail "pid=$pid in $CG — should be under ellul-user-workload.slice/ellul-probe-*"
    fi
  done
fi

# ── Invariant D: memory.events.high derivative is bounded ───────────

echo
echo "== D) Bridge memory.events.high derivative across one minute =="
HIGH1="$(run "cat '$BRIDGE_CGROUP/memory.events' | awk '/^high/ {print \$2}'")"
note "memory.events.high before: $HIGH1"
sleep 60
HIGH2="$(run "cat '$BRIDGE_CGROUP/memory.events' | awk '/^high/ {print \$2}'")"
DELTA=$((HIGH2 - HIGH1))
note "memory.events.high after:  $HIGH2  (Δ=$DELTA over 60s)"
if [ "$DELTA" -lt 200 ]; then
  ok "throttle event derivative bounded (<200/min)"
else
  fail "throttle event derivative $DELTA/min — chronic throttling regression"
fi

# ── Invariant E: inventory cache files present ──────────────────────

echo
echo "== E) Inventory cache files (Phase C disk persistence) =="
if run "test -d '$INVENTORY_DIR'"; then
  for adapter in opencode cursor codex; do
    if run "test -f '$INVENTORY_DIR/$adapter.json'"; then
      AGE_S="$(run "echo \$(( \$(date +%s) - \$(stat -c %Y '$INVENTORY_DIR/$adapter.json') ))")"
      ok "$adapter.json present (age ${AGE_S}s)"
    else
      warn "$adapter.json absent — adapter may not have run a probe yet on this host"
    fi
  done
else
  warn "$INVENTORY_DIR doesn't exist yet — first probe will create it"
fi

# ── Summary ──────────────────────────────────────────────────────────

echo
if [ "$INVARIANT_FAIL" -eq 0 ]; then
  color_green "ALL INVARIANTS HOLD — probe routing is correctly placing spawns outside the bridge cgroup."
  exit 0
else
  color_red "VERIFICATION FAILED — see above. Diagnose by:"
  echo "  - inspecting recent ns.spawner.* events in $EVENTS_LOG"
  echo "  - confirming /usr/local/bin/ellul-spawn-scope is present and executable"
  echo "  - reading docs/v2/architecture/resource-v2/03-spawn-routing.md (host-mode probe section)"
  exit 1
fi
