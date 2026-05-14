# Passkey and PoP authentication

How users authenticate to Sovereign Shield, and how the platform binds sessions to specific browser hardware.

## Overview

Two factors layer:

1. **Passkey (WebAuthn)** — proves who the user is. Hardware-bound; private key never leaves the user's device.
2. **PoP (Proof of Possession)** — proves the same browser hardware is still active during the session. Refreshed every 5 minutes.

Standard tier uses JWT-only auth. `web_locked` and `private_locked` require passkey + PoP.

## Passkey enrollment (web_locked upgrade)

Triggered when the user upgrades to `web_locked`:

```
1. User clicks "Upgrade to Web Locked" in dashboard.
2. Dashboard hits /api/me/tier/upgrade-prepare on API.
3. API generates registration challenge, returns to browser.
4. Browser invokes navigator.credentials.create({
     publicKey: {
       challenge: <random>,
       rp: { id: 'ellul.ai', name: 'ellul.ai' },
       user: { id: <userId>, name: <email>, displayName: <displayName> },
       pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { alg: -257 }],
       authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }
     }
   })
5. User's device prompts: Touch ID / Windows Hello / security key.
6. Device generates ECDSA P-256 keypair internally; private key stays in TEE/Secure Enclave.
7. Browser receives credential: { id, publicKey, attestation, AAGUID, signCount }.
8. Browser POSTs to Shield POST /_auth/register/finish with the attestation.
9. Shield verifies attestation (signature chain to known authenticator), stores public key:
     INSERT INTO credential (credentialId, publicKey, AAGUID, signCount, createdAt)
10. Shield generates 8 recovery codes (8-char alphanumeric, bcrypt-hashed).
11. Shield writes /etc/ellul/security-tier = "web_locked", regenerates Caddyfile.
12. Caddy reloads with web_locked-aware forward_auth.
```

After this point, login on this device requires the passkey, not a password.

## Passkey login (web_locked)

```
1. User navigates to <id>-srv.ellul.ai.
2. Browser sees web_locked challenge UI.
3. Browser POSTs /_auth/login/start, receives challenge.
4. Browser invokes navigator.credentials.get({ publicKey: { challenge, ... } }).
5. User authenticates (biometric / security key tap).
6. Device signs challenge with stored private key.
7. Browser POSTs assertion to /_auth/login/finish.
8. Shield verifies:
   - Challenge matches (replay protection).
   - signCount monotonically increased (clone detection).
   - Signature valid against stored publicKey.
   - AAGUID matches expected authenticator.
9. Shield creates session row, returns __Host-shield_session cookie.
10. Browser receives cookie + connects WebSocket for chat/code.
```

Cookie attributes:
- `Secure` (HTTPS only)
- `HttpOnly` (no JS access)
- `SameSite=Lax`
- `__Host-` prefix (no Domain attribute, exact path match)

## PoP setup (post-login)

Right after login, the browser sets up a PoP keypair:

```
1. Browser generates non-extractable ECDSA P-256:
     const popKey = await crypto.subtle.generateKey(
       { name: 'ECDSA', namedCurve: 'P-256' },
       false,                   // extractable: FALSE
       ['sign']
     );
2. Browser exports the public key (extractable=false applies only to private):
     const popPub = await crypto.subtle.exportKey('raw', popKey.publicKey);
3. Browser signs a one-time challenge with the new private key.
4. Browser POSTs to Shield with { popPublicKey, signedChallenge }.
5. Shield verifies signature, stores publicKey on session row.
```

The non-extractable flag means the private key:

- Cannot be read via JavaScript.
- Lives in the WebCrypto module (often hardware-backed).
- Survives only as long as the JS context (page reload re-derives).

## Continuous PoP challenges

Every 5 minutes on every active WebSocket:

```
Server: { type: 'pop_challenge', nonce: '<32-byte-random>' }
  ↓
Browser: const sig = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            popKey.privateKey,
            challengeBytes
          );
  ↓
Browser: { type: 'pop_response', signature: <base64> }
  ↓
Server: verify signature using stored publicKey
  → success: keep connection alive
  → failure: increment failureCount
  → 2 consecutive failures: terminate connection
```

Why 2 failures: tolerate one network blip; reject a hijacked session.

