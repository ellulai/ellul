teardown)
  ns_phase_log teardown begin
  ANCHOR_UNIT="ellul-ns-$PROJECT"

  # Host-side network cleanup (iptables, veth, named netns) lives in the
  # anchor's scratch dir; it persists across namespace exit and must run
  # before we drop the unit so reset rules don't race new traffic.
  if [ -f "/run/.ns-$PROJECT/ns-cleanup.sh" ]; then
    bash "/run/.ns-$PROJECT/ns-cleanup.sh" 2>/dev/null || true
  fi

  # Stop the transient systemd unit. KillMode=control-group propagates the
  # signal through unshare(1) → ns-mount → sleep, releasing the namespaces.
  systemctl stop "${ANCHOR_UNIT}.service" 2>/dev/null || true
  systemctl reset-failed "${ANCHOR_UNIT}.service" 2>/dev/null || true

  # Belt-and-suspenders: if a stray PID survives (e.g. unit was started
  # outside systemd-run by an older bundle), force-reap it.
  ANCHOR_PID=$(cat "/run/.ns-$PROJECT/anchor.pid" 2>/dev/null || true)
  if [ -n "$ANCHOR_PID" ] && kill -0 "$ANCHOR_PID" 2>/dev/null; then
    kill -9 "$ANCHOR_PID" 2>/dev/null || true
  fi

  CGROUP_DIR="/sys/fs/cgroup/ellul-$PROJECT"
  if [ -d "$CGROUP_DIR" ]; then
    cat "$CGROUP_DIR/cgroup.procs" 2>/dev/null | while read pid; do
      echo "$pid" > /sys/fs/cgroup/cgroup.procs 2>/dev/null || true
    done
    rmdir "$CGROUP_DIR" 2>/dev/null || true
  fi

  # rm -rf on the scratch dir — rmdir silently fails on stray debug files
  # and leaving them would cause stale state at next setup.
  rm -rf "/run/.ns-$PROJECT" 2>/dev/null || true
  rmdir "/run/.ns-lock-$PROJECT" 2>/dev/null || true
  rm -f "/run/.ns-ready-$PROJECT"

__NETWORK_TEARDOWN__

  ns_phase_log teardown end
  echo '{"success":true}'
  ;;
