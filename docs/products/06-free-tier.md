# Free Tier (Sandbox)

ellul.ai's free tier gives every user a persistent, serverless development environment with AI coding agents. It costs them nothing. Under the hood, it's a scale-to-zero VPS on DigitalOcean that is **mechanically identical** to the paid tier — same scripts, same services, same tools — with three enforcement layers that lock it down.

## Design Principle

The free tier is NOT a stripped-down paid tier. It's the **same server** with enforcement on top:

1. **Identity (Context)** — `coder` user (no sudo), CLAUDE.md says "You are running in a Sandbox"
2. **Network (Warden)** — MITM proxy blocks all write operations to the outside world
3. **Privilege (Caddy)** — `/etc/caddy/sites-enabled/` is `root:root 755`, sovereign-shield checks tier before writing routes

## Overview

| Property | Value |
|----------|-------|
| Engine | SandboxEngine (`engines/sandbox/`) |
| Provider | DigitalOcean (golden image, warm pool) |
| Server Size | `s-1vcpu-1gb` (1 vCPU, 1GB RAM, 25GB SSD) |
| User | `coder` at `/home/coder` (no sudo) |
| Workspace Limit | 500MB |
| Session Cap | 60 minutes (hard limit) |
| Idle Timeout | 2 minutes (browser heartbeat) / 15 minutes (legacy) |
| Security | Warden MITM proxy + command shims + cgroup limits |
| Networking | All POST/PUT/DELETE/PATCH to external blocked, git clone/pull allowed |
| App Deployment | Preview only (owner-authenticated, no public URLs) |
| SSH | Disabled |
| Root/Sudo | No (sudo/su/pkexec binaries removed) |

## What Users Get

Everything the paid tier has:
- Web Terminal (ttyd + tmux)
- AI Coding Agents: Claude Code, OpenCode, Codex, Gemini
- Workbench chat interface
- Code Browser (file explorer + git status)
- All ~50 ellul.ai scripts and tools
- Git clone/pull (bring code in from GitHub, GitLab, etc.)
- App preview on dev domain (owner-only access)
- Persistent workspace across sessions (via snapshot/restore)

## What's Enforced (Three Layers)

### Layer 1: Identity (No Privilege)
- **No sudo** — `coder` user, `sudo`/`su`/`pkexec` binaries removed
- **No SSH** — port 22 closed, no key management
- **Cgroup limits** — 80% CPU, 1.5GB RAM, 200 PIDs (via `coder.slice`)
- **SUID lockdown** — only `/usr/bin/passwd` and `/usr/lib/openssh/ssh-keysign` retain SUID
- **Sandbox CLAUDE.md** — AI agents told "You are running in a Sandbox"

### Layer 2: Network (Warden Hotel California)
- **All POST/PUT/DELETE/PATCH** to external domains → blocked
- **Git push** → blocked (content-type inspection)
- **Deploy APIs** → DNS blackholed (Vercel, Fly, AWS, GCP, Azure, etc.)
- **Tunnel services** → DNS blackholed (ngrok, cloudflare tunnels, etc.)
- **WebSocket to external** → blocked
- **GET URL length** → 2KB limit (prevents query-string exfiltration)
- **Bandwidth** → throttled to 500 KB/s

### Layer 3: Privilege (Caddy Lockdown)
- **`/etc/caddy/sites-enabled/`** — `root:root 755`, coder can't write
- **Sovereign-shield** — checks billing tier before writing route configs
- **Custom domains** — refused on free tier
- **`ellul-expose`** — runs through sovereign-shield which enforces tier

### Command Shims (UX, not security)
Shims in `/usr/local/bin/` show friendly upgrade messages. Warden is the hard backstop.
- `git push` → blocked (clone/pull/local ops allowed)
- `ssh`, `scp`, `rsync` (remote) → blocked
- `vercel`, `flyctl`, `netlify`, `heroku`, `aws`, `gcloud`, `az`, `railway`, `render`, `wrangler` → blocked
- `ngrok`, `cloudflared`, `bore`, `localtunnel`, `lt`, `expose` → blocked
- `npm publish` → blocked (install/run/build allowed)

## Architecture

