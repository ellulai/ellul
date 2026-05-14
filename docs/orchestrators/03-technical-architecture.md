# Agent Adapter Infrastructure — Technical Documentation

## Overview

ellul.ai provides sandboxed multi-agent execution infrastructure for orchestration platforms like Paperclip, CrewAI, and others. The system maps an organizational hierarchy (teams, agents, reporting lines) to Linux kernel-level isolation primitives (mount namespaces, PID namespaces, iptables rules), with a scoped comms channel system for inter-team communication.

This document covers the complete architecture from database schema through VPS execution.

---

## Architecture

```
                                    ┌─────────────────────────────┐
                                    │     Orchestrator (e.g.      │
                                    │     Paperclip Server)       │
                                    └──────────┬──────────────────┘
                                               │ Heartbeat fires
                                               ▼
                                    ┌─────────────────────────────┐
                                    │  ellul_cloud Adapter      │
                                    │  (lives in Paperclip repo)  │
                                    └──────────┬──────────────────┘
                                               │ POST /execute
                                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        ellul.ai API (Cloud Run)                         │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  agent-adapter│  │  orchestrator │  │   event-bus  │                  │
│  │  .service.ts  │  │  API keys     │  │  (PG NOTIFY) │                  │
│  └──────┬───────┘  └──────────────┘  └──────────────┘                  │
│         │                                                               │
│         │ enqueueAndWait("agent-adapter-execute")                           │
│         ▼                                                               │
│  ┌──────────────────┐                                                   │
│  │  server_commands  │  (Postgres — enforcer polls this)                │
│  │  table            │                                                   │
│  └──────────────────┘                                                   │
└──────────────────────────────────────────────────────────────────────────┘
                                               │
                                               │ Enforcer polls every 30s
                                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          VPS (Hetzner/DigitalOcean)                      │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │  Enforcer Daemon (root)                                      │       │
│  │                                                              │       │
│  │  1. Write config to /etc/ellul/shield-data/                │       │
│  │  2. Create vault comms dirs                                  │       │
│  │  3. Setup namespace (if not running)                         │       │
│  │  4. Enter namespace → run CLI                                │       │
│  │  5. Capture stdout → report result                           │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                         │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐            │
│  │ Namespace:     │  │ Namespace:     │  │ Namespace:     │            │
│  │ ao-xxxx-audit  │  │ ao-xxxx-block  │  │ ao-xxxx-exec   │            │
│  │                │  │                │  │                │            │
│  │ /comms/team/   │  │ /comms/team/   │  │ /comms/team/   │            │
│  │ /comms/exec/   │  │ /comms/exec/   │  │ /comms/audit/  │            │
│  │ .shared/block/ │  │ .shared/audit/ │  │ /comms/block/  │            │
│  │ .shared/exec/  │  │ .shared/exec/  │  │ /comms/verif/  │            │
│  └────────────────┘  └────────────────┘  └────────────────┘            │
│         ▲                    ▲                    ▲                     │
│         └────────────────────┴────────────────────┘                     │
│                    Vault: .ellul-vault/comms/                          │
│                    (persists across hibernate/wake)                      │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### Database Tables

All tables use Drizzle ORM with PostgreSQL on Neon. Tables are partner-agnostic — they work with any orchestration platform, not just Paperclip.

#### `orgs`

Maps an orchestrator's organization (Paperclip "company") to an ellul.ai VPS.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | Orchestrator's org/company UUID |
| `userId` | text FK → users | ellul.ai account owner |
| `serverId` | text FK → servers | Linked VPS (null until provisioned) |
| `name` | text | Organization name |
| `status` | enum | provisioning, active, hibernated, error, destroying |
| `orchestrator` | text | Source platform: "paperclip", "crewai", etc. |
| `hierarchySnapshot` | json | Full agent/team tree (used to derive namespaces + channels) |
| `executionConfig` | json | CLI type, hibernate policy, timeouts |

#### `org_teams`

Maps each team to a Linux namespace on the VPS.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | Generated UUID |
| `orgId` | text FK → orgs | Parent org |
| `slug` | text | Team identifier: "audit", "blockchain", "executive" |
| `namespaceSlug` | text | VPS namespace ID: "ao-{orgPrefix}-{slug}" |
| `managerAgentId` | text | Agent UUID who leads this team |
| `parentTeamId` | text | Derived from hierarchy (executive is root) |
| `isExecutive` | boolean | True for synthesized executive team (CEO, CSO) |

#### `org_members`

Maps each agent to its team. Agents execute inside their team's namespace.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | Orchestrator's agent UUID |
| `orgId` | text FK → orgs | Parent org |
| `teamId` | text FK → org_teams | Team this agent belongs to |
| `slug` | text | Agent identifier: "code-auditor", "ceo" |
| `reportsToAgentId` | text | Hierarchy parent (drives channel derivation) |
| `lastReadCursors` | json | Per-channel timestamps to prevent context-window explosion |

#### `comms_channels`

Defines communication channels between teams. Each channel is a vault directory.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | Generated UUID |
| `orgId` | text FK → orgs | Parent org |
| `type` | enum | team_internal, hierarchical, cross_team |
| `slug` | text | Vault directory name: "team-audit", "hier-executive-audit", "x-audit-blockchain" |
| `teamAId` | text FK → org_teams | First team (for hierarchical/cross-team) |
| `teamBId` | text FK → org_teams | Second team (for hierarchical/cross-team) |
| `rotationMaxFiles` | integer | Max active files before rotation (default 100) |
| `rotationMaxAgeDays` | integer | Max age before archival (default 7) |

#### `comms_channel_mounts`

Maps which channels are visible inside which namespace, and at what path. This is the key table that enables bidirectional comms: the same vault directory appears at different paths in different namespaces.

| Column | Type | Purpose |
|--------|------|---------|
| `channelId` | text FK → comms_channels | Channel to mount |
| `teamId` | text FK → org_teams | Namespace to mount into |
| `mountPath` | text | Path inside namespace: "/comms/team/", "/comms/exec/", "/comms/audit/" |

**Example:** A hierarchical channel between executive and audit:
- Channel vault dir: `hier-executive-audit`
- Mount in audit namespace: `/comms/exec/` (team sees directives from above)
- Mount in executive namespace: `/comms/audit/` (exec sees reports from below)
- Same directory, two paths. Audit Lead writes to `/comms/exec/`, CEO reads it at `/comms/audit/`.

#### `org_runs`

Tracks each execution (one per heartbeat fire).

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | Generated UUID |
| `orgId` | text FK → orgs | Parent org |
| `agentId` | text FK → org_members | Agent being executed |
| `teamId` | text FK → org_teams | Team namespace for execution |
| `externalRunId` | text UNIQUE | Orchestrator's run UUID |
| `status` | enum | queued, waking, syncing, running, succeeded, failed, timed_out, cancelled |
| `prompt` | text | Full prompt sent to CLI |
| `exitCode` | integer | CLI exit code |
| `stdout` | text | Captured output (capped at 500KB) |
| `inputTokens` / `outputTokens` / `costUsd` | | Token usage and cost |
| `sessionParams` | json | Persisted for session resume across heartbeats |

#### `org_api_keys`

Bearer token authentication for adapter requests. Tokens are SHA-256 hashed before storage (same pattern as VPS AI proxy tokens).

---

## Channel Derivation Algorithm

`deriveChannels(hierarchy)` in `agent-adapter.service.ts` transforms an org chart into filesystem channels:

### Input

```typescript
{
  agents: [
    { id: "ceo-1", name: "CEO", reportsTo: null },
    { id: "cso-1", name: "CSO", reportsTo: "ceo-1" },
    { id: "audit-lead", name: "Audit Lead", reportsTo: "cso-1" },
    { id: "code-auditor", name: "Code Auditor", reportsTo: "audit-lead" },
  ],
  teams: [
    { slug: "audit", managerAgentId: "audit-lead", memberAgentIds: ["code-auditor"] },
  ]
}
```

### Processing

1. **Normalize hierarchy:** CEO and CSO are not in any team → synthesize "executive" team
2. **Build agent→team lookup:** Map every agent ID to its team slug
3. **Team internal channels:** One per team (mounted at `/comms/team/`)
4. **Hierarchical channels:** For each non-executive team, trace manager's `reportsTo` to find parent team. Create a channel mounted bidirectionally:
   - Child team: `/comms/exec/`
   - Parent team: `/comms/{child-slug}/`

### Output

```
team-audit          → mount in audit at /comms/team/
team-executive      → mount in executive at /comms/team/
hier-executive-audit → mount in audit at /comms/exec/
                       mount in executive at /comms/audit/
