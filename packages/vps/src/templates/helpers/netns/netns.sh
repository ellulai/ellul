#!/bin/bash
# ellul-netns-helper — Manage network + mount namespaces for shielded apps.
# Called by sovereign-shield via sudo. root:root 755, agent can execute but not modify.
set -euo pipefail

ACTION="${1:-}"
NS_NAME="${2:-}"
PORT="${3:-}"

# ── Input validation ──
if [ -z "$ACTION" ]; then
  echo '{"success":false,"error":"Missing action"}'
  exit 1
fi

# Namespace name must be safe (prevents injection)
if [ -n "$NS_NAME" ] && ! echo "$NS_NAME" | grep -qE '^shield-[a-z0-9-]{1,8}$'; then
  echo '{"success":false,"error":"Invalid namespace name. Must match shield-[a-z0-9-]{1,8}"}'
  exit 1
fi

# Determine service user
if [ -f /etc/default/ellul ]; then
  source /etc/default/ellul
fi
SVC_USER="${PS_USER:-dev}"

__IP_CALCULATOR__

__FORWARDING_SETUP__

case "$ACTION" in

  # ── CREATE ──────────────────────────────────────────────────────────────
  __CREATE__

  # ── APPLY-WHITELIST ─────────────────────────────────────────────────────
  __WHITELIST__

  # ── EXEC ────────────────────────────────────────────────────────────────
  __EXEC__

  # ── DESTROY ─────────────────────────────────────────────────────────────
  __DESTROY__

  # ── STATUS ──────────────────────────────────────────────────────────────
  __STATUS__

  *)
    echo '{"success":false,"error":"Unknown action. Use: create, apply-whitelist, exec, destroy, status"}'
    exit 1
    ;;
esac