```
+------------------------------------------------------------------+
|                     FREE TIER ARCHITECTURE                        |
+------------------------------------------------------------------+
|                                                                    |
|  ORCHESTRATOR (API)          VPS (DigitalOcean)                   |
|  ┌──────────────────┐       ┌──────────────────────────────────┐ |
|  │ SandboxEngine     │       │ Golden Image (pre-baked)         │ |
|  │  ├─ provision()   │       │  ├─ Node.js, ttyd, Caddy, tmux  │ |
|  │  ├─ hibernate()   │──────>│  ├─ Warden binary + CA cert     │ |
|  │  ├─ wake()        │       │  ├─ Startup Agent (systemd)     │ |
|  │  └─ upgrade()     │       │  └─ All ellul.ai services    │ |
|  │                    │       │                                  │ |
|  │ FreeTierManager    │       │ Runtime Injection:               │ |
|  │  ├─ idle detect    │       │  ├─ server-id, domain, tokens   │ |
|  │  ├─ hibernate cron │       │  ├─ billing-tier = "free"       │ |
|  │  └─ zombie sweep   │       │  └─ snapshot-id (if waking)     │ |
|  └──────────────────┘       │                                  │ |
|                              │ Warden Proxy (port 8080):        │ |
|                              │  ├─ GET allowed (code comes in)  │ |
|                              │  ├─ Git clone/pull allowed        │ |
|                              │  ├─ Git push + other POST blocked │ |
|                              │  ├─ Mining pools blocked          │ |
|                              │  └─ 500 KB/s bandwidth limit     │ |
|                              └──────────────────────────────────┘ |
|                                                                    |
+------------------------------------------------------------------+
```

## Security: Hotel California

The Warden proxy (`packages/ironclad/warden/`) enforces the "Hotel California" policy. All traffic from the `coder` user is redirected through Warden via iptables. Warden operates as a MITM proxy with its own CA certificate.

### Network Jail (iptables)

Applied by the startup agent when `FREE_TIER=true`:

| Rule | Effect |
|------|--------|
| IPv6 completely disabled | No IPv6 egress |
| Cloud metadata (169.254.0.0/16) blocked | Prevents DO metadata API access |
| Private networks blocked (10/8, 172.16/12, 192.168/16) | No lateral movement |
| All TCP redirected to port 8080 | Forces through Warden proxy |
| All DNS redirected to port 5353 | Forces through Warden DNS |
| ICMP, raw sockets, non-53 UDP dropped | No ping, no tunneling |

### Warden Proxy Rules

Configured in `packages/ironclad/warden/configs/rules.yaml`:

| Traffic Type | Rule |
|-------------|------|
| `*.ellul.ai` and `*.ellul.app` (all methods) | ALLOW |
| GET/HEAD/OPTIONS to non-blacklisted | ALLOW |
| Git clone/fetch/pull (upload-pack POST) | ALLOW |
| Git push (receive-pack POST) | BLOCK |
| All other POST/PUT/DELETE/PATCH to external | BLOCK |
| WebSocket upgrades to external | BLOCK |

### Blacklisted Domains

- **Crypto mining**: minergate, coinhive, nanopool, etc.
- **Cloud deploy APIs**: Vercel, Fly.io, Heroku, AWS, GCP, Azure
- **Tunnel services**: ngrok, cloudflare tunnels, localtunnel
- **Container registries**: Docker Hub, GHCR
- **DBaaS**: Supabase, Neon, PlanetScale
- **C2/paste sites**: pastebin.com

### Bandwidth Throttle

Token bucket rate limiter caps outbound bandwidth at 500 KB/s with burst capacity.

## Golden Image Provisioning

Free tier servers boot from a pre-baked golden image built with Packer (`packages/ironclad/packer/ellul-free-do.pkr.hcl`). This enables ~20-30s boot time vs 3-5 minutes for full cloud-init.

### Single Source of Truth

The golden image payload is generated by `packages/ironclad/scripts/generate-golden-payload.ts`, which imports the **same functions** as the paid tier's `payload.ts`. This guarantees mechanical parity — no drift between tiers.

**Two replacement strategies:**
- **Bash scripts** — contain `__PLACEHOLDER__` values (e.g., `__API_URL__`), sed-replaced by startup agent at boot using `|` delimiter (URL-safe)
- **JS service bundles** — read `process.env.ELLUL_*` at runtime via systemd `EnvironmentFile`. No placeholders in JS (avoids corrupting minified bundles)

### What's Baked In

Everything the paid tier has, pre-installed:

- Ubuntu 24.04 + system packages (Node.js 20, git, python3, build-essential)
- **All ~50 ellul.ai scripts** in `/usr/local/bin/ellul-*` (with placeholder values)
- **All JS service bundles** (file-api, agent-bridge, term-proxy, sovereign-shield, enforcer)
- **All systemd units** (10 services + coder.slice)
- NVM, pm2, dev tools (eza, zoxide, lazygit, opencode, btop, fzf)
- Configs: tmux, starship, bashrc, opencode, global gitignore
- Warden binary + root CA certificate
- Command shims (UX restriction messages)
- Sandbox CLAUDE.md context files
- Startup agent (13-step boot sequence)
- Fail2ban, UFW, SSH hardening, iptables abuse prevention
- SUID lockdown, filesystem hardening

### What's Injected at Runtime

Cloud-init writes `/opt/ellul/metadata.json` with runtime values. The startup agent handles the rest:

```json
{
  "server_id": "...",
  "api_url": "https://api.ellul.ai",
  "ai_proxy_token": "...",
  "jwt_secret": "...",
  "domain": "abc123-srv.ellul.ai",
  "deployment_model": "cloudflare",
  "cf_origin_cert": "...",
  "cf_origin_key": "...",
  "snapshot_id": "",
  "user_id": "...",
  "free_tier": "true"
}
```

### Build

```bash
# Step 1: Generate golden payload (from monorepo root)
cd packages/ironclad && npm run generate:golden

# Step 2: Build golden image
npm run packer:build-do
```

### Packer Provisioner Order

1. `install-base.sh` — Ubuntu, Node.js, Caddy, ttyd, coder user
2. `install-golden-payload.sh` — runs generated payload (all ~50 scripts + configs)
3. `install-packages.sh` — NVM, pm2, dev tools, npm globals
4. `install-services.sh` — all 10 systemd units + coder.slice
5. `install-warden.sh` — Warden Go binary
6. `install-ca.sh` — root CA for MITM inspection
7. `install-startup-agent.sh` — 13-step boot sequence
8. `install-shims.sh` — command restriction messages
9. `install-context.sh` — Sandbox CLAUDE.md files
10. `cleanup.sh` — security hardening (SUID audit, /proc hidepid, etc.)

## Scale-to-Zero Lifecycle

Free tier servers don't run 24/7. They hibernate when idle and wake on demand, using a snapshot system to preserve workspace state.

```
+------------------------------------------------------------------+
|                    SCALE-TO-ZERO LIFECYCLE                        |
+------------------------------------------------------------------+
|                                                                    |
|  User signs up → Provision from warm pool (instant)              |
|       |                                                           |
|       v                                                           |
|  [ACTIVE] ──── user coding, AI agents running ────┐             |
|       |                                             |             |
|       | idle 2min (heartbeat)                       | 60min cap  |
|       | idle 15min (legacy)                          |             |
|       v                                             v             |
|  [HIBERNATING] ── snapshot workspace (/home/coder)               |
|       |              tar + gzip → 4MB chunks → Neon DB           |
|       |              delete cloud server (billing stops)          |
|       v                                                           |
|  [HIBERNATED] ── server record remains, cloud server gone        |
|       |                                                           |
|       | user returns (POST /api/servers)                          |
|       v                                                           |
|  [HYDRATING] ── provision new server from pool                   |
|       |            download chunks from Neon → extract to /home   |
|       |            npm install (node_modules excluded)            |
|       v                                                           |
|  [ACTIVE] ── workspace fully restored                            |
|                                                                    |
+------------------------------------------------------------------+
```

### Idle Detection (FreeTierManager cron)

Runs every 5 minutes via `apps/api/src/cron/free-tier-manager.ts`:

| Check | Threshold | Trigger | Notes |
|-------|-----------|---------|-------|
| Browser heartbeat stale | 2 minutes | `lastBrowserHeartbeatAt` old | User closed tab |
| Hard session cap | 60 minutes | `sessionStartedAt` old | Cannot be bypassed |
| Legacy idle | 15 minutes | `lastActivityAt` old | Fallback when no heartbeat |

**Constants:**
- `MAX_CONCURRENT_HIBERNATIONS`: 3 (prevents API overload)
- `MAX_WAKE_CYCLES_PER_DAY`: 3 (prevents abuse)
- `SNAPSHOT_EXPIRY_DAYS`: 30 (stale snapshots auto-cleaned)
- `ZOMBIE_THRESHOLD_MS`: 10 minutes (retries stuck hibernations)

