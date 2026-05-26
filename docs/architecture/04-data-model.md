# Data model

Where state lives, who owns it, what survives a reboot, what survives a hibernate, what survives a tier downgrade.

## Three storage tiers

1. **API PostgreSQL (Cloud SQL).** Identity-of-record for users, billing, servers, manifests, gateway state. Survives forever.
2. **Cloudflare KV + DNS.** Fast routing state for the gateway. Reconciled from API every 10 minutes.
3. **VPS-local.** Auth DB, secrets, app data. Encrypted at rest in LUKS. Survives reboot/wake; scoped to one server.

## API tables (high-level)

`packages/db/src/schema/` is the schema source. Drizzle migrations in `packages/db/migrations/`.

### Identity

| Table | Holds | Notes |
| --- | --- | --- |
| `users` | Customer accounts | Email, OAuth IDs, plan |
| `org_api_keys` | Org-scoped bearer tokens | SHA-256 hashed; for adapter auth |
| `sessions` | Web/CLI sessions | Cookie-bound |

### Servers

| Table | Holds | Notes |
| --- | --- | --- |
| `servers` | One row per provisioned/hibernated VPS | Status, infrastructure (cloudServerId, ipAddress), wrapped LUKS keys, tier, deployment model |
| `volumes` | Persistent storage records | volumeId, encryption mode, securityMode (`standard`/`enhanced`/`sovereign`), wrapped key |
| `server_commands` | Command queue | type, payload (often E2EE), status, claimed_by, expires_at |
| `agent_reports` | Per-VPS heartbeat reports | manifestVersion, appliedVersion, healthStatus |
| `cross_project_access` | A→B read grants | scope: read-only source snapshots |

### Incus orchestration

| Table | Holds | Notes |
| --- | --- | --- |
| `compute_hosts` | Dedicated bare-metal servers running Incus (QEMU/KVM) | Capacity tracking, scheduler state, TLS credentials, health |
| `incus_instances` | QEMU/KVM VM workloads | FK→servers (identity), FK→compute_hosts (placement), plan tier, warm pool state |

`servers.runtime` column (`"vps"` default, `"sandbox"`) determines which engine manages the server. See [../incus/01-data-model.md](../incus/01-data-model.md).

### Manifests

| Table | Holds | Notes |
| --- | --- | --- |
| `agent_manifests` | Signed fleet update bundles | version (monotonic), JWS, rolloutState |

### Org mode

| Table | Holds | Notes |
| --- | --- | --- |
| `orgs` | Orchestrator → VPS mapping | hierarchySnapshot, executionConfig |
| `org_teams` | Team → namespace | namespaceSlug, namespaceIp |
| `org_members` | Agent → team | adapterType, lastReadCursors |
| `comms_channels` | Inter-team channels | type: team_internal / hierarchical / cross_team |
| `comms_channel_mounts` | Channel → namespace mount | mountPath inside namespace |
| `org_runs` | Execution log | status, prompt, stdout, token usage |

See [products/04-agent-adapter.md](../products/04-agent-adapter.md).

### Billing

| Table | Holds |
| --- | --- |
| `subscriptions` | Stripe subscription mirror |
| `usage_events` | Metered usage |
| `invoices` | Invoice history |

## Cloudflare state

| Namespace | Key | Value |
| --- | --- | --- |
| `SERVER_ROUTES` | `<shortId>` | `{"s":"active","o":"<ipTag>"}` or `"sleeping"` |
| `SERVER_ROUTES` | `customHostname:<host>` | `{"shortId":"<shortId>"}` |

DNS records:

- `<shortId>-srv.ellul.ai`, `<shortId>-code.ellul.ai`, `<shortId>-dev.ellul.app` — proxied CNAMEs to CF CDN.
- `o-<ipTag>.ellul.ai`, `o-<ipTag>.ellul.app` — DNS-only A records (one per IP, shared across shortIds on that IP).

Reconciliation: `apps/api/src/cron/gateway-reconciler.ts` runs every 10 minutes (advisory lock 900_003).

## VPS-local state

### Boot partition (unencrypted root FS)

