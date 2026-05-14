# Preview System

How a user's dev server runs on a VPS, gets routed to the browser, stays
healthy, and surfaces state to the console and the agent.

For the deployment (prod) side — blue-green, gate tokens, siblings, — see
[PREVIEW-AND-DEPLOYMENT.md](./PREVIEW-AND-DEPLOYMENT.md). This doc covers
the preview (dev server) runtime specifically.

## TL;DR

A user's project runs as a `next dev` / `vite` / `rails server` / etc.
subprocess inside a per-project systemd unit. Caddy fronts the dev server
on `{shortId}-dev.ellul.app`, enforces auth via sovereign-shield, and
rewrites the `Origin` header on framework-reserved paths so each
framework's built-in cross-origin block doesn't bite HMR.

The control plane (file-api) owns the lifecycle: allocate port, start
unit, probe health, classify state, heal orphans, surface to the console
and to the agent via a tool the chat can call after edits.

Every failure mode has a distinct UI state. Silent-black is structurally
impossible — if the user sees nothing, something is actively mis-wired
and the agent's `preview_verify` tool will tell them where.

## Request Flow

```
Browser
 │  GET https://abc12345-dev.ellul.app/
 │
 ▼
Cloudflare ─ resolveOverride ─► o-{tag}.ellul.ai
 │
 ▼
Caddy (VPS, port 443)
 │
 │  @dev host abc12345-dev.ellul.app
 │    ├── forward_auth → sovereign-shield :3005
 │    │     (validates __Host-preview_session OR ?_preview_token)
 │    │     (validates Origin header via origin-allowlist middleware)
 │    ├── @framework path /_next/* /@vite/* /_nuxt/* /__webpack_hmr …
 │    │   request_header @framework Origin "http://127.0.0.1:{port}"
 │    └── reverse_proxy 127.0.0.1:{port}
 │
 ▼
Dev server (e.g. next-server on :4000)
 │  Running inside ellul-preview@{escaped-app-dir}.service
 │  Owned by SVC_USER (dev / coder), cgroup-limited (640 MB),
 │  restart-on-failure.
 ▼
User's code
```

## Layers

| Layer | Where | Responsibility |
|---|---|---|
| **Gateway edge** | Cloudflare Worker + Caddy | TLS, Host rewriting, forward_auth to shield, path-scoped Origin rewrite |
| **Auth** | sovereign-shield `:3005` | Session validation, preview-token grants, Origin allowlist |
| **Orchestrator** | file-api `:3002` | Port allocation, systemd unit lifecycle, health probe, orphan reconciliation, Caddy route writes |
| **Process supervisor** | systemd template unit `ellul-preview@<instance>.service` | Spawns dev server, restart-on-failure, cgroup limits, journal log capture |
| **Dev server** | User's framework (`next dev`, `vite`, `rails s`, etc.) | Runs the user's code. |
| **Agent observability** | agent-bridge `:7700` builtin tools | `preview_verify`, `restart_preview`, `install_deps` |
| **Console UI** | `apps/console` TabPreview | Iframe, state-specific UI renders |

---

## Lifecycle

### Start

`POST /api/preview/start { app }` (file-api) →

1. **Backpressure check** — memory + load average. If overloaded, reject
   with `backpressure` so the console can retry later.
2. **Ensure spec** — reads `.ellul/preview.json` (or infers from repo).
3. **Install gate** — if `node_modules` / runtime missing, kicks
   background install and returns `installing`.
4. **Listener check** — if the port is already bound, classify via
   `detectOrphan`:
   - **Managed unit owns it** → adopt, route Caddy, return
     `alreadyRunning`.
   - **Orphan we own** (same SVC_USER, known dev-server cmdline, unit
     inactive) → SIGTERM → SIGKILL → fall through to fresh start.
   - **Foreign listener** (different user / unknown cmdline) → adopt.
     User ran their own `npm run dev`; we don't kill it.
