# Authentication flows

Cross-references with [../security/04-passkey-and-pop.md](../security/04-passkey-and-pop.md). This page focuses on flow contracts.

## Standard tier (JWT)

```
[user]
  ↓ login at console.ellul.ai (email+password / Google / GitHub)
  ↓
[API platform]
  ↓ issue HS256 JWT signed with shared platform key
  ↓ set cookie __Host-platform_jwt
[browser]
  ↓ navigate to <id>-srv.ellul.ai
  ↓ cookie sent with request
[Caddy]
  ↓ forward_auth to Shield :3005/_auth/session
[Shield]
  ↓ verify JWT with shared HS256 key (from /etc/ellul/jwt-secret)
  ↓ return 200 + X-Auth-User: <userId>
[Caddy]
  ↓ proxy to upstream with X-Auth-User header
[upstream service]
  ↓ trust X-Auth-User
```

JWT has 24h max TTL. Renewal: silent refresh on browser.

## Web Locked (passkey + PoP)

### Initial enrollment

```
[user with standard tier]
  ↓ click "Upgrade to Web Locked"
[browser]
  ↓ POST /_auth/register/start
[Shield]
  ↓ generate WebAuthn challenge
  ↓ return challenge + RP info
[browser]
  ↓ navigator.credentials.create({ publicKey: { challenge, ... } })
[user]
  ↓ Touch ID / Windows Hello / security key
[browser]
  ↓ POST /_auth/register/finish with attestation
[Shield]
  ↓ verify attestation
  ↓ INSERT INTO credential (credentialId, publicKey, AAGUID)
  ↓ generate 8 recovery codes (bcrypt-hashed)
  ↓ write /etc/ellul/security-tier = "web_locked"
  ↓ regenerate Caddyfile
  ↓ caddy reload
```

### Login

```
[user navigates to <id>-srv.ellul.ai]
  ↓
[Caddy → Shield: forward_auth fails (no session)]
  ↓ redirect to /_auth/login
[Shield serves login page]
[browser]
  ↓ POST /_auth/login/start
[Shield returns challenge]
[browser]
  ↓ navigator.credentials.get({ publicKey: { challenge, ... } })
[user authenticates]
[browser]
  ↓ POST /_auth/login/finish with assertion
[Shield]
  ↓ verify signature, AAGUID, signCount monotonic
  ↓ INSERT INTO sessions (sessionId, credentialId)
  ↓ set cookie __Host-shield_session
[browser proceeds with WebSocket connection]
```

### PoP setup (per-session)

```
[browser, after login]
  ↓ generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
[non-extractable private key in browser hardware]
  ↓ exportKey('raw', popKey.publicKey) → public key bytes
[browser]
  ↓ POST /_auth/pop/register with publicKey + signedChallenge
[Shield]
  ↓ verify signature, store popPublicKey on session row
```

### PoP continuous challenges (every 5 min)

```
[Shield → browser via WebSocket]
  ↓ { type: 'pop_challenge', nonce: <16-byte-random> }
[browser]
  ↓ subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, popKey.privateKey, nonce)
[browser]
  ↓ { type: 'pop_response', signature }
[Shield]
  ↓ verify signature against stored popPublicKey
  ↓ on success: keep connection
  ↓ on failure: increment count
  ↓ 2 consecutive failures: terminate connection
```

## Private Locked (passkey + PRF + LUKS)

Same passkey + PoP as web_locked. Plus:

### Wake unlock

```
[VPS wakes, sovereign marker present]
[Shield reports awaiting_unlock to API]
[API → dashboard]
  ↓ "Unlock with passkey"
[browser]
  ↓ navigator.credentials.get with PRF extension input
[user authenticates]
[authenticator]
  ↓ compute PRF(input, hardwareSecret) → output
[browser]
  ↓ POST /_bridge/luks-unlock with E2EE PRF output
[VPS Shield bridge]
  ↓ decrypt PRF
  ↓ cryptsetup luksOpen <device> --key-file <prf-output>
  ↓ vault opens, services restart
```

For PRF details: [../security/04-passkey-and-pop.md](../security/04-passkey-and-pop.md).

## Recovery (any tier)

```
[user lost passkey access]
[user visits dashboard, clicks "Recover"]
[dashboard prompts for recovery code]
[user enters one of the 8 codes]
[API]
  ↓ verify code (bcrypt compare)
  ↓ mark code used
  ↓ issue short-lived recovery JWT
[recovery JWT enables re-enrollment of passkey on new device]
```

Rate limit: 3 attempts per hour per user.

## OAuth (Google / GitHub)

For standard tier signup:

```
[user clicks "Sign in with Google"]
  ↓ redirect to Google OAuth
[user authenticates with Google]
  ↓ Google redirects back with code
[API]
  ↓ exchange code for token
  ↓ verify Google ID token
  ↓ create or look up user
  ↓ issue platform JWT
[set cookie, redirect to dashboard]
```

For deeper context: [02-sessions.md](./02-sessions.md), [03-cross-device.md](./03-cross-device.md).
