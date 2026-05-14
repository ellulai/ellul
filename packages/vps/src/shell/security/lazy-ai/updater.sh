#!/bin/bash
# update-ai-tools — Update AI CLI tools to their latest versions.
#
# Usage: update-ai-tools [tool]
#   update-ai-tools          # update all tools
#   update-ai-tools claude   # update only claude
#   update-ai-tools list     # show installed versions

source ~/.nvm/nvm.sh 2>/dev/null || { echo "Error: NVM not found. Is this an ellul.ai workspace?"; exit 1; }

TARGET="${1:-all}"
UPDATED=0
FAILED=0
LOCK_FILE="/tmp/.update-ai-tools.lock"

# Concurrent update guard — npm global installs are not atomic across packages.
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "Another update is already running (PID $LOCK_PID). Try again later."
    exit 1
  fi
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Get installed version via jq (available in base image).
get_version() {
  local pkg="$1"
  local ver
  ver=$(npm list -g "$pkg" --depth=0 --json 2>/dev/null | jq -r ".dependencies[\"$pkg\"].version // empty" 2>/dev/null)
  echo "${ver:-not installed}"
}

get_binary_version() {
  local bin="$1"
  if [ -x "/usr/local/bin/$bin" ]; then
    /usr/local/bin/$bin --version 2>/dev/null | head -1
  else
    echo "not installed"
  fi
}

list_versions() {
  echo "AI CLI tools:"
  echo "  claude       $(get_version @anthropic-ai/claude-code)"
  echo "  codex        $(get_version @openai/codex)"
  echo "  cursor-agent $(get_binary_version cursor-agent)"
  echo "  zeroclaw     $(get_binary_version zeroclaw)"
  echo "  opencode     $(get_binary_version opencode)"
}

update_npm_tool() {
  local name="$1"
  local pkg="$2"
  local before
  before=$(get_version "$pkg")
  echo "Updating $name ($before)..."

  # Capture npm output and exit code separately — piping to tail loses the exit code.
  local npm_out
  local npm_rc=0
  npm_out=$(npm install -g "$pkg@latest" 2>&1) || npm_rc=$?

  if [ "$npm_rc" -eq 0 ]; then
    local after
    after=$(get_version "$pkg")
    if [ "$before" = "$after" ]; then
      echo "  $name: already at latest ($after)"
    else
      echo "  $name: $before -> $after"
    fi
    UPDATED=$((UPDATED + 1))
  else
    # Show the full npm error — don't truncate, the user needs to diagnose.
    echo "$npm_out" | tail -10
    echo "  $name: update failed (exit $npm_rc)"
    FAILED=$((FAILED + 1))
  fi
  echo ""
}

update_binary() {
  local name="$1"
  echo "Updating $name..."
  if sudo /usr/local/bin/ellul-update-binary "$name" 2>&1; then
    UPDATED=$((UPDATED + 1))
  else
    echo "  $name: update failed"
    FAILED=$((FAILED + 1))
  fi
  echo ""
}

case "$TARGET" in
  claude)        update_npm_tool "Claude Code" "@anthropic-ai/claude-code" ;;
  codex)         update_npm_tool "Codex" "@openai/codex" ;;
  cursor|cursor-agent) update_binary "cursor-agent" ;;
  zeroclaw)      update_binary "zeroclaw" ;;
  opencode)      update_binary "opencode" ;;
  list)          list_versions ;;
  all)
    update_npm_tool "Claude Code" "@anthropic-ai/claude-code"
    update_npm_tool "Codex" "@openai/codex"
    update_binary "cursor-agent"
    update_binary "zeroclaw"
    update_binary "opencode"
    ;;
  *)
    echo "Unknown tool: $TARGET"
    echo "Available: claude, codex, cursor, zeroclaw, opencode, list, all"
    exit 1
    ;;
esac

if [ "$TARGET" != "list" ]; then
  if [ "$FAILED" -gt 0 ]; then
    echo "$UPDATED updated, $FAILED failed."
    exit 1
  else
    echo "$UPDATED tool(s) updated."
  fi
fi
