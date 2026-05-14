# Watchdog

HTTP server on port 7710. Two responsibilities: interactive CLI auth sessions (PTY-wrapped) and OpenClaw lifecycle reporting.

Source: `packages/vps/src/services/daemons/watchdog/index.ts`.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Service health |
| `GET /zeroclaw/status` | Per-project OpenClaw daemon status |
| `POST /agents/auth/start` | Spawn interactive CLI auth session |
| `GET /agents/auth/{id}/events` | SSE stream of session output |
| `POST /agents/auth/{id}/input` | Write user paste to session stdin |
| `POST /agents/auth/{id}/cancel` | Kill session |
| `POST /agents/auth-status` | Check whether tools have stored credentials |

## Auth session flow

User wants to authenticate Claude Code. Browser triggers:

```
1. Browser: POST /agents/auth/start { "tool": "claude" }
   ↓
2. Watchdog spawns:
     script -qfc "claude setup-token" /dev/null
   This runs Claude under a PTY (so prompts work).
   ↓
3. Claude prints "Visit https://... and paste code:"
   ↓
4. Browser: GET /agents/auth/{sessionId}/events (SSE)
   ↓ (server streams)
   { type: "data", chunk: "Visit https://claude.ai/...\nCode: " }
   ↓
5. User visits URL, gets code, pastes into browser.
   ↓
6. Browser: POST /agents/auth/{sessionId}/input { "data": "<token>" }
   ↓
7. Watchdog writes to PTY stdin. Claude validates and stores in ~/.claude.json.
   ↓
8. Claude exits. SSE: { type: "exit", exitCode: 0 }.
   ↓
9. Session reaped after 10s.
```

Sessions stored in an in-memory `AUTH_SESSIONS` map. TTL: 15 minutes.

## OpenClaw status

Polls agent-bridge `/api/internal/daemon-health` to get per-project OpenClaw daemon status. Reports:

- `online` — daemon responsive.
- `idle` — daemon up but not active.
- `offline` — daemon not running.
- `not_installed` — zeroclaw binary missing.

Used by dashboard to show per-project agent activity.

## Service unit

```ini
[Unit]
After=ellul-sovereign-shield.service
Wants=ellul-luks-boot.service

[Service]
User=dev
Group=dev
EnvironmentFile=/etc/ellul/heap-caps/watchdog.env
Environment=PORT=7710
ExecStart=/home/dev/.node/bin/node /usr/local/bin/ellul-watchdog
Restart=on-failure
ProtectSystem=strict
NoNewPrivileges=true
LimitCORE=0
```

## What watchdog does NOT do

- It does not enforce policy. (Enforcer does.)
- It does not relay chat messages. (Agent-bridge does.)
- It does not directly run agent code. (Namespace runner does.)

It's a thin HTTP shim for interactive auth + status reporting.

## Cross-references

- Enforcer: [01-enforcer.md](./01-enforcer.md).
- Agent-bridge: [03-agent-bridge.md](./03-agent-bridge.md).
