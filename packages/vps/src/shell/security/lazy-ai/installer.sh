#!/bin/bash
LOG="/var/log/lazy-ai-install.log"
FLAG_DIR="/var/lib/ellul.ai"
FLAG_FILE="$FLAG_DIR/lazy-ai-ready"

[ -f /etc/default/ellul ] && source /etc/default/ellul
SVC_USER="${PS_USER:-dev}"

log() { echo "[$(date -Iseconds)] $1" >> "$LOG"; }

# Check if the real binary is installed in the user's NVM path.
# `command -v` under `runuser -l` would be fooled by the shims in
# /etc/profile.d/99-lazy-ai-shims.sh (exported as bash functions with
# the same names), so we unset any same-named function first and rely
# on `type -P` which only resolves PATH entries (ignores builtins and
# functions).
tool_exists() {
  runuser -l $SVC_USER -c "source ~/.nvm/nvm.sh 2>/dev/null; unset -f $1 2>/dev/null; [ -n \"\$(type -P $1)\" ]" &>/dev/null
}

# Install a single npm global with retry. Skips if already on PATH.
install_npm_tool() {
  local label="$1"
  local pkg="$2"
  if tool_exists "$label"; then
    log "$label: already installed — skipping"
    return 0
  fi
  local attempt=1
  while [ $attempt -le 3 ]; do
    log "$label: attempt $attempt/3"
    if runuser -l $SVC_USER -c "source ~/.nvm/nvm.sh && npm install -g $pkg" >> "$LOG" 2>&1; then
      log "$label: OK"
      return 0
    fi
    log "$label: attempt $attempt failed"
    attempt=$((attempt + 1))
    [ $attempt -le 3 ] && sleep 30
  done
  log "!$label (all attempts failed)"
  return 1
}

mkdir -p "$FLAG_DIR"

# Fast path: if all tools exist (snapshot boot), skip the 15s settle delay entirely
if tool_exists claude && tool_exists codex; then
  log "All AI tools already installed — nothing to do"
  touch "$FLAG_FILE"
  exit 0
fi

log "Installing AI tools as $SVC_USER..."
# Settle delay: let NVM symlink, systemd services, and network come up before npm fetches
sleep 15

fail=0
install_npm_tool "claude" "__NPM_CLAUDE_CODE__" || fail=1
install_npm_tool "codex"  "__NPM_CODEX__"       || fail=1

# Only mark "ready" when every tool is actually installed. Leaving the
# flag unset on partial failure lets a later wake/boot retry the missing
# tool instead of caching a broken state in the snapshot.
if [ $fail -eq 0 ]; then
  touch "$FLAG_FILE"
  log "Done"
  wall "AI tools ready" 2>/dev/null || true
else
  log "Done with failures — not marking ready; next boot will retry"
fi
