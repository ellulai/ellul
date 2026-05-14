# Preview & Deployment System

> **Note**: for the preview (dev server) runtime — lifecycle, state model,
> orphan reconciliation, Origin rewriting, agent tool, debugging — see
> [PREVIEW.md](./PREVIEW.md). This doc focuses on the deployment (prod) side.

How ellul.ai previews and deploys applications — from single-project roots to multi-package monorepos — with project isolation, framework detection, self-healing, and inter-package service discovery.

## Architecture Overview

```
                          Browser (Console UI)
                              |
               +--------------+--------------+
               |                             |
        [Preview Tab]                [Deploy Button]
               |                             |
               v                             v
          file-api                    file-api proxy
         (port 3002)                  /api/deploy-authorize
               |                             |
               v                             v
      preview.service.ts            sovereign-shield
     (PM2 + Caddy routes)           (port 3005)
               |                             |
          +----+----+               +--------+--------+
          |         |               |        |        |
       Primary  Companions     Gate Token  PM2    Caddy Config
       Preview   (monorepo)    Validation  Start   + Reload
          |         |               |        |        |
          v         v               v        v        v
       localhost  localhost      Blue-Green Deploy  *.ellul.app
       :4000      :4001-4099    (canary → promote)  routing
```

### Services

| Service | Port | Role |
|---------|------|------|
| **file-api** | 3002 | Preview management, WebSocket real-time updates, API proxy |
| **sovereign-shield** | 3005 | Deployment orchestration, gate tokens, Caddy config, credentials |
| **agent-bridge** | 3003 | AI agent WebSocket, deploy-authorized handler, health gates |

### Key Files

| File | Purpose |
|------|---------|
| `packages/vps/src/services/file-api/src/services/preview.service.ts` | Preview system core |
| `packages/vps/src/services/file-api/src/services/websocket.service.ts` | WebSocket real-time broadcasts |
| `packages/vps/src/services/file-api/src/main.ts` | HTTP endpoints, deploy-authorize proxy |
| `packages/vps/src/services/sovereign-shield/src/routes/workflow.routes.ts` | Deployment orchestration |
| `packages/vps/src/services/agent-bridge/src/main.ts` | Agent deploy handler, health gates |
| `packages/vps/src/services/shared/framework.ts` | Framework detection + start commands |
| `apps/console/src/components/dashboard/tabs/TabPreview.tsx` | Preview UI + companion controls |
| `apps/console/src/hooks/useCurrentApp.ts` | App data + real-time preview updates |
| `apps/console/src/components/server/ServerDeployments.tsx` | Deployment list + project grouping |

---

## Framework Detection

All preview and deployment flows share a common framework detection system (`shared/framework.ts`).

### Detection Logic

`detectFramework(appPath)` scans for marker files in priority order:

| Marker | Detected As |
|--------|-------------|
| `package.json` + `next` dep | Next.js |
| `package.json` + `nuxt` dep | Nuxt |
| `package.json` + `@sveltejs/kit` dep | SvelteKit |
| `package.json` + `astro` dep | Astro |
| `package.json` + `express` dep | Express |
| `package.json` + `fastify` dep | Fastify |
| `package.json` + `hono` dep | Hono |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `requirements.txt` / `pyproject.toml` | Python (FastAPI/Django/Flask) |
| `Gemfile` | Ruby (Rails/Sinatra) |
| `mix.exs` | Elixir (Phoenix) |
| `pubspec.yaml` | Dart |
| `composer.json` | PHP (Laravel) |
| ... | and more |

### Start Commands

`getStartCommand(framework, port, mode)` returns the appropriate command + env for either `'dev'` (preview) or `'production'` (deployment):

```
Next.js  → dev: "next dev -p $PORT"      prod: "next start -p $PORT"
Express  → dev: "node server.js"          prod: "node server.js"
FastAPI  → dev: "uvicorn $MODULE:app --host 0.0.0.0 --port $PORT --reload"
                                          prod: "uvicorn $MODULE:app --host 0.0.0.0 --port $PORT"
Go       → dev: "go run ."               prod: "./main" (after go build)
```

