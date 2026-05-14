#!/bin/bash
set -euo pipefail

# Parse arguments
SERVER_ID=""
DOMAIN=""
USER_ID=""
BILLING_TIER=""
PRODUCT=""
DEPLOYMENT_MODEL=""
SECURITY_TIER=""
USER_LOCALE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --server-id=*) SERVER_ID="${1#*=}" ;;
    --domain=*) DOMAIN="${1#*=}" ;;
    --user-id=*) USER_ID="${1#*=}" ;;
    --billing-tier=*) BILLING_TIER="${1#*=}" ;;
    --product=*) PRODUCT="${1#*=}" ;;
    --deployment-model=*) DEPLOYMENT_MODEL="${1#*=}" ;;
    --security-tier=*) SECURITY_TIER="${1#*=}" ;;
    --user-locale=*) USER_LOCALE="${1#*=}" ;;
    *) echo '{"success":false,"error":"Unknown argument: '$1'"}'; exit 1 ;;
  esac
  shift
done

if [ -z "$SERVER_ID" ]; then
  echo '{"success":false,"error":"Missing --server-id"}'
  exit 1
fi

# Validate server-id format (UUID-like or alphanumeric)
if ! [[ "$SERVER_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo '{"success":false,"error":"Invalid server-id format"}'
  exit 1
fi

log() { echo "[update-identity] $*" >&2; }
__IDENTITY_FILES__

FAILURES=""
__CADDY_REGEN__
__SERVICE_RESTART__