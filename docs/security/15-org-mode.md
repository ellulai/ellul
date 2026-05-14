# Org Shield — Sovereign Shield at Organization Scope

## What This Is

Org Shield extends ellul.ai's Sovereign Shield security model from per-project scope to per-organization scope. It allows multiple AI agent teams — each running in their own kernel namespace — to share a single VPS with the same mathematically provable security guarantees that protect individual project sandboxes today.

This is not a new service. It is the same Sovereign Shield binary running in "org mode," auto-detected when `/etc/ellul/shield-data/org-config.json` exists on the VPS. Every kernel protection, every file permission, every gate mechanism carries over unchanged. The only structural difference: Shield now serves multiple namespaces and identifies the caller by team (via namespace source IP) instead of by project.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              VPS                                        │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Sovereign Shield (port 3005, shield-runner user)                │   │
│  │                                                                   │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │   │
│  │  │ Gate     │ │ Secrets  │ │ Git      │ │ Org Mode         │   │   │
│  │  │ Service  │ │ Service  │ │ Service  │ │ (IP → Team)      │   │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  AI API Proxy (port 3006, HTTPS, shield-runner user)             │   │
│  │  BYOK mode only — intercepts AI calls, attaches real key         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ Namespace:   │  │ Namespace:   │  │ Namespace:   │                 │
│  │ Audit Team   │  │ Blockchain   │  │ Executive    │                 │
│  │ IP: 10.A.B.C │  │ IP: 10.D.E.F│  │ IP: 10.G.H.I│                 │
│  │              │  │              │  │              │                 │
│  │ /comms/team/ │  │ /comms/team/ │  │ /comms/team/ │                 │
│  │ /comms/exec/ │  │ /comms/exec/ │  │ /comms/audit/│                 │
│  │ .shared/     │  │ .shared/     │  │ /comms/block/│                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
│         ▲                  ▲                  ▲                         │
│         │ veth pair        │ veth pair        │ veth pair              │
│         │ (kernel-assigned │ (kernel-assigned │ (kernel-assigned       │
│         │  deterministic)  │  deterministic)  │  deterministic)        │
│         └──────────────────┴──────────────────┘                         │
│                                                                         │
│  Vault: .ellul-vault/ (root:root 700)                                │
│  ├── etc/ellul/secrets/orgs/{orgId}/  (root:shield 2770)             │
│  ├── etc/ellul/shield-data/           (shield-runner 700)            │
│  └── etc/ellul/org-proxy-cert.pem     (root:root 644)               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Two Operating Modes

### Default Mode (CLI Login Sessions)

When a user logs into `claude` and `codex` once on the VPS, those login sessions persist in the vault via overlayfs layers. Every team namespace inherits them. No API keys, no proxy, no DNS blackhole. The agent authenticates directly with the AI provider using the CLI session.

This is the zero-configuration path. It works out of the box with orchestrators like Paperclip, whose adapter docs state: "Paperclip assumes the CLI is already installed and authenticated on the host machine."

### BYOK Mode (Bring Your Own Key)

When the user stores explicit API keys via the dashboard (e.g., `ANTHROPIC_API_KEY` scoped to the audit team), the full credential governance system activates:

1. Shield stores the key in the vault, encrypted at rest
2. Shield starts the AI API proxy on port 3006 (HTTPS, self-signed ECDSA cert)
3. The namespace script injects a DNS blackhole (`/etc/hosts` maps AI provider domains to `127.0.0.0`)
4. The enforcer injects proxy URLs (`ANTHROPIC_BASE_URL=https://127.0.0.1:3006/proxy/anthropic`)
5. The agent's CLI calls the proxy thinking it's the real API. Shield attaches the real key and streams the response.

BYOK mode is auto-detected by Shield: it checks if the org's secret manifest contains any entries with a `provider` field. The detection result is cached to `/etc/ellul/shield-data/.byok-active` so the enforcer and namespace script can check it with a single file-exists test instead of parsing JSON.

### Dynamic mode switching

Org mode is fully dynamic. Shield re-reads the config file on every request (mtime-checked for efficiency). If `org-config.json` is deleted, org mode deactivates immediately — gate checks skip the org-level fallback, the proxy rejects requests with 503, and BYOK detection returns false.

