# System overview

This page is the mental model. After this, the rest of v2 is detail.

## Three planes

ellul.ai has three operational planes. Confusing them is the most common source of bugs.

### 1. Control plane (`apps/api`)

Stateless Cloud Run service. Owns identity-of-record for users, servers, billing, fleet manifests, and gateway routing. **Never sees plaintext customer data, plaintext secrets, or plaintext code.** Stores wrapped LUKS keys, signed manifests, server status, but no decrypted material.

Implementation: Hono on Cloud Run, PostgreSQL (Cloud SQL), Cloudflare KV, R2 for artifact storage.

### 2. Edge plane (Cloudflare)

Cloudflare DNS, Worker (`packages/gateway`), and Authenticated Origin Pull (mTLS). Routes public traffic on `*.ellul.ai` and `*.ellul.app` to the right VPS. Looks up the destination from KV (`SERVER_ROUTES`), rewrites SNI via `resolveOverride`, and validates mutual TLS before talking to the origin Caddy.

### 3. VPS plane (`packages/vps` runtime + `apps/api/src/provisioning` setup)

The single-tenant Linux machine. Runs the customer's code, AI agent, and all enforcement. Has its own auth database (Sovereign Shield), its own LUKS-encrypted vault, its own gate decisions.

Critical property: **VPS does not trust API responses.** Heartbeat responses are discarded; commands flow as separately-signed envelopes through a queue, validated locally with ML-DSA-65.

### 3b. Sandbox plane (Incus orchestration layer)

An alternative runtime: QEMU/KVM virtual machines on dedicated bare-metal via Incus. Same service stack as VPS (Caddy, Shield, file-api, agent-bridge, enforcer), but provisioned in ~100ms from warm pool (or ~60s cold) via Incus REST API with TLS mutual auth.

The sandbox plane adds one new layer: **compute hosts** (dedicated bare-metal) running a route-manager daemon that does L4 SNI routing to individual VMs. Host never sees plaintext — raw TCP passthrough.

See [../incus/00-overview.md](../incus/00-overview.md).

## How a request flows

A user types `https://abc12345-srv.ellul.ai/api/file?path=README.md` in their browser:

1. **DNS.** Browser resolves `abc12345-srv.ellul.ai` to a Cloudflare proxied IP.
2. **TLS termination at edge.** Cloudflare presents the `*.ellul.ai` cert. TLS with the browser ends here.
3. **Worker.** Cloudflare invokes the gateway Worker (`packages/gateway/src/index.ts`). It extracts `abc12345`, looks up KV → `{"s":"active","o":"c0a80001"}`, builds origin host `o-c0a80001.ellul.ai`.
4. **resolveOverride.** Worker calls `fetch(originRequest, { cf: { resolveOverride: 'o-c0a80001.ellul.ai' } })`. Cloudflare rewrites SNI **and** Host header to `o-c0a80001.ellul.ai`. Origin DNS for that name (DNS-only, `proxied: false`) returns the VPS IPv4.
5. **mTLS at VPS Caddy.** Caddy (port 443) presents Cloudflare-issued origin cert; validates client cert against `cf-origin-pull-ca.pem`. Strict SNI matching requires `o-c0a80001.ellul.ai` to be in the site block — that is why `caddy-gen` reads `/etc/ellul/origin-tag` and includes it.
6. **Host restoration.** The Worker added `X-Forwarded-Host: abc12345-srv.ellul.ai`. Caddy's `@has_xfh` matcher rewrites Host back so `@code` / `@main` matchers work.
7. **forward_auth.** For protected routes, Caddy makes an internal sub-request to Sovereign Shield (`127.0.0.1:3005/_auth/session`). Shield validates the cookie, returns `200 + X-Auth-User`. Caddy injects the header into the upstream request.
8. **Upstream.** Caddy proxies to File API (`127.0.0.1:3002`), which trusts `X-Auth-User` (Caddy is the trust boundary), reads the requested file, returns it.

The reverse path is just the response heading back through Caddy → Cloudflare → browser.

## How an agent message flows

A user types in chat: "rename `foo` to `bar`":

1. **Browser → Caddy → Agent Bridge.** WebSocket message lands at agent-bridge (port 7700) after forward_auth.
2. **Per-thread session.** Agent-bridge looks up the thread's CLI session (claude / codex / gemini / opencode / main).
3. **Spawn into namespace.** `namespace-spawn.service.ts` invokes `sudo /usr/local/bin/ellul-agent-namespace enter ...`. The CLI runs inside the persistent project namespace (mount + PID + network isolated).
4. **Agent reads files.** Inside the namespace, only `/home/dev/projects/<thisProject>` is bind-mounted writable. Other projects are invisible (or visible read-only as `.shared/<slug>` if granted).
5. **Egress.** When the agent calls Anthropic API, packets traverse: namespace veth → host veth → iptables FORWARD → ipset allowlist → Cloudflare/anthropic.com.
6. **Tool calls.** Tools that need privileges (database read, secrets read, deploy) flow through MCP relay → agent-bridge → Sovereign Shield's gate API. Shield surfaces a popup to the user; user approves or denies.
7. **Output streams back.** stdout/stderr lines stream through the WebSocket to the browser as they arrive.