```

### Cross-team channels

Created on demand via `POST /api/agent-adapters/orgs/:id/channels`. Uses canonical alphabetical slug ordering (`x-alpha-zebra`, not `x-zebra-alpha`) to prevent duplicates. Mounted at `/comms/x-{first}-{second}/` in both namespaces.

---

## Execution Pipeline

When a Paperclip heartbeat fires for an agent configured with `ellul_cloud`:

### 1. Adapter → API (POST /orgs/:id/execute)

The adapter in Paperclip's repo renders the prompt template, resolves session state, and POSTs to ellul.ai:

```
POST /api/agent-adapters/orgs/{companyId}/execute
Authorization: Bearer pclip_xxx
{
  agentId: "code-auditor-uuid",
  externalRunId: "paperclip-run-uuid",
  prompt: "Review the ACME codebase for reentrancy...",
  wakeReason: "assignment",
  taskId: "issue-uuid",
  timeoutSec: 600,
  env: { PAPERCLIP_AGENT_ID: "...", PAPERCLIP_COMPANY_ID: "..." },
  sessionParams: { sessionId: "prev-session-id" }
}
```

### 2. API → Command Queue

`agent-adapter.service.ts` → `executeRunAsync()`:
- Resolves agent → team → namespace slug
- Checks server status (if hibernated, calls `wakeServer()` and polls up to 5 minutes)
- Calls `enqueueAndWait()` to insert a `server_commands` row with type `agent-adapter-execute`
- Waits for the enforcer to process it and write the result

### 3. Enforcer → Namespace → CLI

The enforcer daemon on the VPS polls `/api/servers/commands` every 30 seconds. When it picks up `agent-adapter-execute`:

**Step 1: Write config**
```bash
echo "$AOE_COMMS_CONFIG" > /etc/ellul/shield-data/org-config.json
```

**Step 2: Create vault comms directories**
```bash
mkdir -p $VAULT/comms/{channel-slug}
mkdir -p $VAULT/comms/{channel-slug}/archive
chown $SVC_USER:$SVC_USER $VAULT/comms/{channel-slug}
```

**Step 3: Setup namespace (idempotent)**
```bash
/usr/local/bin/ellul-agent-namespace setup $AOE_NS_SLUG
```

**Step 4: Execute CLI inside namespace**
```bash
# Per-CLI flag map
case "$AOE_CLI" in
  claude)   AOE_CLI_CMD="claude --print - --output-format stream-json --verbose --dangerously-skip-permissions" ;;
  codex)    AOE_CLI_CMD="codex --quiet --full-auto" ;;
  gemini)   AOE_CLI_CMD="gemini --sandbox=none" ;;
  opencode) AOE_CLI_CMD="opencode --non-interactive" ;;
