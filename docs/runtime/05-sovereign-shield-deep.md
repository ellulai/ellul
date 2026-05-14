# Sovereign Shield: deep reference

Cross-references with [../security/02-sovereign-shield.md](../security/02-sovereign-shield.md). This page is the runtime / endpoint reference.

## Endpoint inventory

### Public-facing (forward_auth target + browser-direct)

- `GET /_auth/session` — forward_auth target. Returns `200 + headers` or 401.
- `POST /_auth/login/start`, `POST /_auth/login/finish` — passkey login.
- `POST /_auth/register/start`, `POST /_auth/register/finish` — passkey enrollment.
- `POST /_auth/recovery` — recovery-code login.
- `POST /_auth/logout` — invalidate session.
- `GET /_auth/bridge` — postMessage bridge for platform UI.

### Tier

- `GET /_auth/tier/current` — current tier.
- `POST /_auth/tier/upgrade-prepare` — start passkey enrollment.
- `POST /_auth/tier/switch` — transition (localhost + internal token).
- `POST /_auth/tier/sovereign` — irreversible private_locked transition.

### Gates

- `POST /_auth/gates/request` — agent submits gate request.
- `POST /_auth/gates/respond` — user approves/denies.
- `GET /_auth/gates/stream` — SSE event stream to dashboard.
- `GET /_auth/gates/state` — current gates for an app/thread.

### Internal (called by services with IPC token)

- `POST /_auth/terminal/validate` — single-use token validation (term-proxy).
- `POST /_auth/terminal/session/create` — create term session.
- `POST /_auth/terminal/session/validate` — verify term session.
- `POST /_auth/agent/validate` — agent token (chat WS).
- `POST /_auth/code/session/create` — code session (file-api).
- `POST /_internal/git-setup` — git repo init (called by enforcer).
- `POST /_internal/sandbox/destroy` — destroy sandbox (called by enforcer).
- `POST /_internal/db/query` — query proxy (called by agent-bridge).
- `POST /_internal/db/provision` — create per-app DB.
- `POST /_internal/db/backup` — trigger backup.
- `POST /_internal/deploy` — execute approved deploy.

### Settings

- `GET /_auth/settings` — current settings.
- `POST /_auth/settings` — update terminal/SSH enabled, view mode, UI mode.

### SSH keys

- `GET /_auth/keys` — list keys.
- `POST /_auth/keys` — add key.
- `DELETE /_auth/keys/:fingerprint` — remove key.

### Vault secrets (dashboard-managed)

- `GET /_auth/vault/files` — list vault files.
- `POST /_auth/vault/file` — write secret.
- `DELETE /_auth/vault/file` — delete secret.

### Audit

- `GET /_auth/audit/log` — query log with filters.
- `GET /_auth/audit/verify` — verify hash chain integrity.

### Health

- `GET /health` — service health (returns 423 during boot if LUKS pending).

## Boot retries

Shield's systemd unit:

```
StartLimitBurst=3
StartLimitIntervalSec=60
```

3 retries within 60s. If exhausted, Caddy reloads with a lockdown Caddyfile (every protected route returns 503). Enforcer continues retrying via heartbeat.

This avoids a single startup failure (often `better-sqlite3` native init issue on slow ARM disks) breaking the whole boot.

## Caddyfile regeneration

When tier or domain changes:

```bash
sudo /usr/local/bin/ellul-caddy-gen \
  --model "$DEPLOYMENT_MODEL" \
  --main-domain "$MAIN_DOMAIN" \
  ... > /etc/caddy/Caddyfile.new
sudo caddy validate --config /etc/caddy/Caddyfile.new
sudo mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Sudo entries permit only these commands for shield-runner.

## Internal token files

```
/run/shield/                              shield-runner:shield-ipc 2750
/run/shield/internal-file-api.token       shield-runner:shield-ipc 640
/run/shield/internal-agent-bridge.token   shield-runner:shield-ipc 640
/run/shield/internal-enforcer.token       shield-runner:shield-ipc 640
```

Each token regenerated on Shield boot. Service `shield-ipc` group access is via SupplementaryGroups in unit files (not user shell).

## Bundle structure

Shield is a TypeScript application. Build via esbuild. Output: single `server.js` ~10MB at `/opt/ellul/auth/server.js`. **Copied** (not symlinked) from `/opt/ellul/releases/core-runtime/current/sovereign-shield.js` because Node's `require()` resolves relative to the real path; symlinks break `node_modules` resolution.

For details: [../security/02-sovereign-shield.md](../security/02-sovereign-shield.md).
