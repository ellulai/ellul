# BYOS (Bring Your Own Server)

Install the ellul.ai Sovereign Stack on your own hardware. Mac Mini first, Linux second.

## How It Works

```
Dashboard           User's Machine          API
   |                     |                   |
   |-- POST /byos/enroll ------------------>|  (generate token)
   |<-- { token, installCommand } ----------|
   |                     |                   |
   |  (user copies curl command)             |
   |                     |                   |
   |               curl | sudo bash -s -- --token ellul_...
   |                     |-- POST /byos/register -->|  (send hw info)
   |                     |<-- { serverId, code } ---|
   |                     |                   |
   |<-- SSE: byos_node_detected ------------|  (dashboard updates)
   |                     |                   |
   |                     |-- GET /servers/:id/install -->|  (download payload)
   |                     |   (runs provisioning)  |
   |                     |                   |
   |<-- SSE: provision_progress ------------|  (step-by-step updates)
   |                     |                   |
   |  Dashboard: "Your node is ready!"       |
```

## Pricing

- **$10/month** ($100/year)
- Tier ID: `byos_hosting`
- Engine: `sovereign` (always-on)
- Firewall: `relaxed` (no Warden, no iptables jail)

### What users get for $10/mo

- Managed dashboard + monitoring
- Auto DNS + SSL (`*.ellul.ai`)
- OTA stack updates (enforcer self-update)
- Web terminal + Workbench
- AI coding agents (OpenClaw, Claude, Codex, etc.)
- Full root access

### What users provide

- Their own server (Mac Mini, Linux box, etc.)
- Their own AI API keys (free models by default)

## Supported Platforms

| Platform | Status | Min Requirements |
|----------|--------|-----------------|
| macOS 13+ (Ventura) | Supported | Apple Silicon or Intel, 2GB RAM, 10GB disk |
| Debian/Ubuntu Linux | Supported | x86_64 or arm64, 2GB RAM, 10GB disk |

## API Endpoints

All mounted at `/api/byos`.

### `POST /api/byos/enroll` (authenticated)

Creates an enrollment token. Called from the dashboard.

**Response:**
```json
{
  "enrollmentId": "uuid",
  "token": "ellul_abc123...",
  "expiresAt": "2025-01-01T00:15:00Z",
  "installCommand": "curl -fsSL https://api.ellul.ai/api/byos/install-script | sudo bash -s -- --token ellul_abc123..."
}
```

Token expires in 15 minutes. SHA-256 hash stored in `byos_enrollment_tokens` table.

### `POST /api/byos/register` (bearer token)

Called by the bootstrap script running on the user's machine.

**Body:**
```json
{
  "os": "macOS 15.2",
  "arch": "arm64",
  "ram_mb": 16384,
  "cpu_cores": 10,
  "disk_gb": 500,
  "hostname": "mac-mini",
  "public_ip": "203.0.113.5",
  "platform": "macos"
}
```

**Response:**
```json
{
  "serverId": "uuid",
  "aiProxyToken": "...",
  "registrationCode": "ABC-123",
  "installUrl": "https://api.ellul.ai/api/servers/uuid/install"
}
```

### `GET /api/byos/status` (authenticated)

Polls enrollment status for the dashboard UI.

**Response:**
```json
{
  "status": "installing",
  "enrollmentId": "uuid",
  "serverId": "uuid",
  "serverInfo": { "os": "macOS 15.2", "arch": "arm64", "ram_mb": 16384 },
  "registrationCode": "ABC-123"
}
```

States: `pending` -> `detected` -> `installing` -> `ready`

### `GET /api/byos/install-script`

Serves the bootstrap bash script. Platform-detecting (macOS vs Linux).

## Database Schema

### New enum values

- `cloud_provider`: added `"byos"`
- `server_tier` / `plan`: added `"byos_hosting"`
- `platform`: new enum `("linux", "macos")`

### New columns on `servers`

| Column | Type | Purpose |
|--------|------|---------|
| `platform` | `platform` enum | Drives payload variant (linux/macos) |
| `byos_registration_code` | `text` | 6-char pairing code (ABC-123) |
| `byos_code_expires_at` | `timestamp` | Registration code expiry |

### New table: `byos_enrollment_tokens`