`/etc/ellul-bootstrap/` survives every reboot. Holds identity that must be available before the LUKS volume can be unlocked.

```
/etc/ellul-bootstrap/
├── server-id              (cloud-provider stable ID, root:root 644)
├── node.key               (ML-KEM-1024 private, root:shield 640)
├── node.pub.json          (ML-KEM-1024 public, root:root 644)
├── heartbeat.key          (ML-DSA-44 private signing, root:shield 640)
├── heartbeat.pub.json     (ML-DSA-44 public, root:root 644)
├── migration-signing.key  (ML-DSA-65 private, root:shield 640)
├── migration-signing.pub  (ML-DSA-65 public, root:root 644)
├── ai-proxy-token         (API bearer, root:shield 640)
├── volume-device          (e.g. /dev/disk/by-id/scsi-0HC_Volume_12345)
└── sovereign              (marker file, present iff tier is private_locked)
```

### Vault (LUKS-encrypted, mounted at boot)

`$SVC_HOME/.ellul-vault/` (e.g., `/home/dev/.ellul-vault/`). LUKS2 with `aes-xts-plain64`, mounted via `cryptsetup luksOpen` then `mount /dev/mapper/<name>`.

Bind-mounted to system paths after open:

```
.ellul-vault/
├── .initialized           (marker, ISO date of vault creation)
├── .gid-map              (UID/GID map for cross-server restoration)
├── etc/
│   ├── ellul/            → bind to /etc/ellul/
│   ├── caddy/            → bind to /etc/caddy/
│   ├── iptables/         → bind to /etc/iptables/
│   └── ssh/authorized_keys → bind to /etc/ssh/authorized_keys/
├── var/
│   ├── lib/
│   │   ├── ellul-shielded/  → bind to /var/lib/ellul-shielded/
│   │   └── postgresql/      → bind to /var/lib/postgresql/
│   └── log/
│       ├── ellul/        → bind to /var/log/ellul/
│       └── caddy/        → bind to /var/log/caddy/
└── opt/
    └── ellul/            → bind to /opt/ellul/
```

These nine bind mounts are the entire vault contract. The helper functions live in `packages/vps/src/services/daemons/enforcer/lib/heartbeat.sh:bind_mount_vault()`.

For more: [storage/01-vault-layout.md](../storage/01-vault-layout.md).

### Within `/etc/ellul/` (vault-bound)

Configuration and secrets:

- `security-tier` — text file: `standard` / `web_locked` / `private_locked`
- `jwt-secret` — HS256 signing key (root:shield-ipc 640)
- `ai-proxy-token` — already on boot partition; mirror stays here for vault consistency
- `domain`, `dev-domain`, `app-zone`, `platform-zone`, `console-origin`, `origin-tag`, `firewall-mode`, `deployment-model` — text files
- `secrets/<app>.env.enc` — encrypted app secrets (root:shield 660)
- `shield-data/` — Shield's private dir (shield-runner:shield-runner 700):
  - `local-auth.db` (SQLite)
  - `auth-secrets.json` (versioned HMAC keys)
  - `gate-state.json` (persisted gate grants)
  - `gate-permissions.json` (allow_always / never decisions)
  - `cross-project-access.json` (per-project read grants)
  - `preview-ports.json` (slug → preview port)
  - `org-config.json` (org mode config; presence activates org mode)
  - `attestation.json` (TPM quote, if hardware support)
  - `.agent-versions.json` (installed component versions)
  - `.agent-pending-commit.json` (mid-update marker, 120s window)
  - `.byok-active` (BYOK mode flag)
- `pinned-versions/{zeroclaw,opencode,caddy,lazygit}` — binary version pins

### Within `/var/lib/postgresql/` (vault-bound)

PostgreSQL 16 cluster data. Per-app databases `shield_<app>` with three-role hierarchy. See [storage/05-postgresql.md](../storage/05-postgresql.md).

### Within `/opt/ellul/` (vault-bound)

