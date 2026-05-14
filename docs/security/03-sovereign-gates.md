# Sovereign Gates

User-controlled permissions for privileged actions. The agent must hold the right gate to do anything sensitive; the user grants gates via dashboard popups or `allow_always` rules.

Implementation: `packages/vps/src/services/auth/sovereign-shield/src/services/gate.service.ts`, `gate-permissions.service.ts`, `gate-scope-check.ts`.

## Gate types

| Gate | Default TTL | Scope | LUKS-gated |
| --- | --- | --- | --- |
| `logs` | 5 min | thread or app | No |
| `env` | 30s (1-cmd) | thread | No |
| `db_read` | 10 min | app | No |
| `db_write` | 10 min | app | **Yes** |
| `db_migrate` | 5 min | app | **Yes** |
| `git` | 5 min | app | No |
| `deploy` | 5 min | app | **Yes** |
| `exec` | 4 hours | app | No |
| `wallet_spend` | 5 min | app | **Yes** |
| `vault_read` | 4 hours | app | No |

LUKS-gated gates are blocked entirely if volume encryption was expected (mode `enhanced` or `sovereign`) but is not currently mounted. This is a sovereignty principle: writes don't happen on an unencrypted volume.

## Gate scopes

Gates persist at three different scopes:

### Thread-level (ephemeral)

In-process `Map<gate, expiry>`. Cleared on Shield restart, on thread end, on revocation. Used for one-shot operations where the user wants minimal exposure.

### App-level (persistent)

Stored in `/etc/ellul/shield-data/gate-state.json` (atomic write via `mktemp + mv`). Survives Shield restart. Default for `allow_always` permissions.

### Org-level (persistent, scope: org)

Used by `agent_adapter` profile (Paperclip). Org-scoped gates apply across all teams in the org. See [products/04-agent-adapter.md](../products/04-agent-adapter.md).

## Permission decisions

For each (gate, sandbox) pair, the user can configure:

- `ask` — default. Agent request → popup → user approves or denies.
- `allow_always` — auto-grant (skip popup) for the configured TTL on each request.
- `never` — auto-deny (skip popup).

Plus a session-only mode:

- `allow_session` — in-memory grant for the current Shield process; gone on restart.

Stored in `/etc/ellul/shield-data/gate-permissions.json`:

```json
{
  "version": 1,
  "sandboxes": {
    "sbx-abc1234": {
      "db_read": {
        "permission": "allow_always",
        "grantedAt": "2026-04-25T10:00:00Z",
        "grantedBy": "dashboard"
      }
    }
  },
  "orgScopes": {
    "team-audit": { ... }
  }
}
```

### Gates that cannot be `allow_always`

```typescript
const DENY_ALLOW_ALWAYS: ReadonlySet<GateType> = new Set(['exec', 'wallet_spend']);
```

`exec` (sandbox execution) and `wallet_spend` (financial operations) require user approval every session. The `allow_always` permission is rejected if attempted.

## Request flow

### Standard (ask) flow

```
Agent: tool call requires db_read on sbx-abc1234
  ↓
Tool resolver checks scope (gate-scope-check.ts)
  → if cross-project, deny with 403
  → if same project, proceed
  ↓
Agent calls Shield POST /_auth/gates/request
  ↓
Shield checks gate-permissions.json
  → if "allow_always", auto-grant, return token
  → if "never", auto-deny, return 403
  → if "ask", create pending request
  ↓
Dashboard receives SSE event /_auth/gates/stream
  ↓
User clicks Approve in browser
  ↓
Browser POSTs /_auth/gates/respond { id, action: "approve" }
  ↓
Shield issues gate token, persists if app-scoped
  ↓
Agent retries tool call with token in header
  ↓
Tool executes
  ↓
After TTL, gate expires; agent must re-request
```

### Auto-grant flow

```
Agent calls /_auth/gates/request
  ↓
Shield checks gate-permissions.json: db_read on sbx-abc1234 is "allow_always"
  ↓
Shield issues token immediately, no popup
  ↓
Tool executes
```

This is logged to the audit DB so the user has visibility into what the agent did silently.

## Cross-project gate denial

A subtle attack: the agent has read access to project B (via `.shared/sbx-bbbbb`) but is currently running in project A. The agent reads B's source, learns about B's database, then crafts a `db_read` request claiming reason "investigating bug in /projects/sbx-bbbbb".

Without scope check, the user sees "Allow db_read on this project?" and approves. But "this project" is A. The gate would let the agent write database queries to A's DB while having context from B's source — a cross-project leak.

Defense: 4-layer scope check ([08-cross-project-isolation.md](./08-cross-project-isolation.md)).

## LUKS gating for write gates

`db_write`, `db_migrate`, `deploy`, `wallet_spend` check `findmnt /dev/mapper/luks-home`. If volume encryption was expected (mode != `none`) but the device isn't mounted, the gate auto-denies with explanation.

