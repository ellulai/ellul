#!/bin/bash
RED='\033[31m'
GREEN='\033[32m'
NC='\033[0m'

# ── Fast path: pre-minted token (shield git-push flow) ──
if [ -n "$GIT_PUSH_TOKEN" ]; then
  RESULT=$(curl -sf --max-time 5 -X POST http://localhost:3005/api/workflow/validate-git-push \
    -H "Content-Type: application/json" -d "{\"token\":\"$GIT_PUSH_TOKEN\"}" 2>&1)
  if [ $? -eq 0 ] && echo "$RESULT" | grep -q '"valid":true'; then
    echo -e "${GREEN}*${NC} Git push authorized"
    exit 0
  fi
  echo -e "${RED}BLOCKED:${NC} Git push token invalid or expired."
  exit 1
fi

# ── Gate flow: request authorization via bridge → console modal ──
GIT_TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
SANDBOX_ID=$(echo "$GIT_TOPLEVEL" | grep -oE 'sbx-[a-z0-9]{7}' | head -1)

if [ -z "$SANDBOX_ID" ]; then
  echo -e "${RED}BLOCKED:${NC} Cannot determine sandbox context for git push."
  exit 1
fi

BRIDGE="http://localhost:7700"
SHIELD="http://localhost:3005"

AUTH_RESULT=$(curl -sf --max-time 10 -X POST "$BRIDGE/api/internal/git-exec-authorize" \
  -H "Content-Type: application/json" -d "{\"sandboxId\":\"$SANDBOX_ID\"}" 2>&1)

STATUS=$(echo "$AUTH_RESULT" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

# Auto-granted — validate token and proceed
if [ "$STATUS" = "authorized" ]; then
  TOKEN=$(echo "$AUTH_RESULT" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$TOKEN" ]; then
    VALIDATE=$(curl -sf --max-time 5 -X POST "$SHIELD/api/workflow/validate-git-push" \
      -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" 2>&1)
    if [ $? -eq 0 ] && echo "$VALIDATE" | grep -q '"valid":true'; then
      echo -e "${GREEN}*${NC} Git push authorized"
      exit 0
    fi
  fi
  echo -e "${RED}BLOCKED:${NC} Token validation failed."
  exit 1
fi

if [ "$STATUS" = "denied" ]; then
  echo -e "${RED}BLOCKED:${NC} Git push denied — gate policy set to never."
  exit 1
fi

# Pending — poll for approval (up to 120s)
if [ "$STATUS" = "pending" ]; then
  echo "Waiting for git push approval in the console..."

  for i in $(seq 1 60); do
    sleep 2
    POLL=$(curl -sf --max-time 5 -X POST "$BRIDGE/api/internal/git-exec-authorize" \
      -H "Content-Type: application/json" -d "{\"sandboxId\":\"$SANDBOX_ID\"}" 2>&1)
    POLL_STATUS=$(echo "$POLL" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ "$POLL_STATUS" = "authorized" ]; then
      TOKEN=$(echo "$POLL" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ -n "$TOKEN" ]; then
        VALIDATE=$(curl -sf --max-time 5 -X POST "$SHIELD/api/workflow/validate-git-push" \
          -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" 2>&1)
        if [ $? -eq 0 ] && echo "$VALIDATE" | grep -q '"valid":true'; then
          echo -e "${GREEN}*${NC} Git push authorized via console approval"
          exit 0
        fi
      fi
      echo -e "${RED}BLOCKED:${NC} Token validation failed after approval."
      exit 1
    fi

    if [ "$POLL_STATUS" = "denied" ]; then
      echo -e "${RED}BLOCKED:${NC} Git push denied by user."
      exit 1
    fi
  done

  echo -e "${RED}BLOCKED:${NC} Git push approval timed out (120s)."
  exit 1
fi

echo -e "${RED}BLOCKED:${NC} Git push not authorized."
exit 1
