# VPS service inventory

Every systemd service that runs on a customer VPS, in dependency order, with the user it runs as, the port it listens on, the configuration source, and the role it plays.

For request-flow context see [00-system-overview.md](./00-system-overview.md). For the runtime internals of each daemon see [`runtime/`](../runtime/).

## Service ordering

Boot dependency tree:

```
local-fs.target
  └─ ellul-luks-boot.service        (oneshot: open LUKS, mount vault)
     └─ ellul-shield-prereq.service (oneshot: create /run/shield, identity dirs)
        └─ network-online.target
           └─ caddy.service
              └─ ellul-sovereign-shield.service   (BLOCKING: 3 retries → fail-closed)
                 ├─ ellul-file-api.service
                 ├─ ellul-agent-bridge.service
                 ├─ ellul-term-proxy.service
                 ├─ ellul-perf-monitor.service
                 ├─ ellul-enforcer.service        (async, no Wants=)
                 └─ ellul-watchdog.service        (async)

ellul-warden.service                 (free tier only, before agent-bridge)
postgresql.service                   (started by enforcer when needed)
```

Sovereign Shield is the synchronous gate. If it fails its 3 startup retries, Caddy enters lockdown (every protected route returns 503) and provisioning continues without crashing — the enforcer self-heals on retry.

## Inventory table

| Service | Port (bind) | User : group | Supplementary groups | Source |
| --- | --- | --- | --- | --- |
| `caddy` | 443 (0.0.0.0), 80 | `caddy:caddy` | — | provisioned |
| `ellul-luks-boot` | — | `root` | — | `packages/vps/src/services/auth/sovereign-shield/bundle.ts:185` |
| `ellul-shield-prereq` | — | `root` | — | `packages/vps/src/services/auth/sovereign-shield/bundle.ts:152` |
| `ellul-sovereign-shield` | 3005 (127.0.0.1) | `shield-runner:shield-runner` | `shield`, `caddy`, `shield-ipc` | `packages/vps/src/services/auth/sovereign-shield/bundle.ts:142` |
| `ellul-file-api` | 3002 (127.0.0.1), 18790 | `dev` (or `coder`) : `dev` | `caddy`, `shield-ipc`, `systemd-journal` | `packages/vps/src/services/backends/file-api/bundle.ts:99` |
| `ellul-agent-bridge` | 7700 (127.0.0.1), 7702 (0.0.0.0) | `dev` : `dev` | `shield-ipc` | `packages/vps/src/services/backends/agent-bridge/bundle.ts:104` |
| `ellul-term-proxy` | 7701 (127.0.0.1) | `dev` : `dev` | — | `packages/vps/src/services/gateway/term-proxy/index.ts:29` |
| `ellul-enforcer` | — | `root` | — | `packages/vps/src/services/daemons/enforcer/bundle.ts` |
| `ellul-watchdog` | 7710 (127.0.0.1) | `dev` : `dev` | — | `packages/vps/src/services/daemons/watchdog/index.ts:25` |
| `ellul-perf-monitor` | — | `root` | — | `packages/vps/src/scripts/workflow/doctor/perf-monitor.sh` |
| `ellul-warden` (free) | 8080, 5353 (127.0.0.1) | dedicated `warden` | — | `packages/ironclad/warden/cmd/warden/main.go` |
| `ellul-preview@<name>` (template) | 4000–4099 (127.0.0.1) | `dev` : `dev` | — | `packages/vps/src/scripts/workflow/preview/instance-launcher.sh` |
| `ttyd@<session>` (template) | 7710–7799 (127.0.0.1) | `dev` : `dev` | — | dynamically allocated by agent-bridge |
| `postgresql` | 5432 (127.0.0.1) | `postgres:postgres` | — | system package |
| `ellul-ide` (governance only) | 3003 (127.0.0.1) | `dev` : `dev` | `shield-ipc` | `packages/vps/src/services/backends/ide/bundle.ts` |
| `ellul-gbrain` (opt-in, 8GB+) | 7704 (127.0.0.1) | `root` | — | `/opt/ellul/gbrain/` (by Garry Tan) |

## Port registry (canonical)

The single source of truth is `packages/vps/src/services/shared/ports.ts`. Build-time `assertNoPortCollisions()` fails if duplicates appear.

