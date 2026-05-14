# Secrets management

Two categories of secrets, two storage paths, two access models.

## The split

| Category | What | Storage | Owner | Agent access | Read by |
| --- | --- | --- | --- | --- | --- |
| **App secrets** | DATABASE_URL, STRIPE_KEY, app-specific .env | `/etc/ellul/secrets/<app>.env.enc` | root:shield 660 | NO (not in shield group) | Sovereign Shield |
| **CLI keys** | ANTHROPIC_API_KEY, OPENAI_API_KEY (for AI tools) | `~/.ellul-cli-env` | dev:dev 600 | YES (sourced by .bashrc) | Agent CLI |

The split means: code the agent runs has access to AI provider keys (it needs them), but NOT to the customer's app secrets (it doesn't need them and could exfiltrate them).

## App secrets

App secrets are written by Shield when the user uploads them via dashboard. Each app has its own file:

```
/etc/ellul/secrets/sbx-abc1234.env.enc      root:shield 660
/etc/ellul/secrets/sbx-def5678.env.enc      root:shield 660
```

Encrypted-at-rest with AES-256-GCM, key derived from auth-secrets. Decrypted only when needed (by Shield, in process memory).

When the agent needs to run a command that requires secrets:

1. User grants `env` gate.
2. Shield reads & decrypts the app's secrets in memory.
3. Shield spawns the command with secrets injected via stdin pipe (NOT environment).

Why stdin not env: environment variables show up in `/proc/<pid>/environ` (visible to anyone in the same session group). Stdin is consumed before any other process sees the data.

```typescript
const child = spawn('bash', ['-c', 'export $(cat); exec ' + cmd], {
  stdio: ['pipe', 'pipe', 'pipe']
});
child.stdin.write('DATABASE_URL=postgres://...\nSTRIPE_KEY=sk_...\n');
child.stdin.end();
```

The child shell `export`s the values from stdin then execs the command. By the time the agent (or any other process) could probe `/proc/<pid>/environ`, the stdin has been consumed and the env is set in the bash subprocess's own environment — not available outside it.

## CLI keys

`~/.ellul-cli-env` is sourced by the user's `.bashrc`. Contains AI provider API keys:

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
export GEMINI_API_KEY="..."
```

These are present because:

- AI CLIs (Claude, Codex, Gemini) read them from environment.
- Agent's tooling spawns CLIs from the agent's shell.
- The keys are only useful for AI inference, not for accessing customer apps.

Risk acknowledged: a compromised agent could exfiltrate `ANTHROPIC_API_KEY` and use it elsewhere. This is rate-limited by Anthropic and a small dollar exposure compared to the value of unrestricted CLI access.

The user can view/rotate CLI keys from dashboard.

## Versioned auth-secrets

Shield's HMAC signing key supports rotation. `/etc/ellul/shield-data/auth-secrets.json`:

```json
{
  "current": "v3",
  "secrets": {
    "v1": {
      "value": "...",
      "createdAt": "2025-12-01T00:00:00Z",
      "retiredAt": "2026-03-01T00:00:00Z",
      "expiresAt": "2026-04-01T00:00:00Z"
    },
    "v2": {
      "value": "...",
      "createdAt": "2026-03-01T00:00:00Z",
      "retiredAt": "2026-04-15T00:00:00Z",
      "expiresAt": "2026-05-15T00:00:00Z"
    },
    "v3": {
      "value": "...",
      "createdAt": "2026-04-15T00:00:00Z"
    }
  }
}
```

- New tokens signed with `current` version.
- Verification accepts any non-expired version.
- After `expiresAt`, version removed.
- Rotation cadence: every 90 days, automated by Shield.

This means an old token (from before rotation) remains valid until its version expires, giving graceful migration.

## JWT secret

`/etc/ellul/jwt-secret`. 32 bytes, root:shield-ipc 640.

Used for HS256 signing of internal-purpose JWTs:

- Daemon-call JWTs (enforcer → file-api).
- Internal HTTP JWTs (Shield → bridge → file-api).
- Code-session-bound tokens.

Read by services with SupplementaryGroups including `shield-ipc`. Never logged. Rotated only on volume rebuild (rare).

## Vault secrets (dashboard-managed)

Customers can store arbitrary secrets in a "vault" exposed via dashboard. These are stored encrypted in Shield's auth DB.

```sql
CREATE TABLE vault_secrets (
  id INTEGER PRIMARY KEY,
  appId TEXT,
  key TEXT,
  encryptedValue BLOB,
  createdAt INTEGER,
  updatedAt INTEGER
);
```

Encryption: AES-256-GCM, key derived from auth-secrets `current` version.

Read access: requires `vault_read` gate (4-hour TTL by default).

Use case: sharing a long-lived secret across multiple agents/threads, scoped to an app.

## SSH keys

`/etc/ssh/authorized_keys/<user>` (root:shield 660). Owned by Shield. Each entry is one public key.

Add: dashboard "Add SSH key" → API → Shield endpoint → write to authorized_keys file.

Remove: same.

The agent cannot:

- Add its own key (file is root-owned).
- Read others' keys (mode 660, not in shield group).

## Recovery codes

Generated at passkey enrollment. 8 codes, 8 chars alphanumeric. Stored bcrypt-hashed in `recovery_codes` table.

Single-use. After verification, marked `used=true`.

Rate limit on attempts: 3/hour per user.

Expiry: 6 months unused — user prompted to regenerate.

## What about the platform-side?

The API stores wrapped LUKS keys, signed manifests, etc. Plaintext secrets never leave a VPS in plain form:

- LUKS keys are wrapped with AES-256-GCM using a key in Cloud Secret Manager.
- Manifest signing key is in Cloud Secret Manager (Cloud Run only loads it; never on disk).
- Bootstrap tokens are hashed before storing (`bootstrapTokenHash`).

For the wake/E2EE flow that delivers LUKS keys to the VPS without ever storing plaintext: [../lifecycle/03-wake.md](../lifecycle/03-wake.md).

## What about the bootstrap token?

The bootstrap token is the one secret that travels from API to VM in plaintext, embedded in cloud-init `user_data`. Trade-offs:

- **Risk surface.** Hetzner sees user_data; some providers might log it.
- **Mitigation.** Token is single-use, 5-min TTL + 5-min grace, burned on use.
- **Why not more?** Encrypting the token would require pre-shared keys, which we don't have at first boot.

The token's only superpower: it can call `/api/servers/:id/install` (download payload) and `/api/servers/:id/bootstrap` (decrypt secrets). Both are scoped to the specific server-id.

## Audit and rotation

All secret reads are audit-logged:

- `app_secrets.read` (with sandboxId, requestor, gate token)
- `vault_secret.read`
- `cli_keys.read` (rare; usually inherited via env)

Rotation:

- App secrets: user-driven (re-uploaded via dashboard).
- Auth secrets (HMAC): automated 90-day rotation by Shield.
- JWT secret: rotation requires service restart; done only on volume rebuild.
- LUKS keys: optional automated rotation via `luks-rekey` DIRECT command.

## Cross-references

- Gate engine: [03-sovereign-gates.md](./03-sovereign-gates.md).
- LUKS modes: [../storage/02-encrypted-volumes.md](../storage/02-encrypted-volumes.md).
- Sovereign Shield internals: [02-sovereign-shield.md](./02-sovereign-shield.md).
