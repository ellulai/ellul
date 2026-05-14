#!/bin/sh
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ellul.ai. All rights reserved.
#
# The Claude Agent SDK spawns `claude` via Node's child_process.spawn,
# bypassing the Effect ChildProcessSpawner. The adapter sets
# pathToClaudeCodeExecutable to THIS script (ellul-claude-ns). The bridge
# redeems the OAT in-process and passes CLAUDE_CODE_OAUTH_TOKEN via env.
#
# ELLUL_NS_PROJECT contract:
#   - sbx-{7char}: sudo into ellul-agent-namespace, run claude inside
#   - __host__: provider probe (e.g. `claude --version`); exec claude
#     directly. The wrapper does not GRANT a namespace transition; it
#     requests one. Skipping the request keeps the caller in its own
#     namespace — agents already inside their sandbox cannot escape by
#     setting the sentinel.
#   - missing: fail closed.
#
# OAT env propagation across sudo:
#   sudo's default `env_reset` strips environment variables before the
#   inner exec, so the parent's env (set by the launcher) does NOT
#   automatically reach claude. We stage the OAT in a /tmp/.ns-env-*
#   file (mode 0600) and hand it to ellul-agent-namespace via
#   --env-file; the namespace script validates ownership + path prefix,
#   copies the file into the namespace's /tmp via /proc, and sources it
#   as the inner runuser env.
#
#   The script reads from process env — NOT from any file in ~/.claude.json.
#   The OAT lives only in bridge memory and the per-spawn env file
#   (sourced by the namespace script, then deleted).

set -eu

CLAUDE_LAUNCH_TRACE_LOG="/var/log/ellul/claude-launch.log"
TR="${ELLUL_CLAUDE_TRACE_ID:-no-trace}"

# JSON-escape a single string value (POSIX-portable, no jq dependency).
# Handles backslash, double-quote, and ASCII control characters.
trace_json_str() {
  printf '%s' "$1" | awk '
    BEGIN { ORS=""; print "\""; }
    {
      gsub(/\\/, "\\\\");
      gsub(/"/, "\\\"");
      gsub(/\b/, "\\b"); gsub(/\f/, "\\f");
      gsub(/\n/, "\\n"); gsub(/\r/, "\\r");
      gsub(/\t/, "\\t");
      printf "%s", $0;
    }
    END { print "\""; }
  '
}

trace() {
  phase="$1"
  shift
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
  line=$(printf '{"ts":"%s","component":"claude-ns","tr":"%s","phase":"%s"' "$ts" "$TR" "$phase")
  for kv in "$@"; do
    case "$kv" in
      *=*)
        k=${kv%%=*}
        v=${kv#*=}
        line="${line},$(trace_json_str "$k"):$(trace_json_str "$v")"
        ;;
    esac
  done
  line="${line}}"
  printf '%s\n' "$line" >&2
  printf '%s\n' "$line" >> "$CLAUDE_LAUNCH_TRACE_LOG" 2>/dev/null || true
}

trace enter \
  "project=${ELLUL_NS_PROJECT:-<unset>}" \
  "has_oat=$([ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && echo yes || echo no)" \
  "has_home=$([ -n "${HOME:-}" ] && echo yes || echo no)" \
  "argc=$#" \
  "user=${USER:-<unset>}" \
  "pid=$$"

if [ -z "${ELLUL_NS_PROJECT:-}" ]; then
  trace fail-closed reason=missing-ns-project
  echo "ellul-claude-ns: ELLUL_NS_PROJECT env is required — refusing to spawn claude outside any namespace" >&2
  exit 64
fi

if [ -z "${HOME:-}" ]; then
  trace fail-closed reason=missing-home
  echo "ellul-claude-ns: HOME unset — cannot resolve claude binary" >&2
  exit 64
fi

CLAUDE_BIN="$HOME/.node/bin/claude"
trace claude-bin-resolved "claude_bin=$CLAUDE_BIN" "exists=$([ -x "$CLAUDE_BIN" ] && echo yes || echo no)"

if [ "$ELLUL_NS_PROJECT" = "__host__" ]; then
  trace host-bypass-exec target="$CLAUDE_BIN"
  exec "$CLAUDE_BIN" "$@"
fi

ENV_FILE=$(mktemp /tmp/.ns-env-claude.XXXXXX)
chmod 600 "$ENV_FILE"

TOKEN_VALUE="${CLAUDE_CODE_OAUTH_TOKEN:-}"
if [ -n "$TOKEN_VALUE" ]; then
  case "$TOKEN_VALUE" in
    *'
'*)
      trace oat-newline-reject
      echo "ellul-claude-ns: rejecting OAT containing newline" >&2
      exit 64
      ;;
  esac
  printf 'export %s=%s\n' "CLAUDE_CODE_OAUTH_TOKEN" "$TOKEN_VALUE" > "$ENV_FILE"
  trace env-file-write "path=$ENV_FILE" "mode=0600" "oat_len=${#TOKEN_VALUE}"
else
  trace env-file-skip reason=no-oat
fi

# Writable config dir on namespace tmpfs. Inside the namespace /home is
# read-only; claude's atomic-write to ~/.claude.json creates a temp file
# in the same directory which hits EROFS. Redirecting CLAUDE_CONFIG_DIR
# to /tmp (fresh tmpfs per namespace) sidesteps the issue entirely.
printf 'mkdir -p /tmp/.claude-config 2>/dev/null || true\n' >> "$ENV_FILE"
printf 'export CLAUDE_CONFIG_DIR=/tmp/.claude-config\n' >> "$ENV_FILE"

# Disable non-essential outbound traffic (Statsig feature flags, Sentry
# telemetry). These endpoints are not in the namespace /etc/hosts egress
# allowlist, so DNS resolution blocks for ~30 s then fails — stalling
# claude's entire init phase and producing zero stdout.
printf 'export DO_NOT_TRACK=1\n' >> "$ENV_FILE"
printf 'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n' >> "$ENV_FILE"

# Seccomp verbose: print the loaded filter target on stderr so operators
# can confirm which binary seccomp-exec is wrapping.
printf 'export ELLUL_SECCOMP_VERBOSE=1\n' >> "$ENV_FILE"

# Forward resolved cwd so the namespace enter script cd's to the app
# directory instead of the sandbox root.
if [ -n "${ELLUL_NS_CWD:-}" ]; then
  printf 'export ELLUL_NS_CWD=%q\n' "$ELLUL_NS_CWD" >> "$ENV_FILE"
fi

ENV_ARGS="--env-file $ENV_FILE"

trace sudo-exec \
  "project=$ELLUL_NS_PROJECT" \
  "argc=$#"
exec sudo -n ellul-agent-namespace enter "$ELLUL_NS_PROJECT" $ENV_ARGS -- "$CLAUDE_BIN" "$@"
