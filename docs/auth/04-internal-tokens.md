# Internal tokens

How services on a VPS authenticate to each other.

## Three patterns

| Pattern | Used by | Token storage |
| --- | --- | --- |
| HMAC headers (Caddy → file-api) | forward_auth response decoration | `/run/shield/internal-file-api.token` |
| HS256 JWT (enforcer → file-api) | daemon calls | `/etc/ellul/jwt-secret` (signing key) |
| Bearer token (any → API) | heartbeat, command claim | `/etc/ellul-bootstrap/ai-proxy-token` |

## HMAC headers (Caddy → file-api)

Source: `packages/vps/src/services/backends/file-api/src/auth.ts:35-64`.

When Caddy forward_auth succeeds, Shield returns:

```
HTTP/1.1 200 OK
X-Auth-User: <userId>
X-Auth-Tier: <tier>
X-Auth-Session: <sessionId>
X-Auth-Timestamp: <unix>
X-Auth-HMAC: <hmac>
```

HMAC computation:

```typescript
const message = `${userId}|${tier}|${sessionId}|${timestamp}`;
const hmac = crypto.createHmac('sha256', token).update(message).digest('hex');
```

`token` is read from `/run/shield/internal-file-api.token` (regenerated each Shield boot, only `shield-runner` and members of `shield-ipc` group can read).

Caddy decorates upstream request with these headers. file-api validates:

1. Read internal token (cached in memory).
2. Verify timestamp is fresh (±30s).
3. Compute expected HMAC.
4. Constant-time compare with provided HMAC.
5. On mismatch, invalidate cache, re-read token, retry.

Why HMAC: same-host attackers (the agent on localhost:3002) cannot easily fabricate `X-Auth-User` without the token.

The token files (`/run/shield/internal-*.token`) are owned `shield-runner:shield-ipc 640`. The agent's interactive shell does NOT have `shield-ipc` group at shell level (only systemd-managed services with `SupplementaryGroups=shield-ipc` get it).

**Known gap:** agent-bridge runs as `dev` with `SupplementaryGroups=shield-ipc`. A jailbroken agent-bridge could read its own token. See [../security/13-known-limitations.md](../security/13-known-limitations.md).

## HS256 JWT (enforcer → file-api)

Source: `packages/vps/src/services/daemons/enforcer/lib/heartbeat.sh:539-551`.

For volume operations and other daemon calls:

```typescript
const header = { alg: 'HS256', typ: 'JWT' };
const payload = {
  purpose: 'daemon-call',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300  // 5 min
};
const sig = HMAC_SHA256(JSON_STRINGIFY({header, payload}), jwt_secret);
const token = `${b64url(header)}.${b64url(payload)}.${b64url(sig)}`;
```

`jwt_secret` from `/etc/ellul/jwt-secret` (root:shield-ipc 640).

Used for:

- Enforcer's `mount-volume`, `flush-volume`, `force-unmount` calls to file-api's `/api/internal/*` endpoints.
- Cross-service internal HTTP calls.

file-api validates:

1. Parse JWT.
2. Verify signature with shared `jwt-secret`.
3. Check `exp` not expired.
4. Check `purpose: 'daemon-call'`.
5. Process request.

Single-use semantics not enforced (HS256 doesn't have built-in single-use), but short TTL limits replay window.

## Bearer token (any → API)

Source: `/etc/ellul-bootstrap/ai-proxy-token` (root:shield 640).

Used by enforcer to call API:

```
POST /api/servers/heartbeat
Authorization: Bearer <ai-proxy-token>
X-Heartbeat-Signature: <ML-DSA-44 sig>
X-Heartbeat-Timestamp: <unix>
X-Server-Id: <id>
```

API:

1. Verify bearer matches stored hash.
2. Verify ML-DSA-44 signature with registered `heartbeatPublicKey`.
3. Verify timestamp ±30s.
4. Process heartbeat.

The bearer token alone is insufficient — without the matching signature, API rejects. So even if the token leaks, an attacker cannot forge heartbeats.

## Token rotation

| Token | Rotation cadence | Trigger |
| --- | --- | --- |
| HMAC IPC tokens | Each Shield boot | Service restart |
| HS256 JWT secret | Volume rebuild only | Manual |
| Bearer ai-proxy-token | At provisioning; rotated on demand | API directive |
| Auth-secrets (HMAC) | 90-day automatic | Shield cron |

JWT secret is intentionally long-lived because rotation requires service restart for all consumers (file-api, agent-bridge, etc.).

## Verification on disk

```bash
# IPC tokens
ls -la /run/shield/internal-*.token

# JWT secret
ls -la /etc/ellul/jwt-secret

# Bearer token
ls -la /etc/ellul-bootstrap/ai-proxy-token
```

Permissions and ownership should match table above. Drift is auto-corrected by enforcer on boot.

## Cross-references

- Sovereign Shield: [../security/02-sovereign-shield.md](../security/02-sovereign-shield.md).
- Trust boundaries: [../architecture/05-trust-boundaries.md](../architecture/05-trust-boundaries.md).
- Heartbeat protocol: [../runtime/07-heartbeat-protocol.md](../runtime/07-heartbeat-protocol.md).
