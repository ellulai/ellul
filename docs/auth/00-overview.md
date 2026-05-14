# Auth overview

Authentication and session management. For tier-specific details see [../security/05-tiers.md](../security/05-tiers.md). For passkey/PoP mechanics see [../security/04-passkey-and-pop.md](../security/04-passkey-and-pop.md).

This section is the orientation page for auth-related runtime questions.

## Pages

- [01-authentication-flows.md](./01-authentication-flows.md) — passkey, JWT, PoP.
- [02-sessions.md](./02-sessions.md) — web, code, term sessions.
- [03-cross-device.md](./03-cross-device.md) — recovery, multi-device.
- [04-internal-tokens.md](./04-internal-tokens.md) — service-to-service IPC.

## Three auth methods

| Method | When | Strength |
| --- | --- | --- |
| Password / OAuth (via API) | Standard tier | Standard |
| Passkey (WebAuthn) | Web Locked, Private Locked | Hardware-bound |
| PoP (continuous WebSocket) | Web Locked, Private Locked | Per-message proof |

## Session types

| Session | Cookie | Purpose | TTL |
| --- | --- | --- | --- |
| Web | `__Host-shield_session` | Browser dashboard | 4h idle, 24h max |
| Code | (token) | Git operations, deploy | 5min |
| Terminal | `_term_auth` | Web terminal | 60min |
| Agent (CLI) | (header) | Chat WebSocket | continuous via PoP |

## Internal tokens

Services authenticate to each other via:

- HMAC headers (Caddy → file-api): `X-Auth-User` + `X-Auth-HMAC` validated using `/run/shield/internal-file-api.token`.
- HS256 JWT (enforcer → file-api): signed with `/etc/ellul/jwt-secret`, `purpose: 'daemon-call'`.
- Bearer token (any → API): `ai-proxy-token` with ML-DSA-44 signature.

Details: [04-internal-tokens.md](./04-internal-tokens.md).