### Package Manager Detection

`detectPackageManager(appPath, rootDir)` walks up the tree to find a monorepo root lockfile:

- `bun.lockb` / `bun.lock` → bun
- `pnpm-lock.yaml` → pnpm
- `yarn.lock` → yarn
- `package-lock.json` → npm (default)

Returns mode-appropriate install commands (`npm install` for dev, `npm ci` for production).

---

## Preview System

### How Preview Works

When a user navigates to an app in the console, the preview system:

1. **Activates** — `setPreviewApp(directory)` is called, setting the active app
2. **Installs** — Dependencies are installed if missing (async for Node.js, sync for others)
3. **Starts** — A PM2 process runs the dev server on a dedicated port
4. **Routes** — Caddy reverse-proxy config is written and reloaded
5. **Monitors** — Health checks confirm the server is responding, then phase = `ready`

### PM2 Process Naming

Every preview process is named `preview-{directory}`:

| App Type | Directory | PM2 Name |
|----------|-----------|----------|
| Root app | `myapp` | `preview-myapp` |
| Monorepo package | `mono/packages/web` | `preview-mono/packages/web` |

### Port Management

Preview ports are allocated in the range **4000–4099**, one per project:

```
getProjectPort("myapp")             → 4000
getProjectPort("mono/packages/web") → 4001
getProjectPort("mono/packages/api") → 4002
```

- Port assignments persist across restarts via `~/.ellul/preview-ports.json`
- Atomic writes (write `.tmp` → `fsync` → `rename`)
- Registry rebuilt from `pm2 jlist` on corruption
- Warning logged at >80% port range utilization

### LRU Eviction

Maximum 5 concurrent preview processes. When the limit is reached:

1. Access timestamps are tracked in `previewLastAccess` map
2. Least-recently-used preview is evicted (PM2 delete + port release)
3. `evictions` metric incremented

### Preview Phases

```
idle → installing → starting → ready
                        ↓
                      error → crashed (after max restarts)
```

- **idle**: No preview running for this app
- **installing**: Dependencies being installed
- **starting**: PM2 process launched, waiting for HTTP response
- **ready**: Dev server responding to HTTP requests
- **error**: Process errored (auto-heal may attempt fix)
- **crashed**: Max restarts exhausted

### Health Checks

`getPreviewHealth(directory?)` performs actual port-level verification:

1. Read preview metadata file to get expected port
2. **Contamination guard gate 1**: File on disk must contain the expected port
3. **Contamination guard gate 2**: No Caddy write+reload in flight (`caddyWritesPending === 0`)
4. `curl -s -o /dev/null -w "%{http_code}" localhost:{port}` with 1s timeout
5. HTTP 2xx, 3xx, 404, 500 → healthy (server is responding)
6. Connection refused / timeout → not ready or crashed

### Self-Healing

When a preview enters error/crash state:

1. Error summary extracted from PM2 logs
2. POST to agent-bridge `/api/internal/preview-error` with error context
3. AI agent receives the error and attempts a code fix
4. Max 2 heal attempts per error hash, 60s debounce between attempts
5. Metrics: `healAttempted`, `healSucceeded`, `healExhausted`

OpenAPI self-healing works similarly — if `/openapi.json` returns 404 on a ready Express/Fastify app, the agent is notified to add an OpenAPI endpoint.

### Caddy Dev Route

Preview traffic routes through a Caddy config at `/etc/caddy/app-routes.d/dev.caddy`:

```caddy
route {
    forward_auth localhost:3005 {
        uri /_auth/code/pop-verify?required_scope=code
        copy_headers X-Auth-User
    }
    uri query -_shield_session -_preview_token
    reverse_proxy localhost:4000
}
```

