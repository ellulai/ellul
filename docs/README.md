# ellul.ai documentation v2

This is the canonical, code-verified documentation for the ellul.ai platform, infrastructure, and operations. It supersedes the legacy `/docs` tree, which has accumulated drift since the architecture solidified.

Every claim in v2 has been verified against the codebase as of **2026-04-25**. File and line references are included throughout. When code changes, update the matching v2 doc — do not write into the legacy tree.

## Reading order

If you are new, read these in order:

1. [`00-overview.md`](./00-overview.md) — what ellul.ai is, the products, the architectural philosophy.
2. [`architecture/00-system-overview.md`](./architecture/00-system-overview.md) — high-level mental model: control plane, VPS, gateway.
3. [`architecture/01-glossary.md`](./architecture/01-glossary.md) — terms you will see everywhere (Shield, vault, gate, OpenClaw, etc.).
4. [`architecture/02-component-map.md`](./architecture/02-component-map.md) — what lives in `apps/` and `packages/`.
5. [`architecture/03-vps-services.md`](./architecture/03-vps-services.md) — every systemd service that runs on a VPS.

After that, jump to whichever area is relevant.

## Section index

| Section | Purpose |
| --- | --- |
| [`architecture/`](./architecture/) | System overview, glossary, component map, trust boundaries, data model. |
| [`provisioning/`](./provisioning/) | How a VPS gets created: orchestrator, sections, tier profiles, boot/identity split, debugging. |
| [`security/`](./security/) | Kernel hardening, Sovereign Shield, gates, passkey/PoP, tiers, git-push protection, namespace isolation, threat model. |
| [`networking/`](./networking/) | Cloudflare Worker, Caddy, origin tags, mTLS, iptables, Warden, port registry. |
| [`abuse-protection/`](./abuse-protection/) | Miner detection, egress filtering, bandwidth monitoring, Hetzner abuse response. |
| [`runtime/`](./runtime/) | Enforcer, watchdog, agent-bridge, file-api, sovereign-shield internals. |
| [`lifecycle/`](./lifecycle/) | Hibernate, wake, state machine, vault mount, zombie recovery. |
| [`storage/`](./storage/) | Vault layout, LUKS modes, sovereign mode, block migration, PostgreSQL. |
| [`auth/`](./auth/) | Authentication flows, sessions, internal tokens. |
| [`isolation/`](./isolation/) | Per-project namespaces, mount/PID/network isolation, seccomp, cross-project snapshots. |
| [`operations/`](./operations/) | Release pipeline, manifest system, hot-shipping, runbooks, observability, capability versioning, testing. |
| [`incus/`](./incus/) | Incus orchestration layer: QEMU/KVM VMs on bare-metal, warm pool, scheduler, routing, security, host commissioning. |
| [`products/`](./products/) | Cloud Platform, Cloud Sandbox, Shield Gateway, Shield local daemon, Free Tier, BYOS, Game Studio, Paperclip; tier matrix. |
| [`post-quantum/`](./post-quantum/) | PQC engineering: hybrid KEM, ML-DSA migration, fat keys, HD wallet quantum-blind. |
| [`preview-and-deployment/`](./preview-and-deployment/) | Dev-server runtime, framework probe, production deploy, monorepo handling. |
| [`i18n/`](./i18n/) | The five translation surfaces (UI, API, VPS shell, agent-context, MDX content), the three i18n packages, and the add-a-locale checklist. |
| [`seo/`](./seo/) | Operational SEO/locale launch artefacts (checklists, templates, per-locale dashboards). |

## How v2 differs from legacy `/docs`

- **Code-verified.** Every section was cross-referenced against the actual implementation files. Outdated sections in the legacy tree are flagged but not edited there.
- **Single source of truth.** Each topic has exactly one home. No duplication across SECURITY.md, SECURITY-HARDENING-PLAN.md, SECURITY-AUDIT-REMEDIATION-3.md, etc.
- **Run-only.** Plans, audits, and roadmaps live elsewhere. v2 documents only what is shipped and how it works today.
- **File:line references.** Where it helps a reader find the code, references are concrete.

## What is NOT here

- Patent applications (legacy `/docs/PATENT-*.md`) — those are legal artefacts, not engineering documentation.
- NIST RFI responses — same.
- Marketing or pricing copy — see `apps/web/`.
- In-progress design docs — those belong in conversation/PRs, not in v2.

## Writing convention

- Use file paths absolute from the repo root: `apps/api/src/provisioning/payload.ts:246`.
- Show real shell, JSON, or TypeScript when it clarifies; never fabricate.
- If you must reference a future plan or known gap, mark it explicitly: **Status: planned**, **Status: known gap**, **Status: TODO**. Don't let intent and reality blur.
