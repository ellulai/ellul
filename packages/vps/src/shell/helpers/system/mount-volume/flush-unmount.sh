
  flush)
    # CRITICAL: Checkpoint PostgreSQL BEFORE flushing the filesystem.
    PG_CHECKPOINT="skipped"
    PG_STOP="skipped"

    # Stop PG cleanly BEFORE flush — same approach that works for migrations.
    # A running PG can write new dirty pages between CHECKPOINT and volume detach.
    # Stopping PG guarantees all data is on disk with a clean shutdown record.
    if command -v pg_isready &>/dev/null && pg_isready -q 2>/dev/null; then
      # CHECKPOINT first to minimize shutdown time
      if sudo -u postgres psql -c "CHECKPOINT;" >/dev/null 2>&1; then
        PG_CHECKPOINT="ok"
      else
        PG_CHECKPOINT="failed"
      fi
      # Stop PG cleanly — writes shutdown checkpoint + closes all files
      if systemctl stop postgresql 2>/dev/null; then
        PG_STOP="ok"
      else
        PG_STOP="failed"
      fi
    elif systemctl is-active --quiet postgresql 2>/dev/null; then
      # PG is running but pg_isready failed (socket issue?) — stop it anyway
      systemctl stop postgresql 2>/dev/null && PG_STOP="ok" || PG_STOP="failed"
    fi

    sync
    IS_MOUNTED=false
    IS_LUKS=false
    if mountpoint -q "$SVC_HOME" 2>/dev/null; then
      IS_MOUNTED=true
      # Detect if mount source is a LUKS dm-crypt device
      MOUNT_SRC=$(findmnt -n -o SOURCE "$SVC_HOME" 2>/dev/null || echo "")
      if [[ "$MOUNT_SRC" == /dev/mapper/luks-* ]]; then
        IS_LUKS=true
      fi
      if command -v fsfreeze &>/dev/null; then
        fsfreeze --freeze "$SVC_HOME" 2>/dev/null || true
        fsfreeze --unfreeze "$SVC_HOME" 2>/dev/null || true
      fi
    fi
    echo "{\"success\":true,\"volumeMounted\":${IS_MOUNTED},\"isLuks\":${IS_LUKS},\"pgCheckpoint\":\"${PG_CHECKPOINT}\",\"pgStop\":\"${PG_STOP}\"}"
    ;;

  force-unmount)
    # Full teardown: vault bind mounts → filesystem → LUKS.
    # Used by hibernate, block migration, and pool-manager releaseServer.
    #   1. Tear down vault bind mounts (they source from the volume)
    #   2. Kill processes, sync, unmount filesystem
    #   3. Close LUKS encrypted container
    # Order matters: bind mounts hold the LUKS device busy.

    # Tear down vault bind mounts before unmount (they source from the volume
    # and keep the LUKS device busy even after the main FS unmount)
    for _vbm in $(awk '/ellul-vault.*bind/ {print $2}' /etc/fstab 2>/dev/null); do
      mountpoint -q "$_vbm" 2>/dev/null && umount -l "$_vbm" 2>/dev/null || true
    done

    if ! mountpoint -q "$SVC_HOME" 2>/dev/null; then
      # Already unmounted — still close LUKS if open
      if [ -e /dev/mapper/luks-home ]; then
        cryptsetup luksClose luks-home 2>/dev/null || true
      fi
      echo '{"success":true,"alreadyUnmounted":true}'
      exit 0
    fi

    # Kill everything using the mount (SIGKILL — no negotiation)
    fuser -kvm "$SVC_HOME" 2>/dev/null || true
    sleep 2

    # Flush all dirty pages to disk
    sync

    # Lazy unmount — detaches from namespace, pending I/O drains to device
    umount -l "$SVC_HOME" 2>/dev/null || true

    # Remove fstab entry so the stale mount doesn't reappear on reboot
    sed -i "\| ${SVC_HOME} |d" /etc/fstab 2>/dev/null || true

    # Close LUKS — now safe because bind mounts and filesystem are gone
    if [ -e /dev/mapper/luks-home ]; then
      cryptsetup luksClose luks-home 2>/dev/null || true
    fi

    echo '{"success":true,"luksClosedOk":$([ ! -e /dev/mapper/luks-home ] && echo true || echo false)}'
    ;;

  luks-close)
    # Tear down vault bind mounts first
    for _vbm in $(awk '/ellul-vault.*bind/ {print $2}' /etc/fstab 2>/dev/null); do
      mountpoint -q "$_vbm" 2>/dev/null && umount -l "$_vbm" 2>/dev/null || true
    done
    sync
    fuser -kvm "$SVC_HOME" 2>/dev/null || true
    sleep 1
    umount "$SVC_HOME" 2>/dev/null || umount -l "$SVC_HOME" 2>/dev/null || true
    [ -e /dev/mapper/luks-home ] && cryptsetup luksClose luks-home 2>/dev/null || true
    echo '{"success":true,"luksClosedOk":$([ ! -e /dev/mapper/luks-home ] && echo true || echo false)}'
    ;;

  grow)
    # Online-grow the service-user home filesystem after the underlying
    # block device has been enlarged by the cloud provider.
    #
    # This case is the guest-side half of a resize-after-provider-grow
    # flow. It is invoked ONLY for non-sovereign (platform-managed)
    # encryption, where a persistent platform keyfile lives at
    # /etc/ellul/.luks-platform-keyfile and cryptsetup can authenticate
    # without any out-of-band key source. For sovereign volumes, the API
    # state machine skips this step entirely because the grow happened
    # atomically inside wake-mount during the user's PRF unlock (see
    # packages/vps/.../device-mount.sh inline resize).
    #
    # CONTRACT with the caller (file-api /api/grow-volume):
    #   - Always exit 0.
    #   - Always write a single-line JSON blob on stdout:
    #       success path:  {"success":true, "luksResized": bool, ...}
    #       failure path:  {"success":false,"error": "..."}
    #   - Keep tool output off stdout (use tmp files / >&2) so the
    #     caller's JSON.parse never chokes on stray text. file-api
    #     runs us via execSync, which throws on non-zero exit and
    #     discards the subprocess stdout, surfacing only a generic
    #     "Command failed:" to the API. Exiting 0 with an in-band
    #     error is the only reliable way to report failures.
    _grow_emit() {
      echo "$1"
      exit 0
    }
    _grow_emit_err() {
      local msg="$1"
      # Escape double quotes and backslashes for safe JSON embedding.
      local esc
      esc=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
      _grow_emit "{\"success\":false,\"error\":\"grow: ${esc}\"}"
    }

    if ! mountpoint -q "$SVC_HOME" 2>/dev/null; then
      _grow_emit_err "SVC_HOME $SVC_HOME is not mounted"
    fi

    MOUNT_SRC=""
    MOUNT_SRC=$(findmnt -n -o SOURCE "$SVC_HOME" 2>/dev/null || true)
    if [ -z "$MOUNT_SRC" ]; then
      _grow_emit_err "could not resolve mount source for $SVC_HOME"
    fi

    OLD_FS_BYTES=0
    OLD_FS_BYTES=$(df -B1 --output=size "$SVC_HOME" 2>/dev/null | awk 'NR==2 {print $1}' || true)
    if [ -z "$OLD_FS_BYTES" ]; then OLD_FS_BYTES=0; fi

    # Resolve the backing block device. Primary source: lsblk pkname
    # (ships with util-linux everywhere). Fallback: dmsetup deps parsed
    # into major:minor resolved via /dev/block/.
    BACKING_DEV=""
    if [ -z "$BACKING_DEV" ]; then
      _pk=$(lsblk -no pkname "$MOUNT_SRC" 2>/dev/null | head -1 || true)
      if [ -n "$_pk" ] && [ -b "/dev/${_pk}" ]; then BACKING_DEV="/dev/${_pk}"; fi
    fi
    if [ -z "$BACKING_DEV" ] && [[ "$MOUNT_SRC" == /dev/mapper/luks-* ]]; then
      _majmin=$(dmsetup deps "$(basename "$MOUNT_SRC")" 2>/dev/null \
        | grep -oE '\([0-9]+, ?[0-9]+\)' \
        | head -1 \
        | tr -d '() ' \
        | tr ',' ':')
      if [[ "$_majmin" =~ ^[0-9]+:[0-9]+$ ]]; then
        _resolved=$(readlink -f "/dev/block/${_majmin}" 2>/dev/null || true)
        if [ -n "$_resolved" ] && [ -b "$_resolved" ]; then BACKING_DEV="$_resolved"; fi
      fi
    fi

    # Belt-and-suspenders SCSI rescan so the kernel's view of the
    # backing device size is current. Idempotent; failures are fine.
    if [ -n "$BACKING_DEV" ]; then
      BACK_NAME=$(basename "$BACKING_DEV")
      if [ -e "/sys/block/${BACK_NAME}/device/rescan" ]; then
        echo 1 > "/sys/block/${BACK_NAME}/device/rescan" 2>/dev/null || true
      fi
    fi

    LUKS_RESIZED=skipped-not-luks
    if [[ "$MOUNT_SRC" == /dev/mapper/luks-* ]]; then
      MAPPER_NAME=$(basename "$MOUNT_SRC")

      # Short-circuit: if the mapping is already within 64 MiB of the
      # backing device, there's nothing to do at the LUKS layer. This
      # covers the "wake-mount already did the inline grow" case for
      # sovereign servers that (defensively) also enter this step.
      _already_sized=0
      if [ -n "$BACKING_DEV" ]; then
        _map_sz=$(blockdev --getsize64 "$MOUNT_SRC" 2>/dev/null || echo 0)
        _back_sz=$(blockdev --getsize64 "$BACKING_DEV" 2>/dev/null || echo 0)
        if [ "$_map_sz" -gt 0 ] && [ "$_back_sz" -gt 0 ] \
           && [ "$((_back_sz - _map_sz))" -lt 67108864 ]; then
          _already_sized=1
        fi
      fi

      if [ "$_already_sized" = "1" ]; then
        LUKS_RESIZED=skipped-already-sized
      else
        # Platform keyfile: persistent, root-owned, 0600. When present,
        # cryptsetup derives the volume key directly from it without
        # touching the kernel keyring — so a fresh subprocess can
        # authenticate just fine. This is the non-sovereign path.
        PLATFORM_KEYFILE="/etc/ellul/.luks-platform-keyfile"
        _crypt_err=""
        _crypt_log=$(mktemp /tmp/.grow-crypt.XXXXXX 2>/dev/null || echo "/tmp/.grow-crypt.$$")
        if [ -r "$PLATFORM_KEYFILE" ]; then
          if cryptsetup --batch-mode resize --key-file="$PLATFORM_KEYFILE" "$MAPPER_NAME" >"$_crypt_log" 2>&1; then
            LUKS_RESIZED=ok-platform-keyfile
          else
            _crypt_err=$(tr '\n' ' ' <"$_crypt_log" 2>/dev/null || true)
          fi
        else
          _crypt_err="no platform keyfile at $PLATFORM_KEYFILE (sovereign mode is handled by wake-mount, not this command — this step should not have been queued)"
        fi
        rm -f "$_crypt_log"
        if [ "$LUKS_RESIZED" = "skipped-not-luks" ]; then
          _grow_emit_err "cryptsetup resize ${MAPPER_NAME} failed: ${_crypt_err}"
        fi
      fi
    fi

    # Online resize2fs — grows mounted ext4 to fill the dm-crypt mapping
    # (or the plain block device, for non-LUKS mounts). Idempotent:
    # no-op when already at full size. Output captured to a tmp log
    # so it cannot leak onto our stdout.
    _resize_log=$(mktemp /tmp/.grow-resize2fs.XXXXXX 2>/dev/null || echo "/tmp/.grow-resize2fs.$$")
    if ! resize2fs "$MOUNT_SRC" >"$_resize_log" 2>&1; then
      _resize_out=$(tr '\n' ' ' <"$_resize_log" 2>/dev/null | sed 's/[[:space:]]*$//' || true)
      rm -f "$_resize_log"
      _grow_emit_err "resize2fs ${MOUNT_SRC} failed: ${_resize_out}"
    fi
    rm -f "$_resize_log"

    NEW_FS_BYTES=0
    NEW_FS_BYTES=$(df -B1 --output=size "$SVC_HOME" 2>/dev/null | awk 'NR==2 {print $1}' || true)
    if [ -z "$NEW_FS_BYTES" ]; then NEW_FS_BYTES=0; fi

    _grow_emit "{\"success\":true,\"luksResized\":\"${LUKS_RESIZED}\",\"mountSource\":\"${MOUNT_SRC}\",\"oldFsBytes\":${OLD_FS_BYTES},\"newFsBytes\":${NEW_FS_BYTES}}"
    ;;