- Forward-auth guard validates the code session (PoP signature for `web_locked` tier)
- Query parameters stripped before proxying
- Atomic file writes with promise-based mutex serialization
- Old config saved for rollback on reload failure

### Request Ordering

Rapid app switching is handled by request ordering:

```typescript
const requestId = getNextRequestId();
// ... async work ...
if (!isLatestRequest(requestId)) return; // superseded — abort
```

Only the latest request wins. Earlier requests detect supersession and abort gracefully.

---

## Monorepo Preview — Companion System

### What Are Companions?

Companions are secondary preview processes that run alongside the primary preview. In a monorepo with `frontend` and `backend` packages, the primary preview shows the frontend while a companion runs the backend on a separate port.

### How Companions Work

```
Primary:    preview-mono/packages/web     → port 4000 → /
Companion:  preview-mono/packages/api     → port 4001 → /~p/4001/
```

1. **Start companion** — `startCompanionPreview("mono/packages/api")`
2. **Project isolation enforced** — companion must be from the same monorepo root as primary
3. **Port allocated** — same `getProjectPort()` system as primary
4. **PM2 process started** — same install/start flow
5. **Caddy config regenerated** — companion `handle_path` blocks added BEFORE the primary route

### Companion Caddy Routes

```caddy
# Companion routes (matched first — top-down)
handle_path /~p/4001/* {
    forward_auth localhost:3005 { ... }
    uri query -_shield_session -_preview_token
    reverse_proxy localhost:4001 {
        header_up X-Forwarded-Prefix /~p/4001
    }
}

# Primary route (catch-all)
route {
    forward_auth localhost:3005 { ... }
    reverse_proxy localhost:4000
}
```

Path prefix `/~p/{port}` is chosen because:
- `~p` is unlikely to conflict with real app routes
- Port in the path makes each companion uniquely addressable
- `handle_path` strips the prefix before proxying (app sees `/` not `/~p/4001/`)

### Project Isolation

Companions are strictly scoped to the same monorepo root:

```typescript
const primaryRoot = primaryApp.split('/')[0];     // "mono"
const companionRoot = appDirectory.split('/')[0];  // "mono"
if (primaryRoot !== companionRoot) → reject
```

Switching the primary app to a different project automatically cleans up all companions from the old project.

### Companion Registry

Active companions are tracked in `~/.ellul/companion-registry.json`:

```json
[
  { "directory": "mono/packages/api", "port": 4001, "startedAt": 1709500000000 }
]
```

Atomic writes, loaded on startup, cleared when all previews stopped.

### Real-Time Updates

All preview state (primary + companions) is broadcast as a single `preview_all_status` WebSocket message:

```json
{
  "type": "preview_all_status",
  "data": {
    "primary": {
      "app": "mono/packages/web",
      "phase": "ready",
      "active": true,
      "port": 4000
    },
    "companions": [
      {
        "app": "mono/packages/api",
        "phase": "ready",
        "active": true,
        "port": 4001,
        "pathPrefix": "/~p/4001"
      }
    ]
  }
}
```

The frontend `useCurrentApp` hook processes this message to update both the primary preview query cache and the companions state array.

---

## Deployment System

### Deployment Flow Overview

```
1. Browser clicks Deploy
2. Console → POST /api/deploy-authorize → sovereign-shield creates gate token
3. Agent-bridge receives deploy-authorized event with gate token
4. Agent-bridge → POST sovereign-shield /api/workflow/expose with token
5. sovereign-shield validates gate, starts blue-green deployment
6. Caddy config written, domain assigned, app live
```

### Gate Tokens (Browser Authorization)

Deployments require a one-time gate token created by a browser button press:

```typescript
interface ActionGate {
  token: string;          // crypto.randomUUID() — 128-bit
  type: 'deploy' | 'git-push';
  project: string;        // Sanitized project name
  projectRoot: string;    // Top-level project for cross-project validation
  createdAt: number;
  expiresAt: number;      // 5-minute TTL
}
```

