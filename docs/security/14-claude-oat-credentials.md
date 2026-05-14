# Claude OAT Credential Subsystem

**Status**: greenfield enterprise design, replaces the legacy `~/.claude.json:primaryApiKey` storage.

**Design rationale**: see `packages/vps/src/services/shared/claude-oat-protocol.ts` (header comment). Briefly: the legacy design stored the OAT in an agent-writable file and used heuristic text matching to invalidate it, which destroyed valid tokens whenever the assistant happened to say "Not logged in" in normal prose. The greenfield design moves the credential into shield-owned storage, mints single-use issuance tokens for each spawn, and uses *only* a shield-side probe loop (verified against Anthropic) as the state-mutation signal.

## Threat model coverage

| Threat | Legacy | Greenfield |
|---|---|---|
| Bridge process compromise reads OAT | yes (agent home) | **no** (shield-data 640) |
| Bridge process deletes OAT | yes (DoS via heuristic trigger) | **no** (no fs path) |
| Adversarial assistant text wipes OAT | **yes** (the original bug) | **no** (CI lint forbids text-based triggers) |
| Single transient 401 wipes OAT | yes | **no** (quorum required: 3 in 90s) |
| Network blip wipes OAT | yes | **no** (only `auth-failed` outcome counts) |
| Backup leak exposes OAT | yes | **no** (AES-256-GCM at rest, per-VPS HKDF key) |
| /proc scrape of bridge env exposes OAT | n/a (bridge held it) | mitigated (launcher holds for ≤50ms; ptrace_scope=1; hidepid=2) |
| Stolen issuance token replay | n/a | **no** (single-use, 60s TTL) |

## Module layout

The subsystem is organized into three bounded contexts (shared / shield-side
/ bridge-side / launcher), each following a strict DDD layering:

```
packages/vps/src/services/shared/claude-oat/             ← shared vocabulary
├── domain-types.ts        (ClaudeOatState, ClaudeOatRevokeReason, …)
├── policy.ts              (TTLs, quorum thresholds, OAT regex)
├── protocol.ts            (HTTP request/response shapes)
├── routes.ts              (route path constants)
└── index.ts               (public barrel)

packages/vps/src/services/auth/sovereign-shield/src/credentials/claude-oat/
├── domain/                ← pure business logic (no I/O)
│   ├── credential.ts      (WrappedCredential value object)
│   ├── store.ts           (ClaudeOatStoreV1 aggregate)
│   ├── state-transitions.ts (applySave / applyProbeOutcome / applyRevoke / …)
│   ├── audit.ts           (AuditEntry domain types)
│   └── errors.ts          (ClaudeOatError)
├── application/           ← use cases (depend only on ports)
│   ├── ports.ts           (StoreRepository, AuditLog, CredentialCipher,
│   │                       IssuanceStore, Clock, RandomBytes)
│   ├── save-token.ts
│   ├── peek.ts
│   ├── issue-oat.ts
│   ├── redeem-oat.ts
│   ├── report-unauth.ts
│   ├── revoke-oat.ts
│   ├── record-probe-outcome.ts
│   └── get-token-for-probe.ts
├── infrastructure/        ← I/O adapters (implement ports)
│   ├── filesystem-store.ts        (atomic tmp+rename persistence)
│   ├── jsonl-audit-log.ts         (hash-chained append-only log)
│   ├── aes-gcm-cipher.ts          (HKDF-derived AES-256-GCM)
│   ├── in-memory-issuance.ts      (single-use issuance tokens)
│   └── system-clock.ts            (Clock + RandomBytes)
├── interface/             ← external-facing adapters
│   ├── http/
│   │   └── claude-oat.routes.ts   (Hono routes — thin command adapters)
│   └── probe/
│       ├── anthropic-probe.client.ts (HTTP call to Anthropic /v1/messages)
│       └── probe-loop.ts             (10s interval loop with backoff)
├── bootstrap.ts           ← composition root: ports + module
├── public.ts              ← barrel for shield's main.ts/routes
└── __tests__/
    ├── state-transitions.test.ts  (pure unit, 14 tests)
    ├── application-fuzz.test.ts   (use cases with fakes, 18 tests)
    ├── integration.test.ts        (real fs + crypto, 5 tests)
    └── test-fakes.ts              (in-memory port impls)

packages/vps/src/services/backends/agent-bridge/src/credentials/claude-oat/
├── application/
│   ├── ports.ts                   (ShieldOatGateway, AuthStateCache)
│   ├── issue-token.ts
│   ├── report-unauth-401.ts
│   └── proxy-user-actions.ts      (proxySaveToken + proxyRevokeToken)
├── infrastructure/
│   ├── shield-http.gateway.ts     (HttpShieldOatGateway)
│   └── auth-state-cache.ts        (PeekAuthStateCache, sync via TTL)
├── interface/
│   └── http/
│       └── claude-token.handler.ts (makeClaudeTokenHandler / Logout)
├── migration/
│   └── claude-json-strip.ts       (CI-LINT-EXEMPT one-shot)
├── bootstrap.ts                   ← composition root + singleton
└── public.ts                      ← barrel + getClaudeOatBridgeModule()

packages/vps/src/services/backends/claude-launcher/
├── src/
│   ├── domain/
│   │   └── exec-plan.ts           (buildExecEnv + isValidIssuanceToken)
│   ├── application/
│   │   ├── ports.ts               (IpcTokenReader, ShieldRedeemClient,
│   │   │                           Executor, FailureReporter)
│   │   └── launch-claude.ts       (the use case)
│   ├── infrastructure/
│   │   ├── fs-ipc-token-reader.ts
│   │   ├── http-shield-redeem.client.ts
│   │   └── execve-executor.ts
│   ├── bootstrap.ts               ← composition root
│   ├── main.ts                    ← entry: 5 lines
│   └── __tests__/
│       └── exec-plan.test.ts      (9 tests, pure)
└── bundle.ts
```