Why: in sovereign mode, the volume might be locked (user hasn't unlocked yet). Allowing writes during this state could leave database changes that the user later loses (because they unlock and the FS is in an unexpected state). Forcing unlock before write maintains the invariant: data only changes when the user has authorized the unlock.

## Granted-token storage

Per-gate token (UUID-128) issued and stored in:

```
gate-state.json:
{
  "version": 2,
  "thread": {
    "<threadId>": {
      "<gate>": { "expiresAt": "<iso>", "grantedAt": "<iso>" }
    }
  },
  "app": {
    "<sandboxId>": {
      "<gate>": { "token": "<uuid>", "expiresAt": "<iso>" }
    }
  },
  "org": {
    "<orgScope>": { ... }
  }
}
```

Atomic write: write to `gate-state.json.tmp`, fsync, `rename` over `gate-state.json`. POSIX rename guarantees atomicity. Even on power loss, never see partial writes.

## Temporary migrate roles

`db_migrate` gate is special: in addition to issuing a token, Shield creates a temporary PostgreSQL role with DDL permissions for the gate's TTL.

```
1. User approves db_migrate.
2. Shield generates: shield_<app>_temp_<random12>
3. Shield runs (via shield-pg-wrapper sudo):
     CREATE ROLE shield_<app>_temp_<random> LOGIN PASSWORD '<rand>';
     GRANT shield_<app>_owner TO shield_<app>_temp_<random>;
     GRANT CONNECT ON DATABASE shield_<app> TO ...;
     GRANT USAGE, CREATE ON SCHEMA public TO ...;
     GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ...;
4. Password held only in Shield's memory. Never on disk.
5. Agent queries via /api/internal/db/query as this role.
6. After TTL (5 min):
     ALTER ROLE shield_<app>_temp_<random> NOLOGIN;
     SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ...;
     REASSIGN OWNED ... TO shield_<app>_owner;
     DROP OWNED ...;
     DROP ROLE shield_<app>_temp_<random>;
```

Why three-step teardown:

- `ALTER NOLOGIN` is atomic in PG. Once executed, the role cannot connect.
- `pg_terminate_backend` kills active sessions; combined with NOLOGIN they cannot reconnect.
- `DROP ROLE` cleans up the role record.

The race window between terminate and drop is closed by NOLOGIN coming first.

Orphaned cleanup on Shield boot: query `pg_roles WHERE rolname ~ '^shield_.*_temp_'` and run the same teardown for each. Recovers from crashes that left temp roles around.

## Auto-deny / auto-approve in code

```typescript
async function requestGate(
  gate: GateType,
  threadId: string,
  sandboxId: SandboxId,
  reason: string,
  orgScope?: string
) {
  // 0. Cross-project scope check
  const crossProjectDeny = await scopeCheck(reason, sandboxId);
  if (crossProjectDeny) return { granted: false, reason: 'cross-project' };

  // 1. LUKS gating for write gates
  if (LUKS_GATED_GATES.has(gate) && !isLuksMounted()) {
    return { granted: false, reason: 'luks-not-mounted' };
  }

  // 2. Permission lookup
  const perm = lookupPermission(gate, sandboxId);
  if (perm === 'never') {
    audit('gate.auto_denied', { gate, sandboxId, reason });
    return { granted: false, reason: 'permission-never' };
  }
  if (perm === 'allow_always') {
    audit('gate.auto_granted', { gate, sandboxId, reason });
    return { granted: true, token: issueToken(gate, threadId, sandboxId) };
  }

  // 3. Org-scope auto-grant
  if (orgScope && orgPermAllow(gate, orgScope)) {
    return { granted: true, token: issueToken(...) };
  }

  // 4. Default: pending request, surface to dashboard
  const requestId = createPendingRequest(gate, threadId, sandboxId, reason);
  emitToDashboard(requestId);
  return { granted: false, pending: true, requestId };
}
```

## Audit logging

Every gate event writes to `audit_log`:

- `gate.requested`
- `gate.auto_granted`
- `gate.user_granted`
- `gate.auto_denied`
- `gate.user_denied`
- `gate.expired`
- `gate.revoked`

Plus details: gate type, sandbox, thread, reason text, timestamp, IP.

The hash-chained log makes any retroactive tampering detectable. Auditing is also exposed via `GET /_auth/audit/log`.

## Tools that need gates

Tools advertise their required gate via the capability registry (`packages/vps/src/capabilities/`).

- File operations on `/projects/<sbx>/**` — no gate (default access).
- File operations on `.shared/<other-sbx>/**` — read no gate; write blocked at namespace level.
- Database SELECT — `db_read`.
- Database INSERT/UPDATE/DELETE — `db_write`.
- Database CREATE/ALTER/DROP — `db_migrate`.
- Reading app .env — `env` (single-command, secrets injected via stdin).
- Reading raw logs (no redaction) — `logs`.
- Pushing to git remote — `git`.
- Caddy reload / deploy — `deploy`.
- Sandbox execution (long-running) — `exec`.
- Vault secret reads — `vault_read`.
- Solana wallet spend — `wallet_spend`.

For details on cross-project enforcement: [08-cross-project-isolation.md](./08-cross-project-isolation.md).

For internal API contracts: [02-sovereign-shield.md](./02-sovereign-shield.md).
