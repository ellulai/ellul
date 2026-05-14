# Sovereign Shield

The auth and gate service. Runs on port 3005, localhost only. User: `shield-runner`. Source: `packages/vps/src/services/auth/sovereign-shield/`.

For a high-level place in the system, see [architecture/03-vps-services.md](../architecture/03-vps-services.md). This page is the implementation detail.

## Bundle structure

Shield is a TypeScript application bundled to a single JS file at provisioning time. Build:

- **Tool.** esbuild (`bundle.ts:44-90`).
- **Entry.** `src/main.ts`.
- **External deps.** `better-sqlite3` (native), `@solana/web3.js`, `bip39`, `ed25519-hd-key` — installed at provisioning, not bundled.
- **Browser PQC.** `@noble/post-quantum/ml-kem` baked in via `pqc-mlkem-bundle.ts` for browser-side passkey + ML-KEM operations.
- **Output.** Single `server.js` ~10MB.

Deployed to `/opt/ellul/auth/server.js` (root:shield-runner, copied not symlinked — Node `require()` resolves relative to the real path; symlinks break `node_modules` resolution).

## Systemd unit

```ini
[Unit]
Description=Ellul Sovereign Shield (Auth)
After=ellul-luks-boot.service ellul-shield-prereq.service
Wants=ellul-luks-boot.service ellul-shield-prereq.service
RequiresMountsFor=/etc/ellul /opt/ellul

[Service]
Type=simple
User=shield-runner
Group=shield-runner
SupplementaryGroups=shield caddy shield-ipc
WorkingDirectory=/opt/ellul/auth
EnvironmentFile=/etc/ellul/heap-caps/sovereignShield.env
Environment=NODE_ENV=production
Environment=PORT=3005
ExecStart=/home/dev/.node/bin/node /opt/ellul/auth/server.js
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60
LimitCORE=0
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ReadWritePaths=/etc/ellul/shield-data /etc/caddy /var/log/ellul /run/shield
```

`SupplementaryGroups=shield caddy shield-ipc` is critical:

- `shield` — read `/etc/ellul/jwt-secret`, `/etc/ellul/secrets/*`, `/etc/ellul-bootstrap/node.key`, `/etc/ssh/authorized_keys/*`.
- `caddy` — write `/etc/caddy/Caddyfile` and reload via admin socket.
- `shield-ipc` — read `/run/shield/internal-*.token` (for HMAC-signing internal API calls).

`StartLimitBurst=3` + `StartLimitIntervalSec=60`: 3 retries within a minute. After exhaustion, Caddy enters lockdown and provisioning continues — enforcer self-heals on next heartbeat.

## SQLite auth DB

Path: `/etc/ellul/shield-data/local-auth.db`. Owner: `shield-runner:shield-runner`, mode 600. Vault-bound (LUKS-backed).

### Schema

| Table | Purpose |
| --- | --- |
| `sessions` | Active web sessions: sessionId, credentialId, popPublicKey, deviceFingerprint, createdAt, lastActiveAt, expiresAt |
| `credential` | Passkey credentials: credentialId, publicKey, AAGUID, signCount, createdAt |
| `recovery_codes` | Bcrypt-hashed recovery codes: id, hash, salt, used (boolean), expiresAt |
| `pop_nonces` | Active PoP challenge nonces: nonce, expiresAt |
| `audit_log` | Hash-chained event log: id, timestamp, event, details, prev_hash, hash |
| `term_sessions` | Terminal session tokens: sessionId, ip, expiresAt |
| `code_sessions` | Code browser session tokens: sessionId, ip, expiresAt |
| `gate_state` | Persisted gate grants (also mirrored to JSON file for atomic write) |
| `gate_permissions` | Sandbox-level allow_always / never decisions |

### Hash-chained audit log

Each row links to the previous via `prev_hash`. Verifying the chain detects any retroactive modification.

```typescript
// Pseudocode for log append:
function appendAudit(event: string, details: object) {
  const prev = db.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const ts = Date.now();
  const row = { timestamp: ts, event, details: JSON.stringify(details), prev_hash: prev?.hash || null };
  const hash = sha256(canonicalJson({ ...row, prev_hash: row.prev_hash }));
  db.insert('audit_log', { ...row, hash });
}
```

