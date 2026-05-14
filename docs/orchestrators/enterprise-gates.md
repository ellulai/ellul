# Enterprise discipline gates for the orchestrator hosting work

> **Status: design only.** These are the controls that must be in
> place before the W6 trust-headers patch can be applied to
> production builds. Without them, "patch carried in repo" is just a
> polite fork without admission.

## Why this document exists

A trust-headers patch alone is not enterprise practice; the
*discipline around it* is. Linux distributions, Kubernetes vendors,
and every serious infrastructure team that maintains downstream
patches against upstream packages does so inside an envelope of
operational controls that bound the maintenance burden, ensure
build correctness, and provide an exit ramp.

Without those controls, patching turns into a soft fork that nobody
admits is a fork — slow drift, stale CVE response, audit pain.

## The five gates

Each must be in place before the W6 patch can be applied to a
production build.

### Gate 1 — CI patch-apply verification

**What:** A test in the orchestrator engine's CI suite that, on every
commit:
1. Clones `paperclipai/paperclip` at the manifest's pinned ref
2. Runs `git apply --check patches/paperclip-trust-headers.patch`
3. Fails the build (red CI) on non-zero exit

**Why:** Without this, an upstream tag bump can silently invalidate
the patch and the failure surfaces only at provisioning time, on a
customer VPS, in production.

**Acceptance:** test exists at
`apps/api/tests/orchestrator-patch-apply.test.ts` (or equivalent)
and runs on every PR. Pre-existing test infrastructure in apps/api
already supports this pattern.

**LOC estimate:** ~30 lines (clone helper, exec git apply, assert
exit code).

### Gate 2 — Upstream-bump tracker

**What:** Scheduled job that polls upstream tags (via GitHub API)
weekly. When the manifest's `pinnedRef` is more than two minor
versions behind the latest tag, the job opens a tracking issue in our
own repo titled `[orchestrator] paperclip pinned ref <X> behind by N
versions`.

**Why:** Pinned refs that stagnate accumulate CVE exposure (we don't
pick up upstream security fixes) and rebase debt (the longer we wait,
the more divergent the patch surface becomes).

**Acceptance:** GitHub Action workflow exists at
`.github/workflows/orchestrator-bump-tracker.yml` with a weekly cron
trigger; opens issues against our repo with the diff between pinned
and latest tags.

**LOC estimate:** ~50 lines of YAML + a small script.

### Gate 3 — Build-artifact gate

**What:** The orchestrator engine's `applyUpstreamPatch` phase (W6
implementation in the rebuilt
`apps/api/src/provisioning/orchestrators/engine.ts`) must:
1. Verify the patch applies cleanly to the cloned upstream tree
2. Compute a hash of the resulting tree
3. Compare against an expected hash recorded in the manifest
4. Refuse to provision if the hash doesn't match

**Why:** Without this, a corrupted patch file or a pre-applied state
on the tree can silently produce a different binary than expected.
Production builds need byte-exact reproducibility from `manifest +
upstream ref + patch` to artifact.

**Acceptance:** manifest has `expectedTreeHash: string` field;
engine computes and compares; provisioning fails loud on mismatch.

**LOC estimate:** ~40 lines in the engine, plus the manifest field
addition (already designed — see `OrchestratorIdentity.upstreamPatch`).

### Gate 4 — Patch lifetime SLA

**What:** A hard ceiling on how long the patch can be carried before
escalation. Encoded in the manifest:

```ts
identity: {
  ...
  upstreamPatch: "patches/paperclip-trust-headers.patch",
  upstreamPrUrl: "https://github.com/paperclipai/paperclip/pull/...",
  patchAuthoredAt: "2026-04-29",
  patchEscalateAt: "2026-10-29",        // 6 months default
  patchEscalationRule: "soft-fork" |    // when ceiling hits, decide:
                       "migrate-off" |  // - move to a different orchestrator
                       "accept-debt",   // - explicit accept with new ceiling
}
```

CI checks `patchEscalateAt` weekly and pages on-call if it's within
30 days of the ceiling without an action recorded.

**Why:** Without a stated escalation rule, "we'll just keep
maintaining the patch" becomes the default and the maintenance debt
compounds invisibly. Forcing a decision at a known date keeps the
patch genuinely temporary — or makes the soft-fork choice explicit.

**Acceptance:** manifest enforces these fields when
`upstreamPatch` is set; CI alerts on approaching escalate date;
manifest validation rejects patches whose `patchEscalateAt` is
already in the past.

**LOC estimate:** ~25 lines of manifest validation + ~30 lines of
CI alert.

### Gate 5 — SBOM and signed build artifact

**What:** Every Paperclip build that we ship to a tenant produces:
1. An SPDX SBOM listing all transitive npm dependencies + the patch
   diff content
2. A cosign signature over the build artifact
3. A pinned reference recorded in the audit log when provisioning
   completes

**Why:** Auditors (SOC2, customer security questionnaires) need to
verify what binary actually shipped. The patch is part of the build
provenance and must be reflected in the SBOM. Cosign signature lets
tenants verify the artifact came from us.

**Acceptance:** the W14 release engineering pipeline emits SBOM +
signature; the W8 provisioning step records both in the audit log;
the tenant-facing audit export (W9) includes them.

**LOC estimate:** larger — ~150 lines across W8, W9, W14. Properly
belongs to those workstreams but the *commitment* to it belongs in
the W6 envelope.

## Test coverage

The patch ships with vitest unit tests at
`server/src/middleware/auth.test.ts` covering:

- valid signed headers → `req.actor.type === "board"`, correct
  userId, lazy upsert verified by post-request DB query
