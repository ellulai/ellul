#!/bin/bash
FLAG_FILE="/var/lib/ellul.ai/lazy-ai-ready"
ENV_FILE="$HOME/.ellul-cli-env"

_reload_secrets() {
  [ -f "$ENV_FILE" ] && source "$ENV_FILE"
}

_ai_shim() {
  local tool="$1"
  shift
  _reload_secrets
  if [ -f "$FLAG_FILE" ] || command -v "$tool" &>/dev/null; then
    command "$tool" "$@"
  else
    echo "$tool installing..."
  fi
}

opencode() { _ai_shim opencode "$@"; }

claude() { _ai_shim claude "$@"; }
codex() { _ai_shim codex "$@"; }
# cursor-agent is the real binary name; `cursor` is the user-friendly alias.
cursor() { _ai_shim cursor-agent "$@"; }
cursor-agent() { _ai_shim cursor-agent "$@"; }
grok() { _ai_shim grok "$@"; }

export -f opencode claude codex cursor cursor-agent grok _ai_shim _reload_secrets 2>/dev/null || true