# Hosted AI Orchestrators

> **Status: deferred.** Designed but not implemented. Active focus is the
> main platform (Cloud Platform, Cloud Sandbox, Shield Gateway). This
> directory captures the design so the work can be picked up later
> without re-deriving it.

## What this is

The end-state product is **B2B infrastructure**: orchestrator vendors
(Paperclip, Fusion, Letta, CrewAI Hosted, future arrivals) call ellul.ai's
Runtime API to provision per-tenant Linux namespaces with passkey auth,
vault-backed persistence, hibernate-wake, and real isolation between
agents. They handle their UI + brand + customer relationship; we run the
kernel-grade infrastructure under it.

The hybrid path to get there is to be our own first customer:

1. **Phase 1:** ship Paperclip Hosted as a B2C SKU on top of our existing
   stack to prove the runtime works under load. Builds operational scars,
   first revenue, credibility for B2B sales.
2. **Phase 2:** pivot to B2B. Land 1–2 orchestrator partnerships (Fusion,
   Letta, t3code-via-Theo). Same runtime, wholesale per-tenant-month
   pricing, co-brand surfaces.
3. **Phase 3:** scale the catalog. Become the default runtime for new
   orchestrators. Paperclip Hosted becomes a *product line* of an
   infrastructure company.

## Why deferred

- **No paying customers on the main platform yet.** Validating runtime
  viability with real load before opening a second product line.
- **Patch carry is non-trivial maintenance.** The W6 trust-headers patch
  needs CI gates, lifetime SLA, build-artifact verification, and an
  open upstream PR to be defensible enterprise practice (see
  [enterprise-gates.md](enterprise-gates.md)). Doing this without the
  surrounding discipline is just a polite fork.
- **Vendor outreach (W16.1) hasn't started.** Without confirmed vendor
  partnership interest, building the B2B Runtime API is speculative
  scope.
- **Phase A alone is ~6 weeks of focused work.** The main platform needs
  our attention more than the second product line does today.

## When to revive

All of these should be true:

1. Main platform has paying customers with known SLAs and a stable
   incident cadence
2. At least one orchestrator vendor (Paperclip's `cryppadotta`, Fusion,
   or Letta) has expressed concrete partnership interest — or we have
   B2C demand for Paperclip Hosted strong enough to justify going first
3. Engineering capacity exists for a 6-week Phase A push without
   degrading main-platform velocity
4. The patch surface upstream has not been resolved by PR #1046's
   `managed` mode (or it has merged but we still want the HMAC
   strengthening)

When those conditions are met, the [enterprise-gates.md](enterprise-gates.md)
acceptance criteria become the entry checklist for Phase A.

## Status of the previous scaffolding

The W1 manifest engine scaffolding (originally shipped in commit
`a0d8ea7c` at `apps/api/src/provisioning/orchestrators/`, dry-run-only
behind `ELLUL_ORCHESTRATOR_ENGINE=1`) has been **removed** to keep the
codebase focused on the main platform.

When this product line is revived:
- The manifest abstraction is documented in
  [public-api-design.md](public-api-design.md) (every field
  classified, public API shape sketched). Re-implementing
  `OrchestratorManifest` and `defineOrchestrator()` from that doc is
  straightforward — the design choices are already made.
- The engine phase contract is documented in
  [enterprise-gates.md](enterprise-gates.md) (Gate 3 outlines the
  build-artifact verification flow). The phase ordering DAG is in the
  plan file under W8.
- The reference patch content for W6 is preserved in
  [patch-design.md](patch-design.md) as a code block. Re-validate
  against the then-current upstream tag before applying.

In short: the design lives in these docs, not in code. Restart code
work by re-creating
`apps/api/src/provisioning/orchestrators/{types,engine,registry,
paperclip,fusion,index}.ts` from these documents and the plan.

## Documents in this directory

| Doc | Topic | Plan workstream |
|---|---|---|
| [patch-design.md](patch-design.md) | Trust-headers patch — header_trust deployment mode design + reference patch content | W6 |
| [public-api-design.md](public-api-design.md) | Manifest as public Runtime API — field-by-field public/internal classification | W17.1 |
| [partnership-outreach.md](partnership-outreach.md) | Maintainer relationship plan, identified contacts, engagement sequence | W16.1 |
| [enterprise-gates.md](enterprise-gates.md) | What makes patching actually enterprise — discipline items, alternatives, decision tree | W6 + W14 |

## Source of truth

The canonical plan lives at
`/Users/joeet/.claude/plans/plan-out-looking-at-rustling-charm.md`
and covers Phase A through Phase E with full workstream definitions
(W1–W18). This directory captures specific design artifacts that
supplement that plan; when these documents and the plan disagree, the
plan is canonical.
