#!/bin/bash
#
# __SCRIPT_NAME__ - VPS operation script
#
# Usage: __USAGE__
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}Error: This command must be run with sudo${NC}"
    echo "Usage: __USAGE__"
    exit 1
fi

SERVER_ID_FILE="/etc/ellul-bootstrap/server-id"
API_URL="__API_URL__"
TIER_FILE="/etc/ellul/security-tier"

if [ ! -f "$SERVER_ID_FILE" ]; then
    echo -e "${RED}Error: Server ID not found${NC}"
    exit 1
fi
SERVER_ID=$(cat "$SERVER_ID_FILE")

TOKEN_FILE="/etc/ellul-bootstrap/ai-proxy-token"
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE")
else
    [ -f /etc/default/ellul ] && source /etc/default/ellul
    _SVC_HOME="/home/${PS_USER:-dev}"
    TOKEN=$(grep ELLUL_AI_TOKEN "$_SVC_HOME/.bashrc" 2>/dev/null | cut -d'"' -f2 || true)
fi
if [ -z "$TOKEN" ]; then
    echo -e "${RED}Error: AI proxy token not found${NC}"
    echo "This server may not be properly provisioned."
    exit 1
fi

if [ -f "$TIER_FILE" ]; then
    TIER=$(cat "$TIER_FILE")
else
    TIER="standard"
fi

if [ "$TIER" = "standard" ]; then
    echo -e "${YELLOW}Note: Your server is in Standard tier.${NC}"
    echo "You can __STANDARD_ACTION__ directly from the dashboard."
    exit 0
fi

if [ "$TIER" = "web_locked" ] || [ "$TIER" = "private_locked" ]; then
    echo -e "${YELLOW}Note: Your server is in Web Locked tier.${NC}"
    echo "Use the dashboard and confirm with your passkey to __WEB_LOCKED_ACTION__."
    exit 0
fi
