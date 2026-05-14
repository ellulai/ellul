# File API

Localhost service on port 3002. Code browser, file operations, app detection, preview management, real-time WebSocket events.

Source: `packages/vps/src/services/backends/file-api/`.

## Responsibilities

1. **File tree browsing.** Recursive scan with depth limits, gitignore filtering.
2. **File content read/write.** With path-traversal and symlink-escape checks. 500KB limit.
3. **App detection.** Scans for Next, Vite, Remix, Astro, Express, Django, Flask, Rails, etc. Returns framework, root dir, build commands.
4. **Preview management.** PM2-supervised dev servers on ports 4000-4099. Eviction on memory pressure.
5. **Context aggregation.** CLAUDE.md / AGENTS.md discovery and concatenation.
6. **Volume operations.** Daemon-call endpoints (`/mount`, `/flush`, `/trigger-sync`) authenticated with JWT.
7. **Migration support.** `GET /download` (tarball), `POST /pull` (initiate sync).
8. **Real-time WebSocket events.** chokidar file watcher, app-list changes, preview status, server status.

## Auth model

| Endpoint | Auth |
| --- | --- |
| `/api/files/*`, `/api/apps/*` | Caddy forward_auth → `X-Auth-User` header |
| `/api/internal/*` | HMAC headers from Shield (verified via `/run/shield/internal-file-api.token`) |
| Daemon calls (`/mount`, `/flush`) | JWT signed with `/etc/ellul/jwt-secret` (`purpose: 'daemon-call'`) |
| WebSocket `/ws` | Cookie `__Host-code_session` validated periodically |

## HMAC validation

Source: `packages/vps/src/services/backends/file-api/src/auth.ts:35-64`.

Caddy decorates upstream requests with auth headers + HMAC:

```
x-auth-user: <userId>
x-auth-tier: <tier>
x-auth-session: <sessionId>
x-auth-timestamp: <unix seconds>
x-auth-hmac: <hmac>
```

File-API validates:

1. Read internal token: `/run/shield/internal-file-api.token`.
2. Verify timestamp is fresh (±30s).
3. Compute expected HMAC: `crypto.createHmac('sha256', token).update(message).digest('hex')`.
4. Constant-time compare with provided HMAC.
5. On mismatch, invalidate cached token, force re-read.

The token rotates on each Shield boot, so reads happen frequently. Cache + invalidate-on-failure handles.

## WebSocket events

`/ws` endpoint. Auth via cookie. After connect, server emits events:

| Event | Payload |
| --- | --- |
| `file-changed` | `{ path, timestamp }` |
| `apps-changed` | `{ apps: [...] }` |
| `preview-status` | `{ preview: {...} }` |
| `server-status` | `{ status: {...} }` |

chokidar watches project directories. Diffs are broadcast to connected clients.

Polling fallback for filesystems that don't support inotify (rare in our setup).

## Preview management

PM2 manages dev server processes. Per app:

```
pm2 start <app-dir>/<entry> \
  --name preview-<sandboxId> \
  --max-memory-restart 512M \
  --env PORT=4012,...
```

PM2 daemon is `pm2-shielded` (separate from system PM2 to avoid agent visibility). Lives in `/etc/ellul/pm2-shielded/` (root:shield 2770 SGID).

File-api orchestrates:

- `start <app>` — invoke PM2 to start.
- `stop <app>` — invoke PM2 to stop.
- `restart <app>` — invoke PM2 to restart.
- `status` — query PM2 for current state.

When a port is needed, file-api allocates from 4000-4099 pool.

## Service unit

```ini
[Unit]
After=ellul-sovereign-shield.service
Wants=ellul-luks-boot.service
RequiresMountsFor=/etc/ellul /opt/ellul /etc/caddy

[Service]
User=dev
Group=dev
SupplementaryGroups=caddy shield-ipc systemd-journal
EnvironmentFile=/etc/ellul/heap-caps/fileApi.env
Environment=PORT=3002
ExecStart=/home/dev/.node/bin/node /usr/local/bin/ellul-file-api
Restart=on-failure
RestartSec=5
KillMode=mixed
OOMScoreAdjust=-1000
MemoryHigh=512M
ProtectSystem=strict
PrivateTmp=true
LimitCORE=0
ReadWritePaths=/home/dev /etc/ellul /etc/caddy /opt/ellul
```

`KillMode=mixed` is critical: lets in-flight subprocesses (npm install) survive a service restart.

`OOMScoreAdjust=-1000` prefers other processes when OOM-killing.

## Cross-references

- WebSocket events flow to dashboard: integration with `apps/console`.
- Auth headers: [../security/02-sovereign-shield.md](../security/02-sovereign-shield.md).
- Preview deployment: [../security/07-deploy-protection.md](../security/07-deploy-protection.md).
