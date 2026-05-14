#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ellul.ai. All rights reserved.
#
# run-tests.sh — drive the daemon protocol from inside an
# ellul-agent-bridge.service-shaped cgroup.
#
# The daemon's auth check (auth.c::cgroup_is_bridge) demands the peer's
# cgroup-v2 path end with `/ellul-agent-bridge.service`. systemd's slice
# nesting via dashes places a transient unit named `ellul-agent-bridge`
# under `ellul-control-plane.slice` at exactly that cgroup path.
#
# Usage:
#   sudo run-tests.sh
#
# Required env:
#   GITHUB_WORKSPACE  repo checkout root.
#
# Fails hard on any test failure. No fallbacks.

set -euo pipefail

if [[ -z "${GITHUB_WORKSPACE:-}" ]]; then
  echo "run-tests: GITHUB_WORKSPACE must be set" >&2
  exit 64
fi

NSD_TEST_USER=${NSD_TEST_USER:-runner}

# Resolve pnpm's absolute path while we still have the action's PATH.
PNPM_BIN=$(command -v pnpm)
NODE_BIN=$(command -v node)
if [[ -z "$PNPM_BIN" || -z "$NODE_BIN" ]]; then
  echo "run-tests: pnpm/node not on PATH" >&2
  exit 1
fi

# Make sure the workspace is readable to the runner uid (CI usually owns it
# already, but guard against edge cases).
chown -R "$NSD_TEST_USER":"$NSD_TEST_USER" "$GITHUB_WORKSPACE" || true

run_in_bridge_cgroup() {
  local label=$1; shift
  # Defensive: clear any leftover unit from a previous step. systemd-run
  # refuses to start a unit that already exists, even completed ones.
  systemctl stop ellul-agent-bridge.service 2>/dev/null || true
  systemctl reset-failed ellul-agent-bridge.service 2>/dev/null || true

  systemd-run \
    --wait --pipe --collect \
    --service-type=exec \
    --unit=ellul-agent-bridge \
    --slice=ellul-control-plane.slice \
    --uid="$NSD_TEST_USER" \
    --gid="$NSD_TEST_USER" \
    --working-directory="$GITHUB_WORKSPACE" \
    --setenv=PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    --setenv=HOME="/home/$NSD_TEST_USER" \
    --setenv=NSD_VM_TEST=1 \
    --setenv=NSD_VM_LABEL="$label" \
    -- \
    "$@"
}

# Verify the unit lands in the expected cgroup before driving the protocol.
# This is the canary: if systemd-run's slice routing changes, we want to know.
echo "run-tests: cgroup canary"
run_in_bridge_cgroup canary \
  "$NODE_BIN" -e 'process.stdout.write(require("fs").readFileSync("/proc/self/cgroup", "utf8"))' \
  | tee /tmp/cgroup-canary.txt
grep -q '/ellul-agent-bridge.service' /tmp/cgroup-canary.txt

# Primary opcode coverage.
echo "run-tests: opcode harness"
run_in_bridge_cgroup harness \
  "$PNPM_BIN" tsx \
  "$GITHUB_WORKSPACE/packages/vps/test/integration/nsd-vm/harness.ts"

# Adversarial cases — must run inside the bridge cgroup too because some
# attacks need a valid bridge identity (cross-project) to even reach
# the dispatcher.
echo "run-tests: adversarial harness"
run_in_bridge_cgroup adversarial \
  "$PNPM_BIN" tsx \
  "$GITHUB_WORKSPACE/packages/vps/test/integration/nsd-vm/adversarial.ts"

echo "run-tests: all tests passed"