If an attacker (with write access to the SQLite, which only `shield-runner` has) modifies a row, all subsequent rows' hashes mismatch. A verification pass detects the break and the chain head's signed hash (cross-attested via the API on every heartbeat) flags it.

## Secrets

| File | Owner | Purpose |
| --- | --- | --- |
| `/etc/ellul/shield-data/auth-secrets.json` | shield-runner | Versioned HMAC keys (`current` version + retired keys for grace period) |
| `/etc/ellul/shield-data/.sovereign-auth-secret` | shield-runner | Legacy single secret (fallback) |
| `/etc/ellul/jwt-secret` | root:shield-ipc 640 | HS256 key for internal JWT |
| `/etc/ellul/ai-proxy-token` | root:shield 640 | API bearer (read by Shield to call API) |
| `/etc/ellul-bootstrap/node.key` | root:shield 640 | ML-KEM private key (read by Shield for E2EE) |

The auth-secrets.json supports key rotation:

```json
{
  "current": "v3",
  "secrets": {
    "v1": { "value": "...", "createdAt": "...", "retiredAt": "...", "expiresAt": "..." },
    "v2": { "value": "...", "createdAt": "...", "retiredAt": "...", "expiresAt": "..." },
    "v3": { "value": "...", "createdAt": "..." }
  }
}
```

New tokens are signed with `current`. Verification accepts any non-expired version. After `expiresAt`, an old key is removed.

## Endpoint inventory

Internal endpoints (called by Caddy or other services on localhost):

### `POST /_auth/session`

Forward-auth target. Caddy invokes with the original cookie. Shield validates and returns 200 + auth headers.

Response on success:
```
HTTP/1.1 200 OK
X-Auth-User: <userId>
X-Auth-Tier: <standard|web_locked|private_locked>
X-Auth-Session: <sessionId>
X-Auth-Timestamp: <unix>
X-Auth-HMAC: <hmac of all above using internal-<service>.token>
```

The HMAC defends against same-host spoofing of `X-Auth-User`. File-API verifies the HMAC using its IPC token.

### `POST /_auth/login/start`, `POST /_auth/login/finish`

WebAuthn login ceremony.

### `POST /_auth/register/start`, `POST /_auth/register/finish`

Passkey enrollment (web_locked upgrade).

### `POST /_auth/recovery`

Recovery-code login (when passkey lost).

### `GET /_auth/tier/current`

Returns current tier from `/etc/ellul/security-tier`.

### `POST /_auth/tier/switch`

Tier transition (standard ↔ web_locked, web_locked → private_locked). Requires:

- Localhost only (127.0.0.1, ::1).
- `Authorization: Bearer <internal-token>`.
- For web_locked upgrade: passkey must exist.
- For private_locked: special LUKS rekey flow.

### `POST /_auth/terminal/validate`

Single-use terminal token validation. Used by term-proxy.

### `POST /_auth/terminal/session/create`, `/_auth/terminal/session/validate`

Terminal session lifecycle.

### `POST /_auth/agent/*`

Agent token endpoints (for chat WebSocket auth).

### `POST /_auth/code/*`

Code session endpoints (for git operations, deploy gate).

### `POST /_auth/gates/request`

Agent submits gate request. Shield writes to inbox; user sees popup.

### `POST /_auth/gates/respond`

User approves or denies. Shield issues gate token if approved.

### `GET /_auth/gates/stream` (SSE)

Live stream of gate events to dashboard.

### `POST /_auth/keys`, `GET /_auth/keys`, `DELETE /_auth/keys/:fp`

SSH key management. Shield writes to `/etc/ssh/authorized_keys/<user>`.

### `POST /_auth/permissions/request`, `/_auth/permissions/{id}/approve`

Stored permission requests (e.g., dashboard prompts for allow_always).

### `GET /_auth/audit/log`, `/_auth/audit/verify`

Audit log access. Verify recomputes the hash chain.

### `POST /_auth/guardrails/check`

Evaluate guardrail rules against a prompt.

### `POST /_internal/git-setup`

Called by enforcer's `git-setup` DIRECT command. Initializes git repo, configures credentials, optionally pulls.

