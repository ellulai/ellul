# W17.1 Manifest as public Runtime API — design audit

> **Status: design only, not shipped.** When this work resumes, this
> audit becomes the inheritance brief for W17 implementation.

This document classifies every field on the `OrchestratorManifest`
type (which previously lived at
`apps/api/src/provisioning/orchestrators/types.ts` and was removed
when the program was deferred — see [README.md](README.md) for
context) as either:

- **Public** — safe to expose verbatim on the public Runtime API
  surface that orchestrator vendors integrate against
- **Public, reshaped** — projects to the public surface but with a
  different shape (typically because the vendor model is different
  from the B2C model)
- **Internal-only** — must NOT cross the public boundary, with the
  reason recorded here

The current manifest in `types.ts` was designed for the internal B2C
case (we host Paperclip / Fusion ourselves as SKUs of our cloud
platform). The B2B reframe of "ellul.ai is a runtime for AI
orchestrators" requires a separate but adjacent contract: the
*vendor-provided* manifest that drives `POST /v1/orchestrators`.

This audit produces no code changes. It locks in the abstraction
split ahead of W17 implementation so future commits don't accidentally
expose internal-only state on the public surface.

## Boundary properties

The public Runtime API enforces:

1. **No filesystem paths controlled by the vendor.** A vendor field
   that resolves to a host path (e.g. `source.path`,
   `onboarding.preSeed`) is a path-traversal / RCE vector. Public
   surface accepts capability descriptions (image refs, webhook URLs)
   that we resolve to host paths internally.
2. **No vendor-controlled code execution at provisioning time.** The
   vendor cannot ship arbitrary build commands, npm packages, or
   patches that we apply on our infrastructure. Public surface ships
   pre-built signed artifacts.
3. **No vendor-controlled adapter integration into our trust
   boundary.** Adapters that run inside the orchestrator's address
   space and talk to agent-bridge are co-development with us, not
   arbitrary npm packages.
4. **Versioned and forward-compatible.** Public surface lives at
   `/v1/`; additions only within v1; breaking changes ship as
   `/v2/`.

## Field-by-field classification

### `name: string`
**Public.** Vendor-chosen lowercase identifier. Constraint:
matches `^[a-z][a-z0-9-]{1,30}$`. Validated identically on both sides;
collision handled by 409 in the public API.

### `enabled: boolean`
**Internal-only.** This flag controls whether OUR engine provisions
the orchestrator. The B2B API has the inverse semantics — vendor
calls `POST /v1/orchestrators/:name/activate`. Different state
machine, do not project.

### `product.sku`
**Internal-only.** Maps to OUR Stripe pricing + product table. The
vendor doesn't have a "SKU" in our sense; they have a tenant-month
billing rate negotiated wholesale. New field needed: `billing.rate`.

### `product.displayName`
**Public.** Used by sovereign-shield co-brand surfaces and emails.
Vendor-supplied.

### `product.entryDomain`
**Public, reshaped.** For B2C orchestrators we operate, this is a
subdomain of `ellul.app`. For B2B vendors, the vendor can either
(a) accept a generated `{tenant}.{vendor-name}.runtime.ellul.ai`
hostname or (b) BYO their own domain via DNS proof-of-control. The
public surface is `domains: { mode: "managed" | "byo"; baseDomain?: string }`.

### `product.brandedLoginPath`, `product.brandedEmailFrom`
**Public.** Co-brand fields. Vendor-supplied. W18 (co-brand surface)
defines the mandatory ellul-ai footer that wraps these.

### `source.{type, path, pinnedRef, integrityHash}`
**Internal-only — entire group.**
- `path` is a host-controlled vendored submodule path. Vendors MUST
  NOT control filesystem paths on our infrastructure.
- `pinnedRef` and `integrityHash` make sense only against a git
  source we control checkout of.
- `type: "git_submodule"` is one mechanism we use; B2B doesn't.

**Public replacement:** `image: { ref: string; signature: string; sbom?: string }`.
Vendor pushes a Docker / OCI image to a registry; we verify cosign
signature against vendor's published public key before pulling.
`sbom` (SPDX or CycloneDX) is optional but encouraged and gates
higher trust tiers.

### `build.{cmd, artifacts, timeoutSec}`
**Internal-only — entire group.** Build commands are arbitrary code
execution. We do not run vendor-provided build commands. Public
equivalent is "vendor pushes pre-built image; we pull and run."