esac

timeout $AOE_TIMEOUT /usr/local/bin/ellul-agent-namespace enter $AOE_NS_SLUG -- \
  runuser -l $SVC_USER -c "$AOE_CLI_CMD < $PROMPT_FILE" > $STDOUT_FILE 2>&1
```

**Step 5: Report result**
```json
{"ok": true, "runId": "xxx", "exitCode": 0, "timedOut": false, "stdout": "..."}
```

### 4. API → Result Processing

`handleExecutionResult()` in `agent-adapter.service.ts`:
- Parses the JSON-escaped stdout (enforcer uses `jq -Rs` which wraps in quotes)
- Maps exit code to status: 0 → succeeded, 124 → timed_out, other → failed
- Caps stdout at 500KB
- Updates `lastReadCursors` on the agent if returned in sessionParams
- Pushes SSE event via PostgreSQL LISTEN/NOTIFY

### 5. Adapter ← Polling

The adapter polls `GET /api/agent-adapters/runs/:id` until it sees a terminal status, then maps to Paperclip's `AdapterExecutionResult`:

```typescript
{
  exitCode: 0,
  signal: null,
  timedOut: false,
  usage: { inputTokens: 1500, outputTokens: 800, cachedInputTokens: 0 },
  sessionParams: { sessionId: "new-session-id", lastReadCursors: {...} },
  provider: "anthropic",
  biller: "anthropic",
  model: "claude-sonnet-4-6",
  billingType: "metered_api",
  costUsd: 0.012,
  resultJson: { ellulRunId: "...", stdout: "..." },
  summary: "Found reentrancy vulnerability in withdraw()...",
  clearSession: false,
}
```

---

## Namespace Isolation

Each team namespace is created by `agent-namespace.ts` (1100+ lines of bash generated as a TypeScript template string). The namespace script executes in 6 phases:

### Phase 0: Privatize mount tree + create scratch space
```bash
mount --make-rprivate /
mount -t tmpfs -o size=512M tmpfs $SCRATCH
```

### Phase 1: Save writable resources BEFORE default-deny
- Project directory → bind-mount to scratch
- Cross-project rsync snapshots → filtered copy (excludes `.env*`, credentials, `node_modules`)
- **Cross-team rsync snapshots** → same filtered rsync for each readable namespace
- Overlayfs lowerdirs for `.config`, `.claude`, etc.
- **Comms channel vault directories** → bind-mount to scratch

### Phase 2: DEFAULT-DENY
```bash
mount --bind $SVC_HOME $SVC_HOME
mount -o remount,bind,ro $SVC_HOME  # Everything is now read-only
```

### Phase 3: Writable exceptions
- Project directory → writable bind-mount
- Overlayfs layers → writable upper dirs
- Dotfiles → writable copies

### Phase 3.5: Comms channels (read-write)
```bash
for each comms channel:
  mkdir -p $SVC_HOME/.comms$MOUNT_PATH
  mount --bind $SCRATCH/comms-$IDX $TARGET
  chown $SVC_USER:$SVC_USER $TARGET
