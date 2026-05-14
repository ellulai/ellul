#!/bin/bash
APPS_DIR="$HOME/.ellul/apps"
DOMAIN=$(cat /etc/ellul/domain 2>/dev/null)

GREEN='\033[32m'
CYAN='\033[36m'
NC='\033[0m'

shopt -s nullglob

if [ "$1" = "--json" ]; then
  echo "["
  FIRST=true
  for f in "$APPS_DIR"/*.json; do
    [ -f "$f" ] || continue
    [ "$FIRST" = true ] || echo ","
    FIRST=false
    cat "$f"
  done
  echo "]"
else
  echo ""
  echo -e "${CYAN}ellul.ai Apps${NC}"
  echo ""
  if ! ls "$APPS_DIR"/*.json &>/dev/null; then
    echo "  No apps deployed yet."
    echo ""
    echo "  To deploy an app:"
    echo "    1. Build your project"
    echo "    2. Start it with PM2 on a unique port"
    echo "    3. Run: ellul-expose <name> <port>"
    echo ""
  else
    for f in "$APPS_DIR"/*.json; do
      [ -f "$f" ] || continue
      NAME=$(jq -r '.name' "$f")
      PORT=$(jq -r '.port' "$f")
      URL=$(jq -r '.url' "$f")
      STACK=$(jq -r '.stack // "Unknown"' "$f")
      SUMMARY=$(jq -r '.summary // ""' "$f")
      echo -e "  ${GREEN}$NAME${NC} [${CYAN}$STACK${NC}] :$PORT"
      if [ -n "$SUMMARY" ] && [ "$SUMMARY" != "null" ]; then
        echo -e "    $SUMMARY"
      fi
      echo -e "    $URL"
      echo ""
    done
  fi
fi