### `POST /_internal/sandbox/destroy`

Called by enforcer's `b2b-sandbox-destroy` DIRECT command. Removes a project's namespace, sandbox, related data.

## PoP (Proof of Possession)

For `web_locked` tier, every WebSocket connection signs continuous challenges using a non-extractable ECDSA P-256 key.

### Setup (post-login)

1. User logs in with passkey.
2. Browser generates ECDSA P-256 key via `crypto.subtle.generateKey({ extractable: false })`.
3. Public key sent to Shield via signed registration request.
4. Shield stores public key in `sessions.popPublicKey`.

### Continuous challenge

Every 5 minutes on active WebSocket:

1. Shield issues random 16-byte nonce.
2. Browser signs nonce with private key (`crypto.subtle.sign(...)`).
3. Server verifies signature against stored public key.
4. Two consecutive failures terminate the connection.

### Why this matters

A stolen session cookie is useless without the matching browser hardware. The PoP private key is non-extractable — even browser malware cannot exfiltrate it (it lives in the WebCrypto's HSM-equivalent).

This is the practical implementation of "device-bound" auth without TPM dependence.

## Tier switch hardening

`POST /_auth/tier/switch` (`tier.routes.ts:41`) has explicit defense:

```typescript
// Localhost-only check
const remoteIp = request.headers.get('x-forwarded-for') || socket.remoteAddress;
if (!['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(remoteIp)) {
  return 403;
}

// Internal token required
const auth = request.headers.get('authorization');
if (!auth?.startsWith('Bearer ') || !verifyInternalToken(auth.slice(7))) {
  return 401;
}
```

Even if an attacker reaches Shield's localhost endpoint, they need:

1. To be on 127.0.0.1 (which the agent IS, but...).
2. The internal token from `/run/shield/internal-<service>.token` (which the agent's interactive shell cannot read because shell is not in `shield-ipc` group; only systemd-managed services get it).

The agent jailbreaking agent-bridge (which IS in shield-ipc) and forging a tier-switch is the residual risk acknowledged in [13-known-limitations.md](./13-known-limitations.md).

## Caddyfile regeneration

When tier or domain changes, Shield calls:

```bash
sudo /usr/local/bin/ellul-caddy-gen \
  --model "$DEPLOYMENT_MODEL" \
  --main-domain "$MAIN_DOMAIN" \
  --code-domain "$CODE_DOMAIN" \
  --dev-domain "$DEV_DOMAIN" \
  > /etc/caddy/Caddyfile.new
sudo caddy validate --config /etc/caddy/Caddyfile.new
sudo mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Sudo entries permit only `ellul-caddy-gen` and `caddy`/`systemctl reload caddy` for shield-runner. Agent has no equivalent path.

## Internal token files

```
/run/shield/                              shield-runner:shield-ipc 2750
/run/shield/internal-file-api.token       shield-runner:shield-ipc 640
/run/shield/internal-agent-bridge.token   shield-runner:shield-ipc 640
/run/shield/internal-enforcer.token       shield-runner:shield-ipc 640
```

Each service generates its token on its own startup, writes via Shield's recreate-on-boot flow. The `shield-ipc` group's read access is granted to systemd-managed services via `SupplementaryGroups`, not via `usermod -aG` — so interactive shells of the agent user do NOT inherit the group.

## Boot-time resilience

If Shield fails 3 times during initial start:

1. Caddy is reloaded with a "lockdown" Caddyfile (every protected route returns 503).
2. Provisioning continues; SERVICES section completes.
3. Enforcer's heartbeat tries to start Shield each cycle.
4. If Shield comes up, enforcer triggers Caddyfile regeneration and reloads Caddy.

This avoids a single startup failure breaking the whole boot. The cost: a customer hitting a freshly-failed VPS sees 503; they must wait for self-heal (typically <60s).

## Read this next

- [03-sovereign-gates.md](./03-sovereign-gates.md) — gates implemented by Shield.
- [04-passkey-and-pop.md](./04-passkey-and-pop.md) — auth flows.
- [05-tiers.md](./05-tiers.md) — tier behaviour.
- [13-known-limitations.md](./13-known-limitations.md) — same-user trust gap.