```

### Phase 3.6: Cross-team read snapshots (read-only)
```bash
for each readable namespace:
  mkdir -p $PROJECT_DIR/.shared/$NS_SLUG
  mount --bind $SCRATCH/ao-shared-$IDX $MOUNT_POINT
  mount -o remount,bind,ro $MOUNT_POINT
```

### Phase 4: System isolation
- Private `/proc` (PID namespace)
- Clean `/tmp` (tmpfs)
- DNS override (8.8.8.8, 1.1.1.1)
- Mask `shield-data`, `ellul-shielded`, `run/shield` with empty tmpfs

### Phase 5: Signal readiness + anchor
```bash
echo "ready" > $READY_FIFO
exec sleep infinity  # Anchor process keeps namespace alive
```

---

## Comms Rotation

The enforcer's `check_critical_services()` calls `rotate_comms_channels()` every ~60 seconds:

1. **Count enforcement:** If a channel directory has more than `rotationMaxFiles` files, move the oldest to `archive/`
2. **Age enforcement:** Move files older than `rotationMaxAgeDays` to `archive/`
3. **Inode monitoring:** Warn at 80% inode usage

The `archive/` directory exists in the vault but is NOT mounted into namespaces — agents never see archived messages. The adapter tracks `lastReadCursors` per agent per channel to avoid re-reading old messages.

---

## Provisioning

### Cloud-Init Bootstrap

When a VPS is provisioned for an agent adapter, the provisioning payload includes an `agent-adapter` section that runs during cloud-init:

1. Decodes `ORG_CONFIG` from metadata (base64 JSON)
2. Writes to `/etc/ellul/shield-data/org-config.json`
3. Creates vault comms directories + archive dirs
4. Pre-creates team namespaces via `ellul-agent-namespace setup`

### Belt-and-Suspenders

The provisioning section handles the happy path (config in metadata at boot). The enforcer's `agent-adapter-execute` handler also creates vault dirs and writes config on first execution. This means:
- If metadata path works → VPS is ready at boot, first heartbeat executes immediately
- If metadata path fails → first heartbeat creates dirs + config, second heartbeat executes

### Server Lifecycle

- **Provision:** `POST /orgs/:id/provision` → `provisionServer()` (Hetzner/DigitalOcean) → `linkServerToOrg()`
- **Always-on:** VPS runs 24/7 on the monthly plan. No hibernation, no cold starts.
- **Wake (future):** `executeRunAsync()` has wake-on-hibernate logic built in for future serverless tiers. Currently all org servers are always-on.
- **Destroy:** `DELETE /orgs/:id` → sets status to "destroying"

### Dynamic org mode switching

Org mode is fully dynamic — controlled by the presence of `/etc/ellul/shield-data/org-config.json`. Shield re-reads this file (mtime-checked) on every request. Deleting the file deactivates org mode immediately: gate checks skip org-level fallback, proxy rejects with 503, BYOK detection returns false.

**Important:** Already-running namespaces retain their boot-time configuration. If BYOK mode was active when a namespace was created, its DNS blackhole (`/etc/hosts`) persists until the namespace is torn down and recreated. To fully roll back from org mode: remove the config, then teardown all namespaces so they recreate cleanly.

---

## Security Model

| Protection | Mechanism |
|-----------|-----------|
| Write isolation | Mount namespace: each team can only write to its own workspace |
| Read access | Cross-team source code readable via `.shared/` rsync snapshots (read-only, no credentials). Configurable per-team via `readableNamespaces` — teams not in the list get no snapshot. |
| Process isolation | PID namespace: can't see/signal other teams' processes |
| Network isolation | iptables rules per namespace |
| Credential exclusion | rsync `--exclude` + `--max-size=50m`: `.env*`, `credentials.json`, `.npmrc`, `.pgpass`, large files |
| Comms scoping | Each namespace mounts only its relevant channels |
| Shield data masking | `/etc/ellul/shield-data` hidden by empty tmpfs in namespace |
| Vault protection | `.ellul-vault/` owned by root:root 700 — agent user cannot traverse |

---

## API Reference

### Authentication

Two auth modes:
- **Session (Cookie):** For dashboard operations (register org, provision, create API key, delete)
- **Bearer token:** For adapter operations (execute, poll, cancel, sync, create channel)

Bearer tokens are scoped per-org, prefixed by orchestrator (`pclip_`, `crew_`, `aokey_`), and SHA-256 hashed before storage.

### Endpoints

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/agent-adapters/orgs` | POST | Session | Register organization |
| `/api/agent-adapters/orgs/:id/provision` | POST | Session | Provision VPS (validates tier via Stripe) |
| `/api/agent-adapters/orgs/:id` | GET | Both | Get org details |
| `/api/agent-adapters/orgs/:id/execute` | POST | Bearer | Queue agent execution |
| `/api/agent-adapters/runs/:id` | GET | Bearer | Poll run status |
| `/api/agent-adapters/runs/:id/cancel` | POST | Bearer | Cancel running execution |
| `/api/agent-adapters/orgs/:id/channels` | POST | Bearer | Create cross-team channel |
| `/api/agent-adapters/orgs/:id/sync` | POST | Bearer | Re-sync hierarchy |
| `/api/agent-adapters/api-keys` | POST | Session | Create API key |
| `/api/agent-adapters/orgs/:id` | DELETE | Session | Destroy org |

