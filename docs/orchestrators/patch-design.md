# W6 Trust-headers patch — design

> **Status: design only, not shipped.** Implementation is deferred.
> When this work resumes, the [enterprise-gates.md](enterprise-gates.md)
> discipline must be in place before the patch can be applied to
> production builds.

## Goal

Add a third Paperclip deployment mode `header_trust` for production
reverse-proxy deployments where the proxy (sovereign-shield) terminates
auth (passkey, SAML/OIDC, etc.) and forwards a cryptographically-signed
identity to Paperclip via headers.

Existing modes are untouched:
- `local_trusted` — single-operator, loopback only, no auth (default)
- `authenticated` — login required via Better Auth, with `private` or
  `public` exposure
- `header_trust` — **new**: trusted-proxy auth via signed `${prefix}*`
  headers

## Threat model

Topology:

```
end-user → CDN/edge → reverse proxy (sovereign-shield) → 127.0.0.1 → paperclip
```

Trust boundary: between sovereign-shield and Paperclip on the same VPS
over loopback. Anyone able to reach Paperclip's port directly bypasses
sovereign-shield. The patch enforces the boundary explicitly:

1. **Loopback CIDR check.** The middleware rejects (401) any request
   whose peer IP is not in `PAPERCLIP_TRUSTED_PROXY_CIDR` (default
   `127.0.0.1/32,::1/128`). `req.socket.remoteAddress` reflects the
   actual TCP peer, not a forwarded header.
2. **Per-request HMAC.** Even with loopback, a hostile process
   colocated on the VPS could emit forged headers. The HMAC over
   `${user}|${tenant}|${tier}|${session}|${timestamp}` requires
   possession of the rotating secret in the key file (sovereign-shield
   runner UID, mode 0640, group `shield-ipc`).
3. **Replay window.** Timestamp must be within `maxAgeSec` (default
   30s, matching our existing file-api receiver). Beyond that, the
   request is rejected even with a valid HMAC.
4. **Tenant pinning.** Even with valid HMAC, `tenant` must equal
   `PAPERCLIP_TRUSTED_TENANT_ID` configured at startup. Defends
   against sovereign-shield misrouting a foreign tenant's traffic.
