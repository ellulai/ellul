ACTION="${1:-}"
PROJECT="${2:-}"
shift 2 2>/dev/null || true

# ── Input validation ──
if [ -z "$PROJECT" ]; then
  echo '{"success":false,"error":"Usage: {setup|enter|teardown|spawn} <project> [options]"}' >&2
  exit 1
fi

# Validate project slug (sbx-{7char} format, prevent path traversal / injection)
if ! echo "$PROJECT" | grep -qE '^sbx-[a-z0-9]{7}$'; then
  echo '{"success":false,"error":"Invalid project slug (expected sbx-{7char})"}' >&2
  exit 1
fi

# Determine service user
if [ -f /etc/default/ellul ]; then
  source /etc/default/ellul
fi
SVC_USER="${PS_USER:-dev}"
SVC_HOME="/home/$SVC_USER"
PROJECT_DIR="$SVC_HOME/projects/$PROJECT"
THREADS_DIR="$SVC_HOME/.ellul/threads"

# ── Phase logging ──────────────────────────────────────────
# Append a structured per-phase line to /var/log/ellul/ns-phase.log so the
# bridge (and operators) can see exactly which step inside the namespace
# script is slow. Falls back to /tmp if the primary path isn't writable —
# we never want logging to take down setup.
#
# Schema (whitespace-separated key=value, parseable by both grep and awk):
#   <iso-ts> action=<a> project=<p> phase=<name> state=<begin|end|info>
#       elapsedMs=<n> [pid=<n>] [extra=...]
#
# The `extra` arg is appended verbatim — callers prefer key=value pairs.
NS_PHASE_LOG_FILE="/var/log/ellul/ns-phase.log"
mkdir -p /var/log/ellul 2>/dev/null || true
if ! { : >> "$NS_PHASE_LOG_FILE"; } 2>/dev/null; then
  NS_PHASE_LOG_FILE="/tmp/ellul-ns-phase.log"
  : >> "$NS_PHASE_LOG_FILE" 2>/dev/null || true
fi
# Anchor for elapsed-time arithmetic. ms-precision via date +%s%3N (GNU date).
NS_PHASE_T0_MS="$(date +%s%3N 2>/dev/null || echo 0)"

ns_phase_log() {
  # Args: <phase> [state=info] [extra]
  local phase="${1:-?}"
  local state="${2:-info}"
  local extra="${3:-}"
  local now_iso
  now_iso="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  local now_ms
  now_ms="$(date +%s%3N 2>/dev/null || echo 0)"
  local elapsed=0
  if [ "$NS_PHASE_T0_MS" != "0" ] && [ "$now_ms" != "0" ]; then
    elapsed=$(( now_ms - NS_PHASE_T0_MS ))
  fi
  printf '%s action=%s project=%s phase=%s state=%s elapsedMs=%s pid=%s%s\n' \
    "$now_iso" "${ACTION:-?}" "${PROJECT:-?}" "$phase" "$state" "$elapsed" "$$" \
    "${extra:+ $extra}" >> "$NS_PHASE_LOG_FILE" 2>/dev/null || true
}

# Always emit an entry-point marker so even a fast-failing action shows up.
ns_phase_log entrypoint info "args=$#"