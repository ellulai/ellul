
    # ── VAULT RESTORE ──
    # If the volume has a vault from a previous server, restore bind mounts
    # so all system state (auth DB, Caddy config, iptables) is live.
    # Identity files live on /etc/ellul-bootstrap/ (boot partition, never
    # vault-bound), so vault restore is always safe — no identity deadlock.
    VAULT="$SVC_HOME/.ellul-vault"
    VAULT_RESTORED=false
    if [ -f "$VAULT/.initialized" ] && [ "$FIRST_BOOT" != "true" ]; then
      echo "Restoring vault from volume..." >&2

      # Restore UID/GID map (users may not exist on this fresh server)
      if [ -f "$VAULT/.gid-map" ]; then
        while IFS=: read -r _type _name _id; do
          case "$_type" in
            g) getent group "$_name" >/dev/null 2>&1 || groupadd --gid "$_id" "$_name" 2>/dev/null || groupadd --system --gid "$_id" "$_name" 2>/dev/null || true ;;
            u) id -u "$_name" >/dev/null 2>&1 || useradd --system --uid "$_id" --no-create-home --shell /usr/sbin/nologin "$_name" 2>/dev/null || true ;;
          esac
        done < "$VAULT/.gid-map"
      fi

      # Create mount points and bind-mount vault → system paths
      mkdir -p /etc/ellul /etc/caddy /etc/iptables /etc/ssh/authorized_keys
      chown root:shield /etc/ssh/authorized_keys
      chmod 770 /etc/ssh/authorized_keys
      mkdir -p /var/lib/ellul-shielded /var/lib/ellul.ai /var/lib/postgresql
      mkdir -p /var/log/ellul /var/log/caddy /opt/ellul

      for _vpath in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys var/lib/ellul-shielded var/lib/ellul.ai var/log/ellul var/log/caddy opt/ellul; do
        if [ -d "$VAULT/$_vpath" ] && ! mountpoint -q "/$_vpath" 2>/dev/null; then
          # Seed-before-mount: if vault is empty but root FS has content,
          # merge first. This is the safety net for the "wrote to root FS
          # before bind mount activated" failure mode — without it the
          # root-FS content gets hidden by the bind mount on next boot
          # and the user sees their data disappear (notably SSH keys at
          # /etc/ssh/authorized_keys/<user>, which is exactly what bit
          # us in 2026-04 — see setup-ssh-key.sh for the corresponding
          # write-time fix).
          _vc=$(ls -A "$VAULT/$_vpath" 2>/dev/null | wc -l)
          _rc=$(ls -A "/$_vpath" 2>/dev/null | wc -l)
          if [ "$_vc" -eq 0 ] && [ "$_rc" -gt 0 ]; then
            cp -a "/$_vpath/." "$VAULT/$_vpath/" 2>/dev/null || true
            echo "Merged root FS → vault for /$_vpath" >&2
          elif [ "$_vc" -gt 0 ] && [ "$_rc" -gt 0 ]; then
            # Both populated — vault wins, but copy any FILES the root
            # FS has that the vault doesn't (e.g. a freshly-added SSH
            # key from a buggy provisioner that wrote to /etc/ssh/...
            # while the bind mount was inactive). cp -an = no-clobber,
            # so existing vault entries are preserved.
            cp -an "/$_vpath/." "$VAULT/$_vpath/" 2>/dev/null || true
          fi
          mount --bind "$VAULT/$_vpath" "/$_vpath" 2>/dev/null || true
        fi
      done
      # PostgreSQL bind mount (consistent with enforcer's bind_mount_vault)
      [ -d "$VAULT/var/lib/postgresql" ] && ! mountpoint -q /var/lib/postgresql 2>/dev/null && \
        mount --bind "$VAULT/var/lib/postgresql" /var/lib/postgresql 2>/dev/null || true

      # Re-chown for current server UIDs
      chown root:root /etc/ellul 2>/dev/null; chmod 755 /etc/ellul 2>/dev/null
      [ -f /etc/ellul-bootstrap/node.key ] && chown root:shield /etc/ellul-bootstrap/node.key 2>/dev/null && chmod 640 /etc/ellul-bootstrap/node.key 2>/dev/null
      [ -f /etc/ellul/jwt-secret ] && chown root:shield-ipc /etc/ellul/jwt-secret 2>/dev/null && chmod 640 /etc/ellul/jwt-secret 2>/dev/null
      [ -f /etc/ellul-bootstrap/ai-proxy-token ] && chown root:shield /etc/ellul-bootstrap/ai-proxy-token 2>/dev/null && chmod 640 /etc/ellul-bootstrap/ai-proxy-token 2>/dev/null
      [ -d /etc/ellul/shield-data ] && chown shield-runner:shield-ipc /etc/ellul/shield-data 2>/dev/null && chmod 2710 /etc/ellul/shield-data 2>/dev/null
      chown -R caddy:caddy /etc/caddy 2>/dev/null; chmod 2770 /etc/caddy 2>/dev/null
      chown root:shield /var/lib/ellul-shielded 2>/dev/null; chmod 2770 /var/lib/ellul-shielded 2>/dev/null
      chown -R postgres:postgres /var/lib/postgresql 2>/dev/null; chmod 700 /var/lib/postgresql 2>/dev/null

      # Restore iptables
      [ -f /etc/iptables/rules.v4 ] && [ -s /etc/iptables/rules.v4 ] && \
        iptables-restore < /etc/iptables/rules.v4 2>/dev/null || true
      [ -f /etc/iptables/rules.v6 ] && ip6tables-restore < /etc/iptables/rules.v6 2>/dev/null || true

      # Restart services to pick up restored config.
      #
      # CRITICAL: --no-block is mandatory here. This script runs as part of
      # ellul-luks-boot.service. The services listed below have
      # `After=ellul-luks-boot.service` in their unit files. A blocking
      # `systemctl restart` would wait for them to finish starting, but
      # they can't start until luks-boot finishes — classic ordering-cycle
      # deadlock. systemd resolves it by hitting the 180s
      # TimeoutStartSec on luks-boot, leaving every dependent service
      # delayed by 3 minutes per boot.
      #
      # Pre-fix: every reboot took ~3 min for caddy to come back; the
      # OOM-loop reboot of 2026-04-21 cascaded ~19 min of 503s.
      # Post-fix: luks-boot returns immediately; caddy/shield/postgres
      # start as soon as the After= ordering allows (~1-2s after vault
      # mount completes), and any restart we queue here for already-
      # running services lands in parallel without blocking us.
      #
      # If a service isn't currently active, we don't queue a restart at
      # all — the `After=` chain will start it cleanly. Restarts are only
      # for the wake-from-hibernation case where services already started
      # against pre-vault state and need a re-read.
      for svc in ellul-sovereign-shield caddy postgresql; do
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
          systemctl restart --no-block "$svc" 2>/dev/null || true
        fi
      done

      VAULT_RESTORED=true
      echo "Vault restored" >&2
    fi