### `runtime.cmd`, `runtime.args`
**Internal-only.** Same reasoning — running an arbitrary command on
our host. Public equivalent: image's `ENTRYPOINT` / `CMD`. Vendors
specify these in their Dockerfile, not on our API.

### `runtime.port`
**Public.** Container port the orchestrator listens on. We map to a
namespace-internal port; vendors don't see the host port.

### `runtime.healthcheck`, `runtime.readinessGate`, `runtime.shutdown`
**Public — entire group.** Generic deployment lifecycle hooks.
Vendors specify HTTP path + expected status + timeouts. We honor
them identically to internal manifests.

### `storage.postgres`
**Public, reshaped.**
- `required: boolean` → public, identical
- `schemaInit: "managed" | "first_run"` → public, identical
- `backupSchedule`, `pitrRetentionDays` → public but **gated by
  pricing tier**. Default tier gets daily backups; PITR is a
  paid-tier feature. Vendor-requested values clamped to tier limits.

### `storage.fs.{stateDir, vaultBound, backupSchedule, retentionDays}`
**Public, reshaped.**
- `stateDir` is internal — vendors shouldn't choose host paths.
  Public equivalent: `volumes: [{ name: "state"; mountPath: "/var/lib/X" }]`.
  Vendor specifies the in-container mount path; we control the host
  path that backs it.
- `vaultBound` → always true on the public API; internal-only flag
  exists for backwards compat with our B2C path. Not exposed.
- `backupSchedule`, `retentionDays` → same tier-gating as Postgres.

### `identity.mode`
**Public.** Currently the manifest types only `"trusted_proxy"`. The
public surface adds `"byo_auth"` for vendors who want to terminate
auth themselves and not rely on sovereign-shield. (Tradeoff:
byo_auth loses our enterprise SSO for free; vendors take on the
SAML/OIDC work.)