- Gate created via `POST /api/workflow/deploy-gate` (requires valid code session)
- Gate consumed once on `POST /api/workflow/expose` (one-time use)
- Max 40 gates in memory (GC on insertion)
- **Project validation**: `projectRoot` stores the top-level project name. On consume, `deriveProjectName(projectPath)` is compared against `projectRoot` to prevent cross-project deploy via a stolen token.

### Project Name Derivation

`deriveProjectName(projectPath, home)` extracts the top-level project:

```
/home/dev/projects/myapp                    → "myapp"
/home/dev/projects/mono/packages/web        → "mono"
/home/dev/projects/mono/packages/backend    → "mono"
```

Used for: gate validation, metadata tagging, sibling discovery.

### Blue-Green Deployment

Every deployment uses blue-green with a canary phase:

```
1. Canary Start
   - Start PM2 process on (port + 1) as "{name}-canary"
   - Wait for HTTP health (8s timeout, 500ms polling)
   - Port adaptation: if app binds to different port, detect and adjust

2. Health Check
   - curl localhost:{canaryPort} — accept 2xx/3xx as healthy
   - Crash detection via PM2 process status
   - Early bail on 5xx responses

3. Promotion
   - Stop old process on original port
   - Restart canary on original port with production name
   - Verify health on original port
   - Write Caddy config + reload

4. Rollback (on failure)
   - Delete canary process
   - Restart old process on original port
   - Verify old process is healthy
```

### PM2 Process Start

`startPm2Process(procName, port, projectPath, siblingUrls?)`:

1. Detect framework via `detectFramework()`
2. Get production start command via `getStartCommand(fw, port, 'production')`
3. Inject sibling URLs as env vars (if monorepo — see Service Discovery below)
4. Start via PM2:

```bash
pm2 start bash --name "myapp-backend" --cwd /home/dev/projects/mono/packages/backend \
  -- -lc "export PORT=8080 && export NODE_ENV=production && \
          export SIBLING_URL_FRONTEND=https://xxx-mono-frontend.ellul.app && \
          npm start"
```

### Port Allocation

`findFreePort(startPort)` iterates from the given port to 65535, skipping reserved ports. Checks actual port occupancy via `ss -tlnH`.

Port adaptation: if an app ignores the `PORT` env var and binds to a different port, the system detects this by walking the PM2 process tree and querying `ss -tlnp` for the actual listening port.

### Caddy Config for Deployed Apps

Each deployed app gets a route config based on the routing mode:

**Gateway mode** (behind Cloudflare): Handler-only configs in `/etc/caddy/app-routes.d/{name}.caddy`
**Direct mode**: Standalone site blocks in `/etc/caddy/sites-enabled/{name}.caddy`

Domain format: `{shortId}-{name}.ellul.app` — shortId is an 8-char hex prefix that MUST come first (gateway regex: `/^[0-9a-f]{8,}-/`).

### App Metadata

Each deployment writes metadata to `~/.ellul/apps/{name}.json`:

```json
{
  "name": "mono-backend",
  "port": 8080,
  "url": "https://c9aabc0c-mono-backend.ellul.app",
  "project": "mono",
  "projectPath": "/home/dev/projects/mono/packages/backend",
  "stack": "express",
  "summary": "Express server",
  "createdAt": "2026-03-01T00:00:00.000Z",
  "deploymentPath": "/home/dev/projects/mono/packages/backend"
}
```

### Deployment Metrics

```typescript
deployMetrics = {
  deploys, deploysSucceeded, deploysFailed,
  rollbacks, rollbacksSucceeded, rollbacksFailed,
  canaryPromotions, canaryPromotionsFailed,
  caddyReloadFailures, npmInstallFailures,
  snapshotFailures, lockContentions,
  gateOpened, gateConsumed, gateExpired, gateRejected,
}
```