## What PoP defends against

- **Stolen cookie attacks.** An attacker who exfiltrates the session cookie cannot replay it; without the matching browser hardware, PoP signs fail.
- **MITM cookie hijack.** The cookie is `Secure`; it doesn't leave HTTPS. But even if it did, PoP would catch the imposter.
- **Persistent client-side malware.** Malware that reads the WebCrypto key out is not possible (extractable=false). Malware that calls `crypto.subtle.sign` impersonating the browser is bound to that browser's process; once the browser closes, the key is gone.

## What PoP does NOT defend against

- **Browser sandbox escape.** If malware compromises the browser process itself, it can call `subtle.sign` and proxy responses.
- **Compelled signing.** If the user is coerced to sign while present, no defense helps.
- **Stolen attached device.** A stolen logged-in laptop with cached PoP context retains validity until session expires (24h max).

## Standard tier (JWT only)

Standard tier uses JWT issued by the API:

```
1. User logs in via API platform UI (email + password / OAuth).
2. API issues HS256 JWT signed with platform key.
3. Cookie set: __Host-platform_jwt.
4. User visits VPS subdomain.
5. Caddy forward_auth → Shield.
6. Shield validates JWT using shared HS256 secret (delivered via bootstrap).
7. Session cookie issued for VPS.
```

JWT is not PoP-bound; a stolen JWT works until expiry. Standard tier is convenient (no passkey ceremony) but less secure. The trade-off is explicit.

## private_locked (sovereign mode)

Same passkey + PoP as web_locked, plus:

- LUKS slot 0 (platform-managed key) is removed.
- Wake requires user passkey to derive PRF and unlock LUKS slot 1.
- The platform cannot decrypt the volume even if compelled.

PRF derivation:

```
1. WebAuthn assertion includes PRF extension input.
2. Authenticator computes PRF output (HMAC of input with hardware secret).
3. Browser sends PRF output to LUKS-unlock endpoint on VPS.
4. VPS uses PRF output as LUKS slot 1 passphrase.
5. cryptsetup luksOpen succeeds.
6. Vault mounts; services restart.
```

The PRF output is reproducible (same authenticator + same input → same output) but cannot be extracted from the authenticator. The platform never sees the PRF output (delivered direct to VPS via authenticated bridge).

Detail: [storage/03-sovereign-mode.md](../storage/03-sovereign-mode.md).

## Sessions

| Field | Value |
| --- | --- |
| Idle timeout | 4 hours |
| Absolute max | 24 hours |
| Rotation | every 15 minutes |

Session rotation: Shield issues a new sessionId every 15 minutes; browser stores both the old and new in the cookie until next refresh. This limits the impact of any leaked sessionId.

## Recovery

If user loses passkey access (lost device, etc.):

1. User visits dashboard, clicks "Recover account".
2. Dashboard prompts for one of the 8 recovery codes (generated at enrollment).
3. Recovery code submitted to API.
4. API verifies (bcrypt compare against stored hash), marks code used.
5. API issues short-lived recovery JWT.
6. Recovery JWT enables passkey re-enrollment from a new device.

Rate limit: 3 attempts per hour per user. Failures audit-logged.

Recovery codes expire after 6 months unused — user is prompted to regenerate.

## Cross-device passkeys (multiple credentials)

A user can register multiple passkeys (laptop, phone). Each is a separate row in `credential` table. Login accepts any registered credential.

Browser support varies:

- Apple's iCloud Keychain syncs passkeys across Mac/iPhone (one credential, multiple devices).
- Google's Password Manager syncs Chrome passkeys.
- Hardware security keys (YubiKey) are device-specific.

Shield stores AAGUID with each credential to identify the authenticator type.

## What survives a wipe

If the customer:

- Loses their device — recovery code or new-device passkey via SSH (if SSH enabled).
- Wipes the VPS — passkeys are vault-bound, gone with vault. Account lives on, but they re-register.
- Hibernates and wakes — passkeys persist (vault preserves auth DB).
- Sovereign-mode loses passkey — DATA LOSS. No recovery (4-layer defense in [storage/03-sovereign-mode.md](../storage/03-sovereign-mode.md)).

For the failure-mode matrix and recovery flows: [auth/03-cross-device.md](../auth/03-cross-device.md).
