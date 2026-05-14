# Enforcer

The state engine of the VPS. Bash daemon assembled from modular libraries. Runs as root. Heartbeats every 30 seconds.

Source: `packages/vps/src/services/daemons/enforcer/lib/*.sh`. Bundle: `packages/vps/src/services/daemons/enforcer/bundle.ts`.

## What enforcer does

Twelve responsibilities, in roughly this order on each cycle:

1. **Pet systemd watchdog.** Without this, systemd would restart the service.
2. **Self-heal namespace iptables.** Reconcile per-project allow rules in `ELLUL-NS-IN/OUT` chains.
3. **Collect worker results.** Background jobs (block-migrate, etc.) report completion.
4. **Heartbeat.** POST telemetry to API. Fetch entitlements, manifest, command queue.
5. **Liveness ping** (every N ticks). Independent of manifest sync.
6. **Service health check** (every 2 cycles). Restart failing services.
7. **Process command queue.** Fetch, verify, execute, report.
8. **Apply pending agent updates.** If a manifest is staged and conditions met, apply.
9. **Identity check.** `/etc/ellul/owner.lock` mismatch triggers lockdown.
10. **Burst mode.** If commands processed, skip sleep and re-poll.
11. **Deferred restart.** For commands like `update-identity` that require enforcer restart.
12. **Interruptible sleep.** SIGUSR1 wakes immediately.

## Modular libraries

Each library is a self-contained bash file:

| Library | Role |
| --- | --- |
| `constants.sh` | Env vars, paths, intervals |
| `logging.sh` | Structured logging |
| `terminals.sh` | TTY/PTY session management |
| `security.sh` | Tier detection, identity pinning |
| `status.sh` | System reporting (RAM, CPU, disk) |
| `enforcement.sh` | Settings application, kill orders |
| `deployment.sh` | Deployment model switching |
| `agents.sh` | OpenClaw daemon telemetry |
| `block-migrate.sh` | Block migration upload/download |
| `capabilities.sh` | Capability advertisement |
| `agent-sync.sh` | Manifest fetch, signature verification, atomic apply |
| `heartbeat.sh` | Main heartbeat loop |
| `services.sh` | Service health monitoring |

The `bundle.ts` file concatenates these into a single `ellul-env` script at build time.

## Boot sequence

```bash
run_daemon() {
  seed_baseline_release          # for self-update rollback
  recover_from_crash             # check pending-commit marker
  validate_applied_releases      # .applied-stable markers
  
  luks_recovery                  # in case wake-mount didn't complete
  bind_mount_vault_if_needed
  
  enforce_startup_settings       # SSH/terminal enable
  validate_full_service_stack    # boot validation
  
  signal_systemd_ready           # Type=notify
  
  while true; do
    pet_watchdog
    namespace_iptables_self_heal
    collect_worker_results
    heartbeat
    liveness_ping_if_due
    service_health_check_if_due
    process_command_burst
    interruptible_sleep
  done
}
```

## Identity pinning

`/etc/ellul/owner.lock` is written once at provisioning with `chattr +i`:

```
owner=<cloud-server-id>
created=2026-04-25T10:00:00Z
```

On each heartbeat, enforcer reads this file. If `owner` doesn't match the current `$CLOUD_SERVER_ID`, increment failure counter. After 5 mismatches:

```bash
EMERGENCY_LOCKDOWN_FAILURES=5
if [ $FAIL_COUNT -ge $EMERGENCY_LOCKDOWN_FAILURES ]; then
  log_critical "Identity mismatch — emergency lockdown"
  systemctl isolate rescue.target
fi
```

This catches volume-attached-to-different-server attacks.

## Kill orders

API can request session/port termination via DIRECT commands or via heartbeat command queue:

- `kill-session <sessionId>` — terminate user sessions for that ID.
- `kill-port <number>` — kill processes listening on the given port.
- `lockdown` — emergency: kill all sessions, disable SSH.

## Service health monitoring

Every 2 cycles (60s):

```bash
for svc in caddy ellul-sovereign-shield ellul-file-api ellul-agent-bridge \
           ellul-term-proxy postgresql; do
  if ! systemctl is-active --quiet "$svc"; then
    log "Service $svc DOWN — restarting"
    systemctl restart "$svc"
  fi
done
```

If shield is down, restart with retry (3 attempts, exponential backoff).

## Self-update flow

The enforcer applies its own updates via `agent-sync.sh`. After applying ALL other components, the LAST step is self-update:

```bash
# Run the NEW ellul-env with --self-test
bash /opt/ellul/releases/ellul-env/current/ellul-env --self-test

# If success, exec the new version (replaces PID 1 inside systemd notify)
exec /opt/ellul/releases/ellul-env/current/ellul-env "$@"
```

Self-test verifies the new version starts and signals systemd Ready before the old version is replaced. If self-test fails, rollback.

For the full apply flow: [../operations/03-hot-shipping.md](../operations/03-hot-shipping.md).

## Cross-references

- Heartbeat protocol: [07-heartbeat-protocol.md](./07-heartbeat-protocol.md).
- DIRECT commands: [06-direct-commands.md](./06-direct-commands.md).
- Service health: [08-service-health.md](./08-service-health.md).
- Manifest system: [../operations/02-manifest-system.md](../operations/02-manifest-system.md).
