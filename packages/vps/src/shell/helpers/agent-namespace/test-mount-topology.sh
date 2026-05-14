#!/bin/bash
# test-mount-topology.sh — Verify namespace mount graph matches expectations.
#
# Runs ellul-ns-mount in a test namespace, captures findmnt --json output,
# and verifies mount topology: correct mount points, types, options, and
# propagation flags. Also verifies host mount table is unaffected after teardown.
#
# Usage: sudo bash test-mount-topology.sh [project-slug]
#
# Exit codes:
#   0 — all checks passed
#   1 — mount topology mismatch or verification failure

set -euo pipefail

PROJECT="${1:-sbx-test001}"
SVC_USER="${PS_USER:-dev}"
SVC_HOME="/home/$SVC_USER"
PROJECT_DIR="$SVC_HOME/projects/$PROJECT"
NS_MOUNT="/usr/local/bin/ellul-ns-mount"
READY_FIFO="/run/.ns-ready-$PROJECT"
PASS=0
FAIL=0

red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }

check() {
  local desc="$1" result="$2"
  if [ "$result" = "ok" ]; then
    green "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $desc ($result)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Mount Topology Test ==="
echo "Project: $PROJECT"
echo "User: $SVC_USER"
echo ""

# ── Prerequisite: create test project dir ──
mkdir -p "$PROJECT_DIR"
mkdir -p "$SVC_HOME/.config" "$SVC_HOME/.claude" "$SVC_HOME/.opencode"
chown -R "$SVC_USER:$SVC_USER" "$PROJECT_DIR" 2>/dev/null || true

# ── Capture host mount table BEFORE ──
HOST_MOUNTS_BEFORE=$(findmnt --json 2>/dev/null | md5sum | awk '{print $1}')

# ── Create test namespace ──
rm -f "$READY_FIFO"
mkfifo "$READY_FIFO"

$NS_MOUNT \
  --project "$PROJECT" \
  --home "$SVC_HOME" \
  --user "$SVC_USER" \
  --ready-fifo "$READY_FIFO" \
  --defer-shared &
NS_PID=$!

# Wait for ready signal
if timeout 30 cat "$READY_FIFO" > /dev/null 2>&1; then
  echo "Namespace ready (PID=$NS_PID)"
else
  red "Namespace failed to signal readiness within 30s"
  kill -9 $NS_PID 2>/dev/null || true
  exit 1
fi
rm -f "$READY_FIFO"

# ── Capture mount topology inside namespace ──
NS_MOUNTS=$(nsenter --mount --pid --target $NS_PID -- findmnt --json 2>/dev/null || echo "{}")

# ── Verify mount points ──
echo ""
echo "--- Mount Point Verification ---"

verify_mount() {
  local path="$1" expected_type="$2" expected_opts="${3:-}"
  local result=$(echo "$NS_MOUNTS" | python3 -c "
import json, sys
try:
  data = json.load(sys.stdin)
  def find(node, target):
    if node.get('target') == target:
      return node
    for child in node.get('children', []):
      r = find(child, target)
      if r: return r
    return None
  fs = data.get('filesystems', [{}])
  for root in fs:
    m = find(root, '$path')
    if m:
      fstype = m.get('fstype', '')
      opts = m.get('options', '')
      if '$expected_type' and fstype != '$expected_type':
        print(f'type mismatch: got {fstype}, expected $expected_type')
      elif '$expected_opts' and '$expected_opts' not in opts:
        print(f'opts missing $expected_opts: got {opts}')
      else:
        print('ok')
      sys.exit(0)
  print('mount not found')
except Exception as e:
  print(f'parse error: {e}')
" 2>/dev/null || echo "parse error")
  check "$path ($expected_type)" "$result"
}

# Phase 0: scratch tmpfs
verify_mount "/run/.ns-$PROJECT" "tmpfs"

# Phase 2: home read-only
verify_mount "$SVC_HOME" "" "ro"

# Phase 3: projects tmpfs
verify_mount "$SVC_HOME/projects" "tmpfs"

# Phase 3: project bind
verify_mount "$PROJECT_DIR" ""

# Phase 3: overlayfs (.config, .claude, .opencode)
verify_mount "$SVC_HOME/.config" "overlay"
verify_mount "$SVC_HOME/.claude" "overlay"
verify_mount "$SVC_HOME/.opencode" "overlay"

# Phase 4: proc
verify_mount "/proc" "proc" "hidepid=2"

# Phase 4: /tmp
verify_mount "/tmp" "tmpfs"

# Phase 4: DNS
verify_mount "/etc/resolv.conf" ""

# Phase 4: shield blackholes
verify_mount "/etc/ellul/shield-data" "tmpfs"
verify_mount "/var/lib/ellul-shielded" "tmpfs"
verify_mount "/run/shield" "tmpfs"

# ── Verify propagation (rprivate) ──
echo ""
echo "--- Propagation Verification ---"
PROP=$(nsenter --mount --pid --target $NS_PID -- findmnt -n -o PROPAGATION / 2>/dev/null || echo "unknown")
check "root propagation is private" "$([ "$PROP" = "private" ] && echo ok || echo "got: $PROP")"

# ── Security checks ──
echo ""
echo "--- Security Verification ---"

# Shield data inaccessible
SHIELD_READ=$(nsenter --mount --pid --target $NS_PID -- runuser -l "$SVC_USER" -c "ls /etc/ellul/shield-data/ 2>&1" || echo "blocked")
check "shield-data inaccessible" "$(echo "$SHIELD_READ" | grep -q "Permission denied\|cannot access\|blocked" && echo ok || echo "readable: $SHIELD_READ")"

# Home not writable (except project dir)
HOME_WRITE=$(nsenter --mount --pid --target $NS_PID -- runuser -l "$SVC_USER" -c "touch $SVC_HOME/.test-write 2>&1" || echo "blocked")
check "home not writable" "$(echo "$HOME_WRITE" | grep -q "Read-only\|Permission denied\|blocked" && echo ok || echo "writable")"

# Project dir IS writable
PROJECT_WRITE=$(nsenter --mount --pid --target $NS_PID -- runuser -l "$SVC_USER" -c "touch $PROJECT_DIR/.test-write && rm $PROJECT_DIR/.test-write && echo ok" 2>/dev/null || echo "not writable")
check "project dir writable" "$PROJECT_WRITE"

# .shared/ exists (for deferred mounts)
SHARED_EXISTS=$(nsenter --mount --pid --target $NS_PID -- ls -d "$PROJECT_DIR/.shared" 2>/dev/null && echo ok || echo "missing")
check ".shared/ dir exists" "$SHARED_EXISTS"

# ── Teardown and verify host unaffected ──
echo ""
echo "--- Teardown Verification ---"
kill $NS_PID 2>/dev/null || true
wait $NS_PID 2>/dev/null || true
sleep 1

HOST_MOUNTS_AFTER=$(findmnt --json 2>/dev/null | md5sum | awk '{print $1}')
check "host mount table unaffected" "$([ "$HOST_MOUNTS_BEFORE" = "$HOST_MOUNTS_AFTER" ] && echo ok || echo "changed")"

# ── Clean up ──
rm -rf "$PROJECT_DIR/.test-write" 2>/dev/null || true

# ── Summary ──
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && green "ALL CHECKS PASSED" || red "$FAIL CHECK(S) FAILED"
exit $FAIL
