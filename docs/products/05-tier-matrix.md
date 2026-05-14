# Tier matrix

Feature comparison across all products and security tiers.

## Products vs security tiers

Security tiers (`standard`, `web_locked`, `private_locked`) apply within a product. The product determines what features exist; the security tier determines how authentication works.

| Product | Default sec tier | Tiers supported |
| --- | --- | --- |
| Cloud Platform Free | standard | standard only |
| Cloud Platform Paid | standard | standard, web_locked, private_locked |
| Cloud Sandbox | standard | standard, web_locked, private_locked |
| Shield Gateway | standard | standard, web_locked, private_locked |

Free tier doesn't support web_locked because passkey enrollment requires console upgrade — which we restrict to paying customers. (This is a product decision, not a technical limitation.)

## Feature matrix

| Feature | CP Free | CP Starter | CP Standard | Sandbox | Shield Gateway |
| --- | --- | --- | --- | --- | --- |
| Browser UI | yes | yes | yes | minimal | none |
| Web terminal | yes | yes | yes | no | no |
| Code browser | yes | yes | yes | no | no |
| Per-project namespaces | yes (1) | yes (5) | yes (20) | yes (5/20) | n/a |
| AI CLIs (Claude, Codex, Gemini) | yes | yes | yes | yes | no |
| Preview servers | yes | yes | yes | no | no |
| Custom domains | yes | yes | yes | yes | n/a |
| Database (Postgres) | yes | yes | yes | yes | no |
| Deploy gate | yes | yes | yes | yes | n/a |
| Hibernate/wake | yes | yes | yes | yes | yes |
| Cloudflare proxied | yes | yes | yes | yes | optional |
| Direct mode | optional | optional | optional | optional | optional |

## Resource limits

| Tier | RAM | vCPU | Disk | Bandwidth | CPU limit |
| --- | --- | --- | --- | --- | --- |
| CP Free | 2GB | 1 | 40GB | throttled 500 KB/s | 80% (cgroup) |
| CP Starter | 4GB | 3 | 80GB | unlimited | none |
| CP Standard | 8GB | 4 | 160GB | unlimited | none |
| Sandbox $20 | 4GB | 3 | 80GB | unlimited | none |
| Sandbox $50 | 8GB | 4 | 160GB | unlimited | none |
| Shield Gateway | 2GB | 1 | 40GB | unlimited | none |

## Restrictions on free tier

| Restriction | Reason |
| --- | --- |
| 1 project max | Resource constraint on small VM |
| Mining pool DNS blocked | Abuse prevention |
| Tunnel services blocked | Abuse prevention |
| Cloud APIs blocked (Vercel, Fly, etc.) | Resource arbitrage prevention |
| Bandwidth throttle 500 KB/s | Abuse prevention |
| Tight localhost port whitelist | Force traffic through Caddy auth |
| No web_locked/sovereign | Product gating |

Paid tiers lift these (except mining/tunnel blocks, which are universal).

## Idle / hibernate behaviour

| Tier | Idle algorithm | Soft cap | Hard kill |
| --- | --- | --- | --- |
| CP Free / Sandbox $20 | Starter (strict) | 120 min | 130 min |
| CP Starter | Starter | 120 min | 130 min |
| CP Standard / Sandbox $50 | Builder (smart) | 8h | 8h 10min |
| Shield Gateway | Doesn't hibernate (always-on) | n/a | n/a |

## Provisioning profiles

| Product | Profile |
| --- | --- |
| CP Free | `cloud_platform_hobby` |
| CP Paid, Sandbox | `cloud_platform` (or `cloud_sandbox`) |
| Shield Gateway | `shield_proxy` |

For details: [../provisioning/03-tier-profiles.md](../provisioning/03-tier-profiles.md).

## Cross-references

- Cloud Platform: [01-cloud-platform.md](./01-cloud-platform.md).
- Cloud Sandbox: [02-cloud-sandbox.md](./02-cloud-sandbox.md).
- Shield Gateway: [03-shield-gateway.md](./03-shield-gateway.md).
- Security tiers: [../security/05-tiers.md](../security/05-tiers.md).