### Snapshot System

**Hibernate** (`packages/ironclad/startup-agent/hibernate.sh`):

1. Check workspace size (max 500MB uncompressed)
2. Tar + gzip `/home/coder` (excludes: `node_modules`, `.cache`, `__pycache__`, `.next`, `dist`, `build`, `.git/objects`, `*.log`)
3. Split tarball into 4MB chunks
4. Base64-encode + SHA256-checksum each chunk
5. Upload chunks to API: `POST /api/servers/{id}/snapshot-chunk`
6. Mark complete: `POST /api/servers/{id}/snapshot-complete`

**Hydrate** (`packages/ironclad/startup-agent/hydrate.sh`):

1. Download all chunks: `GET /api/servers/{id}/snapshot-chunks`
2. Reassemble (sort by chunkIndex, base64-decode, concatenate)
3. Extract tarball to `/home/coder`
4. Fix ownership: `chown -R coder:coder`
5. Run `npm install` if `package.json` exists

**Hydrate (paid server)** — also available via sovereign-shield workflow route (`POST /api/workflow/hydrate`) for cross-engine migrations:

1. Read config from `/etc/ellul/*` files
2. Determine target: `/home/dev` (paid) or `/home/coder` (free)
3. Download snapshot chunks from API
4. Extract + chown to correct user

### Startup Agent (13-Step Boot Sequence)

Systemd oneshot service (`packages/ironclad/startup-agent/startup-agent.sh`) that runs before user-facing services. All user services have `Requires=ellul-startup-agent.service`.

| Step | Action |
|------|--------|
| 1 | Load runtime config from `/opt/ellul/metadata.json` |
| 2 | Write `/etc/ellul/*` config files (server-id, api-url, billing-tier, domain, jwt-secret, ai-proxy-token, owner.lock) |
| 3 | Write `/etc/default/ellul` (EnvironmentFile for all systemd services) |
| 4 | Sed-replace `__PLACEHOLDER__` values in bash scripts (using `\|` delimiter, NEVER on JS bundles) |
| 5 | Write Caddyfile (cloudflare or direct model, with `import /etc/caddy/sites-enabled/*.caddy`) |
| 6 | Generate 4096-bit RSA keypair + register public key with API |
| 7 | Git config for coder user (gitignore, hooksPath, credential helper) |
| 8 | Replace domain placeholders in CLAUDE.md files |
| 9 | Enable Warden iptables (redirect all coder TCP→8080, DNS→5353) |
| 10 | Hydrate workspace from snapshot (if snapshot_id present) |
| 11 | Reload systemd daemon |
| 12 | Start all services (sovereign-shield first, then rest), validate Caddy |
| 13 | Report ready to orchestrator API |

## App Deployment (Preview Only)

Free tier users can deploy apps, but they're **preview only** — accessible only to the server owner.

### How It Works

When a free tier user runs `ellul-expose <name> <port>`, the sovereign-shield workflow route generates a Caddy config with `forward_auth`:

```caddyfile
app-name-abc12345.ellul.app:443 {
    tls /etc/caddy/origin.crt /etc/caddy/origin.key {
        client_auth {
            mode require_and_verify
            trusted_ca_cert <cloudflare-ca-base64>
        }
    }
    # Owner-only access — checks shield session
    forward_auth localhost:3005 {
        uri /api/auth/check
        header_up Cookie {http.request.header.Cookie}
    }
    reverse_proxy localhost:<port>
}
```

The `/api/auth/check` endpoint in sovereign-shield:
1. Parses the user's session (JWT or shield session cookie)
2. Reads `/etc/ellul/owner.lock` to get the server owner ID
3. Returns 200 if the requesting user matches the owner, 403 otherwise

Paid tier apps skip the `forward_auth` block — they're public.

### App Metadata

Stored at `~/.ellul/apps/<name>.json` with `isPreview: true` for free tier apps. The dashboard shows a "Dev Preview" badge.

## Free → Paid Upgrade

When a user subscribes (Stripe checkout), their workspace data carries over seamlessly. This is a cross-engine migration: SandboxEngine → SovereignEngine.

### Why Snapshot-Based (Not rsync)?

1. Home directories differ: `/home/coder` (free) vs `/home/dev` (paid)
2. Works for both active AND hibernated free servers
3. Reuses existing snapshot infrastructure
4. No need for cross-server SSH keys

