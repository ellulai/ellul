# Trust boundaries

Who trusts whom, where the boundaries lie, and what happens at each crossing. This is the threat model in concrete form.

## Principal list

The principals on a customer VPS, ordered by privilege:

1. **Linux kernel** — ultimate authority. Enforces ptrace_scope, namespace isolation, POSIX ACLs, seccomp filters.
2. **`root`** — enforcer, luks-boot oneshot, caddy supervisor. Privileged but narrow: enforcer's heartbeat is the only outbound network from `root`.
3. **`shield-runner`** — Sovereign Shield. Owns auth DB and all gate decisions. Reads from `/etc/ellul/shield-data/`. Cannot run arbitrary user code.
4. **`caddy`** — reverse proxy. Owns `/etc/caddy/` and admin socket. No code execution beyond Caddy itself.
5. **`postgres`** — PostgreSQL daemon. Sees app data; isolated from agent by peer auth + per-app role hierarchy.
6. **`dev` / `coder`** — the agent's user. Runs file-api, agent-bridge, term-proxy, watchdog. Where the customer's CLI sessions execute. **The threat actor.**

External principals:

7. **API (apps/api)** — control plane. Trusted to issue commands but commands are ML-DSA-65 signed and chain-checked locally; an evil API cannot inject arbitrary commands without VPS-side keys.
8. **Cloudflare** — TLS termination, KV, DNS. Trusted for routing but origin mTLS validates client cert (AOP).
9. **The user (browser)** — auth via passkey or JWT. WebSockets validated continuously with PoP signing.

## The agent boundary

The single most important boundary. `dev`/`coder` is what every customer-controlled code path executes as. The defenses:

### What `dev` cannot read

- `/etc/ellul/shield-data/` — owner `shield-runner:shield-runner 700`. POSIX denies.
- `/etc/ellul-bootstrap/node.key` — owner `root:shield 640`. `dev` not in `shield`.
- `/etc/ellul/jwt-secret` — `root:shield-ipc 640`. `dev` IS in `shield-ipc` but for `/run/shield/internal-*.token` only — jwt-secret has tighter ACL via the directory.
- `/etc/ellul/secrets/<app>.env.enc` — `root:shield 660`. `dev` not in `shield`.
- `/etc/caddy/` — `caddy:caddy 2770`. `dev` not in `caddy`.
- `/proc/<pid>/environ` of sibling processes — kernel enforces via `ptrace_scope=1`.
- `/proc/<pid>` of root-owned processes — kernel enforces via `hidepid=2`.
- Coredumps in `/opt/ellul/coredumps/` — owner `root:shield-runner 2770`.
- Other projects' source code (in per-project namespace) — not bind-mounted.

### What `dev` cannot do

- `su` — `chmod 000 /usr/bin/su`.
- `pkexec` — removed.
- `newgrp` — removed.
- Modify iptables — `chmod 700 /sbin/iptables`, `/usr/sbin/nft`.
- `nsenter`, `unshare` — `chmod 700`. Only root can switch namespaces.
- `sudo` arbitrary commands — sudoers narrowed to specific binaries (`/usr/local/bin/ellul-*`).
- Replace sudo-reachable scripts — they have `chattr +i` after provisioning.
- Write `authorized_keys` — `/etc/ssh/authorized_keys/<user>` is `root:shield 660`. Shield-runner manages keys; `dev` cannot.
- Modify Caddyfile — caddy directories are `caddy:caddy 2770`.
- Read kernel ring buffer — `kernel.dmesg_restrict=1`.
- Attach BPF programs — `kernel.unprivileged_bpf_disabled=1`.
- Read other UIDs' processes via `/proc` — `hidepid=2`.

### What `dev` CAN do

- Run code in `/home/dev/projects/<active project>` (writable inside namespace).
- Read public files (`/etc/ssl/certs`, `/usr/share`, etc.).
- Outbound network to allowlisted destinations (via Warden/iptables).
- Read its own files in `/home/dev/.ellul/`, `/home/dev/.agents/`.
- Read source code of explicitly-shared projects (`.shared/<slug>` snapshots, read-only).
- Spawn subprocesses inside its namespace (with seccomp-BPF restricting dangerous syscalls).
- Call internal APIs (file-api, agent-bridge, MCP relay) over localhost or namespace veth.
- Request gates via Shield's gate API — Shield decides; user approves or denies in dashboard.