### `identity.headerSchema`
**Public, reshaped.** Internal manifests hardcode `X-Ellul-*` (matches
the W6 patch's prefix env). Public surface lets vendors specify their
own prefix and field names — but the field *semantics* (user, tenant,
tier, session, timestamp, hmac) are fixed. Vendor manifest:

```json
"identity": {
  "mode": "trusted_proxy",
  "headerPrefix": "X-Ellul-",
  "fieldMap": {
    "user": "User", "tenant": "Tenant", "tier": "Tier",
    "session": "Session", "timestamp": "Timestamp", "signature": "HMAC"
  }
}
```

The HMAC algorithm + canonicalization are NOT vendor-controlled — the
runtime fixes those (HMAC-SHA256 over
`${user}|${tenant}|${tier}|${session}|${timestamp}`).

### `identity.upstreamPatch`
**Internal-only.** A patch path we apply to a vendored upstream tree.
The public surface does not accept patches; vendors with auth
requirements that can't be satisfied by `trusted_proxy` or `byo_auth`
file a feature request. Accepting arbitrary vendor patches against
their image would defeat the security boundary we provide.

### `adapter.{package, registerEntry, uiRegisterEntry}`
**Internal-only — entire group.** Adapter integration into a
specific upstream's adapter registry is co-development. The public
surface offers a generic streaming-bridge HTTP/WebSocket contract
that any vendor can call from their orchestrator code. If a vendor
wants deeper integration (custom UI components, native cost
reporting), that's a separate engagement — not a manifest field.

### `onboarding.preSeed`
**Internal-only.** A path to a TS script we run at provisioning.
Public equivalent: `webhooks.preprovision: { url: string; secret: string }`.
We POST tenant context to the vendor's URL after provisioning; the
vendor's webhook can pre-seed via the orchestrator's own REST API
(which they control). HMAC-signed with vendor-supplied secret;
retries with exponential backoff; failures surface as a
`provisioning_failed` state on the tenant.

### `onboarding.skipWizard`
**Public.** Boolean — vendor declares "first-run wizard must never
appear; tenant lands on populated state via webhook." Validated at
manifest registration; we enforce by failing provisioning if the
vendor's UI is observed serving a setup-wizard route during the
post-provisioning health check.

### `observability.tracing.otelEndpoint`
**Public, reshaped.** Internal manifests use a string
`"$OTEL_COLLECTOR"` which we resolve from env. Public surface
accepts:
- `"shared"` — vendor uses our OTEL backend (default tier)
- `{ url: string; headers?: Record<string, string> }` — vendor's own
  collector (paid tier, requires customer DPA covering trace data
  egress)

### `observability.metrics.prometheusPath`, `observability.auditEmit.topic`
**Public.** Trivially portable. `auditEmit.topic` becomes the audit
log routing key vendors can subscribe to via webhook or shared S3
export.

### `upgrade.{strategy, canaryPct, rollbackOn, schemaCompatibility}`
**Public — entire group.** Deployment strategy is vendor's call.
`schemaCompatibility: "forward_compatible_required"` is enforced by
us regardless of what the vendor sets — we will not ship a vendor
release that breaks tenants on the prior version. Vendor-set value
becomes a *minimum*, not a maximum.

### `resourceProfile.{minMemoryMiB, recommendedMemoryMiB, cpuShare}`
**Public.** Capacity planning info. We use it for namespace
sizing + admission control + billing tier mapping.

## Public Runtime API shape (informative)

```ts
// POST /v1/orchestrators
interface OrchestratorRegistration {
  name: string;
  displayName: string;
  image: { ref: string; signature: string; sbom?: string };
  domains: { mode: "managed" } | { mode: "byo"; baseDomain: string };
  branding: { loginPath: string; emailFrom: string; cobrand: "required" | "premium_optout" };
  runtime: {
    port: number;
    healthcheck: { path: string; expect: number; gracePeriodSec: number };
    readinessGate: { path: string; expect: number; timeoutSec: number };
    shutdown: { signal: "SIGTERM" | "SIGINT" | "SIGQUIT"; drainSec: number; hardKillSec: number };
  };
  storage: {
    postgres: { required: boolean; schemaInit: "managed" | "first_run" };
    volumes: Array<{ name: string; mountPath: string }>;
  };
  identity:
    | { mode: "trusted_proxy"; headerPrefix: string; fieldMap: Record<"user" | "tenant" | "tier" | "session" | "timestamp" | "signature", string> }
    | { mode: "byo_auth"; entryPath: string };
  observability: {
    tracing: "shared" | { url: string; headers?: Record<string, string> };
    metrics: { prometheusPath: string };
    audit: { topic: string };
  };
  upgrade: {
    strategy: "canary" | "blue_green";
    canaryPct: number;
    rollbackOn: Array<"healthcheckFail" | "errorRateSpike" | "latencyRegression" | "schemaIncompatible">;
    schemaCompatibility: "forward_compatible_required" | "best_effort";
  };
  resources: { minMemoryMiB: number; recommendedMemoryMiB: number; cpuShare: number };
  webhooks: {
    preprovision?: { url: string };
    tenantReady?: { url: string };
    tenantSuspended?: { url: string };
    tenantCancelled?: { url: string };
    secret: string;
  };
  billing: {
    rateModel: "per_tenant_month" | "per_request";
    tierFloor?: "starter" | "pro" | "enterprise";
  };
}
```

This is what `@ellul.ai/runtime-sdk`'s
`client.orchestrators.register()` would accept. The SDK validates
against the OpenAPI spec at compile time; the API revalidates at the
boundary.

## Stability commitment

Once a field on the public surface lands in v1, we commit to:
- Never removing it within v1
- Never tightening its validation in a way that rejects
  previously-accepted values
- Never changing its semantics

Additions are forward-compatible. Removals or breaking changes ship
as `/v2/` with a deprecation window of 12 months minimum on `/v1/`.

## Internal manifest deltas

When this work resumes and the internal `OrchestratorManifest` type
is rebuilt at `apps/api/src/provisioning/orchestrators/types.ts`,
the public counterpart lives alongside in
`apps/api/src/provisioning/orchestrators/public-types.ts` (proposed
filename). Internal-to-public projection lives in a translator
module; public-to-internal happens at the API boundary.

## Migration concerns

Today, `paperclip` and `fusion` are internal manifests. When Fusion
graduates to a B2B partnership (Phase E), we expect to:

1. Define the public registration shape (W17 implementation).
2. Have Fusion submit it via our (then-existing) admin path.
3. Translate to an internal manifest at registration.
4. The existing `ALL_ORCHESTRATORS` list comes from the registration
   table at runtime, not from imports. The hardcoded `paperclip` /
   `fusion` files become bootstrap seeds for the registration table.

This migration is W17 work; W17.1 just earmarks the abstraction split.

## What this audit deliberately does not decide

- Whether the public API ships before or after Phase A internal work
  is fully landed
- The exact wholesale pricing tiers
- Whether SBOMs are required vs encouraged at v1 launch
- Whether `byo_auth` mode ships in v1 (vs trusted_proxy only)

Those decisions are tracked separately and not blockers for the
abstraction.