| Column | Type | Purpose |
|--------|------|---------|
| `id` | `text` PK | UUID |
| `user_id` | `text` FK | Owner |
| `token_hash` | `text` UNIQUE | SHA-256 of plaintext token |
| `status` | `text` | `pending` / `used` / `expired` |
| `server_id` | `text` FK nullable | Set when server registers |
| `server_info` | `json` | Hardware info from enrolling machine |
| `expires_at` | `timestamp` | 15 minutes from creation |
| `created_at` | `timestamp` | Default now() |

### Migration

Generated at `packages/db/drizzle/0000_slippery_wild_child.sql`. This is the initial migration (full schema). Apply with `pnpm db:push` for dev or `drizzle-kit migrate` for production.

## macOS Provisioning Details

### Pre-flight checks (`byos-preflight.ts`)

1. RAM >= 2GB, disk >= 10GB free
2. Port conflict detection (80, 443, 3002, 3005, 7681)
3. Stop conflicting services (nginx, apache)
4. Install Rosetta 2 (ARM64 only)
5. Install Xcode CLI tools (wait up to 5 min)
6. Install Homebrew as non-root user
7. Disable sleep: `pmset -a sleep 0 && displaysleep 0 && disksleep 0`

### User creation (`user.ts`)

Primary: `sysadminctl -addUser dev -fullName "ellul.ai Dev" -shell /bin/zsh -home /Users/dev`
Fallback: `dscl` manual creation with UniqueID, PrimaryGroupID, NFSHomeDirectory

### Packages (`packages.ts`)

All via Homebrew (must run as non-root):
```
node@22 git tmux curl jq openssl starship eza zoxide lazygit ttyd caddy ripgrep fzf tree bat btop
```

Global npm: `ws better-sqlite3 pm2`

### Application Firewall

Binaries added to `socketfilterfw` allowlist: `ttyd`, `caddy`, `node`

### Services (launchd plists)

All in `/Library/LaunchDaemons/`:

| Plist | Runs as | Purpose |
|-------|---------|---------|
| `ai.ellul.enforcer` | root | Heartbeat, health checks, enforcement |
| `ai.ellul.file-api` | dev | File tree API, workspace WebSocket |
| `ai.ellul.agent-bridge` | dev | Workbench chat, terminal sessions |
| `ai.ellul.term-proxy` | dev | Terminal WebSocket auth proxy |
| `ai.ellul.sovereign-shield` | root | Passkey auth, security tier management |
| `ai.ellul.caddy` | root | Reverse proxy, TLS termination |
| `ai.ellul.perf-monitor` | root | CPU/RAM/disk metrics |
| `ai.ellul.watchdog` | dev | Agent lifecycle, CLI auth management |

Every plist includes:
- `KeepAlive` + `ThrottleInterval=10` (prevents launchd crash-loop bricking)
- `EnvironmentVariables` with hardcoded PATH (`/opt/homebrew/bin:...`)
- `RunAtLoad` for boot persistence

### Enforcer platform helpers (`constants.sh`)

The enforcer bash daemon abstracts all platform differences via helper functions:

| Helper | Linux | macOS |
|--------|-------|-------|
| `svc_is_active` | `systemctl is-active --quiet` | `launchctl print system/` |
| `svc_start/stop/restart` | `systemctl` | `launchctl kickstart/kill` |
| `svc_enable/disable` | `systemctl enable/disable` | `launchctl load/bootout` |
| `run_as_user` | `runuser -l $SVC_USER -c` | `sudo -u $SVC_USER bash -c` |
| `get_listening_ports` | `ss -tlnH` | `lsof -iTCP -sTCP:LISTEN` |
| `get_public_ip` | `ip -4 route get 1.1.1.1` | `ipconfig getifaddr en0` |
| `fw_allow/deny/is_allowed` | `ufw allow/delete/status` | no-op (relaxed mode) |
| `file_mtime` | `stat -c %Y` | `stat -f %m` |
| `sed_inplace` | `sed -i` | `sed -i ''` |
| `b64_encode` | `base64 -w0` | `base64` |
| `get_ram_usage` | `free` | `vm_stat + sysctl hw.memsize` |
| `get_cpu_usage` | `top -bn2` | `ps -A -o %cpu` normalized by ncpu |

### boot-config platform handling

- `chattr +i` (Linux) -> `chflags uchg` (macOS) for immutable files
- `sed -i` (Linux) -> `sed -i ''` (macOS) for in-place edits
- `mkdir -p /etc/default` before writing EnvironmentFile (dir may not exist on macOS)
- Systemd service file sed replacements skipped on macOS
- `ellul-apt-install` lock skipped on macOS