5. **Mode gating.** The header trust path only fires when
   `deploymentMode === "header_trust"`. Setting the env vars on
   `local_trusted` or `authenticated` does NOT activate the bypass
   (this is the security flaw Greptile flagged on the upstream
   `managed` mode PR #1046; this design avoids it by construction).

## Non-mitigations (called out explicitly)

- **No nonce table.** A request replayed within the 30-second window
  from the same loopback peer is accepted. Same-VPS rogue-process
  attack is already beyond our threat model — if a rogue process can
  sniff loopback HTTP, it can also read the key file directly.
- **No PoP / mTLS.** A leaked key permits forging requests until
  rotation. Compensating control: rotation cadence (sovereign-shield
  rotates every 30 minutes by default; the key-file format supports
  current+previous with explicit expiry for atomic rotation).
- **No request-body integrity.** HMAC covers identity, not body.

## Env-var contract

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PAPERCLIP_TRUSTED_TENANT_ID` | — | yes | Single-tenant pin; must match `${prefix}Tenant` header |
| `PAPERCLIP_TRUSTED_KEY_FILE` | — | yes | Path to JSON `{current, previous, previousExpiresAt}` |
| `PAPERCLIP_TRUSTED_HEADER_PREFIX` | `X-Trusted-` | no | Configurable for upstream-friendliness; we set `X-Ellul-` |
| `PAPERCLIP_TRUSTED_PROXY_CIDR` | `127.0.0.1/32,::1/128` | no | Comma-separated CIDRs |
| `PAPERCLIP_TRUSTED_MAX_AGE_SEC` | `30` | no | Replay window; range 5–600 |

### Key file shape

```json
{
  "current": "<64-hex-char rotating secret>",
  "previous": "<previous secret>" | null,
  "previousExpiresAt": <unix-ms when previous stops being accepted> | null
}
```

The middleware caches by mtime so atomic rename writes pick up
immediately without a service restart.

## Header surface

With `prefix = X-Ellul-` (configured via env on our deploys):

| Header | Value | Notes |
|---|---|---|
| `X-Ellul-User` | opaque user id | becomes `req.actor.userId`; lazy-upserted into `authUsers` |
| `X-Ellul-Tenant` | company id | must equal `PAPERCLIP_TRUSTED_TENANT_ID`; becomes `req.actor.companyIds[0]` |
| `X-Ellul-Tier` | string | passed through (unused by Paperclip directly) |
| `X-Ellul-Session` | session id | opaque; included in HMAC for binding |
| `X-Ellul-Timestamp` | unix seconds | enforced freshness window |
| `X-Ellul-HMAC` | hex of HMAC-SHA256 over `${user}|${tenant}|${tier}|${session}|${timestamp}` | rejected if invalid or stale |

Pipe (`|`), newline, and >256-char field values are rejected as
defensive canonicalization to prevent message-separator collision.

## Lazy upsert

On the first valid request from a given `${user}` in the configured
tenant, the middleware inserts:
- `authUsers` row (`id=user, name=user, email={user}@trusted.local, verified`)
- `instanceUserRoles` row (`instance_admin`)
- `companyMemberships` row (`owner` of the tenant company)

Subsequent requests find the existing rows and skip the inserts. This
makes the mode usable standalone without a separate preseed step.

## Why patch and not the alternatives

See [enterprise-gates.md § Alternatives](enterprise-gates.md#alternatives-considered)
for the full comparison. Summary:

- **Soft fork** (vendored repo we maintain): more work to keep current,
  identical end state, worse for upstream-PR optics ("they forked us
  instead of contributing").
- **Sidecar/proxy that injects Paperclip-native auth**: doesn't work —
  Paperclip's data model has per-user identity baked in (`authUsers`,
  `companyMemberships`, `instanceUserRoles`). The only ways to populate
  it are (a) BetterAuth session forging, which means writing to
  Paperclip's session table on every request and coupling tightly to
  its schema, (b) the trust-headers patch, or (c) accepting that all
  tenants share one synthetic user (kills the product). (a) is *worse*
  coupling than (b).
- **Wait for PR #1046's `managed` mode**: uses static management
  secrets — replayable on leak. Greptile flagged it. We don't control
  its merge.
- **`byo_auth` mode (vendor terminates own auth)**: works for
  orchestrators with simpler identity models — see
  [public-api-design.md](public-api-design.md) for that as a public
  API option. Doesn't work for Paperclip specifically because
  Paperclip's auth IS BetterAuth, which we're trying to bypass.

The patch is the right *mechanism*. What's missing is the
*operational envelope* around it — see
[enterprise-gates.md](enterprise-gates.md).

## Pinned upstream ref

The patch was authored against `paperclipai/paperclip` at tag
`v2026.428.0` (sha `3494e84a2920f3e2bc5f627f916da29e224086dc`).
Upstream tree at that ref:
- `packages/shared/src/constants.ts` (DEPLOYMENT_MODES tuple)
- `server/src/middleware/auth.ts` (actorMiddleware — 194 LOC)
- `server/src/app.ts` (createApp opts + actorMiddleware invocation)
- `server/src/index.ts` (deploymentMode init branches around line 478)

When work resumes, validate the patch still applies cleanly to the
then-pinned ref via `git apply --check`. If hunks have drifted,
rebase against the new upstream layout before applying.

## Files touched (informative)

The patch is 204 insertions, 5 deletions across 4 files:

| File | LOC delta | Purpose |
|---|---|---|
| `packages/shared/src/constants.ts` | +1 / -1 | Add `"header_trust"` to `DEPLOYMENT_MODES` |
| `server/src/middleware/auth.ts` | +181 / -3 | New imports + helpers + `header_trust` branch in `actorMiddleware` |
| `server/src/app.ts` | +3 / -1 | Thread `headerTrustConfig` through createApp opts to middleware |
| `server/src/index.ts` | +22 / 0 | New init branch parsing env, fail-fast on misconfig |

## Verification

The patch has been verified via:
- `git apply --check` against a fresh clone of `v2026.428.0` — exit 0
- Manual inspection of resulting tree in `/tmp/paperclip-verify`
  during the design session

When work resumes, additional verification required:
- Patch applies cleanly to manifest's then-current pinned ref
- Existing Paperclip vitest suite still passes after patch applied
- New tests added (per
  [enterprise-gates.md § Test coverage](enterprise-gates.md#test-coverage))
- Build-artifact gate verifies the patched build's hash

## Reference patch content

The full patch was authored and verified during the W6 design session.
Preserving it here so when work resumes the implementation can start
from a working diff instead of being re-derived. Apply with
`git apply` from the root of a clean `paperclipai/paperclip@v2026.428.0`
checkout.

```diff
diff --git a/packages/shared/src/constants.ts b/packages/shared/src/constants.ts
--- a/packages/shared/src/constants.ts
+++ b/packages/shared/src/constants.ts
@@ -4,7 +4,7 @@ export type CompanyStatus = (typeof COMPANY_STATUSES)[number];
 export const DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
 export const MAX_COMPANY_ATTACHMENT_MAX_BYTES = 1024 * 1024 * 1024;

-export const DEPLOYMENT_MODES = ["local_trusted", "authenticated"] as const;
+export const DEPLOYMENT_MODES = ["local_trusted", "authenticated", "header_trust"] as const;
 export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

 export const DEPLOYMENT_EXPOSURES = ["private", "public"] as const;
```

```diff
diff --git a/server/src/middleware/auth.ts b/server/src/middleware/auth.ts
--- a/server/src/middleware/auth.ts
+++ b/server/src/middleware/auth.ts
@@ -1,8 +1,11 @@
-import { createHash } from "node:crypto";
-import type { Request, RequestHandler } from "express";
+import { createHash, createHmac, timingSafeEqual } from "node:crypto";
+import { BlockList, isIP } from "node:net";
+import { statSync, readFileSync } from "node:fs";
+import type { Request, RequestHandler, Response } from "express";
 import { and, eq, isNull } from "drizzle-orm";
 import type { Db } from "@paperclipai/db";
-import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@paperclipai/db";
+import { agentApiKeys, agents, authUsers, companyMemberships, instanceUserRoles } from "@paperclipai/db";
 import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
 import type { DeploymentMode } from "@paperclipai/shared";
 import type { BetterAuthSessionResult } from "../auth/better-auth.js";
@@ -13,9 +16,107 @@ function hashToken(token: string) {
   return createHash("sha256").update(token).digest("hex");
 }

+export interface HeaderTrustConfig {
+  prefix: string;
+  tenantId: string;
+  keyFile: string;
+  trustedCidrs: string[];
+  maxAgeSec: number;
+}
+
+interface TrustedKey {
+  current: string;
+  previous: string | null;
+  previousExpiresAt: number | null;
+}
+
+let cachedKey: TrustedKey | null = null;
+let cachedKeyMtime = 0;
+
+function readTrustedKey(keyFile: string): TrustedKey | null {
+  try {
+    const m = statSync(keyFile).mtimeMs;
+    if (cachedKey && m === cachedKeyMtime) return cachedKey;
+    const parsed = JSON.parse(readFileSync(keyFile, "utf8")) as TrustedKey;
+    if (typeof parsed.current !== "string" || parsed.current.length < 32) return null;
+    cachedKey = parsed;
+    cachedKeyMtime = m;
+    return parsed;
+  } catch {
+    return null;
+  }
+}
+
+function buildBlockList(cidrs: string[]): BlockList {
+  const list = new BlockList();
+  for (const cidr of cidrs) {
+    const [base, maskStr] = cidr.split("/");
+    const family = isIP(base) === 6 ? "ipv6" : "ipv4";
+    const prefix = parseInt(maskStr ?? (family === "ipv6" ? "128" : "32"), 10);
+    list.addSubnet(base, prefix, family);
+  }
+  return list;
+}
+
+function verifyHmac(message: string, sigHex: string, key: string): boolean {
+  const expected = createHmac("sha256", key).update(message).digest();
+  let provided: Buffer;
+  try { provided = Buffer.from(sigHex, "hex"); } catch { return false; }
+  if (provided.length !== expected.length) return false;
+  return timingSafeEqual(expected, provided);
+}
+
+async function ensureHeaderTrustPrincipal(db: Db, userId: string, tenantId: string): Promise<void> {
+  const now = new Date();
+  const userExists = await db
+    .select({ id: authUsers.id })
+    .from(authUsers)
+    .where(eq(authUsers.id, userId))
+    .then((rows) => rows[0] ?? null);
+  if (!userExists) {
+    await db.insert(authUsers).values({
+      id: userId, name: userId, email: `${userId}@trusted.local`,
+      emailVerified: true, image: null, createdAt: now, updatedAt: now,
+    });
+  }
+  const role = await db
+    .select({ id: instanceUserRoles.id })
+    .from(instanceUserRoles)
+    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
+    .then((rows) => rows[0] ?? null);
+  if (!role) {
+    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
+  }
+  const membership = await db
+    .select({ id: companyMemberships.id })
+    .from(companyMemberships)
+    .where(and(
+      eq(companyMemberships.companyId, tenantId),
+      eq(companyMemberships.principalType, "user"),
+      eq(companyMemberships.principalId, userId),
+    ))
+    .then((rows) => rows[0] ?? null);
+  if (!membership) {
+    await db.insert(companyMemberships).values({
+      companyId: tenantId, principalType: "user", principalId: userId,
+      status: "active", membershipRole: "owner",
+    });
+  }
+}
+
+function rejectHeaderTrust(res: Response, reason: string): void {
+  res.status(401).json({ error: "header_trust_rejected", reason });
+}
+
 interface ActorMiddlewareOptions {
   deploymentMode: DeploymentMode;
   resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
+  headerTrustConfig?: HeaderTrustConfig;
 }

 export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
   const boardAuth = boardAuthService(db);
+  const blockList = opts.headerTrustConfig
+    ? buildBlockList(opts.headerTrustConfig.trustedCidrs)
+    : null;
   return async (req, _res, next) => {
+    if (opts.deploymentMode === "header_trust") {
+      if (!opts.headerTrustConfig || !blockList) {
+        rejectHeaderTrust(_res, "config_missing");
+        return;
+      }
+      const cfg = opts.headerTrustConfig;
+      const peer = req.socket.remoteAddress ?? "";
+      const peerNorm = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
+      const family = isIP(peerNorm);
+      if (family === 0 || !blockList.check(peerNorm, family === 6 ? "ipv6" : "ipv4")) {
+        rejectHeaderTrust(_res, "untrusted_peer");
+        return;
+      }
+      const h = (n: string) => req.header(`${cfg.prefix}${n}`);
+      const user = h("User"); const tenant = h("Tenant"); const tier = h("Tier");
+      const session = h("Session"); const timestamp = h("Timestamp"); const hmac = h("HMAC");
+      if (!user || !tenant || !tier || !session || !timestamp || !hmac) {
+        rejectHeaderTrust(_res, "missing_headers"); return;
+      }
+      for (const v of [user, tenant, tier, session, timestamp]) {
+        if (v.includes("|") || v.includes("\n") || v.length > 256) {
+          rejectHeaderTrust(_res, "invalid_field"); return;
+        }
+      }
+      const ts = parseInt(timestamp, 10);
+      const now = Math.floor(Date.now() / 1000);
+      if (Number.isNaN(ts) || Math.abs(now - ts) > cfg.maxAgeSec) {
+        rejectHeaderTrust(_res, "stale_timestamp"); return;
+      }
+      if (tenant !== cfg.tenantId) {
+        rejectHeaderTrust(_res, "tenant_mismatch"); return;
+      }
+      const key = readTrustedKey(cfg.keyFile);
+      if (!key) { rejectHeaderTrust(_res, "key_unavailable"); return; }
+      const message = `${user}|${tenant}|${tier}|${session}|${timestamp}`;
+      let valid = verifyHmac(message, hmac, key.current);
+      if (!valid && key.previous && key.previousExpiresAt && Date.now() < key.previousExpiresAt) {
+        valid = verifyHmac(message, hmac, key.previous);
+      }
+      if (!valid) { rejectHeaderTrust(_res, "hmac_invalid"); return; }
+      await ensureHeaderTrustPrincipal(db, user, tenant);
+      req.actor = {
+        type: "board", userId: user, userName: user, userEmail: null,
+        companyIds: [tenant],
+        memberships: [{ companyId: tenant, membershipRole: "owner", status: "active" }],
+        isInstanceAdmin: true,
+        runId: req.header("x-paperclip-run-id") ?? undefined,
+        source: "trusted_header",
+      };
+      next();
+      return;
+    }
     req.actor =
       opts.deploymentMode === "local_trusted"
         ? { ...
```

```diff
diff --git a/server/src/app.ts b/server/src/app.ts
--- a/server/src/app.ts
+++ b/server/src/app.ts
-import { actorMiddleware } from "./middleware/auth.js";
+import { actorMiddleware, type HeaderTrustConfig } from "./middleware/auth.js";
@@ ... opts type ... @@
     resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
+    headerTrustConfig?: HeaderTrustConfig;
@@ ... actorMiddleware invocation ... @@
       deploymentMode: opts.deploymentMode,
       resolveSession: opts.resolveSession,
+      headerTrustConfig: opts.headerTrustConfig,
```

```diff
diff --git a/server/src/index.ts b/server/src/index.ts
--- a/server/src/index.ts
+++ b/server/src/index.ts
+import type { HeaderTrustConfig } from "./middleware/auth.js";
@@ ... mode init region ... @@
+  let headerTrustConfig: HeaderTrustConfig | undefined;
   if (config.deploymentMode === "local_trusted") {
     await ensureLocalTrustedBoardPrincipal(db as any);
   }
+  if (config.deploymentMode === "header_trust") {
+    const tenantId = process.env.PAPERCLIP_TRUSTED_TENANT_ID;
+    const keyFile = process.env.PAPERCLIP_TRUSTED_KEY_FILE;
+    if (!tenantId || !keyFile) {
+      throw new Error("header_trust mode requires PAPERCLIP_TRUSTED_TENANT_ID and PAPERCLIP_TRUSTED_KEY_FILE");
+    }
+    const trustedCidrs = (process.env.PAPERCLIP_TRUSTED_PROXY_CIDR ?? "127.0.0.1/32,::1/128")
+      .split(",").map((s) => s.trim()).filter((s) => s.length > 0);
+    const maxAgeSec = parseInt(process.env.PAPERCLIP_TRUSTED_MAX_AGE_SEC ?? "30", 10);
+    if (Number.isNaN(maxAgeSec) || maxAgeSec < 5 || maxAgeSec > 600) {
+      throw new Error("PAPERCLIP_TRUSTED_MAX_AGE_SEC must be 5-600 seconds");
+    }
+    headerTrustConfig = {
+      prefix: process.env.PAPERCLIP_TRUSTED_HEADER_PREFIX ?? "X-Trusted-",
+      tenantId, keyFile, trustedCidrs, maxAgeSec,
+    };
+    logger.info({ tenantId, keyFile, trustedCidrs, maxAgeSec }, "header_trust mode active");
+    authReady = true;
+  }
@@ ... createApp call ... @@
     resolveSession,
+    headerTrustConfig,
     pluginWorkerManager,
```

The above is a *condensed* representation. The original full canonical
patch (321 lines including comment header + complete unified diff with
exact line numbers) was generated via `git diff` from a working
modification of upstream `v2026.428.0` and verified to apply cleanly.
When this work resumes, regenerate the canonical diff from the
then-current upstream tag rather than copying these excerpts; the
hunks above are reference, not authoritative.
