# Networking overview

Three layers carry traffic from the public internet to a VPS:

1. **Cloudflare DNS + Worker** — routing decisions, KV lookup.
2. **Cloudflare Edge → VPS Caddy (mTLS)** — TLS termination at edge, AOP to origin.
3. **Caddy → backend services** — forward_auth, host-based and path-based routing.

For a request flow walk-through: [../architecture/00-system-overview.md](../architecture/00-system-overview.md).

## Pages

- [01-gateway-routing.md](./01-gateway-routing.md) — request flow, deployment models.
- [02-cloudflare-worker.md](./02-cloudflare-worker.md) — KV lookup, resolveOverride, CORS.
- [03-origin-tags.md](./03-origin-tags.md) — IP-to-tag, origin DNS records, IPv6 limit.
- [04-caddy.md](./04-caddy.md) — Caddyfile generation, mTLS, forward_auth.
- [05-iptables-warden.md](./05-iptables-warden.md) — egress firewall.
- [06-domain-model.md](./06-domain-model.md) — `.ai` vs `.app`, custom domains.
- [07-port-registry.md](./07-port-registry.md) — every port and what listens.

## Three deployment models

| Model | Description | Customer use case |
| --- | --- | --- |
| `proxied` (gateway) | Cloudflare Worker → resolveOverride → mTLS to origin | Default. CF protections + per-id routing. |
| `direct` | Let's Encrypt ACME, no Cloudflare | Customer wants direct connection, no CF. |
| (legacy) | Cloudflare proxied wildcard, no Worker | Older flow; mostly retired. |

In code, the VPS uses a binary model: `proxied | direct`. The API's three-way (`gateway` / `cloudflare` / `direct`) is normalized to `proxied | direct` at the VPS boundary by `normalizeDeploymentModel()` in `packages/vps/src/services/shared/constants.ts`.

## Critical invariant: origin DNS records must be DNS-only

Origin records `o-<tag>.ellul.ai` and `o-<tag>.ellul.app` MUST have `proxied: false` (DNS-only). If accidentally proxied, the resolveOverride sub-request loops back through Cloudflare's wildcard proxy → infinite loop.

The reconciler (`apps/api/src/cron/gateway-reconciler.ts`) detects and corrects this on every cycle.

For details: [03-origin-tags.md](./03-origin-tags.md).

## Critical invariant: SNI must include origin hostname

Cloudflare's `resolveOverride` rewrites both DNS resolution AND TLS SNI to the origin name. Caddy's strict SNI matching (auto-enabled by mTLS) requires the origin name to be in the site block's address list. Otherwise: 421 Misdirected Request.

The Caddyfile generator includes `o-<tag>.ellul.ai:443` in the appropriate site block, reading `<tag>` from `/etc/ellul/origin-tag` (written by enforcer at boot).

For details: [04-caddy.md](./04-caddy.md).
