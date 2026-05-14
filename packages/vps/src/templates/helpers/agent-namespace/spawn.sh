spawn)
  ns_phase_log spawn begin
  # Parse optional flags (including pre-parsed config from bridge)
  ENV_FILE=""
  THREAD_ID=""
  SHARED_PROJECTS=""
  SHARED_PREVIEWS=""
  SHARED_PREVIEW_PORTS=""
  COMMS_CHANNELS=""
  AO_READABLE_NS=""
  while [ $# -gt 0 ]; do
    case "${1:-}" in
      --env-file)         ENV_FILE="${2:-}"; shift 2 2>/dev/null || true ;;
      --thread-id)        THREAD_ID="${2:-}"; shift 2 2>/dev/null || true ;;
      --shared-projects)  SHARED_PROJECTS="${2:-}"; shift 2 2>/dev/null || true ;;
      --shared-previews)  SHARED_PREVIEWS="${2:-}"; shift 2 2>/dev/null || true ;;
      --shared-ports)     SHARED_PREVIEW_PORTS="${2:-}"; shift 2 2>/dev/null || true ;;
      --comms-channels)   COMMS_CHANNELS="${2:-}"; shift 2 2>/dev/null || true ;;
      --readable-ns)      AO_READABLE_NS="${2:-}"; shift 2 2>/dev/null || true ;;
      *) break ;;
    esac
  done

  AGENT_CMD="$*"
  SPAWN_CMD_NAME="$(basename -- "${1:-}" 2>/dev/null || echo unknown)"
  ns_phase_log spawn info "cmd=$SPAWN_CMD_NAME argc=$# threadId=${THREAD_ID:-none} envFile=${ENV_FILE:+present}"
  # Shell-escape args as exported env var — inherited by unshare's bash -c subprocess.
  # Temp files don't work because unshare mounts fresh tmpfs over /tmp.
  export _NS_ESCAPED_CMD=$(printf '%q ' "$@")

  # Pre-export key env vars from the env file so they survive through unshare + runuser -l.
  # The env file is root-owned and gets permission-denied inside runuser. Exported vars
  # pass through unshare cleanly (inherited by child process).
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
    export ZEROCLAW_WORKSPACE ZEROCLAW_CONFIG_DIR HOME 2>/dev/null || true
  fi

  if [ -z "$AGENT_CMD" ]; then
    ns_phase_log spawn fail "reason=missing-command"
    echo '{"success":false,"error":"Missing command"}' >&2
    exit 1
  fi

  # Validate thread ID if provided — must match TypeScript's /^[0-9a-f]{24}$/ exactly.
  # SECURITY: Previous regex was '^[a-zA-Z0-9_-]+$' which was far more permissive
  # than the TypeScript validation. Tightened to match the canonical format.
  if [ -n "$THREAD_ID" ]; then
    if ! echo "$THREAD_ID" | grep -qE '^[0-9a-f]{24}$'; then
      ns_phase_log spawn fail "reason=invalid-thread-id"
      echo '{"success":false,"error":"Invalid thread ID format"}' >&2
      exit 1
    fi
  fi

  # Validate env file if provided
  if [ -n "$ENV_FILE" ]; then
    if [ ! -f "$ENV_FILE" ]; then
      ns_phase_log spawn fail "reason=env-file-missing path=$ENV_FILE"
      echo '{"success":false,"error":"Env file does not exist"}' >&2
      exit 1
    fi
    case "$ENV_FILE" in
      /tmp/.ns-env-*) ;;
      *)
        ns_phase_log spawn fail "reason=env-file-bad-path path=$ENV_FILE"
        echo '{"success":false,"error":"Env file path not allowed"}' >&2; exit 1 ;;
    esac
  fi

  # Verify project directory exists
  if [ ! -d "$PROJECT_DIR" ]; then
    ns_phase_log spawn fail "reason=project-dir-missing path=$PROJECT_DIR"
    echo '{"success":false,"error":"Project directory does not exist"}' >&2
    exit 1
  fi
  ns_phase_log spawn validate-end

  # Config already parsed — SHARED_PROJECTS, SHARED_PREVIEW_PORTS set via CLI args from bridge.

  # ── HOST-SIDE NETWORK SETUP (one-shot) ──
  # SECURITY: Use HMAC-SHA256 keyed by server-local secret to derive IPs.
  # Prevents attackers from pre-computing namespace IPs from project slugs.
  NS_IP_KEY=""
  [ -f /etc/ellul/jwt-secret ] && NS_IP_KEY=$(cat /etc/ellul/jwt-secret 2>/dev/null | tr -d '[:space:]')
  [ -z "$NS_IP_KEY" ] && [ -f /etc/machine-id ] && NS_IP_KEY=$(cat /etc/machine-id 2>/dev/null | tr -d '[:space:]')
  [ -z "$NS_IP_KEY" ] && NS_IP_KEY="ellul-ns-fallback-key"
  NET_HASH=$(echo -n "$PROJECT" | openssl dgst -sha256 -hmac "$NS_IP_KEY" -hex 2>/dev/null | awk '{print $NF}')
  [ -z "$NET_HASH" ] && NET_HASH=$(echo -n "$PROJECT" | md5sum)
  OCTET1=$(( (16#${NET_HASH:0:2} % 55) + 200 ))
  OCTET2=$(( 16#${NET_HASH:2:2} ))
  OCTET3=$(( 16#${NET_HASH:4:2} & 0xFC ))
  NS_IP="10.$OCTET1.$OCTET2.$(($OCTET3 + 2))"
  HOST_IP="10.$OCTET1.$OCTET2.$(($OCTET3 + 1))"
  NS_SHORT=$(echo "$PROJECT" | sed 's/^sbx-//')
  VETH_HOST="ea-$NS_SHORT"
  VETH_NS="vn-$NS_SHORT"
  NS_NETNS="ellul-$PROJECT"

  $IP netns del "$NS_NETNS" 2>/dev/null || true
  $IP link del "$VETH_HOST" 2>/dev/null || true
  $IP netns add "$NS_NETNS"
  $IP link add "$VETH_HOST" type veth peer name "$VETH_NS"
  $IP link set "$VETH_NS" netns "$NS_NETNS"

  $IP addr add "$HOST_IP/30" dev "$VETH_HOST"
  $IP link set "$VETH_HOST" up
  echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true
  echo 1 > /proc/sys/net/ipv4/conf/$VETH_HOST/route_localnet 2>/dev/null || true

  # Egress allowlist dependency — FORWARD chain below matches ipset `ellul-egress`.
  ipset list -n ellul-egress >/dev/null 2>&1 || \
    ipset create ellul-egress hash:ip family inet hashsize 1024 maxelem 65536 timeout 3600

  $IPTABLES -t nat -D POSTROUTING -s $NS_IP/32 -j MASQUERADE 2>/dev/null || true
  $IPTABLES -t nat -A POSTROUTING -s $NS_IP/32 -j MASQUERADE
  $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p udp --dport 53 -j DNAT --to-destination 127.0.0.54:53 2>/dev/null || true
  $IPTABLES -t nat -A PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p udp --dport 53 -j DNAT --to-destination 127.0.0.54:53
  $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 53 -j DNAT --to-destination 127.0.0.54:53 2>/dev/null || true
  $IPTABLES -t nat -A PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 53 -j DNAT --to-destination 127.0.0.54:53
  # Legacy DNAT target from before the egress-allowlist migration.
  $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p udp --dport 53 -j DNAT --to-destination 127.0.0.53:53 2>/dev/null || true
  $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 53 -j DNAT --to-destination 127.0.0.53:53 2>/dev/null || true

  # ZeroClaw gateway DNAT — allows opencode inside namespace to reach the shared gateway via HOST_IP
  $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 18790 -j DNAT --to-destination 127.0.0.1:18790 2>/dev/null || true
  $IPTABLES -t nat -A PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 18790 -j DNAT --to-destination 127.0.0.1:18790

  # FORWARD chain — written in REVERSE so -I places them at the intended positions.
  # Final order (top to bottom):
  #   1. ACCEPT -d HOST_IP/30, 2. DROP 169.254/16, 3. DROP 10/8, 4. DROP 172.16/12,
  #   5. DROP 192.168/16, 6. DROP !ellul-egress, 7. ACCEPT catchall, 8. RELATED,ESTABLISHED
  $IPTABLES -D FORWARD -d $NS_IP/32 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  $IPTABLES -I FORWARD -d $NS_IP/32 -m state --state RELATED,ESTABLISHED -j ACCEPT
  $IPTABLES -D FORWARD -s $NS_IP/32 -j ACCEPT 2>/dev/null || true
  $IPTABLES -I FORWARD -s $NS_IP/32 -j ACCEPT
  $IPTABLES -D FORWARD -s $NS_IP/32 -m set ! --match-set ellul-egress dst -j DROP 2>/dev/null || true
  $IPTABLES -I FORWARD -s $NS_IP/32 -m set ! --match-set ellul-egress dst -j DROP
  $IPTABLES -D FORWARD -s $NS_IP/32 -d 192.168.0.0/16 -j DROP 2>/dev/null || true
  $IPTABLES -I FORWARD -s $NS_IP/32 -d 192.168.0.0/16 -j DROP
  $IPTABLES -D FORWARD -s $NS_IP/32 -d 172.16.0.0/12 -j DROP 2>/dev/null || true
  $IPTABLES -I FORWARD -s $NS_IP/32 -d 172.16.0.0/12 -j DROP
  $IPTABLES -D FORWARD -s $NS_IP/32 -d 10.0.0.0/8 -j DROP 2>/dev/null || true
  $IPTABLES -I FORWARD -s $NS_IP/32 -d 10.0.0.0/8 -j DROP
  $IPTABLES -D FORWARD -s $NS_IP/32 -d 169.254.0.0/16 -j DROP 2>/dev/null || true
  $IPTABLES -I FORWARD -s $NS_IP/32 -d 169.254.0.0/16 -j DROP
  $IPTABLES -D FORWARD -s $NS_IP/32 -d $HOST_IP/30 -j ACCEPT 2>/dev/null || true
  $IPTABLES -I FORWARD -s $NS_IP/32 -d $HOST_IP/30 -j ACCEPT

  SPAWN_PREVIEW_PORTS=($SHARED_PREVIEW_PORTS)
  for PPORT in "${SPAWN_PREVIEW_PORTS[@]}"; do
    if [ "$PPORT" != "0" ] && [ -n "$PPORT" ] && echo "$PPORT" | grep -qE '^[0-9]+$'; then
      if [ "$PPORT" -lt 4000 ] || [ "$PPORT" -gt 4099 ]; then continue; fi
      $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport $PPORT -j DNAT --to-destination 127.0.0.1:$PPORT 2>/dev/null || true
      $IPTABLES -t nat -A PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport $PPORT -j DNAT --to-destination 127.0.0.1:$PPORT
    fi
  done

  $IP netns exec "$NS_NETNS" $IP link set lo up
  $IP netns exec "$NS_NETNS" $IP addr add $NS_IP/30 dev $VETH_NS
  $IP netns exec "$NS_NETNS" $IP link set $VETH_NS up
  $IP netns exec "$NS_NETNS" $IP route add default via $HOST_IP
  # NS-internal firewall: only accept traffic from host IP (bridge).
  # No DNAT to 127.0.0.1 — OpenCode binds to 0.0.0.0 so the bridge connects
  # directly to NS_IP:4096. DNAT + route_localnet is impossible under
  # ProtectKernelTunables=true (agent-bridge systemd hardening).
  $IP netns exec "$NS_NETNS" $IPTABLES -A INPUT -i lo -j ACCEPT
  $IP netns exec "$NS_NETNS" $IPTABLES -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  $IP netns exec "$NS_NETNS" $IPTABLES -A INPUT -s $HOST_IP/32 -j ACCEPT
  $IP netns exec "$NS_NETNS" $IPTABLES -A INPUT -j DROP

  # Write cleanup script to HOST filesystem
  mkdir -p "/run/.ns-$PROJECT"
  cat > "/run/.ns-$PROJECT/ns-cleanup.sh" <<NSCLEANEOF
#!/bin/bash
$IPTABLES -D FORWARD -s $NS_IP/32 -d $HOST_IP/30 -j ACCEPT 2>/dev/null || true
$IPTABLES -D FORWARD -s $NS_IP/32 -d 169.254.0.0/16 -j DROP 2>/dev/null || true
$IPTABLES -D FORWARD -s $NS_IP/32 -d 10.0.0.0/8 -j DROP 2>/dev/null || true
$IPTABLES -D FORWARD -s $NS_IP/32 -d 172.16.0.0/12 -j DROP 2>/dev/null || true
$IPTABLES -D FORWARD -s $NS_IP/32 -d 192.168.0.0/16 -j DROP 2>/dev/null || true
$IPTABLES -D FORWARD -s $NS_IP/32 -m set ! --match-set ellul-egress dst -j DROP 2>/dev/null || true
$IPTABLES -D FORWARD -s $NS_IP/32 -j ACCEPT 2>/dev/null || true
$IPTABLES -D FORWARD -d $NS_IP/32 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
$IPTABLES -t nat -D POSTROUTING -s $NS_IP/32 -j MASQUERADE 2>/dev/null || true
$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p udp --dport 53 -j DNAT --to-destination 127.0.0.54:53 2>/dev/null || true
$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 53 -j DNAT --to-destination 127.0.0.54:53 2>/dev/null || true
$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 18790 -j DNAT --to-destination 127.0.0.1:18790 2>/dev/null || true
$IP link del $VETH_HOST 2>/dev/null || true
$IP netns del $NS_NETNS 2>/dev/null || true
NSCLEANEOF
  for CLEANUP_PORT in "${SPAWN_PREVIEW_PORTS[@]}"; do
    if [ "$CLEANUP_PORT" != "0" ] && [ -n "$CLEANUP_PORT" ] && [ "$CLEANUP_PORT" -ge 4000 ] 2>/dev/null && [ "$CLEANUP_PORT" -le 4099 ] 2>/dev/null; then
      echo "$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport $CLEANUP_PORT -j DNAT --to-destination 127.0.0.1:$CLEANUP_PORT 2>/dev/null || true" >> "/run/.ns-$PROJECT/ns-cleanup.sh"
    fi
  done
  chmod 700 "/run/.ns-$PROJECT/ns-cleanup.sh"

  # Cleanup trap (no exec — trap fires when nsenter+unshare exits)
  trap 'bash "/run/.ns-$PROJECT/ns-cleanup.sh" 2>/dev/null || true; rm -f "/run/.ns-$PROJECT/ns-cleanup.sh"; rmdir "/run/.ns-$PROJECT" 2>/dev/null || true' EXIT

  ns_phase_log spawn pre-nsenter "cmd=$SPAWN_CMD_NAME nsIp=$NS_IP hostIp=$HOST_IP netns=$NS_NETNS"

  # Enter named netns, create mount+PID namespace (one-shot).
  #
  # OBSERVABILITY: every step inside the inner bash echoes a `[ns-spawn]`
  # marker to stderr. Captured by agent-bridge session-runtime stderrTail
  # and surfaced via `codex.process.exit` (and equivalent claude/opencode
  # events) so a SIGTRAP/exit 133 reveals which inner step the seccomp
  # filter killed.
  nsenter --net=/var/run/netns/$NS_NETNS -- \
    unshare --mount --pid --fork -- bash -c '
    set -euo pipefail
    ns_log() { printf "[ns-spawn] %s phase=%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:-}" >&2; }
    ns_log enter-inner "pid=$$"
    mount --make-rprivate /
    ns_log mount-private

    NS="'"$PROJECT"'"
    SCRATCH="/run/.ns-$NS"
    mkdir -p "$SCRATCH"
    mount -t tmpfs -o size=512M,mode=700,uid=0,gid=0 tmpfs "$SCRATCH"

    mkdir -p "$SCRATCH/project"
    mount --bind "'"$PROJECT_DIR"'" "$SCRATCH/project"

    SHARED_IDX=0
    for SHARED in '"$SHARED_PROJECTS"'; do
      if ! echo "$SHARED" | grep -qE "^sbx-[a-z0-9]{7}$"; then
        SHARED_IDX=$((SHARED_IDX + 1))
        continue
      fi
      SHARED_DIR="'"$SVC_HOME"'/projects/$SHARED"
      if [ -d "$SHARED_DIR" ]; then
        SNAPSHOT="$SCRATCH/shared-$SHARED_IDX"
        mkdir -p "$SNAPSHOT"
        # SECURITY: allowlist of known-safe extensions, not denylist.
        # `__RSYNC_ALLOWLIST__` is replaced at build time by spawnBlock() with
        # the canonical filter args from services/shared/rsync-allowlist.ts.
        # Hardlinks rejected via --no-H (defeats hardlink-to-host-secret),
        # symlinks via --no-links, devices via --no-D.
        rsync -aq --no-links --no-H --no-D --max-size=50m \
__RSYNC_ALLOWLIST__
          "$SHARED_DIR/" "$SNAPSHOT/" 2>/dev/null || true
      fi
      SHARED_IDX=$((SHARED_IDX + 1))
    done

    mkdir -p "$SCRATCH/ctx"
    for CTX_FILE in CLAUDE.md AGENTS.md; do
      SRC="'"$SVC_HOME"'/projects/$CTX_FILE"
      if [ -f "$SRC" ] && [ ! -L "$SRC" ]; then
        cp "$SRC" "$SCRATCH/ctx/projects-$CTX_FILE" 2>/dev/null || true
      fi
    done

    for OVL_DIR in .config .claude .codex .cursor .opencode .ellul .local .zeroclaw .cache; do
      if [ -d "'"$SVC_HOME"'/$OVL_DIR" ]; then
        mkdir -p "$SCRATCH/lower-$OVL_DIR" "$SCRATCH/upper-$OVL_DIR" "$SCRATCH/work-$OVL_DIR"
        chown '"$SVC_USER"':'"$SVC_USER"' "$SCRATCH/upper-$OVL_DIR"
        mount --bind "'"$SVC_HOME"'/$OVL_DIR" "$SCRATCH/lower-$OVL_DIR"
      fi
    done

    NS_THREAD_ID="'"$THREAD_ID"'"
    if [ -n "$NS_THREAD_ID" ] && [ -d "'"$THREADS_DIR"'/$NS_THREAD_ID" ]; then
      mkdir -p "$SCRATCH/thread"
      mount --bind "'"$THREADS_DIR"'/$NS_THREAD_ID" "$SCRATCH/thread"
    fi

    NS_ENV_ORIG="'"$ENV_FILE"'"
    if [ -n "$NS_ENV_ORIG" ] && [ -f "$NS_ENV_ORIG" ]; then
      cp "$NS_ENV_ORIG" "$SCRATCH/env-file"
      chmod 600 "$SCRATCH/env-file"
      rm -f "$NS_ENV_ORIG"
    fi


    # Save writable dotfiles to scratch BEFORE making home read-only.
    # CLIs write to these: .claude.json (Claude Code), .gitconfig (git).
    mkdir -p "$SCRATCH/dotfiles"
    for DOTFILE in .claude.json .gitconfig; do
      if [ -f "'"$SVC_HOME"'/$DOTFILE" ]; then
        cp "'"$SVC_HOME"'/$DOTFILE" "$SCRATCH/dotfiles/$DOTFILE"
        chown '"$SVC_USER"':'"$SVC_USER"' "$SCRATCH/dotfiles/$DOTFILE"
      fi
    done

    mount --bind "'"$SVC_HOME"'" "'"$SVC_HOME"'"
    mount -o remount,bind,ro "'"$SVC_HOME"'"

    # Restore writable dotfiles via bind-mount over the read-only copies
    for DOTFILE in .claude.json .gitconfig; do
      if [ -f "$SCRATCH/dotfiles/$DOTFILE" ]; then
        mount --bind "$SCRATCH/dotfiles/$DOTFILE" "'"$SVC_HOME"'/$DOTFILE"
      fi
    done

    mount -t tmpfs -o size=1M,mode=755 tmpfs "'"$SVC_HOME"'/projects"
    mkdir -p "'"$PROJECT_DIR"'"
    mount --bind "$SCRATCH/project" "'"$PROJECT_DIR"'"

    for CTX_FILE in CLAUDE.md AGENTS.md; do
      if [ -f "$SCRATCH/ctx/projects-$CTX_FILE" ]; then
        cp "$SCRATCH/ctx/projects-$CTX_FILE" "'"$SVC_HOME"'/projects/$CTX_FILE" 2>/dev/null || true
      fi
    done

    SHARED_PPORTS=('"$SHARED_PREVIEW_PORTS"')
    SHARED_IDX=0
    for SHARED in '"$SHARED_PROJECTS"'; do
      if echo "$SHARED" | grep -qE "^sbx-[a-z0-9]{7}$" && [ -d "$SCRATCH/shared-$SHARED_IDX" ]; then
        PPORT="${SHARED_PPORTS[$SHARED_IDX]:-0}"
        if [ "$PPORT" != "0" ] && [ -n "$PPORT" ]; then
          echo "http://'"$HOST_IP"':$PPORT" > "$SCRATCH/shared-$SHARED_IDX/.preview-url"
        fi
        MOUNT_POINT="'"$PROJECT_DIR"'/.shared/$SHARED"
        mkdir -p "$MOUNT_POINT"
        mount --bind "$SCRATCH/shared-$SHARED_IDX" "$MOUNT_POINT"
        mount -o remount,bind,ro "$MOUNT_POINT"
      fi
      SHARED_IDX=$((SHARED_IDX + 1))
    done

    for OVL_DIR in .config .claude .codex .cursor .opencode .ellul .local .zeroclaw .cache; do
      if [ -d "$SCRATCH/lower-$OVL_DIR" ]; then
        mount -t overlay overlay \
          -o "lowerdir=$SCRATCH/lower-$OVL_DIR,upperdir=$SCRATCH/upper-$OVL_DIR,workdir=$SCRATCH/work-$OVL_DIR" \
          "'"$SVC_HOME"'/$OVL_DIR"
      fi
    done

    NS_THREAD_ID="'"$THREAD_ID"'"
    if [ -n "$NS_THREAD_ID" ]; then
      mkdir -p "'"$THREADS_DIR"'"
      mount -t tmpfs -o size=32M,mode=755 tmpfs "'"$THREADS_DIR"'"
      if [ -d "$SCRATCH/thread" ]; then
        mkdir -p "'"$THREADS_DIR"'/$NS_THREAD_ID"
        mount --bind "$SCRATCH/thread" "'"$THREADS_DIR"'/$NS_THREAD_ID"
      else
        mkdir -p "'"$THREADS_DIR"'/$NS_THREAD_ID"
      fi
    fi


    mount -t proc proc /proc
    mount -t tmpfs -o size=256M,mode=1777 tmpfs /tmp

    mkdir -p "$SCRATCH/dns"
    echo "nameserver 8.8.8.8" > "$SCRATCH/dns/resolv.conf"
    echo "nameserver 1.1.1.1" >> "$SCRATCH/dns/resolv.conf"
    mount --bind "$SCRATCH/dns/resolv.conf" /etc/resolv.conf

    # SECURITY-CRITICAL: shield-data / shielded-vault / run-shield blackholes.
    # These are LOAD-BEARING. If any one fails the agent inside the namespace
    # would see cross-project config, IPC tokens, BYOK manifests, the LUKS-
    # shielded vault, or the shield runtime socket. Fail CLOSED — abort the
    # spawn, never enter agent code with a leaky mount tree.
    #
    # Pre-create target dirs (idempotent on provisioned hosts; defends against
    # a fresh box where shield was not yet installed). Then mount; any error
    # from mount(8) other than EBUSY-on-existing-tmpfs is fatal.
    for BH_TARGET in /etc/ellul/shield-data /var/lib/ellul-shielded /run/shield; do
      mkdir -p "$BH_TARGET" 2>/dev/null || {
        echo "ns-spawn FATAL: cannot create blackhole target $BH_TARGET" >&2
        exit 73
      }
      if ! mount -t tmpfs -o size=0,mode=000 tmpfs "$BH_TARGET" 2>/tmp/.bh-mount-err; then
        # Tolerate the case where a tmpfs is ALREADY mounted at the target
        # (idempotent re-spawn into a previously-set-up namespace). Anything
        # else — refuse to continue; the agent would be able to read secrets.
        if ! findmnt --noheadings --output FSTYPE "$BH_TARGET" 2>/dev/null | grep -qx tmpfs; then
          echo "ns-spawn FATAL: shield blackhole mount failed for $BH_TARGET:" >&2
          cat /tmp/.bh-mount-err >&2 2>/dev/null || true
          rm -f /tmp/.bh-mount-err
          exit 73
        fi
      fi
      rm -f /tmp/.bh-mount-err
      # Post-condition: target must be a tmpfs and reading it must yield no
      # entries. If statfs reports anything else, the agent could still see
      # host content underneath — fail closed.
      if ! findmnt --noheadings --output FSTYPE "$BH_TARGET" 2>/dev/null | grep -qx tmpfs; then
        echo "ns-spawn FATAL: $BH_TARGET is not tmpfs after mount (refusing to expose)" >&2
        exit 73
      fi
      if [ "$(ls -A "$BH_TARGET" 2>/dev/null | wc -l)" -ne 0 ]; then
        echo "ns-spawn FATAL: $BH_TARGET tmpfs is not empty (refusing to expose)" >&2
        exit 73
      fi
    done

    # Source env inside the runuser login shell (not before it — runuser -l resets env).
    # $SCRATCH is root:root 700 — dev user cannot read it. Copy to /tmp (fresh tmpfs
    # was mounted above, so this /tmp is namespace-private and writable). Chown to
    # $SVC_USER so the inner `rm -f` works — /tmp is mounted sticky (1777) and
    # non-owners cannot delete root-owned files.
    NS_ENV="$SCRATCH/env-file"
    NS_ENV_USER="/tmp/.ns-env-login"
    if [ -f "$NS_ENV" ]; then
      cp "$NS_ENV" "$NS_ENV_USER"
      chown '"$SVC_USER"':'"$SVC_USER"' "$NS_ENV_USER"
      chmod 600 "$NS_ENV_USER"
    fi

    # $_NS_ESCAPED_CMD inherited from outer shell (exported env var survives unshare)
    # Inline ZEROCLAW_WORKSPACE export — env file sourcing is unreliable through runuser -l
    # SECURITY: Apply seccomp-BPF filter before executing agent command. The
    # filter applies uniformly across every adapter — anything that tries to
    # spawn bwrap or otherwise call mount/unshare SIGTRAPs loudly rather than
    # silently widening the boundary.
    if [ ! -x /usr/local/bin/ellul-seccomp-exec ]; then
      ns_log fail "reason=seccomp-bin-missing"
      echo '"'"'{"success":false,"error":"SECURITY: seccomp binary missing — refusing to execute without syscall filter"}'"'"' >&2
      exit 1
    fi
    SECCOMP_PREFIX="/usr/local/bin/ellul-seccomp-exec "
    ns_log pre-runuser
    if [ -f "$NS_ENV_USER" ]; then
      exec /usr/sbin/runuser -l "'"$SVC_USER"'" -c "source $NS_ENV_USER; rm -f $NS_ENV_USER; export ZEROCLAW_WORKSPACE='"'"'"'"$PROJECT_DIR"'"'"'"'; cd '"'"'"'"$PROJECT_DIR"'"'"'"' && exec ${SECCOMP_PREFIX}$_NS_ESCAPED_CMD"
    else
      exec /usr/sbin/runuser -l "'"$SVC_USER"'" -c "export ZEROCLAW_WORKSPACE='"'"'"'"$PROJECT_DIR"'"'"'"'; cd '"'"'"'"$PROJECT_DIR"'"'"'"' && exec ${SECCOMP_PREFIX}$_NS_ESCAPED_CMD"
    fi
  '
  ;;