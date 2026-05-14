# Shield Gateway

Standalone Sovereign Shield deployment. For customers running their own cloud who want Shield's auth + gate features without the full ellul.ai stack.

## Pricing

$10/month.

## What it is

A VPS running just:

- Caddy (reverse proxy).
- Sovereign Shield (auth + gates).

No file-api, no agent-bridge, no preview servers. Just the auth layer.

## Use case

Customer has their own backend (e.g., self-hosted database, app servers, etc.) and wants:

- Passkey authentication.
- Gate-based authorization.
- Audit log.
- Tier transitions (web_locked, sovereign).

They point their backend's auth at our Shield instance:

```
[customer app] → [our Shield] → forward_auth → [customer backend]
```

## What runs

```
caddy.service
ellul-sovereign-shield.service
ellul-luks-boot.service
ellul-shield-prereq.service
ellul-enforcer.service (state, heartbeat)
```

That's it. No file-api, no agent-bridge, no PM2, no PostgreSQL by default.

## Architecture

Provisioning profile: `shield_proxy`. Firewall mode: `governance` (minimal — only Shield + Caddy).

```typescript
profile.services = {
  fileApi: false,
  agentBridge: false,
  termProxy: false,
  watchdog: false,
};
profile.firewall = 'governance';
```

## Customer integration

Customer's backend integrates by:

- Putting their backend behind our Caddy (forward_auth to our Shield).
- Or running their own Caddy and calling our Shield's `/_auth/session` endpoint.

We provide:

- API for managing users (passkeys, recovery codes, sessions).
- Webhook for gate decisions (notify customer's backend when a gate is granted).

## Tier support

Shield Gateway supports the same three security tiers (`standard`, `web_locked`, `private_locked`) as Cloud Platform. Customer can offer their users sovereign-mode auth.

## Cross-references

- Sovereign Shield internals: [../security/02-sovereign-shield.md](../security/02-sovereign-shield.md).
- Tier matrix: [05-tier-matrix.md](./05-tier-matrix.md).
