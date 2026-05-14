#!/bin/bash

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     ellul.ai System Diagnostics     ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════╝${NC}"
echo ""

# 1. Memory Check
echo -e "${CYAN}[Memory]${NC}"
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
AVAIL_MEM=$(free -m | awk '/^Mem:/{print $7}')
USED_PCT=$((100 - (AVAIL_MEM * 100 / TOTAL_MEM)))
if [ "$USED_PCT" -gt 90 ]; then
  echo -e "  ${RED}CRITICAL:${NC} Memory at ${USED_PCT}% (${AVAIL_MEM}MB free)"
elif [ "$USED_PCT" -gt 70 ]; then
  echo -e "  ${YELLOW}WARNING:${NC} Memory at ${USED_PCT}% (${AVAIL_MEM}MB free)"
else
  echo -e "  ${GREEN}OK:${NC} Memory at ${USED_PCT}% (${AVAIL_MEM}MB free)"
fi
echo ""

# 2. Disk Check
echo -e "${CYAN}[Disk]${NC}"
DISK_PCT=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')
if [ "$DISK_PCT" -gt 90 ]; then
  echo -e "  ${RED}CRITICAL:${NC} Disk at ${DISK_PCT}%"
elif [ "$DISK_PCT" -gt 70 ]; then
  echo -e "  ${YELLOW}WARNING:${NC} Disk at ${DISK_PCT}%"
else
  echo -e "  ${GREEN}OK:${NC} Disk at ${DISK_PCT}%"
fi
echo ""

# 3. Service Status
echo -e "${CYAN}[Services]${NC}"
# Previews run as per-app instances of the ellul-preview@<key>.service
# template managed by file-api; there is no singleton preview daemon to
# health-check here.
for SVC in caddy ttyd ellul-enforcer ellul-file-api ellul-agent-bridge; do
  if systemctl is-active --quiet $SVC 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $SVC"
  else
    echo -e "  ${RED}✗${NC} $SVC - attempting restart..."
    sudo systemctl restart $SVC 2>/dev/null
    if systemctl is-active --quiet $SVC 2>/dev/null; then
      echo -e "    ${GREEN}→ Fixed!${NC}"
    else
      echo -e "    ${RED}→ Failed. Check: journalctl -u $SVC${NC}"
    fi
  fi
done
echo ""

# 4. PM2 Apps
echo -e "${CYAN}[PM2 Apps]${NC}"
if command -v pm2 &>/dev/null; then
  ERRORED=$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.pm2_env.status == "errored") | .name' 2>/dev/null)
  if [ -n "$ERRORED" ]; then
    echo -e "  ${RED}Errored apps:${NC}"
    for APP in $ERRORED; do
      echo -e "    ${RED}✗${NC} $APP"
    done
  else
    APP_COUNT=$(pm2 jlist 2>/dev/null | jq '. | length' 2>/dev/null || echo "0")
    echo -e "  ${GREEN}OK:${NC} $APP_COUNT apps running"
  fi
else
  echo -e "  ${YELLOW}PM2 not found${NC}"
fi
echo ""

# 5. Caddy Config Test
echo -e "${CYAN}[Caddy Config]${NC}"
if caddy validate --config /etc/caddy/Caddyfile 2>/dev/null; then
  echo -e "  ${GREEN}OK:${NC} Config valid"
else
  echo -e "  ${RED}ERROR:${NC} Invalid config - run: caddy fmt --overwrite /etc/caddy/Caddyfile"
fi
echo ""

# 6. DNS Check
echo -e "${CYAN}[DNS]${NC}"
DOMAIN=$(cat /etc/ellul/domain 2>/dev/null)
if [ -n "$DOMAIN" ]; then
  if host "$DOMAIN" &>/dev/null; then
    echo -e "  ${GREEN}OK:${NC} $DOMAIN resolves"
  else
    echo -e "  ${RED}ERROR:${NC} $DOMAIN does not resolve"
  fi
else
  echo -e "  ${YELLOW}No custom domain configured${NC}"
fi
echo ""

echo -e "${CYAN}Done. Run 'ellul-doctor' anytime to check system health.${NC}"
echo ""