5. **Start unit** via `sudo ellul-preview-ctl start <escaped-instance>`.
6. **Write Caddy dev route** → reload via unix socket.
7. Return.

### Probe (two-phase)

`probePreview(appDir)` is called by the agent's `preview_verify` tool and
by health polling.

**Phase A — Liveness** (60s budget, 500ms backoff):
- TCP connect + HTTP HEAD.
- Returns on first 2xx/3xx/5xx (any HTTP response means alive).
- Tolerates Turbopack cold compile (can take 30-45s on a monorepo).

**Phase B — Correctness** (once liveness passes, single request):
- GET `/` with `Origin: https://{devDomain}` header.
- Inspects response body for framework block-page signatures
  (Next's "Blocked cross-origin request", Vite's "Blocked request.
  This host…"). Presence = `blocked` state.
- Hashes response body (first 8KB) into a short `contentHash` the agent
  can use to detect changes.

### State machine

```
                    ┌──────────────────┐
                    │      idle        │  no unit, no listener
                    └────────┬─────────┘
                             │ POST /api/preview/start
                             ▼
                    ┌──────────────────┐
                    │   installing     │  background dep install
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐       fail ≥3x
                    │    starting      │─────────────────┐
                    └────────┬─────────┘                  │
                             │ port bound + HTTP 2xx      │
                             ▼                            ▼
                    ┌──────────────────┐       ┌──────────────────┐
                    │      ready       │       │     crashed      │
                    └────────┬─────────┘       └──────────────────┘
                             │ HTTP 4xx/5xx persistent
                             ▼
                    ┌──────────────────┐
                    │      error       │  listening but failing
                    └──────────────────┘

Orthogonal split-brain state (port bound, unit NOT active):

                    ┌──────────────────┐
                    │     orphan       │  auto-heal fires for
                    └──────────────────┘  healable cases
```

The probe exposes a narrower enum for the agent: `warming | ok | blocked
| unreachable | orphan`.

---

## Cross-origin handling (why this matters)

Every modern dev server refuses to serve `/_next/*`, `/@vite/*`, etc.
when the `Host` sent by the browser doesn't match a built-in allowlist
(CVE-2024-28849 defense). Through our gateway, Host = the real dev
domain — not the framework's expected `localhost`.

Caddy solves this with a **path-scoped Origin rewrite**:

```caddyfile
@framework path /_next/* /@vite/* /@fs/* /@id/* /@react-refresh
              /__vite_ping /node_modules/.vite/* /_nuxt/* /_astro/*
              /_app/* /_kit/* /__webpack_hmr /sockjs-node/*
              /___graphql /__original-stack-frame
              /__webpack-dev-server__/*
request_header @framework Origin "http://127.0.0.1:{port}"
```

Critical implementation note: **this is a top-level `request_header`
directive, not `header_up` inside `reverse_proxy`**. Caddy 2.x silently
ignores named matchers on `header_up` directives — scope would collapse
and Origin would be rewritten on ALL requests, masking user-app CSRF
protections. Asserted by
`packages/vps/src/services/gateway/caddy-gen/handlers.integration.test.ts`
against real Caddy so this can't regress.

User app routes (their own `/api/*`, page routes) keep their original
Origin header — their CSRF defenses remain intact.

The canonical path list is `FRAMEWORK_DEV_PATHS` in
`packages/vps/src/services/shared/framework.ts`.

---

## Orphan reconciliation

An **orphan** is a split-brain state: a dev-server process is listening
on the preview port, but the managed systemd unit reports `inactive`.
Happens when:

- Someone kills the systemd-owned process directly (hot-patch, `pkill`).
- A previous boot left a leaked PID the new boot didn't clean up.
- Cloud-init race: unit exited but child forked before SIGTERM reached it.

`getPreviewHealth` used to return `phase: 'idle'` in this case — the
console rendered "dev server not running" even though the dev server was
serving the user's app correctly.

### Classification

`classifyOrphan(inputs)` is a pure function (no I/O) with a complete
decision matrix:

| pid | unit state | uid | cmdline | → reason |
|---|---|---|---|---|
| null | any | — | — | `no_listener` (not orphan) |
| alive | active | — | — | `unit_active` (not orphan) |
| alive | activating | — | — | `unit_activating` (not orphan) |
| alive | inactive | foreign | — | `foreign_user` (surface only) |
| alive | inactive | ours | unknown | `unknown_cmdline` (surface only) |
| alive | inactive | ours | dev-server | `orphan_healable` → heal |

The cmdline patterns are token-anchored to prevent false positives on
path substrings (e.g. `/usr/bin/my-next-app-helper` is NOT a "next"
match). See `DEV_SERVER_CMDLINE_PATTERNS` in `preview.service.ts`.

### Healing

`healOrphan(appDir)` is called from:

1. **`getPreviewHealth`** — background heal when a healable orphan is
   observed. UI shows `phase: 'orphan'` with recovery hint; next poll
   sees the port free.
2. **`startPreview`** — heals before spawning the new unit (port must
   be free to bind).
3. **`reconcilePortRegistry`** — boot-time sweep.
4. **`restartPreview`** — healing happens before the restart, so the
   new unit always lands on a free port.

Escalation:
1. SIGTERM, poll `/proc/{pid}` every 100ms up to 2s.
2. SIGKILL if still alive, same poll.
3. If neither cleared it (zombie / D-state) → return `healed: false`,
   surface to the user via the UI's recovery hint.

Foreign processes (different user) and unknown cmdlines are **never**
auto-killed. They're reported as `orphan` with an explanation so the
user can decide what to do.

---

## Auth & Origin allowlist

Every authenticated request to a shield-gated route passes through the
origin-allowlist middleware
(`packages/vps/src/services/auth/sovereign-shield/src/middleware/origin-allowlist.middleware.ts`):

- Origin header absent → allow (SSR, navigation, curl, localhost IPC)
- Same-origin → allow (URL-parsed compare of `X-Forwarded-Proto` +
  `X-Forwarded-Host` vs. the `Origin` header)
- In trusted exact list (`readAllowedOrigins()`) → allow
- Matches trusted pattern (`*.ellul.app`, `*.ellul.ai`, or manifest
  patterns) → allow
- Else → `403 { error: 'origin_not_allowed' }`

Trusted set comes from:
- `/etc/ellul/allowed-origins` — platform defaults (primary host, -dc
  variant, console)
- `/etc/ellul/custom-domain` — customer's custom domain
- `/etc/ellul/dev-domain` — `{shortId}-dev.ellul.app`
- `/etc/ellul/preview-origins.json` — `{ origins, patterns }` manifest

All four files are written by boot-config at provisioning.
`preview-origins.json` is `jq`-validated on write — malformed shapes
fail provisioning rather than reaching shield.

Session cookies + PoP + JWTs remain the primary auth boundary. Origin
check is advisory defense-in-depth against cross-site forged requests
that might pass cookie auth on older browsers lacking CHIPS support.

---

## Agent tool: `preview_verify`

When the user reports the preview is broken, black, or unchanged after
an edit, the agent is instructed to call `preview_verify({ project })`
**before** making any further code edits. The tool returns:

```
{
  ok: boolean,
  healthState: "ok" | "warming" | "blocked" | "unreachable" | "orphan",
  httpStatus: number | null,
  contentHash: string | null,  // sha256 prefix of response body
  warnings: string[],
  devDomain: string,
  port: number,
  durationMs: number,
  cached: boolean,
  ageMs: number
}
```

Decision guidance in the agent's system prompt:

- `ok` → edit landed; user is seeing something else (stale browser,
  wrong tab). Ask them to hard-refresh before editing.
- `warming` → dev server still compiling. Wait, don't rewrite.
- `blocked` or `orphan` → **platform problem, not user's code**. Tell
  them plainly and call `restart_preview`. Never edit speculatively.
- `unreachable` → server died. Call `restart_preview`.

Rate-limited 1 probe / 2s per project at agent-bridge, 3s result cache
at file-api. A chatty agent can't saturate the dev server.

This tool exists specifically so the chat can tell apart "my code is
wrong" from "the preview is wrong" — the spiral that prompted this
whole system.

---

## Console UI states

`TabPreview.tsx` maps every health phase to a distinct view. No phase
falls through to a generic placeholder — silent-black is impossible.

| phase | UI render |
|---|---|
| `idle` | "Live Preview — will appear once dev server is running" |
| `installing` | Spinner: "Installing dependencies..." with runtime name |
| `starting` | Spinner: "Starting dev server..." (unit activating, port not bound) |
| `compiling` | Spinner: "Building your {Framework} bundle" (port bound, first HEAD probe timing out during compile) |
| `ready` | Iframe rendering the app |
| `error` | Red panel: HTTP status + log tail + Restart button |
| `crashed` | Red panel: "Build Error" + log tail + Restart button |
| `orphan` | Amber panel: "Preview out of sync" + Restart button + orphanReason |

The preview URL is loaded with a `?_preview_token=…` query param so
cross-origin requests from the console to the dev domain don't bounce
through a login flow.

---

## Observability

`GET /api/preview/metrics` returns the full counter set:

```
healAttempted, healSucceeded, healExhausted,
openapiHealAttempted, openapiHealSucceeded, openapiHealExhausted,
gcPortsReclaimed, backpressureRejections, registryRebuilds,
orphansDetected, orphansHealed, orphansUnhealable, orphanHealFailed,
probeBlocked, probeWarming, probeOk,
verifyCacheHits, verifyCacheMisses,
uptimeMs, portsUsed, portsTotal, portsUtilization,
activeHeals, activeOpenapiHeals
```

Signals worth alerting on:
- `orphanHealFailed > 0` — zombie / D-state processes we can't clear.
  Manual intervention needed.
- `probeBlocked > 0` — framework cross-origin rewrite isn't reaching
  upstream. Check Caddy config + reload state.
- `backpressureRejections > 0` — host is load-shedding preview starts;
  investigate memory / load avg.

---

## Debugging runbook

### "The preview is black / nothing loads"

1. Agent: run `preview_verify({ project })`. Report `healthState`.
2. If `ok` → user's browser is stale or wrong tab. Hard-refresh.
3. If `warming` → dev server is compiling. Wait 30s and re-probe.
4. If `blocked` → platform cross-origin rewrite broke. Check:
   - `sudo -u caddy caddy validate --config /etc/caddy/Caddyfile`
   - `grep request_header /etc/caddy/app-routes.d/dev.caddy` — should
     see `request_header @framework Origin "http://127.0.0.1:{port}"`
   - If missing, trigger a `reconfigure-caddy-domain` to regenerate.
5. If `orphan` → file-api will auto-heal; if it doesn't clear within
   30s, SSH in and check `sudo systemctl status ellul-preview@*`.
6. If `unreachable` → the dev server died. Call `restart_preview`.

### "I made a code change, preview didn't update"

Same as above: agent must call `preview_verify` first. If `contentHash`
didn't change after the edit, the edit isn't being served — could be:
- HMR WebSocket failing (check browser console for WSS errors on
  `/_next/webpack-hmr`)
- Caddy not hot-reloading (should be sub-second via unix socket)
- Dev server cached the old module (rare; restart clears it)

### "preview_verify says orphan repeatedly"

The auto-heal isn't converging. Possible causes:
- Process is in uninterruptible sleep (SIGKILL can't clear it). Check
  `ps -ef` for `D`-state.
- `orphanHealFailed` counter in `/api/preview/metrics` will be
  non-zero.
- Remediate: reboot the VPS.

### "Everything says ok, user still sees blank"

The iframe itself is failing to load, not the dev server. Likely:
- Browser blocking third-party cookies (preview is on different origin
  than console). Check `Partitioned` cookie support.
- Restrictive CSP from user's dev server. Check response headers for
  `Content-Security-Policy: frame-ancestors …`.
- User is looking at the wrong tab.

---

## Provisioning contract

Boot-config (Linux/macOS) writes these files atomically at provisioning:

| File | Owner | Content |
|---|---|---|
| `/etc/ellul/domain` | root:root 644 | Primary VPS hostname |
| `/etc/ellul/dev-domain` | root:root 644 | `{shortId}-dev.ellul.app` |
| `/etc/ellul/console-origin` | root:root 644 | `https://console.ellul.ai` |
| `/etc/ellul/allowed-origins` | root:root 644 | One origin per line |
| `/etc/ellul/preview-origins.json` | root:root 644 | `{ origins, patterns }` — jq-validated |
| `/etc/ellul/custom-domain` | root:root 644 | Optional (customer domain) |

All required except `custom-domain`. Shield fails to boot if any required
file is missing or malformed. No runtime fallbacks — provisioning owns it.

---

## Key files

| File | Purpose |
|---|---|
| `packages/vps/src/services/backends/file-api/src/services/preview.service.ts` | Everything: lifecycle, probe, orphan, metrics |
| `packages/vps/src/services/backends/file-api/src/main.ts` | HTTP routes (`/api/preview/*`) |
| `packages/vps/src/services/gateway/caddy-gen/handlers.ts` | Initial dev route generator |
| `packages/vps/src/services/auth/sovereign-shield/src/middleware/origin-allowlist.middleware.ts` | Origin validation middleware |
| `packages/vps/src/services/auth/sovereign-shield/src/config.ts` | Trusted origins + manifest readers |
| `packages/vps/src/services/shared/framework.ts` | Framework detection + `FRAMEWORK_DEV_PATHS` |
| `packages/vps/src/services/shared/preview-types.ts` | Re-exports from `@ellul.ai/types` |
| `packages/types/src/preview.ts` | **Single source of truth** for all preview types |
| `packages/vps/src/services/backends/agent-bridge/src/services/code-mode/platform-tools.ts` | `preview_verify` + `restart_preview` builtin tools |
| `packages/vps/src/services/backends/agent-bridge/src/services/context.service.ts` | Agent system prompt (tells the agent when to call `preview_verify`) |
| `apps/console/src/components/dashboard/tabs/TabPreview.tsx` | UI, one render per phase |
| `apps/console/src/hooks/useCurrentApp.ts` | `PreviewStatus` type, real-time updates |
| `apps/api/src/provisioning/shell/boot-config/boot-config-linux.sh` | Writes + `jq`-validates `preview-origins.json` |

## Tests

| File | What it covers |
|---|---|
| `caddy-gen/handlers.test.ts` | Caddy route structure invariants (4 tests) |
| `caddy-gen/handlers.integration.test.ts` | Real Caddy + real upstream — asserts Origin rewrite on framework paths, preserve on user paths (7 tests, gates on `caddy` binary) |
| `auth/sovereign-shield/.../origin-allowlist.middleware.test.ts` | Full allow/reject matrix, pattern matching, same-origin reconstruction (24 tests) |
| `file-api/.../preview.service.test.ts` | Pure orphan classifier, false-positive rejections, live-subprocess signal escalation (33 tests) |

68 total. Run: `cd packages/vps && npx vitest run`.

## Related

- [PREVIEW-AND-DEPLOYMENT.md](./PREVIEW-AND-DEPLOYMENT.md) — production
  deployment (blue-green, gate tokens, siblings)
- [SANDBOX-FIX-PLAN.md](./SANDBOX-FIX-PLAN.md) — sandbox network isolation
- [GIT-PUSH-PROTECTION.md](./GIT-PUSH-PROTECTION.md) — the shield
  architecture the preview flow sits on top of
