# Shield Local Daemon — API Reference

> All routes served over Unix domain socket at `~/.ellul/daemon.sock`.
> Peer UID verified on every connection.
> Correlation ID (`X-Correlation-Id`) included in every response.

## Health & Status

### GET /_local/health
Per-component health check for monitoring.

**Response** `200` or `503`:
```json
{
  "status": "ok | degraded | unhealthy",
  "components": {
    "daemon": { "status": "ok" },
    "peercred": { "status": "ok", "detail": "native-addon" },
    "guardrail": { "status": "ok", "detail": "/path/to/binary" },
    "ruleStore": { "status": "ok", "detail": "3 rules" },
    "projects": { "status": "ok", "detail": "1 registered" }
  }
}
```

### GET /_local/status
Detailed daemon status.

**Response** `200`:
```json
{
  "version": "0.1.0",
  "mode": "local",
  "execMode": "capability",
  "uptime": 3600,
  "ipc": "unix-socket",
  "peercredTier": "native-addon",
  "operatorKeyPublic": "base64...",
  "guardrailBinary": "found",
  "ruleCount": 3,
  "projects": [{ "slug": "local-my-api-a3f8", "name": "my-api", "directory": "/path", "fingerprint": "sha256...", "secrets": 5 }],
  "gates": [{ "gate": "test", "open": false, "policy": "ask" }]
}
```

## Projects

### POST /_local/projects/register
Register a project from its `.ellul/project.json`.

**Body**: `{ "dir": "/absolute/path/to/project" }`
**Response** `200`: `{ "ok": true, "slug": "local-my-api-a3f8", "fingerprint": "sha256..." }`

### GET /_local/projects
List registered projects.

### POST /_local/projects/:slug/sts
Issue a local STS token for a project (15-min TTL, workspace-fingerprinted).

## Secrets

> Values are NEVER returned via HTTP. Auto-injected into exec env vars.

### GET /_local/secrets?project={slug}
List secret names (no values). `{ "names": ["DB_URL", "API_KEY"], "count": 2 }`

### POST /_local/secrets
Store a secret. **Body**: `{ "project": "slug", "name": "DB_URL", "value": "postgres://..." }`

### POST /_local/secrets/import
Bulk import from .env content. **Body**: `{ "project": "slug", "content": "KEY=value\n..." }`

### DELETE /_local/secrets/:name?project={slug}
Delete a secret.

## Gates

### GET /_local/gates?project={slug}
List all gate states. Returns array of `{ gate, open, policy, expiresAt }`.

### POST /_local/gates/request
Agent requests a gate. **Body**: `{ "gate": "test", "project": "slug", "reason": "Need to run tests" }`
Response: `{ "requestId": "abc123", "status": "pending | auto_approved | auto_denied | already_open" }`

### POST /_local/gates/approve *(requires operator signature)*
**Body**: `{ "gate": "test", "project": "slug", "duration": 300, "operatorSignature": "base64...", "operatorTimestamp": "1234567890" }`
Signature domain: `gate-approve|{gate}|{project}|{duration}|{timestamp}`

### POST /_local/gates/deny *(requires operator signature)*
**Body**: `{ "gate": "test", "project": "slug", "operatorSignature": "base64...", "operatorTimestamp": "1234567890" }`
Signature domain: `gate-deny|{gate}|{project}|{timestamp}`

## Guardrails

### GET /_local/guardrails/rules
List all guardrail rules (active + disabled).

### POST /_local/guardrails/propose
Agent proposes a rule change. **Body**: `{ "action": "disable", "reason": "...", "rule_id": "..." }`
Response: `{ "status": "pending", "proposal_id": "prop_abc123" }`

### GET /_local/guardrails/proposals
List pending proposals.

### POST /_local/guardrails/proposals/:id/approve *(requires operator signature)*
Signature domain: `rule-approve|{proposalId}|{timestamp}`

### POST /_local/guardrails/proposals/:id/deny *(requires operator signature)*
Signature domain: `rule-deny|{proposalId}|{timestamp}`

## Execution

### POST /_local/exec/run
Full exec pipeline: capability check → gate check → proposal ingestion → strike check → integrity restoration → guardrail scan → execute → redact.

**Body**: `{ "project": "slug", "command": "npm test", "stream": true }`

**SSE Response** (when `Accept: text/event-stream`):
```
event: meta
data: {"command":"npm test","project":"local-my-api-a3f8"}

event: stdout
data: PASS src/test.ts

event: exit
data: {"code":0}
```

**JSON Response** (default):
```json
{ "ok": true, "exitCode": 0, "stdout": "PASS...", "stderr": "" }
```

**Error Responses** (403):
- `{ "error": "command_not_allowed" }` — not in capability allowlist
- `{ "error": "gate_closed", "gate": "test" }` — gate not open
- `{ "error": "guardrail_blocked", "findings": [...] }` — AST violation
- `{ "error": "guardrail_halted" }` — 3-strike hard stop

### POST /_local/exec/scan
Guardrail scan only (no execution). Returns scan result JSON.

## Internal (MCP Coordination)

### POST /_internal/sync-receipt?project={slug}
Content hash coordination for MCP subprocesses.

### POST /_internal/gate-grant
Forward agent gate request to REPL.

### POST /_internal/gate-revoke → 403
Requires operator signature. Use REPL `/deny`.

### POST /_internal/policy-set → 403
Requires operator signature. Use REPL.

## Authentication

- **Unix socket mode**: Peer UID verified via SO_PEERCRED / LOCAL_PEERCRED. No bearer token needed.
- **TCP fallback mode**: `X-Daemon-Nonce` header required (nonce from `~/.ellul/daemon.nonce`).
- **STS verification**: Guarded routes (`/exec/*`, `/gates/request|approve|deny`, `/secrets`, `/guardrails/propose`) verify X-STS-Token header with workspace fingerprint binding.
- **Operator signature**: Privileged routes require SLH-DSA-SHA2-128s signature in request body with domain-separated payload and 30-second timestamp tolerance.
