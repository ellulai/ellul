
    if [ -z "$DEVICE" ]; then
      echo '{"success":false,"error":"Missing device parameter"}'
      exit 1
    fi

    # Resolve symlinks before validation (e.g., /dev/disk/by-id/scsi-* -> /dev/sda)
    DEVICE=$(readlink -f "$DEVICE" 2>/dev/null || echo "$DEVICE")

    # Validate device path: raw devices OR stable /dev/disk/by-id/ symlinks
    # DO: /dev/disk/by-id/scsi-0DO_Volume_*
    # Hetzner: /dev/disk/by-id/scsi-0HC_Volume_*
    # OVH: /dev/disk/by-id/virtio-*
    if [[ ! "$DEVICE" =~ ^/dev/(sd|vd|xvd|nvme)[a-z0-9]+$ ]] && \
       [[ ! "$DEVICE" =~ ^/dev/disk/by-id/(scsi|virtio)-[a-zA-Z0-9_-]+$ ]]; then
      echo '{"success":false,"error":"Invalid device path"}'
      exit 1
    fi

    # Wait for device to appear (cloud attach is async -- can take 30-60s under load)
    WAIT=0
    while [ ! -e "$DEVICE" ] && [ $WAIT -lt 60 ]; do
      sleep 1
      WAIT=$((WAIT + 1))
    done

    if [ ! -e "$DEVICE" ]; then
      echo "{\"success\":false,\"error\":\"Device ${DEVICE} not found after 60s\"}"
      exit 1
    fi

    # Already mounted?
    # If already mounted, check whether it SHOULD be LUKS but isn't.
    # Race condition fix: systemd may auto-mount from fstab as plain ext4
    # before the wake-mount command delivers the LUKS passphrase.
    # If we have a passphrase but the mount is NOT LUKS, unmount so we can
    # LUKS-format the device. Never silently accept a plain mount when LUKS was intended.
    if mountpoint -q "$SVC_HOME" 2>/dev/null; then
      CURRENT_SOURCE=$(findmnt -n -o SOURCE "$SVC_HOME" 2>/dev/null || echo "")
      if [ -n "${LUKS_PASSPHRASE:-}" ] && [ "$CURRENT_SOURCE" != "/dev/mapper/luks-home" ]; then
        echo "WARNING: volume mounted as plain ext4 but LUKS passphrase provided — unmounting for LUKS format" >&2
        umount "$SVC_HOME" 2>/dev/null || umount -l "$SVC_HOME" 2>/dev/null || true
        # Remove premature fstab entry so systemd doesn't re-mount plain ext4
        sed -i "\| ${SVC_HOME} |d" /etc/fstab 2>/dev/null || true
        systemctl daemon-reload 2>/dev/null || true
        # Fall through to LUKS format below
      else
        echo '{"success":true,"alreadyMounted":true}'
        exit 0
      fi
    fi

    # Check filesystem and label. Our mkfs uses -L ellul-home.
    # If label differs (or missing), volume was pre-formatted by cloud provider.
    FSTYPE=$(blkid -o value -s TYPE "$DEVICE" 2>/dev/null || echo "")
    LABEL=$(blkid -o value -s LABEL "$DEVICE" 2>/dev/null || echo "")
    FIRST_BOOT=false
    LUKS_OPENED=false
    MOUNT_DEVICE="$DEVICE"

    # LUKS_PASSPHRASE may be set by caller (wake-mount handler) after E2EE decryption.
    # If set, we use it for LUKS format (first boot) or LUKS open (wake).
    # If not set and volume is LUKS, bail — requires user PRF unlock via bridge.

    if [ "$FSTYPE" = "crypto_LUKS" ]; then
      # ── Stale LUKS mapping teardown ──
      # If LUKS is already open but the dm-crypt mapping is smaller than
      # the backing device, a provider-side volume grow happened after
      # the mapping was opened. cryptsetup/dmsetup cannot resize an
      # active mapping from a subprocess (per-process-session kernel
      # keyring limitation) — the only safe recovery is to tear down
      # the mapping and re-open it fresh. We can only do that when a
      # new LUKS_PASSPHRASE has been delivered in this wake-mount call.
      if [ -b /dev/mapper/luks-home ] && [ -n "${LUKS_PASSPHRASE:-}" ]; then
        _back_sz=$(blockdev --getsize64 "$DEVICE" 2>/dev/null || echo 0)
        _map_sz=$(blockdev --getsize64 /dev/mapper/luks-home 2>/dev/null || echo 0)
        if [ "$_back_sz" -gt 0 ] && [ "$_map_sz" -gt 0 ] && [ "$((_back_sz - _map_sz))" -gt 67108864 ]; then
          echo "Stale LUKS mapping detected (backing=$_back_sz mapping=$_map_sz) — tearing down for fresh luksOpen" >&2
          for _svc in ellul-agent-bridge ellul-file-api ellul-sovereign-shield caddy postgresql ellul-ide; do
            systemctl stop "$_svc" 2>/dev/null || true
          done
          for _vbm in $(awk '/ellul-vault.*bind/ {print $2}' /etc/fstab 2>/dev/null); do
            mountpoint -q "$_vbm" 2>/dev/null && umount -l "$_vbm" 2>/dev/null || true
          done
          fuser -kvm "$SVC_HOME" 2>/dev/null || true
          sleep 1
          sync
          umount "$SVC_HOME" 2>/dev/null || umount -l "$SVC_HOME" 2>/dev/null || true
          sed -i "\\| ${SVC_HOME} |d" /etc/fstab 2>/dev/null || true
          systemctl daemon-reload 2>/dev/null || true
          cryptsetup luksClose luks-home 2>/dev/null || true
        fi
      fi

      # ── EXISTING LUKS VOLUME ──
      if [ -b /dev/mapper/luks-home ]; then
        # Already opened (e.g., by PRF unlock before mount script was called)
        LUKS_OPENED=true
        MOUNT_DEVICE="/dev/mapper/luks-home"
      elif [ -z "${LUKS_PASSPHRASE:-}" ]; then
        # No passphrase and not already open — sovereign mode or missing key
        echo '{"success":false,"luksDetected":true,"error":"LUKS volume detected — requires passkey unlock or platform key delivery"}'
        exit 0
      else
        echo "Opening LUKS2 volume..." >&2
        # Try slot 1 first (platform recovery key, pbkdf2 — fast).
        # Slot 0 may be PRF-derived (argon2id) which can OOM on low-memory hosts.
        if printf '%s' "$LUKS_PASSPHRASE" | cryptsetup luksOpen --key-file=- --key-slot 1 "$DEVICE" luks-home 2>/dev/null; then
          true  # slot 1 succeeded
        else
          printf '%s' "$LUKS_PASSPHRASE" | cryptsetup luksOpen --key-file=- "$DEVICE" luks-home >&2
        fi
        LUKS_OPENED=true
        MOUNT_DEVICE="/dev/mapper/luks-home"

        # ── Inline dm-crypt mapping grow (same process, same passphrase) ──
        # LUKS2 with a dynamic data segment SHOULD create a mapping
        # covering the full current device size at luksOpen time, but
        # in practice some cryptsetup+kernel combinations produce a
        # smaller mapping when the device has been grown since the
        # header was written. Force-resize using --key-file to pass
        # the passphrase directly: cryptsetup derives the volume key
        # from the passphrase rather than looking it up in the kernel
        # keyring (which is per-process-session and unreachable from
        # a separate subprocess). This is the single moment we hold
        # both the key AND live bash context, so we do it here.
        if [ -b /dev/mapper/luks-home ]; then
          _back_sz_open=$(blockdev --getsize64 "$DEVICE" 2>/dev/null || echo 0)
          _map_sz_open=$(blockdev --getsize64 /dev/mapper/luks-home 2>/dev/null || echo 0)
          if [ "$_back_sz_open" -gt 0 ] && [ "$_map_sz_open" -gt 0 ] \
             && [ "$((_back_sz_open - _map_sz_open))" -gt 67108864 ]; then
            echo "Inline cryptsetup resize: mapping=$_map_sz_open backing=$_back_sz_open" >&2
            _keytmp=$(mktemp /dev/shm/.luks-resize-XXXXXX 2>/dev/null || echo "/dev/shm/.luks-resize-$$")
            (umask 077 && printf '%s' "$LUKS_PASSPHRASE" > "$_keytmp")
            if cryptsetup --batch-mode resize --key-file="$_keytmp" luks-home >&2 2>&1; then
              echo "Inline cryptsetup resize: ok" >&2
            else
              echo "Inline cryptsetup resize: FAILED (filesystem will stay at old size)" >&2
            fi
            shred -u "$_keytmp" 2>/dev/null || rm -f "$_keytmp"
          fi
        fi
      fi

      # Zeroize passphrase from environment immediately
      unset LUKS_PASSPHRASE

    elif [ -z "$FSTYPE" ] && [ -n "${LUKS_PASSPHRASE:-}" ]; then
      # ── RAW DEVICE + PASSPHRASE — LUKS FORMAT (FIRST BOOT) ──
      FIRST_BOOT=true
      SKEL_TMP="/var/tmp/skel-backup-$$"
      mkdir -p "$SKEL_TMP" && chmod 700 "$SKEL_TMP"
      cp -a "${SVC_HOME}/." "$SKEL_TMP/"

      echo "Formatting LUKS2 volume (AEAD)..." >&2
      printf '%s' "$LUKS_PASSPHRASE" | cryptsetup luksFormat \
        --type luks2 \
        --cipher aes-xts-plain64 \
        --key-size 512 \
        --hash sha256 \
        --pbkdf argon2id --pbkdf-memory 262144 --pbkdf-parallel 2 \
        --key-file=- \
        --batch-mode \
        "$DEVICE" >&2

      printf '%s' "$LUKS_PASSPHRASE" | cryptsetup luksOpen --key-file=- "$DEVICE" luks-home >&2
      LUKS_OPENED=true
      MOUNT_DEVICE="/dev/mapper/luks-home"

      # Zeroize passphrase from environment immediately
      unset LUKS_PASSPHRASE

      mkfs.ext4 -L ellul-home "$MOUNT_DEVICE" >&2

    elif [ "$FSTYPE" = "ext4" ] && [ -n "${LUKS_PASSPHRASE:-}" ]; then
      # ── EXT4 DEVICE + PASSPHRASE — WIPE AND LUKS FORMAT ──
      # Race condition recovery: the device was auto-mounted/formatted as plain ext4
      # (by systemd fstab or a failed prior attempt) but LUKS was intended.
      # Wipe the ext4 header and LUKS-format. Data loss is acceptable here because
      # this only happens on first boot (no user data yet).
      FIRST_BOOT=true
      SKEL_TMP="/var/tmp/skel-backup-$$"
      mkdir -p "$SKEL_TMP" && chmod 700 "$SKEL_TMP"
      cp -a "${SVC_HOME}/." "$SKEL_TMP/"

      echo "WARNING: wiping existing ext4 for LUKS format (first boot race recovery)" >&2
      wipefs -a "$DEVICE" >&2 2>/dev/null || true

      echo "Formatting LUKS2 volume (AEAD)..." >&2
      printf '%s' "$LUKS_PASSPHRASE" | cryptsetup luksFormat \
        --type luks2 \
        --cipher aes-xts-plain64 \
        --key-size 512 \
        --hash sha256 \
        --pbkdf argon2id --pbkdf-memory 262144 --pbkdf-parallel 2 \
        --key-file=- \
        --batch-mode \
        "$DEVICE" >&2

      printf '%s' "$LUKS_PASSPHRASE" | cryptsetup luksOpen --key-file=- "$DEVICE" luks-home >&2
      LUKS_OPENED=true
      MOUNT_DEVICE="/dev/mapper/luks-home"

      unset LUKS_PASSPHRASE

      mkfs.ext4 -L ellul-home "$MOUNT_DEVICE" >&2

    elif [ -z "$FSTYPE" ]; then
      # ── RAW DEVICE, NO PASSPHRASE — PLAIN EXT4 (LEGACY FIRST BOOT) ──
      FIRST_BOOT=true
      SKEL_TMP="/var/tmp/skel-backup-$$"
      mkdir -p "$SKEL_TMP" && chmod 700 "$SKEL_TMP"
      cp -a "${SVC_HOME}/." "$SKEL_TMP/"
      mkfs.ext4 -L ellul-home "$DEVICE" >&2

    elif [ "$LABEL" != "ellul-home" ]; then
      # Pre-formatted by cloud provider -- reformat with skeleton
      FIRST_BOOT=true
      SKEL_TMP="/var/tmp/skel-backup-$$"
      mkdir -p "$SKEL_TMP" && chmod 700 "$SKEL_TMP"
      cp -a "${SVC_HOME}/." "$SKEL_TMP/"
      mkfs.ext4 -L ellul-home "$DEVICE" >&2
    fi

    # nosuid: prevent setuid binaries on user volumes (privilege escalation)
    # nodev: prevent device nodes on user volumes
    # Race with systemd fstab auto-mount: opening LUKS creates /dev/mapper/luks-home,
    # which fires a udev event, which triggers systemd's home-dev.mount unit (from
    # fstab). That unit may mount SVC_HOME from the same device before — or
    # concurrently with — our explicit mount call. Both `mountpoint -q` AND the
    # subsequent `mount` call race against systemd; only checking once is not enough.
    #
    # Pattern (mirrors ellul-luks-boot): try once, on failure re-check mountpoint
    # after a brief sleep, treat a concurrent-systemd mount as success, only emit
    # a structured JSON error + exit 1 if SVC_HOME is still not mounted. Mount's
    # stderr is captured to a file so the message survives into the error report
    # without polluting stdout (which the caller parses as a single JSON blob).
    if mountpoint -q "$SVC_HOME" 2>/dev/null; then
      echo "Volume already mounted by systemd (fstab race, detected pre-mount)" >&2
    else
      _mount_err_file=$(mktemp /tmp/.mount-volume-err.XXXXXX)
      if mount -o nosuid,nodev "$MOUNT_DEVICE" "$SVC_HOME" 2>"$_mount_err_file"; then
        rm -f "$_mount_err_file"
      else
        _mount_err=$(tr '\n' ' ' <"$_mount_err_file" 2>/dev/null | sed 's/[[:space:]]*$//')
        rm -f "$_mount_err_file"
        sleep 1
        if mountpoint -q "$SVC_HOME" 2>/dev/null; then
          echo "Volume mounted by systemd between check and mount (race confirmed): ${_mount_err}" >&2
        else
          # Real mount failure — emit the same JSON shape the ERR trap would
          # have produced, so the caller's error message is informative rather
          # than an empty "mount script failed: ". Escape double quotes and
          # backslashes for safe JSON embedding.
          _err_json=$(printf '%s' "$_mount_err" | sed 's/\\/\\\\/g; s/"/\\"/g')
          echo "{\"success\":false,\"error\":\"mount $MOUNT_DEVICE at $SVC_HOME failed: ${_err_json}\"}"
          exit 1
        fi
      fi
    fi

    # ── Online ext4 grow (guest-side resize) ──
    # After any successful LUKS mount, extend ext4 to fill the dm-crypt
    # mapping. This is idempotent: resize2fs is a no-op when the
    # filesystem already matches the mapping size, and costs
    # milliseconds on that path. On a provider-grown volume (the
    # inline cryptsetup resize above just enlarged the mapping), this
    # is the step that actually makes the new space usable.
    #
    # Output is redirected to stderr to keep the script's stdout clean
    # for the single-line JSON response the caller parses.
    if [ "$LUKS_OPENED" = "true" ] && mountpoint -q "$SVC_HOME" 2>/dev/null; then
      if resize2fs "$MOUNT_DEVICE" >&2 2>&1; then
        echo "Online ext4 grow: resize2fs ok (idempotent)" >&2
      else
        echo "Online ext4 grow: resize2fs FAILED (non-fatal)" >&2
      fi
    fi

    if [ "$FIRST_BOOT" = "true" ]; then
      cp -a "$SKEL_TMP/." "$SVC_HOME/"
      rm -rf "$SKEL_TMP"
    fi

    # Fix ownership (exclude vault — root:root 700)
    chown ${SVC_USER}:${SVC_USER} "$SVC_HOME"
    find "$SVC_HOME" -mindepth 1 -maxdepth 1 ! -name '.ellul-vault' \
      -exec chown -R ${SVC_USER}:${SVC_USER} {} +
    [ -d "$SVC_HOME/.ssh" ] && chmod 700 "$SVC_HOME/.ssh"

    # Persist mount across reboots (with nosuid,nodev)
    # For LUKS volumes, fstab uses the mapper device
    # Check for mount point (not device) to avoid duplicates when device path
    # differs between callers (e.g. /dev/sdb vs /dev/disk/by-id/scsi-...)
    if [ "$LUKS_OPENED" = "true" ]; then
      if ! grep -q "luks-home" /etc/fstab 2>/dev/null; then
        echo "/dev/mapper/luks-home ${SVC_HOME} ext4 defaults,nosuid,nodev,nofail 0 2" >> /etc/fstab
      fi
    elif ! grep -q " ${SVC_HOME} " /etc/fstab 2>/dev/null; then
      echo "$DEVICE ${SVC_HOME} ext4 defaults,nosuid,nodev,nofail 0 2" >> /etc/fstab
    fi