| Constant | Port | Bind | Reachable from |
| --- | --- | --- | --- |
| `FILE_API` | 3002 | 127.0.0.1 | Caddy forward_auth, enforcer with daemon JWT |
| `SOVEREIGN_SHIELD` | 3005 | 127.0.0.1 | Caddy forward_auth |
| `OPENCODE_API` | 4096 | 127.0.0.1 | Per-namespace (when enabled) |
| `AGENT_BRIDGE` | 7700 | 127.0.0.1 | Caddy WebSocket |
| `TERM_PROXY` | 7701 | 127.0.0.1 | Caddy WebSocket |
| `MCP_ENDPOINT` | 7702 | **0.0.0.0** | Per-project namespace veth only (iptables `ELLUL-NS-IN`) |
| `TERMINAL_PROXY_BACKEND` | 18790 | 127.0.0.1 | file-api internal terminal socket |
| `GBRAIN` | 7704 | 127.0.0.1 | agent-bridge MCP gateway only (opt-in) |

The only service binding `0.0.0.0` is the MCP endpoint, because per-project namespaces reach it via the host veth IP. Three layers protect it: (a) iptables `ELLUL-NS-IN` chain matches `-i ea-+` only, (b) per-project HMAC token validates calls, (c) catch-all DROP for external networks.

## Per-service detail

### `caddy`

The reverse proxy on 443. Provisioned via apt at image-build time; configured by `caddy-gen` at first boot and on every model/domain change.

- **Source of Caddyfile.** `caddy-gen` CLI (`packages/vps/src/services/gateway/caddy-gen/caddyfile.ts`). Reads runtime parameters from CLI args plus `/etc/ellul/origin-tag`, `/etc/ellul/platform-zone`, `/etc/ellul/app-zone`, `/etc/ellul/console-origin`, `/etc/ellul/custom-domain`.
- **mTLS.** TLS cert at `/etc/caddy/origin.crt` (for `*.ellul.ai`) and `/etc/caddy/origin-app.crt` (for `*.ellul.app`). Client CA is `/etc/caddy/cf-origin-pull-ca.pem`. `client_auth { mode require_and_verify }`.
- **Strict SNI.** Site block addresses include the origin hostname `o-<tag>.ellul.ai:443`. SNI mismatches return 421 (Misdirected Request).
- **Admin socket.** Unix socket at `/run/caddy/admin.sock`, owner `caddy:caddy 2770`. The agent (dev/coder) is NOT in the caddy group — cannot reload Caddy directly. Reload helpers run as shield-runner (which IS in caddy via SupplementaryGroups).
- **Forward auth.** Protected routes invoke a sub-request to `127.0.0.1:3005/_auth/session`. Shield returns `200 + X-Auth-User` (passed to upstream) or 401.

See [networking/04-caddy.md](../networking/04-caddy.md) for handler details.

### `ellul-luks-boot.service`

Oneshot service that opens the LUKS volume and bind-mounts vault paths. Defined in `packages/vps/src/services/auth/sovereign-shield/bundle.ts:185`. Runs before any service that needs the vault (almost all do).

For the mount logic see [storage/01-vault-layout.md](../storage/01-vault-layout.md) and the `wake-mount` DIRECT command in [runtime/06-direct-commands.md](../runtime/06-direct-commands.md).

### `ellul-shield-prereq.service`

Oneshot. Creates:

- `/run/shield/` (tmpfs runtime dir for IPC tokens)
- `/home/<svc>/.ellul-identity/` (where Shield reads/writes identity)
- `/etc/ellul/` skeleton if missing

Defined in `packages/vps/src/services/auth/sovereign-shield/bundle.ts:152`.

### `ellul-sovereign-shield.service`

The auth service. **Synchronous startup gate** for the whole stack.

- **3 startup retries.** First start can hit native-binding init delays (better-sqlite3). On 3 failures, Caddy is locked down (all protected routes return 503) and the enforcer continues — eventually retries.
- **Caddyfile regeneration.** On startup, Shield calls `sudo /usr/local/bin/ellul-caddy-gen` to regenerate Caddyfile based on current tier/domain/deployment-model. SupplementaryGroup `caddy` lets Shield write `/etc/caddy/Caddyfile`.
- **PoP challenges.** For WebSockets, Shield issues 5-minute challenges. Two consecutive PoP failures terminate the connection.

Endpoints, gates, and internals: [runtime/05-sovereign-shield-deep.md](../runtime/05-sovereign-shield-deep.md), [security/02-sovereign-shield.md](../security/02-sovereign-shield.md).

### `ellul-file-api.service`

Code browser, file ops, app detection, preview ctl, real-time WebSocket.

