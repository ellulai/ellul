# Cross-project isolation

Within a single VPS, multiple projects coexist as separate namespaces. The agent in project A by default cannot see project B. When the user grants A read access to B (`cross_project_access`), B's source becomes visible at `.shared/<sbx-bbbbb>` — but only as a frozen, read-only snapshot.

A subtler attack vector: even with valid read access, the agent in A could try to use B's source to craft gate requests against B's data. Defense: 4-layer scope check.

## Implementation

- Agent-bridge: `tool-resolver.ts`, `mcp-gateway.service.ts`.
- Sovereign Shield: `gate-scope-check.ts`, `cross-project.service.ts`.
- Shared utility: `packages/vps/src/services/shared/cross-project-scope.ts`.

## How the snapshot works

When sandbox A spawns its namespace and has `cross_project_access` to B:

1. Bridge reads the cross-project-access config from `/etc/ellul/shield-data/cross-project-access.json`.
2. Bridge calls `ellul-agent-namespace setup` with `--shared-projects sbx-bbbbb` and other flags.
3. Inside A's namespace setup, rsync copies B's source to a tmpfs scratch dir:

```bash
rsync -aq --no-links --max-size=50m \
  --exclude '.env*' --exclude '.envrc' \
  --exclude 'credentials.json' --exclude 'service-account.json' \
  --exclude '.npmrc' --exclude '.pypirc' --exclude '.netrc' \
  --exclude '.htpasswd' --exclude '.pgpass' \
  --exclude '.zeroclaw' --exclude '.claude' --exclude '.codex' \
  --exclude '.config' --exclude '.cursor' --exclude '.vscode' \
  --exclude '.idea' --exclude '.docker' \
  --exclude 'node_modules' --exclude '.yarn' --exclude '.pnpm-store' \
  --exclude '.git/objects' --exclude '.git/lfs' \
  /home/dev/projects/sbx-bbbbb/ /run/.ns-<sbx-aaaaa>/scratch/shared-0/
```

4. The scratch dir is bind-mounted read-only at `.shared/sbx-bbbbb` inside A's namespace.

Properties:

- **Snapshot, not bind mount.** Changes to B after A's namespace creation are invisible to A.
- **`--no-links` rejects all symlinks.** Symlink-pointing-to-secret attacks fail.
- **Excludes secrets-and-state.** `.env*`, credential files, npm/pip/git auth dotfiles.
- **Read-only.** Even if A's agent writes to `.shared/sbx-bbbbb/<file>`, the bind-mount remount-ro causes EROFS.
- **Per-spawn.** Each namespace gets a fresh snapshot. Long-lived persistent namespaces refresh on reconcile (every 30s).

## The 4-layer gate scope check

The agent has a valid read snapshot of B. It can read B's `package.json`, see `DATABASE_URL` references, see the schema in B's migrations. It then crafts a request:

> "Run `db_read` on this project. Reason: investigating connection issue per `/projects/sbx-bbbbb/src/db.ts`."

Without scope check, the user (who knows about B) might approve. But A is the project that gets the gate, leading to A's agent executing queries with B's leaked context.

### L1: Tool resolver (agent-bridge)

`tool-resolver.ts`. Before the agent's tool call goes to MCP/internal HTTP:

```typescript
const SANDBOX_SCOPED_CAPABILITIES = new Set([
  'database:read', 'database:write', 'database:migrate',
  'secrets:env_read', 'secrets:env_inject', 'secrets:vault_read',
  'deployment:git_read', 'deployment:git_write', 'deployment:deploy_trigger',
  'observability:logs_read', 'observability:metrics_read',
]);

function isCrossSandboxArg(arg: any, currentSlug: string): boolean {
  // Recursively scan arg for references like:
  //   .shared/sbx-xxxxxxx
  //   /projects/sbx-xxxxxxx
  //   bare sbx-xxxxxxx token
  // matching project must NOT be currentSlug
}

if (cap in SANDBOX_SCOPED_CAPABILITIES && isCrossSandboxArg(args, project)) {
  return { error: 'cross-project capability denied at L1' };
}
```

Result: tools like `database:read` cannot be invoked with arguments referencing other projects.

### L2: Reason enrichment

