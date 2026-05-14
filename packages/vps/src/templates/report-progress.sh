#!/bin/bash
STEP="$1"
curl -sS -X POST "__API_URL__/api/servers/provision-progress" \
  -H "Content-Type: application/json" \
  -d '{"token": "__AI_PROXY_TOKEN__", "step": "'"$STEP"'"}' \
  >> /var/log/ellul-provision.log 2>&1 || true