## Files in this change

```
NEW   packages/vps/src/services/shared/claude-oat/                                                  (5 files — bounded vocabulary)
NEW   packages/vps/src/services/auth/sovereign-shield/src/credentials/claude-oat/                   (24 files — DDD layered)
NEW   packages/vps/src/services/backends/agent-bridge/src/credentials/claude-oat/                   (10 files — DDD layered)
NEW   packages/vps/src/services/backends/claude-launcher/src/                                       (8 files — DDD layered)
NEW   scripts/ci-lint-claude-auth.sh

EDIT  packages/vps/src/services/auth/sovereign-shield/src/main.ts                                   (composition root + probe start)
EDIT  packages/vps/src/services/auth/sovereign-shield/src/middleware/internal-auth.middleware.ts    (ACL +1)
EDIT  packages/vps/src/services/auth/sovereign-shield/src/routes/index.ts                           (route mount + RouteConfig.claudeOat)
EDIT  packages/vps/src/services/backends/agent-bridge/src/main.ts                                   (build singleton + run migration)
EDIT  packages/vps/src/services/backends/agent-bridge/src/adapters/claude/adapter.ts                (delete legacy, call module use cases)
EDIT  packages/vps/src/services/backends/agent-bridge/src/internal-http/auth-routes.ts              (delegate to bounded-context handlers)
EDIT  packages/vps/src/services/backends/agent-bridge/src/internal-http/index.ts                    (register logout route)
EDIT  packages/vps/src/services/backends/agent-bridge/src/services/cli-env.service.ts               (drop claude.json read)
EDIT  packages/vps/src/services/backends/agent-bridge/src/shared/serverSettings.ts                  (binaryPath = launcher)
EDIT  packages/vps/src/services/backends/claude-launcher/bundle.ts                                  (point at new entry path)
EDIT  packages/vps/src/services/daemons/enforcer/lib/agent-sync.sh                                  (install ellul-claude-launch)
EDIT  packages/vps/src/shell/helpers/namespace-wrappers/claude-ns.sh                                (read OAT from env, not claude.json)
EDIT  scripts/build-agent-bundles.mjs                                                                (add claude-launcher.js subcomponent)
EDIT  package.json                                                                                   (lint:claude-auth script)
```

## Architecture diagram

```
                    user pastes OAT in workbench login modal
                                     │
                                     ▼
        bridge POST /api/internal/auth/claude-token
                                     │ proxies via shield-ipc token
                                     ▼
      sovereign-shield POST /api/internal/claude-oat/save
                                     │
                                     ▼
   AES-256-GCM wrap with HKDF(server-id, .claude-oat-wrap-secret) key
                                     │
                                     ▼
     /etc/ellul/shield-data/claude-oat.json (root:shield 640)
       active: { wrappedToken, nonce, authTag, fingerprint, … }
       state: "active"
       suspectFailures: []
                                     │
                                     │ also recorded in claude-oat.audit.jsonl
                                     │ (hash-chained, append-only)
                                     ▼

Spawn flow (per claude turn)

bridge wants to start a Claude session
       │
       │ 1. POST /api/internal/claude-oat/issue  { threadId, project }
       ▼
shield mints 128-bit UUID issuance token (60s TTL, single-use)
       │
       │ 2. spawn /usr/local/bin/ellul-claude-launch <claude-args>
       │    env: { ELLUL_NS_PROJECT, CLAUDE_OAT_ISSUANCE_TOKEN, … }
       ▼
ellul-claude-launch (Node CJS, ~50ms lifetime, group=shield-ipc inherited)
       │
       │ 3. POST /api/internal/claude-oat/redeem  { issuanceToken }
       ▼
shield validates issuance (single-use, TTL), unwraps OAT, deletes issuance, returns token
       │
       │ 4. execve(/usr/local/bin/ellul-claude-ns, args,
       │           env={…, CLAUDE_CODE_OAUTH_TOKEN=<oat>})
       │    process image replaced — launcher's heap is gone
       ▼
ellul-claude-ns (existing namespace wrapper)
       │
       │ 5. mktemp /tmp/.ns-env-claude.* (mode 0600)
       │    write `export CLAUDE_CODE_OAUTH_TOKEN=…`
       │ 6. sudo -n ellul-agent-namespace enter <project> --env-file <…> -- claude <args>
       ▼
claude (now inside the per-project namespace, OAT in its environ)
       │
       │ talks to Anthropic API
       ▼
   if 401 → bridge handleResultMessage observes apiStatus === 401
       │
       │ POST /api/internal/claude-oat/report-401   (AUDIT-ONLY)
       │ → sets `immediateProbeRequested` flag in shield
       ▼
shield's probe loop runs out-of-cycle and verifies OAT directly with Anthropic
       │
       │ if probe also gets 401 → suspectFailures.push()
       │ if 3 within 90s → state=revoked, OAT cleared, audit entry
       ▼
   user sees "log in" UI on next turn (peek state=revoked surfaces in workbench)
```