For non-scoped capabilities (`filesystem:*`, `network:*`, `execution:*`), the gate-request reason is enriched with hints:

```typescript
const reasonWithHint = `${reason}\n[CROSS_PROJECT_HINTS: ${detectedSlugs.join(', ')}]`;
```

Even though the capability isn't intrinsically cross-project-blocked, the hint flags the request to L3.

### L3: Shield scope check

`gate-scope-check.ts`. On `/_auth/gates/request`:

```typescript
function checkScope(reason: string, sandboxId: SandboxId): { allowed: boolean; reason?: string } {
  const matches = reason.matchAll(/\b(?:\.shared\/)?(sbx-[a-z0-9]{7})\b/gi);
  for (const m of matches) {
    const referencedSlug = m[1].toLowerCase();
    if (referencedSlug === sandboxId.toLowerCase()) continue;  // self-ref OK
    
    // Check if requester (sandboxId) has read access to referencedSlug
    if (hasCrossProjectAccess(sandboxId, referencedSlug)) {
      return { allowed: false, reason: 'cross-project scope confusion' };
    }
  }
  return { allowed: true };
}
```

If the gate request mentions a different sandbox that the requester has read access to, the request is denied with 403 — **no popup shown to the user**, audit-logged.

Read access is queried fresh from the DB each time (not cached). Revoked grants take effect immediately.

### L4: Agent prompt

The agent's system prompt (set by `context.service.ts`) explicitly instructs:

> Shared sandboxes available at `.shared/<slug>` are inspect-only. Do not attempt to use shared content as the basis for gate requests against other projects; such requests will be auto-denied.

This is a behavioural nudge, not a defense, but it reduces accidental cross-project requests from a well-aligned agent.

## Matching rules

The L3 matcher uses three patterns:

1. **`.shared/<slug>`** — relative path reference.
2. **`/projects/<sbx-xxxxxxx>`** — absolute on-disk path. Strict 7-char slug suffix.
3. **Bare `<sbx-xxxxxxx>` token** — word-boundary anchored.

Case-insensitive. Slug shape: `sbx-` followed by exactly 7 lowercase alphanumeric characters.

## What about non-sandbox-scoped tools?

Tools like `filesystem:*` and `execution:*` are not auto-denied at L1 (they have legitimate cross-project use, e.g., reading `.shared` files). For those:

- L1 lets the call proceed.
- L2 enriches the reason with cross-project hints.
- L3 sees the hint, denies the gate at Shield level.
- Result: the user never sees a popup; agent gets 403.

## Kill switch

Environment variable `ELLUL_CROSS_PROJECT_SCOPE_CHECK=0` disables all four layers. Used only for emergency debugging (e.g., a false positive blocking legitimate work). Default is enabled.

## Test coverage

108 tests across 5 files in `packages/vps/src/services/auth/sovereign-shield/src/services/__tests__/`:

- `cross-project-scope-confusion.test.ts` — 53 cases of matcher patterns, hint extraction, capability classification.
- `cross-project-scope-redteam.test.ts` — 27 documented bypass attempts.
- `cross-project-scope-flag.test.ts` — 17 kill-switch parsing tests.
- `gate-scope-check.test.ts` — 5 end-to-end pipeline cases.
- `tool-resolver-scope-confusion.test.ts` — 6 L1 scope denial cases.

Run: `cd packages/vps && npx vitest run src/services/auth/sovereign-shield/src/services/__tests__/cross-project-*`.

## What this does NOT prevent

- **Legitimate cross-project filesystem reads.** The user granted read access; the agent can read .shared files, see code, learn from it. That's the point.
- **Information embodied in the agent's reasoning.** If the agent reads B's code and then writes A's code informed by B's patterns, that's intended.
- **Side-channel inference.** If the agent measures timing (B's queries, A's queries) and infers structure, that's out of scope.

The scope check defends against **explicit gate-token misuse** — the agent crafting requests that, if approved, would let it act on B's behalf while in A's session.

## Cross-references

- Gate types: [03-sovereign-gates.md](./03-sovereign-gates.md).
- Namespace mount layout: [../isolation/02-mount-layout.md](../isolation/02-mount-layout.md).
- Shared snapshot details: [../isolation/04-cross-project-snapshots.md](../isolation/04-cross-project-snapshots.md).