### Trigger Points

1. **Stripe webhook** (`checkout.session.completed`): Detects free server, fires `upgradeFreeServer()` in background
2. **Server create endpoint** (`POST /api/servers`): Paying user with existing free server triggers upgrade instead of error

### Flow

```
User completes Stripe checkout
  → Webhook: checkout.session.completed
  → Detect user has free server
  → upgradeFreeServer(userId, newTier, region)

Step 1: Snapshot (if server is active)
  → enqueueAndWait(freeServer, "flush-volume")
  → Poll workspaceSnapshots until complete
  → If hibernated: use existing snapshot

Step 2: Provision paid server
  → provisionServer(userId, { tier: newTier, region })
  → Wait for status="active" + provisioningStep="ready"

Step 3: Transfer workspace via R2
  → Generate AES-256-GCM key + R2 presigned URLs
  → enqueueAndWait(source, "migrate-upload", { uploadUrl, encryptionKey })
  → enqueueAndWait(target, "migrate-download", { downloadUrl, encryptionKey })

Step 4: Finalize
  → Copy new server metadata to OLD server ID (preserves domain)
  → Delete new server record
  → Delete old cloud instance
  → Update DNS to new IP
```

### Failure Handling

- If migration fails after snapshot: restore free server to original state
- If migration fails after paid server provisioned: `cleanupFailedMigration()` deletes the new server
- Lock with `hibernationStatus: "hydrating"` prevents concurrent upgrades
- Critical alert sent on failure (manual intervention may be needed)

## Relevant Files

### API (Orchestrator)

| File | Purpose |
|------|---------|
| `apps/api/src/engines/sandbox/index.ts` | SandboxEngine class |
| `apps/api/src/engines/sandbox/hibernate.ts` | Hibernate/wake/forceDelete |
| `apps/api/src/engines/sandbox/buffer.ts` | Pool claim + assignment |
| `apps/api/src/engines/sandbox/upgrade.ts` | Free→Paid migration |
| `apps/api/src/cron/free-tier-manager.ts` | Idle detection + hibernation cron |
| `apps/api/src/config/server-plans.ts` | Free tier config (limits, lifecycle) |

### Ironclad (Free Tier Infrastructure)

| File | Purpose |
|------|---------|
| `packages/ironclad/scripts/generate-golden-payload.ts` | Golden payload generator (single source of truth) |
| `packages/ironclad/packer/ellul-free-do.pkr.hcl` | Golden image builder (DigitalOcean) |
| `packages/ironclad/packer/scripts/install-base.sh` | Ubuntu, Node.js, Caddy, ttyd, coder user |
| `packages/ironclad/packer/scripts/install-golden-payload.sh` | Runs generated payload (all scripts + configs) |
| `packages/ironclad/packer/scripts/install-packages.sh` | NVM, pm2, dev tools, npm globals |
| `packages/ironclad/packer/scripts/install-services.sh` | All 10 systemd units + coder.slice |
| `packages/ironclad/packer/scripts/install-shims.sh` | Command restriction shims |
| `packages/ironclad/packer/scripts/install-context.sh` | Sandbox CLAUDE.md files |
| `packages/ironclad/packer/scripts/cleanup.sh` | Security hardening (SUID, /proc, filesystem) |
| `packages/ironclad/startup-agent/startup-agent.sh` | 13-step boot sequence |
| `packages/ironclad/startup-agent/hibernate.sh` | Workspace snapshot + upload |
| `packages/ironclad/startup-agent/hydrate.sh` | Workspace download + restore |
| `packages/ironclad/warden/` | Go MITM proxy (Hotel California) |
| `packages/ironclad/warden/configs/rules.yaml` | Blocking rules (git, deploy, mining, tunnels) |

### VPS (Shared with Paid Tier)

| File | Purpose |
|------|---------|
| `packages/vps/src/provisioning/cloud-init.ts` | `generateGoldenImageCloudInit()` for metadata.json |
| `packages/vps/src/configs/docs/index.ts` | Tier-aware CLAUDE.md generators (Sandbox framing) |
| `packages/vps/src/services/sovereign-shield/src/routes/workflow.routes.ts` | Expose + hydrate endpoints (tier-checked) |
| `packages/vps/src/services/sovereign-shield/src/routes/session.routes.ts` | `/api/auth/check` (owner verification) |
