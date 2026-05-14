# Service health

The enforcer monitors critical services and restarts failures.

Source: `packages/vps/src/services/daemons/enforcer/lib/services.sh`. Triggered every 2 cycles (~60s) by the main heartbeat loop.

## Monitored services

| Service | Why monitor |
| --- | --- |
| `caddy` | Reverse proxy; if down, all customer traffic 503s |
| `ellul-sovereign-shield` | Auth; if down, no logins |
| `ellul-file-api` | Code browser; if down, dashboard limited |
| `ellul-agent-bridge` | Chat; if down, no agent interaction |
| `ellul-term-proxy` | Terminal; if down, no shell access |
| `ellul-watchdog` | Auth sessions; if down, can't enroll new tools |
| `postgresql` | App DBs; if down, app queries fail |

## Check loop

```bash
SERVICES=(
  caddy
  ellul-sovereign-shield
  ellul-file-api
  ellul-agent-bridge
  ellul-term-proxy
  ellul-watchdog
  postgresql
)

for svc in "${SERVICES[@]}"; do
  if ! systemctl is-active --quiet "$svc"; then
    log "Service $svc DOWN — restarting"
    systemctl reset-failed "$svc"
    systemctl restart "$svc"
  fi
done
```

`reset-failed` clears any "burst limit reached" state (systemd may have given up on auto-restart).

## Special handling for Shield

Shield's startup can fail intermittently (better-sqlite3 native init, slow disks, vault not mounted). Restart logic:

```bash
restart_shield_with_retry() {
  for attempt in 1 2 3; do
    systemctl restart ellul-sovereign-shield.service
    sleep 5
    if systemctl is-active --quiet ellul-sovereign-shield.service; then
      log "Shield up after attempt $attempt"
      regenerate_caddyfile_if_needed
      return 0
    fi
    log "Shield restart attempt $attempt failed, retrying..."
    sleep $((attempt * 5))
  done
  log_critical "Shield failed to start after 3 attempts"
  return 1
}
```

After Shield comes up, regenerate Caddyfile (might still be in lockdown mode).

## PostgreSQL recovery

PostgreSQL has special handling because of WAL recovery:

```bash
check_postgresql() {
  # Ensure socket dir exists
  mkdir -p /var/run/postgresql
  chown postgres:postgres /var/run/postgresql
  chmod 2775 /var/run/postgresql
  
  if ! systemctl is-active --quiet postgresql; then
    systemctl reset-failed postgresql
    systemctl start postgresql
    
    # Wait up to 30s for pg_isready
    for i in $(seq 1 30); do
      if sudo -u postgres pg_isready -q; then
        log "PostgreSQL up"
        return 0
      fi
      sleep 1
    done
    
    log "PostgreSQL not ready after 30s"
  fi
}
```

The WAL recovery hook (`/usr/local/bin/ellul-pg-recovery`) runs as ExecStartPre on the postgresql unit; if WAL is corrupted, it runs `pg_resetwal -f` before Postgres starts. See [../storage/05-postgresql.md](../storage/05-postgresql.md).

## Boot stale-service detection

A subtle issue: services started during a Hetzner resize or cloud-init re-run might bind FDs against the root filesystem before vault is mounted. After the vault mount, those FDs reference now-hidden paths.

Detection:

```bash
detect_stale_services() {
  vault_mount_time=$(stat -c %Y /home/dev/.ellul-vault/.initialized)
  
  for svc in "${SERVICES[@]}"; do
    pid=$(systemctl show -p MainPID --value "$svc")
    if [ -z "$pid" ] || [ "$pid" -eq 0 ]; then continue; fi
    
    # Get process start time
    start_time=$(stat -c %Y /proc/$pid)
    
    if [ "$start_time" -lt "$vault_mount_time" ]; then
      log "Service $svc started before vault mount — restarting (stale FDs)"
      systemctl restart "$svc"
    fi
  done
}
```

Runs once at enforcer startup.

## When Shield dies

If Shield crashes or fails to start:

- `/_auth/session` requests return 502 (forward_auth backend down).
- Caddy's `handle_errors` block returns "Server unavailable" page.
- All protected routes effectively 503.
- Login is impossible.
- Enforcer continues; no lockdown of customer.

The enforcer's restart loop (3 attempts) is the recovery mechanism. If still failing, manual investigation needed.

## When PostgreSQL dies

App queries via Shield's query proxy fail. App-level errors propagate to customer.

Enforcer auto-restarts. WAL recovery hook handles corruption. Customer sees ~30-60s of DB errors during restart.

## When Caddy dies

All customer traffic on 443 fails.

Enforcer restarts. Customer sees ~5-10s of timeouts.

## When agent-bridge dies

Chat WebSockets drop. Browser reconnects on its own (with backoff).

Enforcer restarts. Customer sees brief chat interruption.

## Cross-references

- Caddy: [../networking/04-caddy.md](../networking/04-caddy.md).
- Shield resilience: [05-sovereign-shield-deep.md](./05-sovereign-shield-deep.md).
- Service inventory: [../architecture/03-vps-services.md](../architecture/03-vps-services.md).
