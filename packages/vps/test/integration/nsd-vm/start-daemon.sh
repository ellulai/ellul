#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ellul.ai. All rights reserved.
#
# start-daemon.sh — start ellul-namespaced and wait for sd_notify(READY=1).
# Aborts if the daemon doesn't reach READY within 10s, or if it logs
# nsd.startup.kernel-too-old (status 78). No fallbacks.

set -euo pipefail

systemctl restart ellul-namespaced.service

# Block until ActiveState=active OR exit on failure.
deadline=$(( $(date +%s) + 10 ))
while (( $(date +%s) < deadline )); do
  state=$(systemctl show -p ActiveState --value ellul-namespaced.service 2>/dev/null || echo "unknown")
  if [[ "$state" == "active" ]]; then
    break
  fi
  if [[ "$state" == "failed" ]]; then
    echo "start-daemon: ellul-namespaced.service failed" >&2
    journalctl -u ellul-namespaced.service --no-pager -n 50 >&2 || true
    exit 1
  fi
  sleep 0.2
done

state=$(systemctl show -p ActiveState --value ellul-namespaced.service)
if [[ "$state" != "active" ]]; then
  echo "start-daemon: ellul-namespaced.service did not reach active (state=$state)" >&2
  journalctl -u ellul-namespaced.service --no-pager -n 50 >&2 || true
  exit 1
fi

# Confirm the admin socket exists and is mode 0660 root:ellul-ns.
deadline=$(( $(date +%s) + 5 ))
while (( $(date +%s) < deadline )); do
  if [[ -S /run/ellul-ns/admin.sock ]]; then
    break
  fi
  sleep 0.2
done

if [[ ! -S /run/ellul-ns/admin.sock ]]; then
  echo "start-daemon: admin socket /run/ellul-ns/admin.sock missing" >&2
  exit 1
fi

# Validate ownership and mode (defense-in-depth — the daemon should set this).
mode=$(stat -c '%a' /run/ellul-ns/admin.sock)
owner=$(stat -c '%U:%G' /run/ellul-ns/admin.sock)
if [[ "$mode" != "660" ]] || [[ "$owner" != "root:ellul-ns" ]]; then
  echo "start-daemon: admin socket has unexpected perms mode=$mode owner=$owner" >&2
  exit 1
fi

echo "start-daemon: ellul-namespaced active, admin socket bound"
