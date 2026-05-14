setup)
  ns_phase_log setup begin

  # Concurrent setup lock — mkdir is POSIX-atomic on local FS.
  LOCK_DIR="/run/.ns-lock-$PROJECT"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    ns_phase_log lock-contended info
    for i in $(seq 1 60); do
      if [ -f "/run/.ns-$PROJECT/anchor.pid" ]; then
        ANCHOR_PID=$(cat "/run/.ns-$PROJECT/anchor.pid" 2>/dev/null || true)
        if [ -n "$ANCHOR_PID" ] && kill -0 "$ANCHOR_PID" 2>/dev/null; then
          ns_phase_log lock-piggyback end "iter=$i anchorPid=$ANCHOR_PID"
          echo '{"success":true,"pid":'$ANCHOR_PID'}'
          exit 0
        fi
      fi
      sleep 0.5
    done
    ns_phase_log lock-wait-timeout end
    echo '{"success":false,"error":"Timed out waiting for concurrent setup"}' >&2
    rmdir "$LOCK_DIR" 2>/dev/null || true
    exit 1
  fi
  ns_phase_log lock-acquired info
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

  ANCHOR_UNIT="ellul-ns-$PROJECT"

  # Stale state cleanup — previous anchor unit + iptables/veth from a
  # crashed setup. systemctl stop is idempotent (no-op if unit absent).
  ns_phase_log stale-cleanup begin
  systemctl stop "${ANCHOR_UNIT}.service" 2>/dev/null || true
  systemctl reset-failed "${ANCHOR_UNIT}.service" 2>/dev/null || true
  if [ -f "/run/.ns-$PROJECT/anchor.pid" ]; then
    OLD_PID=$(cat "/run/.ns-$PROJECT/anchor.pid" 2>/dev/null || true)
    if [ -n "$OLD_PID" ]; then
      OLD_CLEANUP="/run/.ns-$PROJECT/ns-cleanup.sh"
      [ -f "$OLD_CLEANUP" ] && bash "$OLD_CLEANUP" 2>/dev/null || true
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
  fi
  CLEANUP_SHORT=$(echo "$PROJECT" | sed 's/^sbx-//')
  $IP link del "ea-$CLEANUP_SHORT" 2>/dev/null || true
  /usr/bin/nsenter --target 1 --mount -- $IP netns del "ellul-$PROJECT" 2>/dev/null || true
  ns_phase_log stale-cleanup end

  if [ ! -d "$PROJECT_DIR" ]; then
    ns_phase_log project-dir-missing end
    echo '{"success":false,"error":"Project directory does not exist"}' >&2
    exit 1
  fi

  # Anchor binary must exist before we hand it to systemd — failing here
  # gives a clean error rather than a transient unit that crashes immediately.
  if [ ! -x /usr/local/bin/ellul-ns-mount ]; then
    ns_phase_log mount-binary-missing end
    echo '{"success":false,"error":"ellul-ns-mount binary missing — provisioning incomplete"}' >&2
    exit 1
  fi

  mkdir -p "/run/.ns-$PROJECT"
  # Ready-FIFO is mode 0600 (root-only) so the agent user cannot race-open
  # it for read and steal the anchor's "ready\n" write — that would force
  # the bash reader to time out waiting for a signal the kernel already
  # delivered to the wrong process.
  READY_FIFO="/run/.ns-ready-$PROJECT"
  rm -f "$READY_FIFO"
  mkfifo -m 0600 "$READY_FIFO"

  # Pre-parsed config from the bridge (TS-side JSON parsing replaces
  # python3 forks). Empty defaults keep the script working for older
  # bridge versions that don't pass these flags yet.
  SHARED_PROJECTS=""
  SHARED_PREVIEWS=""
  SHARED_PREVIEW_PORTS=""
  COMMS_CHANNELS=""
  AO_READABLE_NS=""
  while [ "${1:-}" = "--shared-projects" ] || [ "${1:-}" = "--shared-previews" ] || \
        [ "${1:-}" = "--shared-ports" ] || [ "${1:-}" = "--comms-channels" ] || \
        [ "${1:-}" = "--readable-ns" ]; do
    case "${1:-}" in
      --shared-projects)  SHARED_PROJECTS="${2:-}"; shift 2 ;;
      --shared-previews)  SHARED_PREVIEWS="${2:-}"; shift 2 ;;
      --shared-ports)     SHARED_PREVIEW_PORTS="${2:-}"; shift 2 ;;
      --comms-channels)   COMMS_CHANNELS="${2:-}"; shift 2 ;;
      --readable-ns)      AO_READABLE_NS="${2:-}"; shift 2 ;;
    esac
  done

  BYOK_MODE="false"
  [ -f "/etc/ellul/shield-data/.byok-active" ] && BYOK_MODE="true"

  ns_phase_log network-setup begin
__NETWORK_SETUP__
  ns_phase_log network-setup end

  ns_phase_log preview-dnat begin
__PREVIEW_DNAT__
  ns_phase_log preview-dnat end

  ns_phase_log cleanup-script begin
