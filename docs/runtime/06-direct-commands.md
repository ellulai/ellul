# DIRECT commands

The enforcer executes commands from the API queue. Two categories:

- **DIRECT** — handled by enforcer locally (root context).
- **HTTP** — relayed to file-api via internal JWT.

This page lists every DIRECT command type and what it does.

Source: `packages/vps/src/services/daemons/enforcer/lib/heartbeat.sh:559+` (dispatch table) plus per-command handlers.

## Identity & cryptography

| Command | What it does |
| --- | --- |
| `update-identity` | Writes new server-id, domain, tier markers. Sets `_DEFERRED_ENFORCER_RESTART=1` for restart after batch completes. |
| `read-public-key` | Reads `/etc/ellul-bootstrap/heartbeat.pub.json`. Used for first-write-wins public-key registration with API. |
| `re-attest` | Re-runs hardening attestation: sshd no-password, sudo NOPASSWD disabled, firewall active, script immutability. Signs report with ML-DSA-44. |
| `rotate-to-pqc` | Migrates from Ed25519 to ML-DSA-44 + ML-KEM-1024 keypair. Verifies, commits via API. |

## Encryption & volume

| Command | What it does |
| --- | --- |
| `luks-close` | Closes encrypted home volume (dmsetup, cryptsetup). Preserves boot partition. |
| `luks-format` | Initializes LUKS v2 container on target device. Uses platform keyfile + optional user PRF. |
| `luks-rekey` | Changes a LUKS slot. Action variants: `add-platform-key`, `remove-platform-key`, `rotate-slot-0`. |
| `luks-header-backup` | Extracts LUKS header for recovery. Returns base64-encoded header. |
| `wake-mount` | Opens LUKS, mounts vault, restores bind mounts, starts services. Single-phase. Sovereign-mode aware. |
| `init-encrypted-volume` | Initializes a fresh encrypted volume. Sub-actions: `mark-sovereign`, etc. |
| `flush-volume` | fsfreezes filesystem, ensures dirty pages flushed. Returns `volumeMounted` status. |
| `force-unmount` | Force-unmounts a stuck volume. Last resort before destroy. |
| `grow-volume` | Resizes ext4 inside LUKS after volume size change. |

## Service management

| Command | What it does |
| --- | --- |
| `stop-postgresql` | Graceful Postgres shutdown. Used before block-migrate or tier transitions. |
| `restart-services` | Restart specific systemd services. |
| `maintenance-mode` | Enter/exit maintenance mode (degraded UX, locked operations). |

## Agent self-update

| Command | What it does |
| --- | --- |
| `apply-pending-update` | Applies a staged manifest when auto-update=false. Re-verifies chain. |
| `set-auto-update` | Toggles the auto-update flag. |

## Entitlements & adapters

| Command | What it does |
| --- | --- |
| `update-entitlements` | Applies desired-state limits (max projects, previews). Fetched separately from manifest. |
| `agent-adapter-execute` | Runs CLI (Claude/Codex/Cursor/OpenCode) in namespace. Per-CLI flag mapping for output format. Inline timeout via `timeout(1)`. |
| `agent-adapter-secret` | Stores adapter credentials in vault, encrypted. |

## Block migration (inline, no worker)

| Command | What it does |
| --- | --- |
| `block-migrate-upload` | Unmount vault, close LUKS, read raw blocks, upload to R2. Inline (cannot worker-spawn — tears down signing keys). 2-hour timeout. |
| `block-migrate-download` | Inverse: fetch blocks, write to target, open LUKS, mount vault. Inline. |

## Identity backup

| Command | What it does |
| --- | --- |
| `backup-identity` | Tar + encrypt identity files; store in vault. Used at hibernate. |
| `restore-identity` | Inverse: restore identity from vault. |

## Git integration

| Command | What it does |
| --- | --- |
| `git-setup` | Delegate to Shield's `/_internal/git-setup`. Initialize repo, configure credentials, optional pull. |

## Web tier management

| Command | What it does |
| --- | --- |
| `reconfigure-caddy-domain` | Update Caddy config with new domain. Reload Caddy. Sync iptables. |
| `b2b-sandbox-destroy` | Destroy a per-project sandbox: kill preview units, stop OpenClaw daemon, reap workspace, clean namespace. Validates slug format (path-traversal defense). |

## HTTP-routed commands

These go through file-api with internal JWT:

- `mount-volume` — attach + mount.
- `flush-volume` (alternate path).
- `force-unmount` (alternate path).
- `grow-volume` (alternate path).
- `backup-identity` (alternate path).
- `restore-identity` (alternate path).
- `maintenance-mode` (alternate path).
- `ping` — health check.

## Command verification

Every command is signed (ML-DSA-65) and optionally E2EE (ML-KEM-1024 + AES-256-GCM):

```json
{
  "id": "cmd-abc-123",
  "type": "wake-mount",
  "payload": "<opaque>",
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

1. ML-DSA-65 signature over metadata + payload hash. Verified with platform's public key (embedded at provisioning).
2. If `_e2ee`, decrypt payload via hybrid KEM using vault's `node.key`.
3. Reject on signature failure or decryption failure. Report rejection back to API.

## Claim → execute → report

```
1. Enforcer polls GET /api/servers/commands.
2. For each command:
   a. Verify signature.
   b. Decrypt if E2EE.
   c. Claim: POST /api/servers/commands/{id}/claim (signed).
   d. Other enforcers can't double-claim.
   e. Execute handler.
   f. Report: POST /api/servers/commands/{id}/complete { success, result/error }.
3. If commands processed, burst mode: skip sleep, re-poll.
```

## Cross-references

- Heartbeat protocol: [07-heartbeat-protocol.md](./07-heartbeat-protocol.md).
- Manifest update commands: [../operations/03-hot-shipping.md](../operations/03-hot-shipping.md).
- Wake-mount mechanics: [../lifecycle/04-vault-mount.md](../lifecycle/04-vault-mount.md).
- Block migration: [../storage/04-block-migration.md](../storage/04-block-migration.md).
