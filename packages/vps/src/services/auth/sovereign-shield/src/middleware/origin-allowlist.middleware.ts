// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Origin Allowlist Middleware
 *
 * Advisory CSRF defense-in-depth. Validates the Origin header on authenticated
 * requests against a trusted set (platform defaults + custom domain + dev-preview
 * domain + preview-origins.json manifest patterns).
 *
 * Decision matrix (per request):
 *   - Origin header absent                 → allow  (standard navigation / SSR)
 *   - Origin same-origin with request host → allow  (reconstructed from
 *                                                    X-Forwarded-Proto/Host,
 *                                                    falls back to c.req Host)
 *   - Origin in trusted exact list         → allow
 *   - Origin matches a trusted pattern     → allow  (glob: *.ellul.app etc.)
 *   - Otherwise                            → 403  { error: 'origin_not_allowed', origin }
 *
 * Session cookies, JWTs, PoP, and internal tokens remain the primary auth
 * boundary. Origin check is layered on top as a cheap defense against
 * cross-site forged requests that slip past SameSite/Partitioned cookie
 * protections in older browsers.
 */

import type { MiddlewareHandler } from "hono";
import {
  readAllowedOrigins,
  readPreviewOriginsManifest,
  type PreviewOriginsManifest,
} from "../config";
import { logAuditEvent } from "../application/audit/Audit";

/**
 * Convert a glob-style pattern to a RegExp. Supports `*` (any label chars) and
 * literal dots. Anchored at both ends. Case-insensitive.
 *
 *   "*.ellul.app" → /^[^.]+\.ellul\.app$/i    (wait: see note below)
 *
 * We intentionally allow `*` to match one-or-more labels so that `*.ellul.app`
 * matches both `foo.ellul.app` and `foo.bar.ellul.app`. Shield's trust model is
 * that any subdomain of a listed zone is operated by us; callers that need
 * tighter scoping should use the exact-origin list instead.
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".+");
  return new RegExp(`^${escaped}$`, "i");
}

interface CompiledAllowlist {
  exactOrigins: Set<string>;
  patternRegexes: RegExp[];
}

/**
 * Compile the trusted allowlist at request time. Re-reads config files so
 * custom-domain / preview-origins rebinds are picked up without a restart.
 *
 * Any read failure propagates: /etc/ellul/allowed-origins and
 * /etc/ellul/preview-origins.json are written by boot-config at provisioning,
 * both are required. Missing either is a provisioning bug that must fail loud.
 */
function compileAllowlist(): CompiledAllowlist {
  const exactOrigins = new Set<string>();

  for (const origin of readAllowedOrigins()) {
    exactOrigins.add(origin.toLowerCase());
  }

  const manifest: PreviewOriginsManifest = readPreviewOriginsManifest();
  for (const origin of manifest.origins) {
    // Manifest entries are full origins ("https://host"). Inferring https
    // scheme for bare hostnames is defensive against a malformed entry.
    const normalized = origin.includes("://") ? origin : `https://${origin}`;
    exactOrigins.add(normalized.toLowerCase());
  }
  const patternRegexes = manifest.patterns
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map(patternToRegex);

  return { exactOrigins, patternRegexes };
}

/**
 * Reconstruct the origin (scheme://host[:port]) that the request believes
 * itself to be targeting. Caddy forwards X-Forwarded-Proto and X-Forwarded-Host;
 * when absent we fall back to the Host header seen on the incoming TCP
 * connection (localhost only, via the reverse proxy).
 */
function reconstructRequestOrigin(headers: Headers): string | null {
  const xfHost = headers.get("x-forwarded-host");
  const xfProto = headers.get("x-forwarded-proto");
  const host = xfHost || headers.get("host");
  if (!host) return null;
  const proto = (xfProto || "https").toLowerCase();
  try {
    // Let URL normalize port/host (e.g., strip default :443)
    return new URL(`${proto}://${host}`).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Normalize an Origin header value to a comparable origin string, or null on
 * malformed input. Browsers always send a serialized origin (no path/query),
 * but we parse via URL to be strict about port/case.
 */
function normalizeOriginHeader(raw: string): string | null {
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowed(origin: string, list: CompiledAllowlist): boolean {
  if (list.exactOrigins.has(origin)) return true;

  // Pattern match is against the bare hostname (no scheme/port) so that
  // "*.ellul.app" matches both https and http and non-default ports.
  // hostname (not host) strips the port, which matters when Caddy/Cloudflare
  // forward an Origin header that carries a non-default port (e.g., the
  // framework dev server echoes back its own http://host:4000 origin for
  // same-origin asset fetches).
  let hostnameForPattern: string;
  try {
    hostnameForPattern = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const re of list.patternRegexes) {
    if (re.test(hostnameForPattern)) return true;
  }
  return false;
}

export const originAllowlistMiddleware: MiddlewareHandler = async (c, next) => {
  const originHeader = c.req.header("origin");
  if (!originHeader) return next(); // standard navigation, SSR, curl, internal IPC

  // "null" is the HTML-spec opaque origin — sent by sandboxed iframes,
  // data: / file: URIs, redirect-stripped cross-origin navigations, and
  // some browser privacy modes. It is NOT malformed; it is a legitimate
  // value meaning "the origin is unique/opaque." Treat it equivalently
  // to an absent Origin header: tier-gate above still requires a valid
  // session cookie + PoP, which is the primary auth boundary. Previously
  // this was rejected as "malformed", 403-ing preview iframe asset loads
  // and any other legitimate null-origin callers.
  if (originHeader === "null") return next();

  const requestOrigin = reconstructRequestOrigin(c.req.raw.headers);
  const normalizedOrigin = normalizeOriginHeader(originHeader);

  // Truly malformed Origin (e.g. non-URL garbage) — reject rather than
  // letting a downstream handler trust it.
  if (!normalizedOrigin) {
    logAuditEvent({
      type: "origin_rejected",
      details: {
        origin: originHeader,
        reason: "malformed",
        path: c.req.header("x-forwarded-uri") || c.req.path,
        requestOrigin,
      },
    });
    return c.json(
      { error: "origin_not_allowed", origin: originHeader, reason: "malformed" },
      403,
    );
  }

  // Same-origin fast path — no allowlist lookup needed.
  if (requestOrigin && normalizedOrigin === requestOrigin) return next();

  const allowlist = compileAllowlist();
  if (isAllowed(normalizedOrigin, allowlist)) return next();

  // Log the rejection with path + request origin so operators can see what's
  // being blocked. Ingress uses the forwarded URI (Caddy's forward_auth sub-
  // request URL points at /api/auth/session and is not the original path).
  logAuditEvent({
    type: "origin_rejected",
    details: {
      origin: normalizedOrigin,
      reason: "not_in_allowlist",
      path: c.req.header("x-forwarded-uri") || c.req.path,
      requestOrigin,
    },
  });
  return c.json(
    { error: "origin_not_allowed", origin: normalizedOrigin },
    403,
  );
};

// Exported for tests
export const __testing = {
  patternToRegex,
  reconstructRequestOrigin,
  normalizeOriginHeader,
  isAllowed,
  compileAllowlist,
};