- **Auth.** Reads `X-Auth-User` from Caddy forward_auth (HTTP); WebSockets use HMAC-signed cookie validated via Shield's IPC token.
- **WebSocket events.** chokidar-based file watcher emits `file-changed`, `apps-changed`, `preview-status`, `server-status` to connected clients.
- **Daemon calls.** Enforcer calls file-api with a JWT signed by `/etc/ellul/jwt-secret` (`purpose: 'daemon-call'`) for volume operations.
- **`KillMode=mixed`.** Lets in-flight subprocesses (npm install, etc.) survive a service restart. Without this, restarting file-api during a long install would tear down the install.

See [runtime/04-file-api.md](../runtime/04-file-api.md).

### `ellul-agent-bridge.service`

The chat WebSocket and CLI orchestration daemon.

- **Session types.** `opencode` (HTTP/SSE to provider), `claude`, `codex`, `gemini` (CLI in tmux), `main` (pure shell).
- **Per-thread isolation.** Each chat thread gets isolated `~/.ellul/threads/<threadId>/` for CLI state.
- **Spawns into namespace.** `namespace-spawn.service.ts` invokes `sudo /usr/local/bin/ellul-agent-namespace enter ...`.
- **MCP relay.** Spawned as a subprocess (a separate binary, not inlined). Listens on `7702` (0.0.0.0). HMAC-token-authenticated per-project.
- **Interactive auth.** Spawns claude/codex/gemini login under PTY wrapper, surfaces tokens via SSE.

See [runtime/03-agent-bridge.md](../runtime/03-agent-bridge.md).

### `ellul-term-proxy.service`

Authenticates terminal WebSocket connections, routes to dynamic ttyd ports.

- **Auth paths.** `?_term_token=<...>` (single-use token validated via Shield) OR `_term_auth=<sessionId>` cookie (session validated via Shield).
- **Port cache.** TTL 60s. Reduces queries to agent-bridge.
- **CORS.** Allowlist: console.ellul.ai, ellul.ai, www.ellul.ai, self.

### `ellul-enforcer.service`

Bash daemon, root. The state engine of the VPS. Heartbeats every 30s, executes commands from the API queue, monitors service health, applies manifest updates, manages vault mounts.

Modular library set in `packages/vps/src/services/daemons/enforcer/lib/`:

- `constants.sh` — env vars, paths, feature flags
- `logging.sh` — structured logging
- `terminals.sh` — TTY/PTY management
- `security.sh` — tier detection, identity (owner.lock + chattr +i)
- `status.sh` — system reporting
- `enforcement.sh` — settings application, kill orders, tier enforcement
- `deployment.sh` — deployment model switching
- `agents.sh` — OpenClaw daemon telemetry
- `block-migrate.sh` — block migration upload/download
- `capabilities.sh` — capability advertisement
- `agent-sync.sh` — manifest fetch, signature verification, atomic apply
- `heartbeat.sh` — main loop (heartbeat + command poll)
- `services.sh` — service health and restart

Assembled at build time from the library modules into a single bash script by `bundle.ts`.

See [runtime/01-enforcer.md](../runtime/01-enforcer.md), [runtime/06-direct-commands.md](../runtime/06-direct-commands.md), [operations/03-hot-shipping.md](../operations/03-hot-shipping.md).

### `ellul-watchdog.service`

HTTP server on 7710. Runs interactive CLI auth sessions under PTY wrappers (`script(1)`), reports OpenClaw daemon health.

- `POST /agents/auth/start` — spawn `script -qfc "claude setup-token" /dev/null`
- `GET /agents/auth/<id>/events` — SSE stream of stdout/stderr
- `POST /agents/auth/<id>/input` — send user paste to stdin
- `POST /agents/auth/<id>/cancel` — kill session
- `GET /health` — overall health
- `GET /zeroclaw/status` — per-project daemon status

See [runtime/02-watchdog.md](../runtime/02-watchdog.md).

### `ellul-warden.service` (free tier only)

Go service in `packages/ironclad/warden/`. Two roles:

- **DNS resolver** (port 5353). Forwards or returns NXDOMAIN. Rate limit (50 q/10s free, 200 paid). Blocks tunneling-prone query types (NULL, TXT, ANY, MX, SRV, HINFO, NAPTR). Entropy-based detection for DNS tunneling (>40-char labels, Shannon entropy >3.5 bits/char).
- **Transparent proxy** (port 8080). Reads SNI from TLS ClientHello (no MITM). Blocks blacklisted domains (mining pools, tunnels, cloud APIs). Forwards otherwise.

Free tier iptables redirects ALL `coder`-user TCP to 8080 and DNS to 5353; everything else dropped.

Paid tier uses tunnel_guard mode with reduced restrictions but still redirects flagged traffic.

