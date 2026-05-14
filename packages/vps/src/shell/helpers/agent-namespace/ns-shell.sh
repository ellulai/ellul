#!/bin/bash
# ellul-ns-shell -- Namespace-aware shell wrapper for ZeroClaw exec tool.
# ZeroClaw calls: $SHELL -c "command" with cwd set to the agent's workspace.
# We derive the project from $PWD and route through the persistent namespace.
# Deployed to /usr/local/bin/ellul-ns-shell, set as SHELL= on per-project daemons.

# If not called as "ns-shell -c <command>", fall through to bash
if [ "${1:-}" != "-c" ] || [ -z "${2:-}" ]; then
  exec /bin/bash "$@"
fi

COMMAND="$2"

# Project identity: ELLUL_PROJECT env var wins. This is set by agent-bridge
# before it invokes ZeroClaw — a value the agent cannot forge across the
# sudo boundary because this script writes ONLY its current environment to
# $CMD_FILE, and the sudo is called below with --cmd-file, not --env-file.
# PWD is used ONLY as a fallback for compatibility with tools that launch
# a shell without setting ELLUL_PROJECT; when both are present AND disagree,
# we refuse.
#
# SECURITY: deriving project from PWD alone is fragile — a stale daemon
# running outside the namespace could pick up the wrong cwd. The explicit
# env var closes that gap.
PROJECT_FROM_ENV=""
if [ -n "${ELLUL_PROJECT:-}" ]; then
  if [[ "$ELLUL_PROJECT" =~ ^sbx-[a-z0-9]{7}$ ]]; then
    PROJECT_FROM_ENV="$ELLUL_PROJECT"
  fi
fi

PROJECT_FROM_PWD=""
if [[ "$PWD" =~ /projects/(sbx-[a-z0-9]{7}) ]]; then
  PROJECT_FROM_PWD="${BASH_REMATCH[1]}"
fi

PROJECT=""
if [ -n "$PROJECT_FROM_ENV" ] && [ -n "$PROJECT_FROM_PWD" ]; then
  # Both present — require agreement. A mismatch means either PWD is stale
  # (shell from a different sandbox reused) or ELLUL_PROJECT is wrong; we
  # refuse rather than guess which is authoritative.
  if [ "$PROJECT_FROM_ENV" = "$PROJECT_FROM_PWD" ]; then
    PROJECT="$PROJECT_FROM_ENV"
  else
    echo "ellul-ns-shell: refused — ELLUL_PROJECT ($PROJECT_FROM_ENV) != PWD project ($PROJECT_FROM_PWD)" >&2
    exit 1
  fi
elif [ -n "$PROJECT_FROM_ENV" ]; then
  PROJECT="$PROJECT_FROM_ENV"
elif [ -n "$PROJECT_FROM_PWD" ]; then
  PROJECT="$PROJECT_FROM_PWD"
fi

# No project detected or namespace not running -> fall through to bash
if [ -z "$PROJECT" ]; then
  exec /bin/bash -c "$COMMAND"
fi

# Check if namespace is running.
# NOTE: Do NOT use kill -0 here -- this script runs as the service user (dev/coder),
# and hidepid=2 on /proc prevents non-root users from seeing root processes.
# The anchor process is owned by root, so kill -0 always fails -> false fallback.
# Instead, check the PID file exists and is non-empty. The enter mode itself
# will fail with a proper error if the anchor is actually dead.
ANCHOR_PID=""
if [ -f "/run/.ns-$PROJECT/anchor.pid" ]; then
  ANCHOR_PID=$(cat "/run/.ns-$PROJECT/anchor.pid" 2>/dev/null || true)
fi

if [ -z "$ANCHOR_PID" ]; then
  # No namespace PID file -- fall through to bash (shared mode fallback)
  exec /bin/bash -c "$COMMAND"
fi

# G1: Preserve environment through sudo boundary.
# sudo strips env vars (API keys, ZEROCLAW_MODE, terminal sizing).
# SECURITY: Write env+command to a secure temp file on the HOST's /tmp (mode 0600,
# mktemp). The agent lives INSIDE the namespace and cannot access the host /tmp
# (namespace has its own tmpfs at /tmp). The enter script (running as root via
# sudo) copies this file into the namespace's /tmp via /proc/$ANCHOR_PID/root,
# then deletes the host copy. This eliminates the TOCTOU window entirely:
# - Host /tmp: only accessible by this process and root (mode 0600, mktemp name)
# - Namespace /tmp: file appears atomically via cp, then executed immediately
CMD_FILE=$(mktemp /tmp/.ns-cmd-XXXXXXXX)
chmod 600 "$CMD_FILE"

# G2: Robust cleanup for temp file (covers normal exit + most signals).
# Belt-and-suspenders: enter.sh also deletes the host copy after copying.
trap 'rm -f "$CMD_FILE"' EXIT HUP INT TERM

# Write current environment to the command file
env -0 | while IFS='=' read -r -d '' key val; do
  # Only safe POSIX env var names
  if echo "$key" | grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*$'; then
    printf 'export %s=%q\n' "$key" "$val"
  fi
done > "$CMD_FILE"

# Append the actual command
echo "$COMMAND" >> "$CMD_FILE"

# Enter namespace with --cmd-file: the enter script (root) copies the file into
# the namespace's /tmp via /proc, deletes the host copy, then executes it.
exec sudo /usr/local/bin/ellul-agent-namespace enter "$PROJECT" --cmd-file "$CMD_FILE"
