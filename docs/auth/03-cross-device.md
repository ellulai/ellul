# Cross-device

Logging in from a new device, recovery, multi-passkey enrollment.

## New device login (web_locked / private_locked)

Passkeys are device-bound. Visiting from a new browser/device requires:

### Option 1: same iCloud/Google account

Apple's iCloud Keychain syncs passkeys across Mac/iPhone. Google's Password Manager syncs Chrome passkeys. If both devices share the same account, the passkey is already on the new device — login just works.

### Option 2: cross-device WebAuthn (CTAP2 hybrid)

```
[user on new desktop, no passkey]
  ↓ POST /_auth/login/start
[Shield returns challenge]
[browser invokes navigator.credentials.get]
  ↓ "Use a passkey from another device"
  ↓ QR code displayed
[user scans QR with phone (which has the passkey)]
  ↓ phone's WebAuthn proxies through Bluetooth/CTAP2
[user authenticates on phone]
[desktop receives signed assertion]
  ↓ POST /_auth/login/finish
```

Browser-implemented WebAuthn standard. No special server work needed.

### Option 3: recovery code

```
[user on new desktop]
  ↓ click "Sign in with recovery code"
[dashboard prompts for code]
[user enters one of 8 codes]
[API]
  ↓ verify code (bcrypt compare)
  ↓ mark code used
  ↓ issue short-lived (5 min) recovery JWT
[recovery JWT enables passkey re-enrollment]
[user enrolls a new passkey on this device]
[new credential added to Shield's `credential` table]
```

Recovery code is single-use. After using, only 7 left.

Rate limit: 3 attempts per hour per user.

### Option 4: SSH bootstrap

If SSH is enabled (some tiers):

```
[user SSHs to VPS]
[shell prompt]
[user runs: ellul auth enroll-passkey]
[ellul-cli issues a one-time enrollment URL]
[user opens URL in browser]
[browser performs WebAuthn registration]
[passkey added]
```

This is for users who lost all passkeys but still have SSH.

## Multi-passkey enrollment

Recommended: enroll passkeys on multiple devices so loss of one isn't catastrophic.

```
[user logged in with passkey A on laptop]
  ↓ dashboard "Add passkey"
[browser invokes navigator.credentials.create]
[user authenticates with passkey A to authorize, then enrolls passkey B]
[passkey B added to credential table]
```

Now login works with either A or B.

For sovereign mode, multi-passkey is critical: different devices may derive the same PRF only if synced via iCloud/Google. If using YubiKey or per-device authenticators, you need separate keys for each device — and each must be enrolled in LUKS slot 1 (which currently allows only one slot 1 key, so this is a limitation; multi-passkey for sovereign is future work).

## Recovery code generation

8 codes, 8 chars alphanumeric:

```typescript
function generateRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => 
    Array.from({ length: 8 }, () => randomAlphanumeric()).join('')
  );
}
```

bcrypt hash + salt stored in `recovery_codes` table:

```sql
CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
```

Plain codes shown to user once at generation; never stored or logged.

User downloads/prints. Loss of codes + loss of passkey = inability to log in (recovery exhausted).

After 6 months unused, codes expire. User prompted to regenerate.

## Cross-device gotchas

- **Sovereign mode + new device.** PRF must match. iCloud-synced passkeys give matching PRF; YubiKey doesn't.
- **Recovery code reuse.** Each is single-use; after using, the code is invalidated. Can't share between devices.
- **Session continuity.** New device gets a new session; old device's session persists until expiry.
- **Audit log.** Every login (passkey or recovery) recorded in audit_log with device fingerprint.

## Cross-references

- Authentication flows: [01-authentication-flows.md](./01-authentication-flows.md).
- Sessions: [02-sessions.md](./02-sessions.md).
- Sovereign mode passkey caveats: [../storage/03-sovereign-mode.md](../storage/03-sovereign-mode.md).
