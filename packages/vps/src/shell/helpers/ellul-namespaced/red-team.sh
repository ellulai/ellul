#!/bin/bash
# ellul-namespaced — adversarial smoke test.
#
# Run on a provisioned VPS where:
#   - feature flag /etc/ellul/feature-flags/nsd-enabled is set
#   - manifest.pub is in /etc/ellul/manifests/
#   - signed manifest is in /opt/ellul/manifests/<tier>.cbor
#   - ellul-namespaced.service is running
#
# Each scenario should be REJECTED by the daemon. Failure (i.e. daemon
# accepts a hostile peer) leaves a marker line in stderr starting with
# "FAIL:".
#
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ellul.ai. All rights reserved.

set -uo pipefail

NSD_RUN=/run/ellul-ns
PROJECTS_DIR=$(ls -d "$NSD_RUN"/sbx-* 2>/dev/null | head -1 || true)

if [ -z "$PROJECTS_DIR" ]; then
  echo "SKIP: no per-project sockets bound at $NSD_RUN/sbx-*" >&2
  exit 0
fi

PROJECT_A=$(basename "$PROJECTS_DIR")
PROJECT_B=$(ls -d "$NSD_RUN"/sbx-* 2>/dev/null | sed -n 2p | xargs -I{} basename {})

PASS_COUNT=0
FAIL_COUNT=0

note() { echo "[red-team] $*"; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo "FAIL: $*" >&2; }

# ── Scenario 1: process not in agent-bridge cgroup connects ──
#
# A login shell (or sudo) sits in user.slice or session.scope, NOT in
# ellul-agent-bridge.service. Connecting from this shell should fail the
# cgroup gate at the daemon.
note "Scenario 1: connection from outside agent-bridge cgroup"
if timeout 2 socat - "UNIX-CONNECT:$NSD_RUN/$PROJECT_A/ctl.sock" </dev/null 2>/dev/null; then
  fail "non-bridge connection accepted (cgroup gate broken)"
else
  ok "non-bridge connection rejected"
fi

# ── Scenario 2: cross-project connect attempt ──
#
# A process inside namespace sbx-A attempts to connect to sbx-B's socket.
# With per-project subdirs at mode 0710 root:ellul-ns, traversal succeeds
# only if the agent's cgroup matches; the cgroup check at message dispatch
# rejects.
if [ -n "${PROJECT_B:-}" ]; then
  note "Scenario 2: cross-project connect from $PROJECT_A → $PROJECT_B"
  /usr/local/bin/ellul-agent-namespace enter "$PROJECT_A" -- /bin/sh -c \
      "timeout 2 socat - 'UNIX-CONNECT:$NSD_RUN/$PROJECT_B/ctl.sock' </dev/null" \
      >/dev/null 2>&1
  if [ $? -eq 0 ]; then
    fail "cross-project connect from $PROJECT_A to $PROJECT_B accepted"
  else
    ok "cross-project connect rejected"
  fi
else
  note "SKIP scenario 2: only one project exists, no cross-project test"
fi

# ── Scenario 3: replay capture ──
#
# Approach: capture a real ATTEST request from agent-bridge → daemon, then
# replay it from a fresh connection. The replay should fail because:
#   - the daemon's session state is per-connection (session_id changes)
#   - peer_pidfd_inode in HMAC binds to the CURRENT pidfd, not the one
#     used during capture
#
# Capture is intentionally left as an exercise: this script can detect that
# replay fails, but capture requires `socat -x` or BPF. Operators run this
# scenario manually after building a capture artifact.
note "Scenario 3: replay (skipped — manual capture required)"

# ── Scenario 4: oversize frame ──
#
# Frame > 64 KiB must be rejected with the connection closed.
note "Scenario 4: oversize frame from agent-bridge cgroup"
# This requires running as the bridge user inside the bridge cgroup —
# a captive-helper invocation is the easiest way. Skip for the bash
# red-team — TS integration tests cover it.
note "SKIP scenario 4: requires bridge-context helper"

# ── Scenario 5: malformed CBOR ──
#
# Send a frame with a length prefix but truncated body. Daemon should
# disconnect cleanly without crashing.
note "Scenario 5: truncated frame causes clean disconnect"
{
  printf '\x00\x00\x00\x10'           # length = 16
  printf '\x01'                        # opcode (HELLO; we'd never legitimately send this)
  printf 'A%.0s' {1..5}                # 5 bytes of garbage
  # length claims 16, we sent 6 → daemon's read_full will block then EOF
} | timeout 1 socat - "UNIX-CONNECT:$NSD_RUN/$PROJECT_A/ctl.sock" >/dev/null 2>&1
# Daemon should NOT crash. Check service is still active.
if systemctl is-active --quiet ellul-namespaced.service; then
  ok "daemon survived malformed frame"
else
  fail "daemon crashed on malformed frame"
fi

# ── Summary ──
echo "[red-team] PASS=$PASS_COUNT FAIL=$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ] || exit 1