## Inter-service IPC

When two VPS services talk over localhost HTTP, the trust model:

### Caddy → Shield (`/_auth/session`)

Caddy makes a sub-request to Shield's localhost endpoint. Trust: Shield is on `127.0.0.1`, agent cannot bind there as a non-root user (Shield holds the port). Shield validates the cookie and returns headers.

### Caddy → File API / Agent Bridge

Caddy decorates the upstream request with `X-Auth-User` from Shield's response. The upstream (file-api) trusts the header because Caddy is the trust boundary — Caddy is the only thing reaching upstream services on those ports (binds 127.0.0.1, agent can't bind there).

But: file-api's localhost server is reachable by anyone on the host who can connect to 127.0.0.1:3002, including the agent. To prevent the agent from spoofing `X-Auth-User`, file-api validates an **HMAC over the auth header set** using the IPC token in `/run/shield/internal-file-api.token`. The agent doesn't have `shield-ipc` group? No — agent IS in `shield-ipc` (so it can read `/run/shield`). But the per-service token files have stricter ACLs.

```
/run/shield/                      shield-runner:shield-ipc 2750  (SGID)
/run/shield/internal-file-api.token   shield-runner:shield-ipc 640
/run/shield/internal-agent-bridge.token  same
```

`shield-ipc` group lets services *read* their own token. The agent process running as `dev` is in `shield-ipc` *only if it's the systemd-managed service*. Manual shells run as `dev` inherit only their primary group (`dev`) — they need explicit `newgrp shield-ipc` (which is removed on free tier) or a setgid binary (none exist). So an interactive agent shell cannot read `/run/shield/internal-*.token`.

This is subtle and worth re-reading. The defense holds because:

- Token files are group-readable by `shield-ipc`.
- `dev` is in `shield-ipc` only for systemd-spawned services (file-api, agent-bridge), not interactive shells.
- A jailbroken file-api could read its own token, but that's the same boundary it already lives at.

**Known gap (acknowledged):** agent-bridge runs as `dev` and is in `shield-ipc`. If the agent jailbreaks the agent-bridge process (e.g., via a deserialization bug in chat handling), it can forge HMAC headers to file-api. The mitigation is hardening agent-bridge against application-level escapes; the kernel boundary doesn't prevent this. See [security/13-known-limitations.md](../security/13-known-limitations.md).

### Enforcer → File API

Enforcer is `root` and uses an HS256 JWT signed with `/etc/ellul/jwt-secret` (which `shield-runner` and root both write). Used for volume operations (`mount`, `flush`, `trigger-sync`). Daemon-call JWTs are short-lived (5-min) and carry `purpose: 'daemon-call'`.

### Enforcer → Sovereign Shield

Internal HTTP, IPC token authenticated. Used for git-setup, command sign-back, etc.

### MCP relay (port 7702, 0.0.0.0)

Reachable from project namespace veths only. Three layers:

1. iptables `ELLUL-NS-IN` chain matches `-i ea-+` interface only. External traffic dropped.
2. Per-project HMAC token validated by relay before processing.
3. Catch-all DROP in INPUT chain.

## VPS ↔ API boundary

Two channels:

### Heartbeat (VPS → API)

VPS posts telemetry every 30s. ML-DSA-44 signature on the request body authenticates the VPS. API verifies signature with the public key registered at first heartbeat (first-write-wins).

API responds 200 + status, but **VPS discards the response body** (`-o /dev/null`). Decisions don't come over heartbeat.

### Command queue (API → VPS)

Commands are placed in `server_commands` table. Enforcer polls `GET /api/servers/commands` after each successful heartbeat. Each command is a signed envelope:

```
{
  "id": "...",
  "type": "wake-mount",
  "payload": <opaque>,
  "_signed": {
    "alg": "MLDSA65",
    "publicKey": "...",
    "signature": "...",
    "metadataHash": "...",
    "payloadHash": "..."
  },
  "_e2ee": true,
  "_pqc": true
}
```

