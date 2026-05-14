#!/bin/bash
# ellul-agent-namespace -- Default-deny namespace isolation per project.
# Called by agent-bridge via sudo. root:root 755.
set -euo pipefail
# Ensure sbin paths are available (iptables, ip, ufw live in /usr/sbin)
export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"
# Absolute paths — sudo env_reset can strip PATH in edge cases
IPTABLES="/usr/sbin/iptables"
IP="/usr/sbin/ip"

__VALIDATION__

case "$ACTION" in

__SETUP__

__ENTER__

__TEARDOWN__

__SPAWN__

*)
  echo '{"success":false,"error":"Usage: {setup|enter|teardown|spawn} <project> [options]"}' >&2
  exit 1
  ;;
esac