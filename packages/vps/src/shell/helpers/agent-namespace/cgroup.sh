    # ═══════ PHASE 5.5: CGROUP MEMORY LIMITS (cgroup v2) ═══════
    # Hard ceiling per workspace prevents OOM from killing the entire system.
    # A build step can spike memory enough to evict PostgreSQL without cgroups.
    # With cgroups, only the offending workspace is killed.
    #
    # Requires cgroup v2 unified hierarchy.
    # Silently skips if unavailable — workspaces run without limits (degraded but functional).
    CGROUP_DIR=""
    if [ -f /sys/fs/cgroup/cgroup.controllers ] && \
       grep -q memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null && \
       [ -w /sys/fs/cgroup/cgroup.subtree_control ]; then

      CGROUP_DIR="/sys/fs/cgroup/ellul-$PROJECT"
      if [ ! -d "$CGROUP_DIR" ]; then
        # Enable memory + pids controllers on root cgroup
        echo "+memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true

        # Create the workspace cgroup
        if ! mkdir -p "$CGROUP_DIR" 2>/dev/null; then
          CGROUP_DIR=""  # mkdir failed — skip cgroup setup
        fi
      fi

      if [ -n "$CGROUP_DIR" ] && [ -d "$CGROUP_DIR" ]; then
        # Determine memory limit based on billing tier + total RAM
        BILLING_TIER=$(cat /etc/ellul/billing-tier 2>/dev/null || echo "free")
        TOTAL_RAM_MB=$(free -m | awk '/Mem:/ {print $2}')
        SYSTEM_RESERVE_MB=640
        AVAIL_MB=$(( TOTAL_RAM_MB - SYSTEM_RESERVE_MB ))
        # Floor: enforce a minimum per workspace
        [ "$AVAIL_MB" -lt 256 ] 2>/dev/null && AVAIL_MB=256

        case "$BILLING_TIER" in
          free)
            LIMIT_MB=$AVAIL_MB
            [ "$LIMIT_MB" -gt 1024 ] 2>/dev/null && LIMIT_MB=1024
            ;;
          paid)
            ENT_CAP=$(cat /etc/ellul/entitlement-cap 2>/dev/null || echo "2")
            # Validate entitlement cap is a number > 0
            case "$ENT_CAP" in ''|*[!0-9]*) ENT_CAP=2 ;; esac
            [ "$ENT_CAP" -lt 1 ] 2>/dev/null && ENT_CAP=1
            LIMIT_MB=$(( AVAIL_MB / ENT_CAP ))
            [ "$LIMIT_MB" -gt 2048 ] 2>/dev/null && LIMIT_MB=2048
            [ "$LIMIT_MB" -lt 512 ] 2>/dev/null && LIMIT_MB=512
            ;;
          *)
            LIMIT_MB=768
            ;;
        esac

        LIMIT_BYTES=$(( LIMIT_MB * 1024 * 1024 ))
        HIGH_BYTES=$(( LIMIT_BYTES + 128 * 1024 * 1024 ))

        # Set limits — verify writes succeeded
        if echo "$LIMIT_BYTES" > "$CGROUP_DIR/memory.max" 2>/dev/null; then
          echo "$HIGH_BYTES" > "$CGROUP_DIR/memory.high" 2>/dev/null || true
          # Workspace NEVER touches swap. A runaway user workload (npm install,
          # next dev, create-next-app) must hit its memory.max and get a
          # *local* cgroup OOM in ~1 second instead of spilling into host swap
          # and dragging the control plane into a thrash spiral. This is the
          # load-bearing guard that would have stopped the 2026-04-20 incident.
          echo 0 > "$CGROUP_DIR/memory.swap.max" 2>/dev/null || true
          echo 256 > "$CGROUP_DIR/pids.max" 2>/dev/null || true

          # Move anchor + all future children into the cgroup
          echo $ANCHOR_PID > "$CGROUP_DIR/cgroup.procs" 2>/dev/null || true
        else
          # memory.max write failed — cgroup is unusable, clean up
          rmdir "$CGROUP_DIR" 2>/dev/null || true
          CGROUP_DIR=""
        fi
      fi
    fi