| Path | Purpose |
| --- | --- |
| `/opt/ellul/auth/` | Sovereign Shield bundle (server.js, node_modules) |
| `/opt/ellul/staging/<component>/<sha256>` | Manifest download staging |
| `/opt/ellul/releases/<component>/<version>/` | Unpacked release artefacts |
| `/opt/ellul/releases/<component>/current` | Symlink to live version |
| `/opt/ellul/coredumps/` | Redirected coredumps (root:shield-runner 2770) |
| `/opt/ellul/metadata.json` | Provisioning metadata (server-id, plan, etc.) |
| `/opt/ellul/volume-device` | Cached device path (set during volume-mount section) |

### Per-user home

`/home/dev/` (or `/home/coder/`). Project source, CLI tool config, OpenClaw workspace.

```
/home/dev/
├── projects/                       (project source — user's working code)
│   └── sbx-xxxxxxx/
├── .ellul-vault/                   (the LUKS-mounted directory; bind-mounts above)
├── .ellul/                       (per-thread CLI state)
│   └── threads/<threadId>/
├── .agents/                        (auth credentials per-tool)
│   └── .auth/{claude,codex,gh,npm}
├── .openclaw/                      (per-project OpenClaw workspace)
├── .ellul-cli-env                  (CLI env vars; sourced by .bashrc)
└── (standard dotfiles)
```

`.ellul-cli-env` sources at shell startup with CLI keys (ANTHROPIC_API_KEY, OPENAI_API_KEY); `secrets.env` (root:shield 660) is NOT sourced — it's read by Shield only.

### `/run/` (tmpfs, recreated each boot)

| Path | Purpose |
| --- | --- |
| `/run/shield/internal-<service>.token` | Per-service IPC token (HMAC) |
| `/run/shield/socket` | Optional Unix socket (mode 0777, trust enforced by HTTP layer) |
| `/run/caddy/admin.sock` | Caddy admin socket (caddy:caddy 2770) |
| `/run/.ns-<project>/anchor.pid` | Per-project namespace anchor PID |
| `/run/.ns-<project>/ns-cleanup.sh` | Generated namespace cleanup script |
| `/run/.ns-ready-<project>` | Namespace ready marker |
| `/run/.ns-lock-<project>` | Concurrent setup lock |
| `/run/ellul-enforcer.pid` | Enforcer PID (for SIGUSR1 push triggers) |
| `/run/ellul-luks-pending` | Boot encryption state |
| `/run/ellul-decrypted` | Decrypted state marker |

## What survives what

| Event | Boot partition | Vault | Memory | Cloudflare |
| --- | --- | --- | --- | --- |
| Reboot | yes | yes (auto-mounted) | no | yes |
| Hibernate | yes | yes (volume preserved) | no | KV updated to `sleeping` |
| Wake (warm pool) | replaced (new server) | yes (re-attached) | no | KV updated to `active` |
| Wake (cold provision) | new (fresh ML-KEM keys) | yes (re-attached, vault keys take precedence) | no | KV updated, new origin record |
| Tier downgrade (web_locked → standard) | yes | yes | no | yes |
| Sovereign transition (→ private_locked) | yes (sovereign marker added) | yes | platform key removed from LUKS slot 0 | yes |
| Block migration (server A → server B) | A's destroyed; B gets new | preserved (re-encrypted block-by-block) | no | yes (KV swapped) |

## Identity continuity across wake

A subtle but important property: when a hibernated server wakes via cold provision (not pool hit), it gets a **new cloud server** with **new ephemeral ML-KEM keys** in the boot partition. But the customer's identity should not change.

The mechanism:

1. Cold provision creates fresh server with new boot-partition keys.
2. `wake-mount` opens the LUKS volume using the API-delivered key.
3. The vault's `.initialized` marker confirms it's an existing vault.
4. `read-public-key` DIRECT command reads the **vault's** persistent ML-KEM key (not boot partition's) and registers it with the API.
5. The boot-partition key is used only for transient wake-flow E2EE.

So the customer's persistent identity (auth DB, sessions, gates) lives in the vault and rides along with the volume across hibernation cycles. The boot partition is just the bootstrap.

For the full hibernate/wake state machine: [lifecycle/02-hibernate.md](../lifecycle/02-hibernate.md), [lifecycle/03-wake.md](../lifecycle/03-wake.md).