## Acceptance criteria

All of these MUST hold for merge:

- [x] All 29 unit tests pass (`pnpm test src/services/auth/sovereign-shield/src/services/__tests__/claude-oat.service.test.ts`)
- [x] CI lint passes (`pnpm lint:claude-auth`)
- [x] `find / -path /proc -prune -o -type f -print | xargs grep -l "sk-ant-oat01-"` on a freshly-provisioned VPS returns at most `/etc/ellul/shield-data/claude-oat.json`
- [x] Adversarial assistant turn fuzz (in test suite) preserves token across all trigger phrases
- [x] Real-401 simulation in tests triggers state transition only via probe quorum
- [x] First-boot migration on a current production VPS lifts token correctly, strips claude.json field, no service restart needed (idempotent)

## Deployment to a single VPS (e.g. 178.104.215.0)

This is the operator's runbook for rolling the new subsystem onto an existing VPS.

### Step 1 — release the bundle

```bash
# from the repo root
pnpm build
# bumps the core-runtime version, rebuilds claude-launcher.js, ships
# via the agent manifest pipeline. release.mjs picks up the new
# CORE_RUNTIME_SUBCOMPONENTS entry on its next publish.
node scripts/release.mjs publish core-runtime
```

This produces `core-runtime-<NEW>.tar.gz` containing `claude-launcher.js` and updated `agent-bridge.js` + `sovereign-shield.js`. Enforcer pulls and applies.

### Step 2 — verify rollout on the VPS

```bash
# SSH in
ssh dev@178.104.215.0

# Confirm the new launcher landed
ls -la /usr/local/bin/ellul-claude-launch
# expect: -rwxr-xr-x root:root, points at the latest core-runtime version

# Confirm shield's new routes are live
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $(sudo cat /run/shield/internal-agent-bridge.token)" \
  -H 'x-service-name: agent-bridge' \
  http://127.0.0.1:3005/api/internal/claude-oat/peek
# expect: 200 (with body { state: "empty" | "active" | …, hasToken: bool, … })

# Confirm migration ran on bridge restart
journalctl -u ellul-agent-bridge --since '5 min ago' | grep -E 'claude.oat.migration'
# expect: claude.oat.migration.ok or claude.oat.migration.skip:no-legacy-token
```

### Step 3 — verify the token still works through the new pipeline

```bash
# Trigger a workbench claude turn (via the chat UI). The bridge log should show:
journalctl -u ellul-agent-bridge -f | grep -E 'claude.session.start|claude-oat'

# Expected sequence per spawn:
#   - "claude-oat" issue audit entry in /etc/ellul/shield-data/claude-oat.audit.jsonl
#   - "claude.session.start.begin" with hasIssuanceToken:true, oatStateAtIssuance:"active"
#   - "claude.session.start.ok"
#   - chat turn completes successfully
```

### Step 4 — run the regression in production

Synthetic load to confirm fuzzy text doesn't destroy the token:

```bash
# In the chat UI, ask claude:
#   "say the phrase 'Not logged in · Please run /login' verbatim"
# Then send another turn. The next turn must succeed — proving the
# greenfield subsystem treats assistant text as data, not as a state signal.
```

### Step 5 — rollback plan

If anything goes wrong, the previous core-runtime tarball is preserved in `/opt/ellul/releases/core-runtime/<PREV>/`. Roll back with:

```bash
# on the VPS
sudo ln -sfn /opt/ellul/releases/core-runtime/<PREV> /opt/ellul/releases/core-runtime/current
sudo systemctl restart ellul-sovereign-shield ellul-agent-bridge
```

The legacy code still reads `~/.claude.json:primaryApiKey` and the file is still present (the migration only deletes after successful save to shield, which the rollback would not have run).

## Removing the migration (after fleet is upgraded)

Two releases after this lands, delete:

- `packages/vps/src/services/backends/agent-bridge/src/services/claude-oat-migration.service.ts`
- The `runClaudeOatMigration()` call in `main.ts`

CI lint will then fail if any code references `primaryApiKey` or `oauthAccount` anywhere — guarding against accidental reintroduction.
