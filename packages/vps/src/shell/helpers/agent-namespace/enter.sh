enter)
  ns_phase_log enter begin
  # Parse optional flags
  ENV_FILE=""
  THREAD_ID=""
  CMD_FILE=""
  while [ "${1:-}" = "--env-file" ] || [ "${1:-}" = "--thread-id" ] || [ "${1:-}" = "--cmd-file" ]; do
    if [ "${1:-}" = "--env-file" ]; then
      ENV_FILE="${2:-}"; shift 2 2>/dev/null || true
    elif [ "${1:-}" = "--thread-id" ]; then
      THREAD_ID="${2:-}"; shift 2 2>/dev/null || true
    elif [ "${1:-}" = "--cmd-file" ]; then
      CMD_FILE="${2:-}"; shift 2 2>/dev/null || true
    fi
  done
  if [ "${1:-}" = "--" ]; then shift; fi
  # Capture the leftmost binary name for log correlation. Strip the path so
  # operators see "codex" / "claude" / "opencode" without the /home/dev/.node
  # prefix flooding the log line.
  ENTER_CMD_NAME="$(basename -- "${1:-}" 2>/dev/null || echo unknown)"
  ns_phase_log enter info "cmd=$ENTER_CMD_NAME argc=$# threadId=${THREAD_ID:-none} envFile=${ENV_FILE:+present} cmdFile=${CMD_FILE:+present}"
  # Write command + args to a pre-escaped exec line to avoid quoting issues
  # through multiple shell layers (sudo → nsenter → unshare → bash -c → runuser).
  # This file is copied into the namespace and sourced by the inner script.
  NS_CMD_ARGS="/tmp/.ns-args-$$"
  {
    printf "exec"
    for _a in "$@"; do printf " %q" "$_a"; done
    echo
  } > "$NS_CMD_ARGS"
  AGENT_CMD="$*"

  if [ -z "$AGENT_CMD" ] && [ -z "$CMD_FILE" ]; then
    ns_phase_log enter fail "reason=missing-command"
    echo '{"success":false,"error":"Missing command for enter"}' >&2
    exit 1
  fi

  # Validate thread ID if provided — must match TypeScript's /^[0-9a-f]{24}$/ exactly.
  # SECURITY: Previous regex was '^[a-zA-Z0-9_-]+$' which was far more permissive
  # than the TypeScript validation (24 hex chars). This mismatch could allow path
  # traversal via thread IDs that pass shell validation but bypass TS validation.
  if [ -n "$THREAD_ID" ]; then
    if ! echo "$THREAD_ID" | grep -qE '^[0-9a-f]{24}$'; then
      ns_phase_log enter fail "reason=invalid-thread-id"
      echo '{"success":false,"error":"Invalid thread ID format"}' >&2
      exit 1
    fi
  fi

  # Validate env file if provided.
  #
  # SECURITY: this script runs as root via sudoers. `cp` follows symlinks by
  # default, so a symlink named like /tmp/.ns-env-foo pointing at (e.g.)
  # /etc/ellul/shield-data/jwt-secret would leak the target's bytes into the
  # namespace — where they get chowned to the agent user. We defend in depth:
  #   1. `-L` + `-h` rejection: file must not be a symlink.
  #   2. `realpath -e` canonicalisation: resolved path must still match the
  #      /tmp/.ns-env- prefix after resolution.
  #   3. Ownership check: file must be owned by the service user, not root.
  #      A root-owned env file would indicate a symlink resolved to a
  #      root-readable secret.
  if [ -n "$ENV_FILE" ]; then
    if [ ! -f "$ENV_FILE" ]; then
      ns_phase_log enter fail "reason=env-file-missing path=$ENV_FILE"
      echo '{"success":false,"error":"Env file does not exist"}' >&2
      exit 1
    fi
    if [ -L "$ENV_FILE" ]; then
      ns_phase_log enter fail "reason=env-file-symlink path=$ENV_FILE"
      echo '{"success":false,"error":"Env file must not be a symlink"}' >&2
      exit 1
    fi
    ENV_FILE_REAL=$(realpath -e -- "$ENV_FILE" 2>/dev/null || true)
    if [ -z "$ENV_FILE_REAL" ]; then
      ns_phase_log enter fail "reason=env-file-realpath-fail path=$ENV_FILE"
      echo '{"success":false,"error":"Env file canonicalisation failed"}' >&2
      exit 1
    fi
    case "$ENV_FILE_REAL" in
      /tmp/.ns-env-*) ;;
      *)
        ns_phase_log enter fail "reason=env-file-bad-path real=$ENV_FILE_REAL"
        echo '{"success":false,"error":"Env file path not allowed"}' >&2; exit 1 ;;
    esac
    # Ownership must be the service user. A root-owned file at this path
    # indicates the caller crafted a symlink that resolved to a privileged
    # location; refuse to proceed.
    ENV_FILE_OWNER=$(stat -c %U -- "$ENV_FILE_REAL" 2>/dev/null || true)
    if [ "$ENV_FILE_OWNER" != "$SVC_USER" ]; then
      ns_phase_log enter fail "reason=env-file-bad-owner owner=$ENV_FILE_OWNER expected=$SVC_USER"
      echo '{"success":false,"error":"Env file must be owned by the service user"}' >&2
      exit 1
    fi
    # Use the canonicalised path for all subsequent operations.
    ENV_FILE="$ENV_FILE_REAL"
  fi

  # Validate cmd file if provided (used by ns-shell to pass env+command securely)
  # SECURITY: cmd-file is written by ns-shell (as service user) to /tmp with mktemp
  # (mode 0600, unpredictable filename). This script (running as root via sudo)
  # copies it into the namespace's /tmp via /proc, then deletes the host copy.
  # This prevents TOCTOU attacks — the agent cannot access /tmp on the host.
  # Same symlink/realpath/ownership rules apply as for env-file.
  if [ -n "$CMD_FILE" ]; then
    if [ ! -f "$CMD_FILE" ]; then
      ns_phase_log enter fail "reason=cmd-file-missing path=$CMD_FILE"
      echo '{"success":false,"error":"Cmd file does not exist"}' >&2
      exit 1
    fi
    if [ -L "$CMD_FILE" ]; then
      ns_phase_log enter fail "reason=cmd-file-symlink path=$CMD_FILE"
      echo '{"success":false,"error":"Cmd file must not be a symlink"}' >&2
      exit 1
    fi
    CMD_FILE_REAL=$(realpath -e -- "$CMD_FILE" 2>/dev/null || true)
    if [ -z "$CMD_FILE_REAL" ]; then
      ns_phase_log enter fail "reason=cmd-file-realpath-fail path=$CMD_FILE"
      echo '{"success":false,"error":"Cmd file canonicalisation failed"}' >&2
      exit 1
    fi
    case "$CMD_FILE_REAL" in
      /tmp/.ns-cmd-*) ;;
      *)
        ns_phase_log enter fail "reason=cmd-file-bad-path real=$CMD_FILE_REAL"
        echo '{"success":false,"error":"Cmd file path not allowed"}' >&2; exit 1 ;;
    esac
    CMD_FILE_OWNER=$(stat -c %U -- "$CMD_FILE_REAL" 2>/dev/null || true)
    if [ "$CMD_FILE_OWNER" != "$SVC_USER" ]; then
      ns_phase_log enter fail "reason=cmd-file-bad-owner owner=$CMD_FILE_OWNER expected=$SVC_USER"
      echo '{"success":false,"error":"Cmd file must be owned by the service user"}' >&2
      exit 1
    fi
    CMD_FILE="$CMD_FILE_REAL"
  fi

  ns_phase_log enter validate-end

  # Read anchor PID
  ANCHOR_PID=$(cat "/run/.ns-$PROJECT/anchor.pid" 2>/dev/null || true)
  if [ -z "$ANCHOR_PID" ] || ! kill -0 "$ANCHOR_PID" 2>/dev/null; then
    ns_phase_log enter fail "reason=anchor-dead anchorPid=${ANCHOR_PID:-none}"
    echo '{"success":false,"error":"Namespace not running for '$PROJECT'"}' >&2
    exit 1
  fi
  ns_phase_log enter info "anchorPid=$ANCHOR_PID"

  # Copy env file into namespace via /proc (G1: survives sudo env scrub)
  # SECURITY: use cp -P to refuse to follow a symlink if the file was swapped
  # for one between validation above and the copy here (TOCTOU defence). We
  # already rejected symlinks and non-SVC_USER-owned files in validation; this
  # is defence-in-depth against a race where the agent replaces the file.
  NS_ENV_PATH=""
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ]; then
    NS_ENV_PATH="/tmp/.ns-env-$$"
    if ! cp -P -- "$ENV_FILE" "/proc/$ANCHOR_PID/root$NS_ENV_PATH" 2>/dev/null; then
      ns_phase_log enter fail "reason=env-cp-fail anchorPid=$ANCHOR_PID dest=$NS_ENV_PATH"
      echo '{"success":false,"error":"Failed to copy env file into namespace"}' >&2
      exit 1
    fi
    chmod 600 "/proc/$ANCHOR_PID/root$NS_ENV_PATH"
    rm -f "$ENV_FILE"
    ns_phase_log enter info "phase=env-copy-ok bytes=$(stat -c %s -- "/proc/$ANCHOR_PID/root$NS_ENV_PATH" 2>/dev/null || echo 0)"
  fi

  # Copy pre-escaped args file into namespace via /proc
  NS_ARGS_PATH="/tmp/.ns-exec-args-$$"
  if [ -f "$NS_CMD_ARGS" ]; then
    if ! cp "$NS_CMD_ARGS" "/proc/$ANCHOR_PID/root$NS_ARGS_PATH" 2>/dev/null; then
      ns_phase_log enter fail "reason=args-cp-fail anchorPid=$ANCHOR_PID"
      echo '{"success":false,"error":"Failed to copy args file into namespace"}' >&2
      exit 1
    fi
    chmod 644 "/proc/$ANCHOR_PID/root$NS_ARGS_PATH"
    rm -f "$NS_CMD_ARGS"
  fi

  # Copy cmd file into namespace via /proc (used by ns-shell for env+command bundle)
  # SECURITY: same symlink-defence as env-file above — cp -P refuses to follow.
  NS_CMD_PATH=""
  if [ -n "$CMD_FILE" ] && [ -f "$CMD_FILE" ] && [ ! -L "$CMD_FILE" ]; then
    NS_CMD_PATH="/tmp/.ns-cmd-$$"
    if ! cp -P -- "$CMD_FILE" "/proc/$ANCHOR_PID/root$NS_CMD_PATH" 2>/dev/null; then
      ns_phase_log enter fail "reason=cmd-cp-fail anchorPid=$ANCHOR_PID"
      echo '{"success":false,"error":"Failed to copy cmd file into namespace"}' >&2
      exit 1
    fi
    chmod 755 "/proc/$ANCHOR_PID/root$NS_CMD_PATH"
    rm -f "$CMD_FILE"
    # If cmd-file provided, override AGENT_CMD to execute it inside the namespace
    AGENT_CMD="bash $NS_CMD_PATH"
  fi

  # Thread isolation: if thread-id provided, set up per-thread mount
  # inside the namespace using secondary unshare --mount
  THREAD_SETUP=""
  if [ -n "$THREAD_ID" ] && [ -d "$THREADS_DIR/$THREAD_ID" ]; then
    # Save thread dir to namespace /tmp via /proc
    THREAD_TMP="/tmp/.ns-thread-$$"
    mkdir -p "/proc/$ANCHOR_PID/root$THREAD_TMP"
    cp -a "$THREADS_DIR/$THREAD_ID/." "/proc/$ANCHOR_PID/root$THREAD_TMP/" 2>/dev/null || true
    THREAD_SETUP="
      mkdir -p '$THREADS_DIR'
      mount -t tmpfs -o size=32M,mode=755 tmpfs '$THREADS_DIR'
      mkdir -p '$THREADS_DIR/$THREAD_ID'
      mount --bind '$THREAD_TMP' '$THREADS_DIR/$THREAD_ID'
    "
  fi

  ns_phase_log enter pre-nsenter "anchorPid=$ANCHOR_PID cmd=$ENTER_CMD_NAME"

  # Enter the persistent namespace.
  #
  # --mount isolates each enter's /proc remount: without it, concurrent
  # enters (e.g. SDK session + thread-title one-shot) both `mount -t proc
  # proc /proc` in the shared anchor mount NS, stacking mounts and
  # corrupting /proc/self/* for the second process. Bun/V8 reads
  # /proc/self/auxv or /proc/self/maps at startup and crashes with
  # SIGTRAP (exit 133) when the stacked mount returns stale data.
  #
  # An earlier attempt removed --mount due to stdio disconnection with
  # runuser -l's PAM pty allocation. Re-tested 2026-05-13: stdio flows
  # correctly through the full bridge SDK path (nsenter → unshare
  # --pid --mount --fork → bash → runuser -l → seccomp-exec → claude).
  #
  # OBSERVABILITY: every step inside the inner bash echoes a `[ns-enter]`
  # marker to stderr. agent-bridge's session-runtime captures the last
  # 16 KB of the codex child's stderr and ships it via the
  # `codex.process.exit` event (similarly for claude/opencode). When
  # codex exits 133 / SIGTRAP, the markers tell us *which* inner step
  # the seccomp filter killed: chown, mktemp, env source, runuser, or
  # the command itself. Without these, exit 133 leaves no stack trace.
  exec nsenter --mount --pid --net --target "$ANCHOR_PID" -- \
    unshare --pid --mount --fork -- bash -c '
      set -euo pipefail
      ns_log() { printf "[ns-enter] %s phase=%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:-}" >&2; }
      ns_log enter-inner "pid=$$"
      # Remount /proc so /proc/self resolves for the forked process.
      # Without this, Go binaries (opencode) abort — they read /proc/self/auxv at startup.
      mount -t proc proc /proc 2>/dev/null || true
      ns_log proc-remounted
      SVC_USER="'"$SVC_USER"'"
      PROJECT_DIR="'"$PROJECT_DIR"'"
      NS_ENV_PATH="'"$NS_ENV_PATH"'"
      THREAD_ID="'"$THREAD_ID"'"
      THREADS_DIR="'"$THREADS_DIR"'"

      # Per-call thread isolation (secondary unshare --mount)
      '"$THREAD_SETUP"'

      # Chown + chmod the env file so the inner runuser as $SVC_USER
      # can source + rm it. /tmp is tmpfs mode 1777 (sticky), so non-owners
      # cannot delete root-owned files — leaving it root:root surfaces as
      # an EPERM rm error on every command.
      if [ -n "$NS_ENV_PATH" ] && [ -f "$NS_ENV_PATH" ]; then
        chown "$SVC_USER":"$SVC_USER" "$NS_ENV_PATH"
        chmod 600 "$NS_ENV_PATH"
        ns_log env-chown-ok
      fi
      # mktemp for uniqueness: every concurrent enter forks `unshare --pid
      # --fork` so `$$` always resolves to PID 1 in the new PID NS — using
      # /tmp/.ns-run-$$ caused parallel enters to overwrite each other'"'"'s
      # script and surface as `exec /tmp/.ns-run-1: Text file busy`. With
      # the per-call mount NS (see unshare --mount above) /tmp is shared
      # across enters, so the file name still has to be unique on its own.
      _CMD=$(mktemp /tmp/.ns-run-XXXXXX)
      NS_ARGS_FILE="'"$NS_ARGS_PATH"'"
      {
        echo "#!/bin/bash"
        if [ -n "$NS_ENV_PATH" ] && [ -f "$NS_ENV_PATH" ]; then
          printf "source %q\n" "$NS_ENV_PATH"
          printf "rm -f %q\n" "$NS_ENV_PATH"
        fi
        printf "_NS_CWD=\"\${ELLUL_NS_CWD:-%q}\"\n" "$PROJECT_DIR"
        printf "export ZEROCLAW_WORKSPACE=\"\$_NS_CWD\"\n"
        printf "cd \"\$_NS_CWD\" && "
        # Use pre-escaped args file (written outside shell layers, preserves quoting)
        if [ -f "$NS_ARGS_FILE" ]; then
          cat "$NS_ARGS_FILE"
          rm -f "$NS_ARGS_FILE"
        else
          # Fallback: positional params (legacy/cmd-file mode)
          printf "exec"
          for _a; do printf " %q" "$_a"; done
          echo
        fi
      } > "$_CMD"
      chmod 755 "$_CMD"
      ns_log cmd-script-built "path=$_CMD"
      # SECURITY: Apply seccomp-BPF filter before executing agent command.
      # Blocks mount, unshare, ptrace, module loading, etc. inside namespace.
      # Uniform across every adapter — adapters that try to spawn bwrap or
      # otherwise call denied syscalls SIGTRAP loudly rather than silently
      # widening the boundary. Normal agent operations (file I/O,
      # networking, spawning) are unaffected.
      SECCOMP_BIN="/usr/local/bin/ellul-seccomp-exec"
      if [ -x "$SECCOMP_BIN" ]; then
        ns_log pre-runuser
        exec /usr/sbin/runuser -l "$SVC_USER" -c "$SECCOMP_BIN $_CMD"
      else
        ns_log fail "reason=seccomp-bin-missing"
        echo '"'"'{"success":false,"error":"SECURITY: seccomp binary missing at /usr/local/bin/ellul-seccomp-exec — refusing to execute without syscall filter"}'"'"' >&2
        exit 1
      fi
    ' -- $AGENT_CMD
  ;;