See [networking/05-iptables-warden.md](../networking/05-iptables-warden.md), [abuse-protection/02-egress-filtering.md](../abuse-protection/02-egress-filtering.md).

### `postgresql.service`

System PostgreSQL 16 (Ubuntu package). Configured for peer auth + scram-sha-256 with locked-down `pg_hba.conf`. Per-app databases (`shield_<app>`) with three-role hierarchy created on demand.

See [storage/05-postgresql.md](../storage/05-postgresql.md).

## Dynamic services

### Per-session `ttyd@<session>.service`

Allocated by agent-bridge from the 7710–7799 pool. Each terminal session gets its own ttyd. tmux-attached so browser refresh resumes the same terminal.

### Per-project `ellul-preview@<name>.service`

PM2-supervised dev server (Next.js, Vite, etc.) on a port from 4000–4099. Started by `ellul-preview-ctl` invocation from file-api or user. Idle eviction managed by file-api.

## Cgroup slice (free tier)

Free-tier services run inside `coder.slice` with:

- `CPUWeight=80` (relative weighting; effectively ~80% under contention)
- `MemoryHigh=75% RAM` (soft limit)
- `MemoryMax` not set (kill on hard OOM only)

Defined in `apps/api/src/provisioning/scripts/cgroup-slice.ts` and applied by adding `Slice=coder.slice` to systemd units.

## Identity in the boot tree

`/etc/ellul-bootstrap/` lives on the unencrypted root filesystem and survives every reboot. It holds:

- `node.key` — ML-KEM-1024 private (root:shield 640)
- `node.pub.json` — ML-KEM-1024 public
- `heartbeat.key` — ML-DSA-44 signing private
- `heartbeat.pub.json` — ML-DSA-44 signing public
- `migration-signing.key` / `.pub` — ML-DSA-65 for block migration
- `server-id` — stable cloud server identity
- `ai-proxy-token` — bearer token to API
- `volume-device` — device path for LUKS boot
- `sovereign` — marker file (sovereign mode active, do not auto-unlock)

These are NOT bind-mounted from the vault — they exist on the root FS. This eliminates the chicken-and-egg of "we need keys to unlock the vault but keys live in the vault." See [storage/01-vault-layout.md](../storage/01-vault-layout.md) for the full split.

## Configuration files

| Path | Owner : group | Mode | Purpose |
| --- | --- | --- | --- |
| `/etc/ellul/security-tier` | root:root | 644 | Current tier (`standard` / `web_locked` / `private_locked`) |
| `/etc/ellul/jwt-secret` | root:shield-ipc | 640 | HS256 key for internal JWT |
| `/etc/ellul/ai-proxy-token` | root:shield | 640 | Bearer token to API (read by Shield) |
| `/etc/ellul/domain` | root:root | 644 | Customer's main domain |
| `/etc/ellul/origin-tag` | root:root | 644 | Hex-encoded VPS IP (for Caddy SNI) |
| `/etc/ellul/firewall-mode` | root:root | 644 | `full_ironclad` / `partial_ironclad` / `relaxed` / `governance` |
| `/etc/ellul/secrets/<app>.env.enc` | root:shield | 660 | Encrypted app .env (read by Shield) |
| `/etc/ellul/shield-data/local-auth.db` | shield-runner:shield-runner | 600 | Auth SQLite |
| `/etc/ellul/shield-data/cross-project-access.json` | shield-runner | 600 | Per-project read grants |
| `/etc/ellul/shield-data/preview-ports.json` | shield-runner | 600 | Slug → preview port map |
| `/etc/ellul/shield-data/org-config.json` | shield-runner | 600 | Org mode config (if active) |
| `/etc/caddy/Caddyfile` | caddy:caddy | 664 | Reverse proxy config |
| `/etc/caddy/sites-enabled/*.caddy` | caddy:caddy | 664 | Per-app site blocks |
| `/etc/iptables/rules.v4` | root:root | 600 | Persisted iptables |

## What runs where (lookup table)

| If you want to find … | Look at |
| --- | --- |
| Listening sockets | `packages/vps/src/services/shared/ports.ts` |
| Systemd units | `bundle.ts` of each service |
| Provisioning sequence | `apps/api/src/provisioning/payload.ts:246` |
| What command does X | [runtime/06-direct-commands.md](../runtime/06-direct-commands.md) |
| Auth endpoint contract | [runtime/05-sovereign-shield-deep.md](../runtime/05-sovereign-shield-deep.md) |
| Caddy routing | `packages/vps/src/services/gateway/caddy-gen/handlers.ts` |
| Iptables rules | `packages/ironclad/packer/scripts/warden-iptables.sh` |