## Console UI

### Enrollment dialog (`byos-enroll-dialog.tsx`)

5-phase state machine:

1. **generate** — Show requirements, "Generate Install Command" button
2. **waiting** — Copy-able curl command, countdown timer, polling `/api/byos/status` every 3s
3. **detected** — Shows hardware info (OS, arch, RAM, CPU), registration code for verification
4. **installing** — Progress spinner, polling every 5s
5. **ready** — Success state, link to dashboard

### Dashboard integration (`layout.tsx`)

The "no server" state has 3 tabs: **Serverless** / **Hosting** / **Your Server**

"Your Server" tab shows BYOS features and $10/mo price with "Add Your Server" button that opens the enrollment dialog.

## Route Guards

BYOS servers (`cloudProvider === "byos"`) are guarded in:

- **delete.routes.ts** — Skip cloud provider `deleteServer()`, just clean DB
- **rebuild.routes.ts** — Return error (can't rebuild hardware you don't control)
- **tier-change.routes.ts** — BYOS stays on `byos_hosting`
- **snapshot/rollback** — Not available for BYOS

## What's Needed to Go Live

### 1. Stripe Setup

Create products in Stripe dashboard:
- Product: "ellul.ai BYOS"
- Monthly price: $10/mo -> set env `STRIPE_PRICE_BYOS_HOSTING`
- Annual price: $100/yr -> set env `STRIPE_PRICE_BYOS_HOSTING_ANNUAL`

### 2. DNS

Point `get.ellul.ai` to the API server (or use `api.ellul.ai/api/byos/install-script` directly).

### 3. Database Migration

```bash
cd packages/db
pnpm db:push    # dev: push schema directly
# OR
pnpm db:generate && drizzle-kit migrate  # production: use migration files
```

### 4. Test on Real Hardware

**Mac Mini test checklist:**
- [ ] Generate enrollment token from dashboard
- [ ] Run curl command on Mac Mini
- [ ] Verify SSE events propagate (node detected -> installing -> ready)
- [ ] Verify all 8 launchd services start: `launchctl list | grep ellul`
- [ ] Verify heartbeat reaches API (check server status in dashboard)
- [ ] Verify web terminal works via ttyd
- [ ] Verify Workbench chat works via agent-bridge WebSocket
- [ ] Trigger a service crash — verify ThrottleInterval prevents permanent disable
- [ ] Reboot Mac Mini — verify all services survive reboot
- [ ] Verify no TCC popups block headless operation
- [ ] Verify Homebrew installs ran as non-root user
- [ ] Test server deletion (DB cleanup without cloud provider calls)

**Edge case tests:**
- [ ] Expired token rejection (wait 15 min)
- [ ] Double-enrollment prevention (use same token twice)
- [ ] Port conflict handling (run nginx on port 80 first)
- [ ] Already-installed detection (`/etc/ellul/metadata.json` exists)

## Key Files

```
packages/db/src/schema.ts                          # Enums, enrollment tokens table, platform column
apps/api/src/config/server-plans.ts                # byos_hosting tier definition
apps/api/src/routes/byos/index.ts                  # Enrollment API routes
apps/api/src/provisioning/payload.ts               # Platform-aware payload assembly
apps/api/src/provisioning/sections/byos-preflight.ts  # Pre-flight checks
apps/api/src/provisioning/sections/user.ts         # macOS user creation
apps/api/src/provisioning/sections/packages.ts     # Homebrew packages
apps/api/src/provisioning/sections/services.ts     # Launchd plists
apps/api/src/provisioning/sections/security.ts     # macOS security (chflags, Application Firewall)
apps/api/src/provisioning/sections/boot-config.ts  # Platform-aware config (sed, chattr/chflags)
apps/api/src/provisioning/sections/caddy.ts        # Platform-aware Caddy setup
packages/vps/src/services/enforcer/lib/constants.sh # Platform helpers (20+ functions)
packages/vps/src/services/enforcer/bundle.ts       # Enforcer script assembly + launchd plist generator
apps/console/src/components/byos-enroll-dialog.tsx  # Enrollment UI
apps/console/src/app/dashboard/layout.tsx          # "Your Server" tab
apps/api/src/billing/stripe.ts                     # BYOS pricing
```