## How an update reaches the fleet

A developer ships a new version:

1. **`scripts/release.mjs publish`** runs preflight, builds bundles, uploads to R2, posts a manifest row to API, promotes to canary.
2. **API signs the manifest** with ML-DSA-65 (NIST FIPS 204 post-quantum). The JWS includes a `previousVersion` chain reference.
3. **Every VPS heartbeats** every 30s. After heartbeat, the enforcer fetches the current manifest. If 304 (same version), nothing happens.
4. **Chain check.** Enforcer verifies the JWS signature and that `manifest.previousVersion == localInstalledVersion`. Bootstrap exception: fresh boxes (local=0) accept any signed manifest.
5. **Stage and apply.** Each component (ellul-env, core-runtime, ide, mount-volume, crypto) is downloaded from R2, sha256-verified, unpacked to `/opt/ellul/releases/<component>/<version>/`, then atomically symlinked via `mv -Tf`.
6. **Restart and health-check.** Affected systemd units are restarted. Enforcer waits for `ActiveState=active`, `SubState=running`, `NRestarts` unchanged for 5 consecutive seconds.
7. **Self-update.** The enforcer is the OLD version during apply. After all other components, it execs the new ellul-env, replacing PID 1 in its systemd notify mode.
8. **Report.** Next heartbeat carries the new `appliedVersion`. CI's `release.mjs verify` polls fleet status until quorum, auto-rolling-back on hard failure.

## Identity boundaries

This is the single most important diagram for thinking about security:

```
┌──────────────────────────────────────────────────────────────────┐
│ root  ─────────────────────────────────────────────────────────  │
│   • enforcer (heartbeat, command execution, mounts, sudo helpers)│
│   • luks-boot, shield-prereq oneshots                            │
│   • caddy supervisor (drops to caddy user)                       │
│                                                                  │
│ caddy ─────────────────────────────────────────────────────────  │
│   • caddy reverse proxy on 443                                   │
│   • Owns /etc/caddy/ (2770), /run/caddy/admin.sock              │
│                                                                  │
│ shield-runner ─────────────────────────────────────────────────  │
│   • Sovereign Shield                                             │
│   • Owns /etc/ellul/shield-data/ (700)                          │
│   • Member of: shield, caddy, shield-ipc                        │
│   • Can read node.key (shield group), regenerate Caddyfile      │
│                                                                  │
│ dev / coder (the AGENT user) ───────────────────────────────── │
│   • file-api, agent-bridge, term-proxy, watchdog                │
│   • Member of: shield-ipc (read /run/shield), caddy (file-api)  │
│   • CANNOT read /etc/ellul/shield-data/, node.key, secrets.env  │
│   • CANNOT modify /etc/caddy/, /etc/iptables/                   │
│   • Locked out of: su, pkexec, newgrp, raw iptables, nsenter   │
│                                                                  │
│ postgres ──────────────────────────────────────────────────────  │
│   • PostgreSQL daemon                                            │
│   • Per-app roles created on demand: shield_<app>_owner/_app/_ro│
└──────────────────────────────────────────────────────────────────┘
```

**The trust boundary that matters most:** `dev` (the agent) cannot escalate to `shield-runner`, `caddy`, or `root`. Every defense — POSIX ACLs, immutable scripts, kernel ptrace_scope, namespace isolation — exists to enforce this.

## Where state lives

| State | Storage | Who owns it |
| --- | --- | --- |
| Users, servers, billing, manifests | API PostgreSQL (Cloud SQL) | Control plane |
| Per-server status, command queue | API PostgreSQL | Control plane |
| Routing (shortId → IP tag) | Cloudflare KV | Reconciler cron |
| Origin DNS records | Cloudflare DNS | Reconciler cron |
| Server identity (server-id, ML-DSA keys, tokens) | `/etc/ellul-bootstrap/` (boot partition, NOT vault) | VPS root |
| Auth (passkeys, sessions, audit log) | `/etc/ellul/shield-data/local-auth.db` (LUKS-vault, shield-runner only) | Sovereign Shield |
| App secrets | `/etc/ellul/secrets/<app>.env.enc` (root:shield 660) | Sovereign Shield |
| App data | PostgreSQL `shield_<app>` databases (LUKS-vault) | Sovereign Shield + agent |
| Customer code | `/home/<user>/projects/<slug>` (LUKS-vault) | Agent user |
| Vault layout | `$SVC_HOME/.ellul-vault/` bind-mounted to system paths | Enforcer (root) |

The split between `/etc/ellul-bootstrap/` (boot partition) and `/etc/ellul/` (vault) eliminates the chicken-and-egg of "we need identity to unlock the vault, but identity lives in the vault." Identity stays on the boot partition; user data goes in the vault. See [storage/01-vault-layout.md](../storage/01-vault-layout.md).

## Where to dig next

- **Component breakdown:** [02-component-map.md](./02-component-map.md)
- **Service inventory:** [03-vps-services.md](./03-vps-services.md)
- **Trust model in detail:** [05-trust-boundaries.md](./05-trust-boundaries.md)