__CLEANUP_SCRIPT__
  ns_phase_log cleanup-script end

  # On any failure from here on, run the network cleanup script before
  # releasing the lock — partial state would prevent the next setup.
  trap 'systemctl stop "${ANCHOR_UNIT}.service" 2>/dev/null || true; bash "/run/.ns-$PROJECT/ns-cleanup.sh" 2>/dev/null || true; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

  # Launch the anchor as a transient systemd unit in
  # ellul-namespaces.slice. This gives it:
  #   - its own cgroup (independent of agent-bridge lifecycle)
  #   - journald-managed stdio (no inherited pipe holding execFile open)
  #   - resource accounting separate from the control plane
  #   - inspectable state via `systemctl status ellul-ns-<project>.service`
  ns_phase_log anchor-start begin
  BYOK_ARGS=()
  [ "$BYOK_MODE" = "true" ] && BYOK_ARGS=(--byok)
  if ! systemd-run --quiet --collect \
       --slice=ellul-namespaces.slice \
       --unit="${ANCHOR_UNIT}" \
       --description="ellul.ai namespace anchor: $PROJECT" \
       --property=Type=simple \
       --property=KillMode=control-group \
       --property=Restart=no \
       --property=TasksMax=64 \
       -- \
       /usr/bin/nsenter --net=/var/run/netns/"$NS_NETNS" -- \
       /usr/bin/unshare --mount --pid --fork -- \
       /usr/local/bin/ellul-ns-mount \
         --project "$PROJECT" \
         --home "$SVC_HOME" \
         --user "$SVC_USER" \
         --ready-fifo "$READY_FIFO" \
         --host-ip "${HOST_IP:-}" \
         --ovl-dirs ".config,.claude,.codex,.cursor,.opencode,.ellul,.local,.zeroclaw,.cache" \
         --ro-dirs "" \
         "${BYOK_ARGS[@]}" \
         --defer-shared 2>/dev/null; then
    ns_phase_log anchor-start fail
    echo '{"success":false,"error":"systemd-run failed to start anchor unit"}' >&2
    exit 1
  fi
  ns_phase_log anchor-start end

  # Wait for ns-mount.c to finish all mount phases and write to the FIFO.
  # 60s tolerates ARM cold-cache; ns-mount itself runs in <200ms once the
  # kernel has the relevant inodes warm.
  ns_phase_log ready-fifo-wait begin
  if ! timeout 60 cat "$READY_FIFO" >/dev/null 2>&1; then
    ns_phase_log ready-fifo-wait timeout
    rm -f "$READY_FIFO"
    systemctl stop "${ANCHOR_UNIT}.service" 2>/dev/null || true
    echo '{"success":false,"error":"Namespace ready signal timed out"}' >&2
    exit 1
  fi
  ns_phase_log ready-fifo-wait end

  # Capture the anchor's main pid from systemd. This is the unshare(1)
  # process; KillMode=control-group on the unit means systemctl stop
  # propagates to the inner ns-mount → sleep chain regardless.
  ANCHOR_PID=$(systemctl show "${ANCHOR_UNIT}.service" -p MainPID --value 2>/dev/null)
  if [ -z "$ANCHOR_PID" ] || [ "$ANCHOR_PID" = "0" ]; then
    ns_phase_log anchor-pid-missing end
    rm -f "$READY_FIFO"
    systemctl stop "${ANCHOR_UNIT}.service" 2>/dev/null || true
    echo '{"success":false,"error":"Failed to read anchor MainPID from systemd"}' >&2
    exit 1
  fi
  echo "$ANCHOR_PID" > "/run/.ns-$PROJECT/anchor.pid"
  rm -f "$READY_FIFO"
  # Replace the FIFO with a regular sentinel so isNamespaceRunning() can
  # confirm setup completed end-to-end (anchor alive AND mount phases done).
  touch "/run/.ns-ready-$PROJECT"

  # Cross-project read access: rsync source-code snapshots into .shared/<slug>.
  # ns-mount.c created .shared/ (0555 root:root) inside the mount namespace;
  # we populate it here AFTER the namespace is ready, using nsenter to reach
  # the namespace's mount tree.
  ns_phase_log cross-project-rsync begin
  if [ -n "$SHARED_PROJECTS" ]; then
    NS_ROOT="/proc/$ANCHOR_PID/root"
    NS_SHARED="$NS_ROOT$PROJECT_DIR/.shared"
    SHARED_IDX=0
    for SHARED in $SHARED_PROJECTS; do
      if ! echo "$SHARED" | grep -qE '^sbx-[a-z0-9]{7}$'; then
        SHARED_IDX=$((SHARED_IDX + 1))
        continue
      fi
      SHARED_SRC="$SVC_HOME/projects/$SHARED"
      SHARED_DST="$NS_SHARED/$SHARED"
      if [ -d "$SHARED_SRC" ]; then
        mkdir -p "$SHARED_DST"
        rsync -aq --no-links --no-H --no-D --max-size=50m \
__RSYNC_ALLOWLIST__
          "$SHARED_SRC/" "$SHARED_DST/" 2>/dev/null || true
        chown -R root:root "$SHARED_DST" 2>/dev/null || true
        chmod -R a+rX,a-w "$SHARED_DST" 2>/dev/null || true
      fi
      SHARED_IDX=$((SHARED_IDX + 1))
    done
  fi
  ns_phase_log cross-project-rsync end

  ns_phase_log cgroup-setup begin
__CGROUP__
  ns_phase_log cgroup-setup end

  # Successful path — disarm the failure cleanup trap (teardown owns the
  # network rollback for normal lifecycle exits) but keep the lock release.
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
  ns_phase_log setup end "anchorPid=$ANCHOR_PID unit=${ANCHOR_UNIT}.service"
  echo '{"success":true,"pid":'$ANCHOR_PID',"unit":"'${ANCHOR_UNIT}'.service"}'

  # Sweep stale ns-shell command files older than 60min — they're harmless
  # but accumulate after SIGKILLed wrappers and clutter `ls`.
  find "$PROJECT_DIR" -maxdepth 1 -name '.ns-cmd-*' -mmin +60 -delete 2>/dev/null || true
  ;;