Verification:

1. ML-DSA-65 signature over metadata + payload hash. Verified locally with platform's signing public key embedded at provisioning time.
2. If `_e2ee`, decrypt payload locally. Hybrid KEM (ML-KEM-1024 + AES-256-GCM) using the VPS's `node.key`.
3. Reject on signature failure or decryption failure. Report rejection back to API.

The API never holds the VPS's private key; only the VPS can decrypt commands sent to it.

### Manifest (signed)

Fleet update manifests are ML-DSA-65 signed with the platform's signing key (held in Cloud Secret Manager, not on disk). Verified locally with `ellul-crypto verify`.

## Cloudflare boundary

Cloudflare is trusted for:

- TLS termination at the edge (clients see Cloudflare cert).
- Wildcard DNS for `*.ellul.ai`, `*.ellul.app`.
- KV and DNS for routing.
- Worker logic (gateway routing, custom domain mapping).
- Mutual TLS to origin (Authenticated Origin Pull).

Cloudflare is NOT trusted for:

- Reading customer code or data. End-to-end TLS can be enabled, and Cloudflare has full TLS visibility, but the platform's threat model treats Cloudflare as a trusted partner — not an attacker. Customers needing zero-trust to Cloudflare should consider direct deployment mode (no Cloudflare).

If Cloudflare is compromised:

- Routing could be redirected.
- The origin still validates the AOP client cert. A different client (not Cloudflare) cannot connect to origin without the cert.
- Customer JWT cookies have `Secure` and `HttpOnly`; cookie stealing requires browser-side compromise too.

## User boundary

Users authenticate via:

- **Standard tier:** username/password OR passkey OR Google/GitHub OAuth (all flow through API → JWT).
- **web_locked:** passkey only. PoP key generated per-session in browser. Continuous WebSocket challenges every 5 minutes.
- **private_locked:** same as web_locked plus LUKS unlock requires user passkey (no platform fallback).

Sessions are long-lived (24h absolute) but PoP makes stolen cookies useless without the matching browser hardware.

## Cross-project boundary

Within a single VPS, multiple projects exist as separate namespaces. The agent in project A by default cannot:

- See files in project B.
- See processes in project B.
- Reach project B's network namespace.

If user grants `cross_project_access` (A → B, read-only):

- A's namespace gets a rsync snapshot of B's source code at `.shared/<slug>` (excluded patterns: `.env*`, credentials, `node_modules`, `.git/objects`, etc.).
- A still cannot read B's secrets, DB, or live state.

Critically: **gate decisions are project-scoped.** If A has read access to B's source and the agent in A tries to request `database:read` against B, the gate is auto-denied at L3 (Shield's gate-scope-check.ts). See [security/08-cross-project-isolation.md](../security/08-cross-project-isolation.md).

## What gets logged

Tamper-evidence is via hash-chained audit log in Shield's SQLite. Each row contains `prev_hash` and `hash`, forming a chain that detects modification.

Logged events:

- Login attempts (success/failure).
- Tier transitions.
- Gate requests, grants, denials.
- Cross-project scope denials.
- Sensitive command executions.
- Service health degradations.

Logs are vault-bound. Forensic analysts can reconstruct the chain by reading from the latest entry backward.

## Threats deliberately out of scope

- **Compromised root.** If `root` is compromised on the VPS, the kernel's defenses don't help. Mitigation is keeping the kernel and services updated; sovereign mode protects the customer in the limit (key removed from LUKS).
- **Hardware-level side channels.** Spectre, rowhammer, DMA attacks. Out of scope.
- **Compromised Cloudflare.** Out of scope (use direct mode).
- **Compromised customer browser.** Auth requires the user's hardware; PoP defends against stolen cookies but not against malware that signs PoPs locally.
- **Coercion / legal compulsion.** Sovereign mode protects against the platform being compelled to decrypt — but it doesn't help if the customer's passkey is compelled.

For known gaps within scope: [security/13-known-limitations.md](../security/13-known-limitations.md).