---

## Monorepo Deployment — Project Isolation & Service Discovery

### Project-Prefixed Naming

When deploying a monorepo package, agent-bridge derives a project-prefixed name:

```typescript
// agent-bridge nameArg derivation
const packageName = appName || project.split('/').pop() || project;
const nameArg = project.includes('/')
  ? `${topLevelProject}-${packageName}`.toLowerCase().replace(/[^a-z0-9-]/g, '')
  : packageName;
```

| Project Path | PM2 Name | Domain |
|-------------|----------|--------|
| `myapp` | `myapp` | `c9aabc0c-myapp.ellul.app` |
| `mono/packages/frontend` | `mono-frontend` | `d4bbcc1a-mono-frontend.ellul.app` |
| `mono/packages/backend` | `mono-backend` | `a7eedd3f-mono-backend.ellul.app` |
| `other/packages/backend` | `other-backend` | `b2ffaa00-other-backend.ellul.app` |

No naming collisions between projects — `mono-backend` and `other-backend` are distinct.

### Gate Project Validation

When a deploy gate is consumed, the system validates the request targets the authorized project:

```typescript
if (gate.projectRoot && projectPath) {
  const derivedProject = deriveProjectName(projectPath, home);
  if (derivedProject && derivedProject !== gate.projectRoot) {
    return 403; // "Project mismatch: deploy authorized for X but targets Y"
  }
}
```

This prevents a compromised token from being used to deploy a different project.

### Service Discovery — Sibling URLs

When deploying a monorepo package, the system discovers all other deployed packages from the same project and injects their URLs as environment variables:

```
SIBLING_URL_FRONTEND=https://d4bbcc1a-mono-frontend.ellul.app
SIBLING_PORT_FRONTEND=8080
SIBLING_URL_BACKEND=https://a7eedd3f-mono-backend.ellul.app
SIBLING_PORT_BACKEND=8081
```

**How it works:**

1. `getSiblingDeployments(projectName, currentAppName, appsDir)` scans `~/.ellul/apps/*.json`
2. Filters for same `project` field, excludes self
3. Extracts suffix from name: `"mono-backend"` → `"BACKEND"`
4. Returns map of `suffix → { url, port, name }`
5. Env vars injected into PM2 start command

### Sibling Restart

After a successful deployment, all running siblings are restarted with updated env vars:

```
Deploy mono-backend
  → Discover siblings: mono-frontend (running)
  → Restart mono-frontend with:
      SIBLING_URL_BACKEND=https://a7eedd3f-mono-backend.ellul.app
      SIBLING_PORT_BACKEND=8081
```

This ensures all packages always have current URLs for their siblings.

### ellul.json Siblings Block

After deployment, the `ellul.json` in the project root is updated with sibling URLs:

```json
{
  "siblings": {
    "frontend": "https://d4bbcc1a-mono-frontend.ellul.app",
    "backend": "https://a7eedd3f-mono-backend.ellul.app"
  }
}
```

This provides a file-based discovery mechanism in addition to env vars.

### Project-Scoped Cleanup

`POST /api/workflow/remove-project` removes all deployments for a project in one operation:

1. Scan `~/.ellul/apps/*.json` for matching `project` field
2. For each: PM2 delete, Caddy config delete, metadata delete
3. Single Caddy reload at the end
4. Returns `{ removed: ["mono-frontend", "mono-backend"] }`

Proxied from file-api as `DELETE /api/deployments/project/:project`.

### Metadata Migration

On startup, `migrateAppMetadata()` backfills the `project` field for existing deployments that predate monorepo support:

```typescript
// For each .json in appsDir: if no project field, derive from projectPath
const project = deriveProjectName(meta.projectPath, home);
if (project) { meta.project = project; writeBack(); }
```

---

## WebSocket Real-Time Updates

### Connection

