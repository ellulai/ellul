#!/bin/bash
# Enforcer Logging Functions
# Logging and status output functions.

# log() writes to both the root-only enforcer log file AND stderr.
# stderr is captured by systemd → journald, which means operators can
# read the enforcer's state via `sudo systemctl status ellul-enforcer`
# or `journalctl -u ellul-enforcer` without needing root access to
# /var/log/ellul-enforcer.log. This was a real blocker during a
# production incident — chain-mismatch errors were only visible in
# the root-only log, forcing a Hetzner rescue boot + disk mount to
# diagnose. Making the same lines appear in journald removes that
# class of "flying blind" incident forever.
log() {
  local line="[$(date -Iseconds)] $1"
  echo "$line" >> "$LOG_FILE"
  # Prefix stderr lines so they stand out from subprocess spam in journald.
  echo "enforcer: $1" >&2
}

# emit_event() writes a structured JSONL line to the daemon events
# stream. Mirrors the agent-bridge pattern (see project memory:
# spawn pipeline observability). Operators read this file for
# fleet-wide reconciliation telemetry — locale.applied counts,
# rejection rates, etc. — without having to grep through plaintext
# enforcer logs.
#
# Usage: emit_event <event-name> <key1> <val1> [<key2> <val2> ...]
# All values are JSON-encoded via jq so embedded quotes/newlines are
# safe. Failure is non-fatal — an unwriteable events file must never
# block the heartbeat loop.
ENFORCER_EVENTS_FILE="/var/log/ellul/enforcer-events.jsonl"
emit_event() {
  local event="$1"
  shift
  command -v jq >/dev/null 2>&1 || return 0
  local payload
  payload=$(jq -nc \
    --arg event "$event" \
    --arg ts "$(date -Iseconds)" \
    '{event: $event, ts: $ts}' 2>/dev/null) || return 0
  # Append remaining args as key/value pairs.
  while [ $# -ge 2 ]; do
    payload=$(printf '%s' "$payload" | jq -c --arg k "$1" --arg v "$2" '. + {($k): $v}' 2>/dev/null) || return 0
    shift 2
  done
  # Best-effort write; events dir may not be ready in early boot.
  mkdir -p "$(dirname "$ENFORCER_EVENTS_FILE")" 2>/dev/null
  printf '%s\n' "$payload" >> "$ENFORCER_EVENTS_FILE" 2>/dev/null || true
}