**Caveat: already-running namespaces retain their boot-time configuration.** If BYOK mode was active when a namespace was created, its `/etc/hosts` DNS blackhole persists until the namespace is torn down and recreated. Removing org mode config while namespaces are running does NOT retroactively remove the blackhole from those namespaces. New namespaces created after the config is removed will start without the blackhole. To fully roll back: remove the config, then teardown and recreate all namespaces.

---

## Tokenless Identity: How Shield Knows Which Team Is Calling

Traditional secret vaults authenticate callers via tokens (JWT, API key, OIDC). If the token is stolen, the identity is compromised.

Org Shield eliminates the token. Each team namespace has a deterministic IP address assigned by the Linux kernel via a virtual ethernet (veth) pair:

```
Namespace slug: ao-xxxx-audit
MD5(slug):      a1b2c3...
IP:             10.{0xa1}.{0xb2}.{0xc3 + 2}  →  10.161.178.197
```

When a request arrives at Shield (port 3005 or 3006), the TCP socket's `remoteAddress` is this deterministic IP. Shield looks it up in the IP → team map (built from `org-config.json` at startup) and resolves the calling team.

**Why this is unforgeable:** The veth pair is created by the namespace setup script running as root. The agent runs inside the namespace as the `dev` user. It cannot:
- Change its own IP (requires root + network namespace admin capabilities)
- Create a new namespace (requires root + sudoers entry it doesn't have)
- Modify the veth configuration (requires `CAP_NET_ADMIN` it doesn't have)
- Escape its network namespace (kernel enforces mount + network isolation)

The source IP is set by the kernel at the packet level. The agent can't forge it any more than it can forge its UID.

---

## The AI API Proxy (BYOK Mode)

### Why a proxy instead of env vars

If you pass `ANTHROPIC_API_KEY=sk-ant-xxx` as an environment variable, the agent has it. It can `echo $ANTHROPIC_API_KEY` and write it to a file, send it in a webhook, or include it in a commit message. Prompt-level instructions like "don't exfiltrate secrets" are not a security boundary.

The proxy ensures the agent **never has the key in its address space**. The key exists only in Shield's process memory (different UID, `ptrace_scope=1` blocks cross-process reads, `hidepid=2` hides Shield's `/proc` entries).

### How it works

```
Agent (inside namespace, dev user):
  claude --print "review this code"
  ↓
  Claude CLI reads ANTHROPIC_BASE_URL=https://127.0.0.1:3006/proxy/anthropic
  ↓
  Sends POST https://127.0.0.1:3006/proxy/anthropic/v1/messages
  with headers: content-type, accept (no x-api-key — agent doesn't have it)
  ↓

Shield proxy (port 3006, shield-runner user):
  1. Receives request on HTTPS (self-signed ECDSA cert)
  2. Reads req.socket.remoteAddress → 10.161.178.197
  3. Looks up: 10.161.178.197 → team "audit"
  4. Reads org secrets scoped to "audit" → finds ANTHROPIC_API_KEY
  5. Attaches: x-api-key: sk-ant-xxx
  6. Forwards to https://api.anthropic.com/v1/messages
  ↓

Anthropic API:
  Authenticates, generates response, streams SSE events
  ↓

Shield proxy:
  upstreamRes.pipe(res) — zero buffering, token-by-token streaming
  ↓

Agent:
  Receives streaming tokens in real-time
  Never saw the API key
```

### SSE streaming (zero buffering)

AI CLI tools stream responses via Server-Sent Events. A buffering proxy would kill the UX — output would dump all at once after 30+ seconds instead of streaming token-by-token.

The proxy uses Node.js `pipe()`:
```typescript
upstream.on('response', (upstreamRes) => {
  res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
  upstreamRes.pipe(res);  // Zero buffering — chunks flow as they arrive
});
```

The proxy runs on a dedicated `https.createServer` (port 3006), separate from Shield's Hono server (port 3005). This avoids patching Hono's response model and gives clean access to raw Node.js `IncomingMessage` / `ServerResponse` for streaming.

### HTTPS with self-signed certificate

AI SDKs enforce HTTPS validation. The proxy generates a self-signed ECDSA P-256 certificate on first boot:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256r1 \
  -keyout /etc/ellul/org-proxy-key.pem \
  -out /etc/ellul/org-proxy-cert.pem \
  -days 3650 -nodes -subj '/CN=127.0.0.1' \
  -addext 'subjectAltName=IP:127.0.0.1'
```

- **Private key:** `root:shield 640` — agent cannot read
- **Public cert:** `root:root 644` — agent CAN read (needs it for trust)
- **Stored in vault** — survives hibernate/wake/migration

The enforcer injects trust chain env vars:
```
NODE_EXTRA_CA_CERTS=/etc/ellul/org-proxy-cert.pem   (Node.js SDKs)
SSL_CERT_FILE=/etc/ellul/org-proxy-cert.pem          (Go/Rust)
REQUESTS_CA_BUNDLE=/etc/ellul/org-proxy-cert.pem     (Python requests)
```

No `NODE_TLS_REJECT_UNAUTHORIZED=0`. That would disable ALL TLS validation including for npm and git. The surgical approach adds our cert to the trust chain.

---

## The DNS Blackhole (Preventing Proxy Bypass)

A determined agent could try to bypass the proxy by:
1. Setting `ANTHROPIC_BASE_URL` back to `https://api.anthropic.com`
2. Hardcoding a Cloudflare IP and connecting directly

The DNS blackhole prevents both.

### How it works

In Phase 4 of namespace setup (system isolation), the namespace script creates a read-only `/etc/hosts` that maps AI provider domains to `127.0.0.0` (an unreachable address):

```
127.0.0.1 localhost
127.0.0.0 api.anthropic.com
127.0.0.0 api.openai.com
127.0.0.0 generativelanguage.googleapis.com
127.0.0.0 openrouter.ai
127.0.0.0 api.deepseek.com
127.0.0.0 api.mistral.ai
127.0.0.0 api.x.ai
127.0.0.0 api.groq.com
```

This file is bind-mounted from scratch space (read-only). The agent cannot modify it.

### Why IP-based blocking doesn't work

AI providers (Anthropic, OpenAI) sit behind CDNs (Cloudflare, Fastly). Their IP addresses rotate based on load balancing and geography. An iptables rule that blocks `104.18.2.1` is stale within minutes — the agent resolves a different IP and bypasses the block.

The DNS blackhole solves this: `/etc/hosts` takes precedence over DNS in glibc's NSS resolution order (`hosts: files dns`). The agent's `dig`, `curl`, `python requests`, and Node.js SDK all resolve `api.anthropic.com` to `127.0.0.0` before ever querying DNS.

### What about hardcoding a CDN IP?

Even if the agent somehow knows a current Cloudflare IP and connects directly, TLS Server Name Indication (SNI) verification fails on the provider side. The Cloudflare edge expects `Host: api.anthropic.com` in the TLS handshake, but the agent's TLS library sends the raw IP. The connection is rejected by the provider, not by our infrastructure — defense-in-depth at the protocol level.

### What's NOT blocked

Non-AI domains resolve normally via 8.8.8.8 (configured in `/etc/resolv.conf`). npm install, git clone, pip install, curl to any non-AI API — all work fine. The blackhole is surgical: only AI provider domains.

The blackhole only activates in BYOK mode. In default mode (CLI login sessions), there's no blackhole and no proxy — the agent calls providers directly with its own session.

---

## Org-Level Secrets

### Storage model

```
/etc/ellul/secrets/                      (root:shield 2770, SGID)
├── _global.env                            (existing per-project secrets)
└── orgs/
    └── {orgId}/                           (root:shield 2770, SGID)
        ├── manifest.json                  (root:shield 660) — metadata + team scopes
        ├── _org.env                       (root:shield 660) — org-wide secrets (all teams)
        ├── audit.env                      (root:shield 660) — audit team only
        ├── executive.env                  (root:shield 660) — executive team only
        └── ...
```

**Scoping rules:**
- `_org.env` — secrets available to ALL teams. Written when `scopes: []` (empty = all).
- `{team}.env` — secrets available to that team ONLY. Written when `scopes: ["audit"]`.
- A secret with `scopes: ["audit", "executive"]` is written to BOTH `audit.env` AND `executive.env`, NOT to `_org.env`.

This prevents scope leakage: a secret scoped to `["audit"]` physically does not exist in any file that the blockchain team's namespace could access through Shield.

**Reading:** `readOrgSecrets(orgId, "audit")` merges `_org.env` (org-wide) + `audit.env` (team-specific). Audit team gets both. Blockchain team calling the same function with its own scope gets `_org.env` + `blockchain.env` — different set.

### Encryption at rest

Secrets follow the existing zero-knowledge model:
1. Browser encrypts the secret value with the VPS's RSA-4096 public key (OAEP + AES-256-GCM)
2. API stores the encrypted envelope (never sees plaintext)
3. Encrypted envelope delivered to VPS via `agent-adapter-secret` command
4. Shield decrypts with `node.key` (root:shield 640)
5. Plaintext stored in vault env file (root:shield 660, inside 2770 SGID directory)

The API never has the plaintext. The agent can't read the env files (not in shield group). Only Shield (shield-runner user, in shield group) can read them.

### Delivery mechanism

Secret operations use a dedicated command type `agent-adapter-secret` (not the general `agent-adapter-execute`). The enforcer handles it as a DIRECT command:

```
API → enqueueAndWait("agent-adapter-secret", { secretOperation: { action: "store", ... } })
  ↓
Enforcer polls command queue → picks up agent-adapter-secret
  ↓
Enforcer generates internal JWT → calls Shield's internal API
  POST http://127.0.0.1:3005/api/internal/org-secrets/store
  ↓
Shield validates internal JWT → decrypts envelope → stores in vault
```

The internal JWT is generated by the enforcer (running as root) from `/etc/ellul/jwt-secret` (root:shield-ipc 640). The agent cannot read this file, cannot generate the JWT, and cannot call Shield's internal API.

---

## Org-Level Gates

The gate system controls what operations agents can perform: read logs, access secrets, read/write database, push git, deploy, execute commands. Each gate type has a TTL and requires either pre-configured permission or human approval.

### Three-level grant hierarchy

```
Thread-level:  {threadId}:{gate}      — per-request, ephemeral (in-memory only)
App-level:     app:{appName}:{gate}   — per-app, persisted to disk
Org-level:     org:{orgScope}:{gate}  — per-org scope, persisted to disk
```

Gate checks cascade: thread → app → org. If any level grants access, the gate is open. If none do, the gate request goes to the approval flow.

### Org-level permissions

The permissions file (`gate-permissions.json`) now has an `orgScopes` section:

```json
{
  "version": 1,
  "apps": {
    "myapp": { "git": { "permission": "allow_always" } }
  },
  "orgScopes": {
    "audit": { "git": { "permission": "allow_always" }, "db_read": { "permission": "allow_session" } },
    "engineering": { "git": { "permission": "ask" } }
  }
}
```

Permission check order: `never` (app or org) → `allow_session` (app or org) → `allow_always` (app or org) → `ask`. The `never` from either level takes absolute priority.

### Approval flow

When a gate permission is `ask`, the request is surfaced via SSE to whatever frontend is connected — the ellul.ai dashboard, the Paperclip UI, or any other client. The backend API is the same regardless of who calls it. The frontend shows the approval popup, the user clicks approve/deny, and the gate grant or denial is applied.

---

## Comms Channels (Hierarchical IPC)

Agent teams communicate via scoped filesystem channels. These are vault directories bind-mounted into namespaces at team-specific paths.

### Channel types

| Type | Example slug | How mounted |
|------|-------------|-------------|
| Team internal | `team-audit` | `/comms/team/` in audit namespace |
| Hierarchical | `hier-executive-audit` | `/comms/exec/` in audit, `/comms/audit/` in executive |
| Cross-team | `x-audit-blockchain` | `/comms/x-audit-blockchain/` in both namespaces |

### The bidirectional mount trick

A hierarchical channel is ONE vault directory mounted at TWO different paths:
- The audit team sees it at `/comms/exec/` (their line to leadership)
- The executive team sees it at `/comms/audit/` (their line to the audit team)

When the Audit Lead writes a report to `/comms/exec/`, the CEO reads it at `/comms/audit/`. Same physical directory. No routing infrastructure, no message broker, no pub/sub. The kernel handles it.

### Derivation from org chart

Channels are auto-derived from the organization hierarchy by `deriveChannels()`:
1. Every team gets a `team-{slug}` internal channel
2. For each non-executive team, trace the manager's `reportsTo` to find the parent team → create a `hier-{parent}-{child}` channel
3. Cross-team channels are created on demand via API

### Rotation

The enforcer's service check cycle (~60 seconds) runs `rotate_comms_channels()`:
- Enforces `rotationMaxFiles` per channel (default 100) — moves oldest to `archive/`
- Enforces `rotationMaxAgeDays` (default 7) — archives files older than the limit
- Monitors inode usage — warns at 80%

The `archive/` directory is in the vault but NOT mounted into namespaces. Agents never see archived messages. The adapter tracks `lastReadCursors` per agent per channel to avoid re-reading old messages.

---

## Vault Persistence

Everything survives across the full server lifecycle:

### First boot
1. Cloud-init provisions VPS, runs payload sections
2. Agent-org provisioning section writes config, creates vault comms dirs, pre-creates namespaces
3. Volume mounts, vault bind-mounts established
4. Shield starts, detects org mode, loads config

### Hibernate
1. Volume flushes, detaches from cloud server
2. Cloud server deleted (stop billing)
3. Volume (with entire vault) persists in cloud storage

### Wake
1. New cloud server provisioned (or claimed from warm pool)
2. Volume reattached
3. `wake-mount` restores all vault bind mounts
4. `.gid-map` restores UID/GID (shield, shield-runner, shield-ipc groups)
5. `fix_vault_ownership` restores file permissions
6. Shield starts, reloads org config, restores gate state

### Migration
1. Source VPS: `migrate-upload` tars entire home (including vault), encrypts with AES-256-GCM, uploads to R2
2. Target VPS: `migrate-download` decrypts, extracts, restores vault bind mounts
3. `.gid-map` ensures shield group GID matches on target
4. All secrets, gate state, permissions, comms channels transfer intact

**Zero changes to the vault infrastructure were needed.** Org secrets live at `/etc/ellul/secrets/orgs/` which is inside the existing `/etc/ellul` bind-mount chain. The self-signed proxy cert lives at `/etc/ellul/org-proxy-cert.pem`, same chain. The BYOK cache file lives in shield-data. All already vault-backed.

---

## Security Proof

### The 12-layer protection model

Layers 1-9 are inherited unchanged from Sovereign Shield:

1. **safeGitCmd** — force credential helper, block hooks, force TLS
2. **Credential sessions** — in-process memory, 2-minute TTL, UUID
3. **Shield group** — `root:shield 640/660/2770` on all secret files
4. **ptrace_scope=1** — agent (`dev`) cannot read `shield-runner` memory
5. **UID separation** — `shield-runner` vs `dev`
6. **hidepid=2** — agent cannot see Shield's `/proc` entries
7. **Kernel hardening** — `dmesg_restrict`, `kptr_restrict`, BPF disabled
8. **DAC (file permissions)** — enforced by kernel, not software
9. **Capability restrictions** — agent has no `CAP_SETUID`, `CAP_NET_ADMIN`, etc.

Layers 10-12 are new for org scope:

10. **Namespace identity** — team identified by deterministic veth IP (kernel-assigned, non-forgeable)
11. **DNS blackhole** (BYOK mode) — `/etc/hosts` read-only bind mount, glibc checks before DNS
12. **TLS SNI enforcement** (BYOK mode) — even hardcoded CDN IPs fail provider-side TLS verification

### Attack path analysis

**Can the agent read org secrets?**
- Path: `cat /etc/ellul/secrets/orgs/*/audit.env`
- Block: Directory is `root:shield 2770`. Agent not in shield group. Kernel DAC denies traversal.
- Path: `ptrace` into Shield process, read from memory
- Block: `ptrace_scope=1` requires ancestor relationship. Agent and Shield are siblings under systemd. Denied by kernel.
- Path: Read `/proc/{shield-pid}/environ`
- Block: `hidepid=2` hides Shield's proc entries from non-shield-group processes.
- Verdict: **Provably impossible.**

**Can the agent bypass the proxy?**
- Path: Set `ANTHROPIC_BASE_URL=https://api.anthropic.com` directly
- Block: DNS blackhole. `api.anthropic.com` resolves to `127.0.0.0` via read-only `/etc/hosts`.
- Path: Hardcode a Cloudflare IP
- Block: TLS SNI mismatch. Provider rejects connections where hostname doesn't match cert.
- Path: Modify `/etc/hosts` to remove blackhole
- Block: Bind-mounted read-only from scratch space. Agent can't remount (no root, no `CAP_SYS_ADMIN`).
- Verdict: **Provably impossible (BYOK mode).**

**Can the agent forge its team identity?**
- Path: Create a new namespace with a slug that hashes to a different team's IP
- Block: Agent is already trapped inside its namespace. Cannot create new namespaces (requires root + sudoers entry it doesn't have).
- Path: Change its own IP address
- Block: Requires `CAP_NET_ADMIN` which the agent doesn't have. The veth pair is configured by the root-owned namespace script.
- Verdict: **Provably impossible.**

**Can the agent activate BYOK mode to trigger DNS blackhole on other namespaces?**
- Path: Create `/etc/ellul/shield-data/.byok-active`
- Block: Shield-data directory is `shield-runner:shield-runner 700`. Agent (dev) cannot traverse.
- Path: Write to `/etc/ellul/shield-data/` via symlink attack
- Block: Directory is not agent-writable at any level. Symlinks into it are irrelevant — the target directory blocks access.
- Verdict: **Provably impossible.**

**Can the agent call Shield's internal API to store/read/delete secrets?**
- Path: `curl http://127.0.0.1:3005/api/internal/org-secrets/list`
- Block: Requires internal JWT in `Authorization` header. JWT generated from `/etc/ellul/jwt-secret` (root:shield-ipc 640). Agent not in shield-ipc group.
- Path: Read the internal token from `/run/shield/internal.token`
- Block: File is `root:shield-ipc 600`. Agent not in shield-ipc group.
- Verdict: **Provably impossible.**

---

## Implementation Files

### New files
| File | Purpose |
|------|---------|
| `sovereign-shield/src/services/org-mode.service.ts` | Org mode detection, namespace IP → team resolution, BYOK detection, config validation |
| `sovereign-shield/src/services/org-proxy.service.ts` | AI API proxy: provider routing, SSE streaming, self-signed cert generation |
| `apps/api/src/routes/paperclip/secrets.routes.ts` | Dashboard API for org secret CRUD |
| `apps/api/src/provisioning/sections/agent-adapter.ts` | Cloud-init provisioning: vault dirs, config, namespace pre-creation |

### Modified files
| File | Change |
|------|--------|
| `sovereign-shield/src/main.ts` | Org mode init, BYOK proxy startup on port 3006 |
| `sovereign-shield/src/routes/index.ts` | Documentation of proxy routing |
| `sovereign-shield/src/services/gate.service.ts` | `org:{scope}:{gate}` key format, `grantGateForOrg()`, persistence |
| `sovereign-shield/src/services/gate-permissions.service.ts` | `orgScopes` in permissions file, org-level `getPermission()` fallback |
| `sovereign-shield/src/services/secrets.service.ts` | Org secret paths, scoped write model, manifest management |
| `agent-namespace.ts` | BYOK: DNS blackhole, comms channels, cross-team rsync, `--max-size=50m` |
| `enforcer/lib/heartbeat.sh` | `agent-adapter-execute`, `agent-adapter-secret` handlers, BYOK proxy URL injection |
| `enforcer/lib/services.sh` | `rotate_comms_channels()` |
| `provisioning/profiles.ts` | `agent_adapter` profile with Shield re-enabled |
| `config/server-plans.ts` | `agent_adapter` tier ($25/mo, 4GB RAM) |

### Unchanged infrastructure
- `bind_mount_vault`, `fix_vault_ownership`, `.gid-map`, `persist_fstab_mounts`
- `wake-mount`, `migrate-upload`, `migrate-download`
- Kernel hardening (`security.ts`)
- Shield group, shield-runner user, shield-ipc group
- `ptrace_scope=1`, `hidepid=2`, `LimitCORE=0`
- safeGitCmd, credential sessions, gate TTLs
