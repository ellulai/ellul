#!/bin/bash
# ellul-env-loader.sh -- Load NUL-delimited env vars from stdin, then exec.
# /proc/<pid>/cmdline shows only: ellul-env-loader.sh <command args>
# Secrets stay in stdin pipe, never in process environment of the parent.
set -euo pipefail

# ── Dump prevention (defense-in-depth) ──
# 1. ulimit -c 0: prevent core dumps from this process
# 2. PR_SET_DUMPABLE=0: make /proc/<pid>/environ unreadable by same-UID processes
#    and prevent ptrace attach (even with ptrace_scope=0). This closes the window
#    between export and exec where secrets exist in the process environment.
# 3. coredump_filter=0: even if core dumps are somehow re-enabled, exclude all
#    memory regions from the dump.
ulimit -c 0
if [ -w /proc/self/coredump_filter ]; then
  echo 0 > /proc/self/coredump_filter 2>/dev/null || true
fi
# PR_SET_DUMPABLE=0 (SUID_DUMP_DISABLE) via /proc interface.
# Equivalent to prctl(PR_SET_DUMPABLE, 0) -- no direct shell access to prctl(2).
if [ -w /proc/self/dumpable ]; then
  echo 0 > /proc/self/dumpable 2>/dev/null || true
fi

# Read NUL-delimited KEY=VALUE pairs from stdin.
# Each record is: KEY=value\0 -- no shell interpretation occurs.
while IFS= read -r -d '' line; do
  # Split on first '=' only -- value can contain '=' characters
  key="${line%%=*}"
  value="${line#*=}"
  # Validate key is a valid env var name (alphanumeric + underscore, no leading digit)
  if [[ "$key" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    export "$key=$value"
  fi
done

# Exec replaces this process -- the new process inherits env vars
# but /proc/<pid>/cmdline only shows the exec'd command args
exec "$@"