---

## Paperclip Integration

The `ellul_cloud` adapter lives in Paperclip's repo at `packages/adapters/ellul-cloud/`. It follows Paperclip's adapter contract exactly:

### Adapter Structure

```
src/
  index.ts            # type: "ellul_cloud", models, config doc
  server/
    execute.ts        # POST to ellul.ai, poll, return AdapterExecutionResult
    test.ts           # Validate API key, connectivity, org status
    index.ts          # ServerAdapterModule default export
  ui/
    parse-stdout.ts   # stdout → TranscriptEntry[] for run viewer
    build-config.ts   # Form values → adapterConfig JSON
    index.ts          # UI module exports
  cli/
    format-event.ts   # Pretty-print for `paperclipai run --watch`
    index.ts          # CLIAdapterModule default export
```

### Registration (changes in Paperclip's repo)

1. Add `"ellul_cloud"` to `AGENT_ADAPTER_TYPES` in `packages/shared/src/constants.ts`
2. Import + register in `server/src/adapters/registry.ts`
3. Import + register in `ui/src/adapters/registry.ts`
4. Import + register in `cli/src/adapters/registry.ts`

### Config

```json
{
  "adapterType": "ellul_cloud",
  "adapterConfig": {
    "agentCli": "claude",
    "model": "claude-sonnet-4-6",
    "promptTemplate": "You are {{agent.name}}. Continue your work.",
    "timeoutSec": 600,
    "env": {
      "ELLUL_API_KEY": { "secret_ref": "ellul-api-key" }
    }
  }
}
```

### Hierarchy Sync

When the org chart changes in Paperclip (agent hired/fired, reportsTo changed), the adapter should call:

```
POST /api/agent-adapters/orgs/:id/sync
{ "hierarchy": { "agents": [...], "teams": [...] } }
```

This deletes all existing teams/agents/channels and re-derives from the new hierarchy. API keys and run history are preserved. The VPS namespaces are updated on the next execution command.
