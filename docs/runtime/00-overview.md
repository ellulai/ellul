# Runtime overview

The long-lived processes on a VPS. Each runs as a systemd service with a specific role.

For inventory and ports: [../architecture/03-vps-services.md](../architecture/03-vps-services.md).

## Daemons by role

| Role | Service | User | Source |
| --- | --- | --- | --- |
| Reverse proxy | caddy | caddy | provisioned |
| Auth + gates | sovereign-shield | shield-runner | `packages/vps/src/services/auth/sovereign-shield/` |
| Code browser, file ops | file-api | dev | `packages/vps/src/services/backends/file-api/` |
| Chat WebSocket, CLI | agent-bridge | dev | `packages/vps/src/services/backends/agent-bridge/` |
| Terminal multiplexer | term-proxy | dev | `packages/vps/src/services/gateway/term-proxy/` |
| State engine | enforcer | root | `packages/vps/src/services/daemons/enforcer/` |
| Auth sessions, OpenClaw | watchdog | dev | `packages/vps/src/services/daemons/watchdog/` |
| Persistent agent memory | gbrain | root | `/opt/ellul/gbrain/` (opt-in, 8GB+) |

## Pages

- [01-enforcer.md](./01-enforcer.md) — bash daemon: heartbeat, command queue, vault management.
- [02-watchdog.md](./02-watchdog.md) — interactive auth sessions, OpenClaw lifecycle.
- [03-agent-bridge.md](./03-agent-bridge.md) — chat WebSocket, namespace spawning.
- [04-file-api.md](./04-file-api.md) — file ops, preview management, real-time events.
- [05-sovereign-shield-deep.md](./05-sovereign-shield-deep.md) — endpoints, internals.
- [06-direct-commands.md](./06-direct-commands.md) — exhaustive list of DIRECT command types.
- [07-heartbeat-protocol.md](./07-heartbeat-protocol.md) — request/response/signing format.
- [08-service-health.md](./08-service-health.md) — monitoring, restart logic.
- [09-code-mode.md](./09-code-mode.md) — code mode / dev environment.
- [10-app-management.md](./10-app-management.md) — app lifecycle.
- [11-gbrain.md](./11-gbrain.md) — persistent agent memory (opt-in, by Garry Tan).
- [12-gstack.md](./12-gstack.md) — AI coding agent skill pack (opt-in, by Garry Tan).
