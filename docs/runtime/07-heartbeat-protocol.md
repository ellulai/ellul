# Heartbeat protocol

Source: `packages/vps/src/services/daemons/enforcer/lib/heartbeat.sh:134-235`.

## Overview

Every 30 seconds, the enforcer POSTs telemetry to `/api/servers/heartbeat` on the API. The response is **entirely discarded** — the VPS does not trust API responses for state changes. Commands flow through a separate signed-envelope queue.

## Request

```
POST /api/servers/heartbeat
Authorization: Bearer <ai-proxy-token>
X-Heartbeat-Signature: <ML-DSA-44 signature of body>
X-Heartbeat-Timestamp: <unix seconds>
X-Server-Id: <server-id>
X-Heartbeat-Public-Key: <base64 of heartbeat.pub.json>  # first-write-wins registration
Content-Type: application/json

{
  "activeSessions": [
    { "name": "main", "port": 7710, "createdAt": 1714032000 }
  ],
  "deployments": [
    { "appId": "sbx-abc", "status": "running", "port": 4012 }
  ],
  "ramUsage": 0.42,
  "cpuUsage": 0.12,
  "diskUsage": 0.55,
  "diskPgUsage": 0.10,
  "securityTier": "web_locked",
  "sshKeyCount": 2,
  "open_ports": [443, 22, 7710],
  "currentTag": "c0a80001",
  "localTerminalEnabled": true,
  "localSshEnabled": true,
  "secretsLocal": true,
  "auditChainHead": { "seq": 12345, "hash": "..." },
  "agentStatus": [
    { "project": "sbx-abc", "daemon": "online" }
  ],
  "bootValidationFailures": [],
  "pgRecoveryEvents": [],
  "securityViolations": 0,
  "securityCritical": 0,
  "securityWarning": 0,
  "securityDegraded": false
}
```

## Authentication

Two layers:

1. **Bearer token.** `ai-proxy-token` from `/etc/ellul-bootstrap/ai-proxy-token`. API verifies token matches stored hash.
2. **ML-DSA-44 signature.** Body hashed and signed with `heartbeat.key`. API verifies with the registered `heartbeatPublicKey`.

The signature is the strong binding — even if the bearer token is leaked, the attacker cannot forge a valid signature without the private key.

First-write-wins registration: the very first heartbeat from a new server includes `X-Heartbeat-Public-Key`. API stores it. Subsequent heartbeats are verified against this key. After first registration, the header is no longer needed.

## Response

```
HTTP/1.1 200 OK
Content-Type: application/json

(body discarded by VPS)
```

The VPS posts and immediately closes the connection. It does not parse the response body for instructions. This is a security guarantee: even an evil API cannot inject commands via heartbeat response.

But the VPS does check status code:

```bash
if curl_status -eq 200; then
  log "heartbeat ok"
  reset_failure_counter
else
  log "heartbeat failed: $curl_status"
  increment_failure_counter
fi
```

## Discarded response is intentional

Why not parse the response for desired-state? Because:

- Allowing API-driven config changes via heartbeat means a compromised API can force VPS-side mutations.
- Forcing all mutations through the signed command queue (with ML-DSA-65 verification) means a compromised API still cannot inject commands without the platform signing key (which is in Cloud Secret Manager, not on Cloud Run instances).

So the heartbeat is unidirectional telemetry. Commands are bidirectional but signed.

## Liveness ping (separate)

A lightweight ping runs every N ticks (default 3 = ~30s) regardless of heartbeat success:

```
GET /api/servers/agent-ping
Authorization: Bearer <token>
```

Used for "last seen" timestamp on dashboard. Independent of manifest sync — even if heartbeat fails (e.g., temporary KV issue), liveness still updates.

API can return a tick-override:

```
{ "tickInterval": 60 }
```

VPS persists override in `/etc/ellul/shield-data/.agent-ping-tick`. Used for high-density fleets where 30s is too aggressive.

## Command queue polling

After successful heartbeat, enforcer polls:

```
GET /api/servers/commands
Authorization: Bearer <token>
X-Server-Id: <id>
```

Response:

```json
{
  "commands": [
    {
      "id": "cmd-abc-123",
      "type": "wake-mount",
      "payload": "...",
      "_signed": {...},
      "_e2ee": true
    }
  ]
}
```

Empty array when no commands pending.

## Commands chained on heartbeat

After processing commands, enforcer fetches:

1. **Entitlements manifest.** `GET /api/servers/entitlements` (304 on cache hit).
2. **Agent manifest.** `GET /api/servers/agent-manifest/current?If-None-Match=version=N` (304 on cache hit).

Both also signed with ML-DSA-65.

## Burst mode

If commands were processed this cycle, enforcer skips sleep and re-polls:

```bash
if [ "$COMMANDS_PROCESSED" = "true" ]; then
  BURST_COUNT=$((BURST_COUNT + 1))
  if [ $BURST_COUNT -lt $MAX_BURSTS ]; then
    continue   # immediate re-loop
  fi
fi
```

`MAX_BURSTS = 10` prevents infinite loops if commands keep generating commands.

## Failure handling

| Failure | Action |
| --- | --- |
| HTTP non-200 from heartbeat | Log, increment failure counter, NO lockdown |
| Signature mismatch on response | Discarded (we don't trust response anyway) |
| Command queue empty | Continue (normal) |
| Command signature invalid | Reject command, report rejection, continue |
| Command decryption fails | Reject, report, continue |
| Network error | Log, increment counter, retry next cycle |

The enforcer is resilient to API blips. It doesn't lock itself out from a few failed heartbeats — only persistent failure (>5 mins typically) escalates.

## Cross-references

- DIRECT commands: [06-direct-commands.md](./06-direct-commands.md).
- Manifest signing: [../operations/02-manifest-system.md](../operations/02-manifest-system.md).
- Heartbeat anomaly detection (API side): [../abuse-protection/04-heartbeat-anomaly.md](../abuse-protection/04-heartbeat-anomaly.md).