- expired timestamp → 401 `stale_timestamp`
- tampered HMAC → 401 `hmac_invalid`
- missing headers → 401 `missing_headers`
- pipe in field → 401 `invalid_field`
- peer IP outside CIDR → 401 `untrusted_peer` (set
  `req.socket.remoteAddress` manually)
- tenant mismatch → 401 `tenant_mismatch`
- rotated key (previous valid within window) → accepted
- rotated key (previous expired) → rejected
- bearer agent JWT alongside `header_trust` mode → still works
  (orthogonal path)
- mode is NOT `header_trust` but env vars set → bypass does NOT fire
  (defends against the Greptile-flagged failure mode)

These tests are required for upstream PR acceptance and should be
included in the patch when filed against `paperclipai/paperclip`.

## Alternatives considered

### Soft fork (vendored repo we maintain)

Carry our own fork of `paperclipai/paperclip` at
`github.com/ellul-ai/paperclip-fork` (or a private mirror); rebase on
upstream tags on a release cadence; our changes live as commits on a
tracked branch.

**Pros:** clearer ownership story for auditors. Fewer "is this a fork
or a patch" semantic arguments.

**Cons:** more work to keep current — every upstream tag bump is a
manual rebase. Worse for upstream-PR optics ("they forked us instead
of contributing"). Functionally equivalent end state to the patch
approach with the gates in place.

**Verdict:** rejected for now. If the patch lifetime SLA (Gate 4)
escalates to soft-fork, this is the path.

### Sidecar proxy that injects Paperclip-native auth

Run an HTTP proxy in front of Paperclip that:
- Verifies our X-Ellul-* HMAC headers
- Forges a Paperclip-native session (Better Auth cookie or board API
  key) per request
- Forwards the request

**Pros:** no patch on Paperclip itself.

**Cons:** Paperclip's data model has per-user identity baked in
(`authUsers`, `companyMemberships`, `instanceUserRoles`). The only
ways to populate it are:
1. BetterAuth session forging — write to Paperclip's session table
   on every request. Tightly couples to Paperclip's session schema,
   which can change between minor releases. Worse coupling than the
   middleware patch.
2. The trust-headers patch (this design).
3. All tenants share one synthetic user. Kills the multi-user
   product.

**Verdict:** rejected. The schema-coupling tax is worse than the
patch-coupling tax.

### Wait for upstream `managed` mode (PR #1046)

Don't carry our own patch; use whatever upstream ships when #1046
merges.

**Pros:** zero ongoing maintenance.

**Cons:** PR #1046 uses static `X-Paperclip-Management-Secret`
bearer — replayable on leak. Greptile flagged auth-bypass-not-mode-gated
as a security issue. The PR has been open ~6 weeks at design time;
merge timing is outside our control.

**Verdict:** rejected as the *primary* path. Use our patch
independently. When (if) #1046 merges, we can layer HMAC strengthening
as a follow-up PR on top of `managed`.

### `byo_auth` deployment mode for the public API

Public Runtime API exposes a `byo_auth` mode where the vendor
terminates their own auth (SAML, OIDC, custom) and Paperclip-style
header trust isn't needed.

**Pros:** doesn't require a patch on the vendor's image.

**Cons:** doesn't apply to Paperclip specifically because Paperclip's
auth IS BetterAuth, which we're trying to bypass. `byo_auth` is for
vendors with simpler identity models; see
[public-api-design.md](public-api-design.md) for the full design.

**Verdict:** complementary, not alternative. Both modes ship in the
public API.

## Decision tree for the day work resumes

```
START
  │
  ▼
Has main platform stabilized + customer demand for orchestrator hosting?
  │
  ├─ No  → continue deferral. Re-evaluate quarterly.
  │
  └─ Yes ▼
        Has upstream PR #1046 merged with HMAC-comparable security?
          │
          ├─ Yes → use upstream `managed` mode; skip the patch entirely.
          │       Document the differences and migrate manifest.
          │
          └─ No  ▼
                Will engineering carry the 5 gates above?
                  │
                  ├─ Yes → ship W6 patch with gates. This document
                  │        becomes implementation checklist.
                  │
                  └─ No  → either
                          (a) add gates to capacity plan first, OR
                          (b) pursue soft fork strategy (more visible
                              maintenance, same end state), OR
                          (c) use `byo_auth` for non-Paperclip
                              orchestrators and defer Paperclip until
                              gate capacity exists.
```

## Acceptance checklist

When this work resumes, the W6 patch can be applied to production
builds when ALL of the following are true:

- [ ] Patch re-validated against then-current upstream pinned ref
- [ ] CI patch-apply gate (Gate 1) green on every PR
- [ ] Upstream-bump tracker (Gate 2) running, no stale issues
- [ ] Build-artifact gate (Gate 3) verifies expected tree hash
- [ ] Patch lifetime SLA (Gate 4) recorded in manifest with concrete
      escalation rule + escalate date
- [ ] SBOM emission (Gate 5) wired into W14 release pipeline
- [ ] vitest test coverage above committed and green
- [ ] Upstream PR opened against `paperclipai/paperclip`
- [ ] Outreach to cryppadotta initiated (see
      [partnership-outreach.md](partnership-outreach.md))

Until all eight are satisfied, the manifest's `enabled` field stays
`false` and the engine remains in dry-run mode.

## What this document deliberately does not decide

- Specific tool choices for SBOM emission (SPDX vs CycloneDX vs both)
- Specific signing infrastructure (cosign vs sigstore vs internal)
- Whether the upstream-bump tracker pages on-call or just opens
  issues
- Patch-vs-fork choice for orchestrators *other than* Paperclip;
  Fusion's auth model may not require either

Those are decisions for the team executing this when work resumes.
The document earmarks the abstraction; the implementer chooses the
specifics.
