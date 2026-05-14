# Products overview

ellul.ai sells three products on top of one infrastructure stack:

| Product | Tagline | Pricing |
| --- | --- | --- |
| [Cloud Platform](./01-cloud-platform.md) | AI coding workbench with chat, terminal, code browser | $0 / $20 / $50 |
| [Cloud Sandbox](./02-cloud-sandbox.md) | Sandboxed agent execution, no workbench UI | $20 / $50 |
| [Shield Gateway](./03-shield-gateway.md) | Standalone Sovereign Shield for self-hosted clouds | $10 |

All three products share:

- Same VPS infrastructure (Hetzner).
- Same provisioning pipeline.
- Same security model.
- Same lifecycle (hibernate/wake).

Differences are configuration: provisioning profile, services enabled, deployment model.

## Cross-cutting

- [05-tier-matrix.md](./05-tier-matrix.md) — feature comparison across products and security tiers.

## Vertical compute model

A unifying design: each customer gets a vertical compute slice.

- Vertical: dedicated VPS, no multi-tenant kernel.
- Compute: scaled by Hetzner instance type (cax11 to cpx31 etc.).
- Slice: defined by namespace cap (free tier: 1 project, paid: more).

Pricing ladder reflects: more vertical compute (bigger VPS) + more namespace slots (more concurrent projects).
