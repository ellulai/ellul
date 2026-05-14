# Security tiers

Three runtime tiers control how authentication and trust boundaries work. Customers move between them. Stored in `/etc/ellul/security-tier`.

## Tier comparison

| Property | `standard` | `web_locked` | `private_locked` |
| --- | --- | --- | --- |
| Auth method | password / OAuth / passkey | passkey only | passkey only |
| PoP signing | optional | required | required |
| WebSocket continuous challenges | no | every 5 min | every 5 min |
| LUKS unlock | platform-managed | platform-managed | **user-only** (PRF) |
| Platform recovery | yes | yes | NO |
| SSH | enabled (with key) | disabled by default | disabled by default |
| Wake | automatic | automatic | requires user passkey |
| Browser session UI | platform-served | embedded in VPS | embedded in VPS |
| Onboarding cost | low (just sign in) | medium (passkey enrollment) | high (passkey + commitment) |

## When to use each

**Standard.** Most customers. Convenience-first. JWT cookies. Platform can recover the account.

**Web Locked.** Users who want hardware-bound session security. Stolen cookies are useless. Slight onboarding friction (one-time passkey ceremony).

**Private Locked (sovereign).** Users who want to be cryptographically untethered from the platform. The platform key is removed from LUKS; even if ellul.ai is fully compromised or compelled, the customer's data cannot be decrypted without the customer's passkey.

## Tier transitions

### standard → web_locked

User-initiated. Steps:

1. Dashboard "Upgrade to Web Locked" → API call.
2. API requests Shield: `POST /_auth/tier/upgrade-prepare`.
3. Shield runs WebAuthn registration ceremony in browser.
4. Public key + recovery codes stored in `credential` table.
5. Shield writes `/etc/ellul/security-tier = "web_locked"`.
6. Shield calls `caddy-gen` to regenerate Caddyfile (forward_auth tightens).
7. Caddy reloads.
8. Existing JWT sessions remain valid until expiry; new connections require passkey.

This is reversible (downgrade to standard is allowed).

### web_locked → private_locked (sovereign transition)

Irreversible without recovery. Steps:

1. Dashboard "Upgrade to Sovereign" → API call.
2. API verifies user has at least one registered passkey.
3. API requests confirmation (warning: data loss if passkey lost).
4. Browser performs PRF-extension assertion to derive LUKS slot 1 passphrase.
5. Bridge endpoint on Shield receives the PRF output (E2E encrypted).
6. Shield runs:
   ```
   cryptsetup luksAddKey <device> --key-slot 1 --key-file <prf-derived-file>
   ```
   Slot 1 is added with user PRF.
7. Shield runs:
   ```
   cryptsetup luksRemoveKey <device> --key-file <platform-keyfile>
   ```
   Slot 0 (platform key) is removed.
8. Shield runs `shred /etc/ellul-bootstrap/luks-keyfile` (multiple-pass overwrite).
9. API removes the wrapped LUKS key from DB (`volumes.luksKeyEncrypted = NULL`).
10. Shield touches `/etc/ellul-bootstrap/sovereign` (marker).
11. Shield writes `/etc/ellul/security-tier = "private_locked"`.

After this, any wake requires the user's passkey. The platform has no way to decrypt.

### web_locked → standard (downgrade)

Allowed but logged. Steps:

1. Dashboard "Downgrade" → API call.
2. Shield runs WebAuthn assertion (require passkey first).
3. On valid signature, write `/etc/ellul/security-tier = "standard"`.
4. Caddyfile regenerates with looser forward_auth.
5. Audit event recorded.

Passkeys are not deleted on downgrade; they remain registered for future re-upgrade.

### private_locked → web_locked (sovereign downgrade)

Possible only via re-introducing a platform key:

1. User logs in with passkey (which still unlocks LUKS slot 1).
2. Vault mounted.
3. Shield generates new platform keyfile.
4. `cryptsetup luksAddKey` to slot 0 with new platform key.
5. API stores wrapped platform key.
6. Remove sovereign marker.
7. Update tier file.

Equivalent to "I want platform recovery again." Rare but supported.

## What changes between tiers in detail

### Caddy forward_auth

In standard, Caddy's forward_auth check is loose (JWT validation only). In web_locked, Shield additionally verifies the PoP signature on every WebSocket message.

In private_locked, the same as web_locked, plus the LUKS-mount path differs at boot.

### SSH

`/etc/ssh/sshd_config.d/ellul.conf` always disables password auth. SSH is allowed only when:

- Tier is `standard` AND SSH is enabled in settings, OR
- Tier is `web_locked` or `private_locked` AND user has explicitly enabled SSH in settings AND has registered SSH keys via Shield.

The enforcer enforces this on each heartbeat, restoring the correct sshd config if it has drifted.

### Browser UI source

In standard, dashboard UI is served from `console.ellul.ai` (API platform).

In web_locked / private_locked, key UI elements (login form, tier-switch confirmation) are served by Shield itself (`/_auth/login`, `/_auth/upgrade`). This is the "self-contained interface" property: even if the API is compromised, the user authenticates against the VPS directly.

This is achieved via the `bridge.routes.ts` endpoint that exposes a hidden iframe for postMessage communication when the platform UI needs to talk to Shield.

### Recovery options

| Tier | Recovery if passkey lost |
| --- | --- |
| `standard` | Email-based password reset on platform |
| `web_locked` | Recovery code (8 generated at enrollment) → re-enroll passkey |
| `private_locked` | Recovery code → re-enroll BUT must also have access to LUKS PRF (typically same authenticator). If both lost: data loss. |

Sovereign customers are explicitly warned about data-loss risk.

## What does NOT change

- Kernel hardening (always applied).
- Iptables egress rules (mode-driven, not tier-driven).
- Per-project namespace isolation.
- Gate types and their TTLs.
- Cross-project scope check.
- Audit log.

These are baseline defenses regardless of tier.

## Tier in audit log

Every relevant action records the active tier:

```
audit_log.event = 'gate.granted'
audit_log.details = { gate: 'db_write', tier: 'web_locked', sessionId: ..., ... }
```

This lets forensic analysts answer "was this action performed under sovereign mode?" — a meaningful distinction for incident scoping.
