# Sessions

Different session types serve different purposes.

## Session types

### Web session

| Property | Value |
| --- | --- |
| Cookie | `__Host-shield_session` |
| Attributes | Secure, HttpOnly, SameSite=Lax, no Domain |
| Storage | Shield's SQLite `sessions` table |
| Idle timeout | 4 hours |
| Absolute max | 24 hours |
| Rotation | every 15 minutes |

Stores: sessionId, credentialId, popPublicKey, deviceFingerprint, createdAt, lastActiveAt, expiresAt.

Used for: browser dashboard, chat WebSocket (with PoP for web_locked).

### Code session

| Property | Value |
| --- | --- |
| Token | UUID 128-bit |
| TTL | 5 minutes |
| Storage | Shield's SQLite `code_sessions` table |
| Single-use | yes (consumed on validation) |

Used for: file-api code-browser access, git operations (the gate-binding token), deploy operations.

### Terminal session

| Property | Value |
| --- | --- |
| Cookie | `_term_auth` |
| Token | UUID 128-bit (alternative path) |
| TTL | 60 minutes |
| IP-bound | yes |
| Storage | Shield's SQLite `term_sessions` table |

Used for: web terminal access via term-proxy.

Two auth paths:

- Cookie `_term_auth=<sessionId>` — long-lived terminal session, validated on each request.
- Query `?_term_token=<token>` — single-use bootstrap token, consumed on first use.

### Agent session (CLI)

Not a stored session. Each WebSocket connection is bound to a parent web session and decorated with PoP signing.

The "session" is the WebSocket connection itself; closing the WebSocket closes the agent session.

### Persistent CLI threads

Each chat thread has isolated CLI state in `~/.ellul/threads/<threadId>/`. Not a session per se — persistent state on disk.

## Session rotation

Web sessions rotate every 15 minutes:

```
[browser → Shield: any request]
  ↓ Shield checks session age
  ↓ if > 15min, generate new sessionId
  ↓ store both old and new in cookie
  ↓ delete old after next refresh
```

Cookie value includes both IDs during transition; downstream uses whichever is current.

Effect: a leaked sessionId is valid only until next rotation. Window typically <15 min.

## Session storage

Shield's SQLite `sessions` table:

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  sessionId TEXT UNIQUE NOT NULL,
  credentialId TEXT,
  popPublicKey BLOB,
  deviceFingerprint TEXT,
  createdAt INTEGER,
  lastActiveAt INTEGER,
  expiresAt INTEGER
);
CREATE INDEX idx_sessions_lookup ON sessions (sessionId);
```

`credentialId` links to the passkey used. `deviceFingerprint` captures user-agent, timezone, screen — change triggers re-auth.

## Device fingerprint

Computed on login:

```typescript
const fingerprint = sha256(JSON.stringify({
  userAgent: navigator.userAgent,
  language: navigator.language,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  screen: { width: screen.width, height: screen.height },
  hardwareConcurrency: navigator.hardwareConcurrency,
  // (no fingerprint-2 / canvas-based tracking — privacy intentional)
}));
```

Stored on session row. Each subsequent request includes a hash of current fingerprint; mismatch triggers re-auth.

This is a coarse defense; not bulletproof but raises the bar.

## Session termination

- Logout button: `POST /_auth/logout` clears session.
- Idle timeout: server-side check; session deleted.
- Absolute max: hard expiry.
- PoP failure (web_locked): WebSocket closes, but cookie may remain valid for non-WebSocket requests until next forward_auth check.
- Password reset (standard): all sessions invalidated.

## Cross-references

- Auth flows: [01-authentication-flows.md](./01-authentication-flows.md).
- Cross-device recovery: [03-cross-device.md](./03-cross-device.md).
- Sovereign Shield: [../security/02-sovereign-shield.md](../security/02-sovereign-shield.md).