- URL: `wss://{serverDomain}/ws`
- Auth: For `web_locked` tier, code session token passed as query param
- Keepalive: Ping every 30s (prevents Cloudflare idle timeout at ~100s)
- Session validation: Every 5 minutes via sovereign-shield
- Absolute timeout: 24 hours (forces re-authentication)

### Message Types

| Type | Payload | Trigger |
|------|---------|---------|
| `connected` | `{ timestamp }` | On connection |
| `tree` | `{ project, tree: FileNode }` | File system change |
| `status` | `{ project, modified: [{status, file}] }` | Git status change |
| `apps_changed` | `{ hint: "refetch" }` | App directory added/removed |
| `server_status` | `{ cpuUsage, ramUsage, ... }` | Server metrics change |
| `preview_all_status` | `{ primary, companions[] }` | Preview state change |

### Change Detection

All broadcasts use hash-based change detection — messages are only sent when state actually changes:

```typescript
const hash = simpleHash(JSON.stringify(data));
if (hash !== lastHash) {
  lastHash = hash;
  broadcast(type, data);
}
```

### Polling Fallback

`fs.watch` is unreliable on some Linux VPS (inotify issues on virtualized filesystems). A 1-second polling fallback runs `computeAndBroadcast()` whenever clients are connected, ensuring changes are always detected.

### Frontend Subscription

The `RealtimeProvider` maintains a shared WebSocket connection. Components subscribe via `useRealtimeSubscribe()`:

```typescript
useRealtimeSubscribe(useCallback((message) => {
  if (message.type === "preview_all_status") {
    // Update primary preview in query cache
    // Update companions state array
  }
}, [deps]));
```

Reconnection uses exponential backoff with jitter (max 20 attempts, permanent failure after 10 quick-fails).

---

## Frontend

### Preview Tab (TabPreview.tsx)

The preview tab renders an iframe pointed at the VPS dev server. Key features:

- **Viewport switching**: Responsive / mobile / tablet / desktop
- **Monorepo package selector**: Dropdown listing nested packages with preview + deploy buttons
- **Companion panel**: Shows running companion processes with stop button
- **Error overlay**: Displays error summary + log tail when `phase === 'error'` or `'crashed'`
- **Switching state**: 30s timeout before showing fallback when switching apps

### Deployment Display (ServerDeployments.tsx)

Deployments are listed with project grouping when multi-package projects exist:

```
mono (2 packages)
  ├── mono-frontend  — Next.js — https://xxx-mono-frontend.ellul.app
  └── mono-backend   — Express — https://xxx-mono-backend.ellul.app

standalone-app — React — https://yyy-standalone-app.ellul.app
```

Each deployment card shows: name, port, stack badge, summary, creation time, and a link to the live URL.

---

## Root vs Monorepo — Summary

| Capability | Root Project | Monorepo Package |
|-----------|-------------|-----------------|
| **Preview PM2 name** | `preview-myapp` | `preview-mono/packages/web` |
| **Preview port** | 4000 | 4001 (per-package) |
| **Companion support** | N/A (single app) | Same-project packages as companions |
| **Deploy PM2 name** | `myapp` | `mono-frontend` (project-prefixed) |
| **Deploy domain** | `xxx-myapp.ellul.app` | `xxx-mono-frontend.ellul.app` |
| **Gate validation** | `projectRoot: "myapp"` | `projectRoot: "mono"` |
| **Service discovery** | N/A | `SIBLING_URL_*` env vars + ellul.json |
| **Sibling restart** | N/A | All siblings restarted with updated env |
| **Project cleanup** | Single `POST /remove` | Bulk `POST /remove-project` |
| **Caddy routing** | Single route | Primary + companion `handle_path` blocks |
| **Metadata** | `project: "myapp"` | `project: "mono"` |

Both paths share the same underlying systems (PM2, Caddy, framework detection, health checks, gate tokens). Monorepo support layers project isolation, naming prefixes, companion management, and service discovery on top.
