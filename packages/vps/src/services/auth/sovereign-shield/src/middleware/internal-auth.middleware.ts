// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Internal Endpoint Authentication + Authorization Middleware
 *
 * Two-layer security for all /api/internal/* endpoints:
 *
 * Layer 1 — Authentication (WHO):
 *   Validates the per-service HMAC-derived token. Each service has a unique
 *   token; a stolen file-api token cannot impersonate agent-bridge. The
 *   verified service identity is set on the request context.
 *
 * Layer 2 — Authorization (WHAT):
 *   Endpoint-level ACLs restrict which verified service can call which
 *   endpoint. file-api cannot call /api/internal/git-credentials even
 *   with a valid file-api token.
 *
 * Token validation uses timing-safe comparison. Failed attempts are
 * rate-limited (10 failures/min triggers 60s cooldown).
 */

import type { Context, Next } from 'hono';
import { validateInternalToken, getVerifiedService, type InternalService } from '../application/credentials/InternalToken';
import { db } from '../database';

// ═══════════════════════════════════════════════════════════════════
// Endpoint-Level ACL Policy
// ═══════════════════════════════════════════════════════════════════
//
// Each entry maps an endpoint pattern to the set of services allowed
// to call it. Patterns support:
//   - Exact match: '/api/internal/backup-identity'
//   - Prefix match: '/api/internal/gate/' (matches all sub-paths)
//   - Param match: '/api/internal/projects/:slug' (matches any slug)
//
// Default policy: DENY. Any endpoint not listed is blocked for all
// services. This forces explicit authorization for every new endpoint.
// ═══════════════════════════════════════════════════════════════════

type ServiceSet = readonly InternalService[];

interface AclEntry {
  /** Endpoint path pattern (exact, prefix with trailing /, or :param segments) */
  pattern: string;
  /** HTTP methods this ACL applies to. Empty = all methods. */
  methods?: string[];
  /** Services allowed to call this endpoint */
  allow: ServiceSet;
}

const FILE_API: InternalService = 'file-api';
const BRIDGE: InternalService = 'agent-bridge';
const ENFORCER: InternalService = 'enforcer';

/**
 * The canonical ACL policy for internal endpoints.
 * Derived from tracing every callShieldInternal/fetch/curl in the codebase.
 *
 * Principle: each service gets the MINIMUM set of endpoints it needs.
 * Adding a new internal endpoint requires an explicit ACL entry here.
 */
const ACL_POLICY: readonly AclEntry[] = [
  // ── Project lifecycle (file-api only) ──
  { pattern: '/api/internal/projects/create', allow: [FILE_API] },
  { pattern: '/api/internal/projects/lock', allow: [FILE_API] },
  { pattern: '/api/internal/projects/entitlement-check', allow: [FILE_API] },
  { pattern: '/api/internal/projects/', methods: ['DELETE'], allow: [FILE_API] },

  // ── Git operations ──
  // git-credentials: ONLY shield-originated shell scripts (via credential helper).
  // Shell scripts don't use IPC tokens — they authenticate via GIT_CREDENTIAL_SESSION.
  // No IPC-authenticated service should call this endpoint.
  // git-clone: file-api delegates clone to shield
  { pattern: '/api/internal/git-clone', allow: [FILE_API] },
  // git-link: file-api delegates the platform /api/git/servers/:id/link call to
  // shield so only shield (not file-api) needs read access to the ai-proxy-token
  // on disk (root:shield 640). Keeps file-api's filesystem privileges narrow.
  { pattern: '/api/internal/git-link', allow: [FILE_API] },
  // git-pull/push/fetch: file-api delegates; bridge delegates via platform tools
  { pattern: '/api/internal/git-pull', allow: [FILE_API, BRIDGE] },
  { pattern: '/api/internal/git-push', allow: [FILE_API, BRIDGE] },
  { pattern: '/api/internal/git-fetch', allow: [FILE_API] },
  // git-credentials: NO IPC service should call this. Credential helper uses session auth.
  // Explicitly empty allow list = denied for all IPC-authenticated callers.
  { pattern: '/api/internal/git-credentials', allow: [] },
  // git auto-authorize: agent-bridge requests authorization on behalf of user
  { pattern: '/api/internal/git-auto-authorize', allow: [BRIDGE] },
  { pattern: '/api/internal/deploy-auto-authorize', allow: [BRIDGE] },

  // ── Secrets & env ──
  // FILE_API uses DELETE /api/internal/secrets/:sandboxId for sandbox cleanup.
  // BRIDGE uses GET/PUT/DELETE /api/internal/secrets/:sandboxId/:name for the
  // read_secret / set_secret / delete_secret platform tools (gate-protected).
  { pattern: '/api/internal/secrets/', allow: [FILE_API, BRIDGE] },
  { pattern: '/api/internal/secret-names', allow: [BRIDGE] },
  { pattern: '/api/internal/env/', allow: [FILE_API, BRIDGE] },

  // ── Sovereign gates (agent-bridge manages gate lifecycle) ──
  { pattern: '/api/internal/gate/', allow: [BRIDGE] },

  // ── Claude OAT credential subsystem (greenfield) ──
  // The shield owns the OAT in /etc/ellul/shield-data/claude-oat.json.
  // Bridge proxies user save/revoke from the workbench UI, polls /peek for
  // login-state UI signal, mints issuance tokens before claude spawn,
  // reports observed 401s (audit-only — does not mutate state).
  // Launcher (ellul-claude-launch) inherits BRIDGE shield-ipc identity
  // (it's spawned by bridge with that supplementary group) so it matches
  // this same ACL entry when calling /redeem.
  { pattern: '/api/internal/claude-oat/', allow: [BRIDGE] },

  // ── Permission inbox (v2 HITL state machine) ──
  // agent-bridge creates permission_request rows on inbound gate asks
  // (/request), resolves them on user grant/deny (/:id/grant, /:id/deny),
  // and revokes on operator action (/:id/revoke). /:id/seen bumps
  // lastSeenAt when the UI surfaces the row. All are /api/internal/*
  // internal calls; the adjacent shield-session-authenticated
  // /_auth/permissions/* read/stream routes live in the tier-gate path,
  // not here. Missing this entry hard-breaks the gate grant flow because
  // /request 403s and the v2 payload (which binds requestId into the PoP
  // signature) can never be minted.
  { pattern: '/api/internal/permissions/', allow: [BRIDGE] },

  // ── Preview management ──
  { pattern: '/api/internal/preview/', allow: [FILE_API] },
  { pattern: '/api/internal/preview-ports', allow: [FILE_API] },

  // ── Identity & session management ──
  { pattern: '/api/internal/backup-identity', allow: [FILE_API] },
  { pattern: '/api/internal/sessions', allow: [ENFORCER, FILE_API] },
  { pattern: '/api/internal/sessions/', allow: [ENFORCER, FILE_API] },
  { pattern: '/api/internal/session-policy', allow: [ENFORCER] },
  { pattern: '/api/internal/session-policy/', allow: [ENFORCER] },

  // ── Cross-project access ──
  { pattern: '/api/internal/cross-project-access', allow: [FILE_API, BRIDGE] },
  { pattern: '/api/internal/cross-project-access/', allow: [FILE_API, BRIDGE] },

  // ── Vault operations (agent-bridge proxies vault queries through shield) ──
  { pattern: '/api/internal/vault/', allow: [BRIDGE] },

  // ── Database operations (agent-bridge proxies user DB requests through shield) ──
  { pattern: '/api/internal/db/', allow: [BRIDGE, FILE_API] },

  // ── Logs & alerts ──
  { pattern: '/api/internal/logs/', allow: [FILE_API] },
  { pattern: '/api/internal/exposure-alerts/', allow: [BRIDGE] },

  // ── Service management ──
  { pattern: '/api/internal/refresh-shield/', allow: [FILE_API] },

  // ── Daemon health (agent-bridge → agent-bridge, but routed via shield) ──
  { pattern: '/api/internal/daemon-health', allow: [BRIDGE] },
  { pattern: '/api/internal/daemon-restart', allow: [FILE_API] },

  // ── Caddy config management (mediated writes to reduce file-api privilege) ──
  { pattern: '/api/internal/caddy/write-route', allow: [FILE_API] },
  { pattern: '/api/internal/caddy/remove-route', allow: [FILE_API] },
  { pattern: '/api/internal/caddy/reload', allow: [FILE_API] },

  // ── Git setup (enforcer triggers after API links a repo via command queue) ──
  { pattern: '/_internal/git-setup', allow: [ENFORCER] },
] as const;

/**
 * Check if a request path matches an ACL pattern.
 *
 * Match rules:
 * - Pattern ending with '/' is a prefix match (e.g., '/api/internal/gate/' matches '/api/internal/gate/status')
 * - Pattern without trailing '/' is exact match on the path prefix (handles param segments)
 * - Method restriction: if entry has methods[], request method must be in the list
 */
function matchesAclPattern(entry: AclEntry, requestPath: string, requestMethod: string): boolean {
  const { pattern, methods } = entry;

  // Method check (if specified)
  if (methods && methods.length > 0 && !methods.includes(requestMethod)) {
    return false;
  }

  // Prefix match: pattern ends with '/'
  if (pattern.endsWith('/')) {
    return requestPath === pattern.slice(0, -1) || requestPath.startsWith(pattern);
  }

  // Exact match: request path equals pattern OR starts with pattern + '/'
  // This handles parameterized routes like /api/internal/projects/:slug
  return requestPath === pattern || requestPath.startsWith(pattern + '/');
}

/**
 * Find the ACL entry for a request. Returns the allow list, or null if no match (deny).
 * First matching entry wins (most specific patterns should come first).
 */
function findAclEntry(requestPath: string, requestMethod: string): ServiceSet | null {
  for (const entry of ACL_POLICY) {
    if (matchesAclPattern(entry, requestPath, requestMethod)) {
      return entry.allow;
    }
  }
  return null; // No match → default deny
}

// ═══════════════════════════════════════════════════════════════════
// Rate Limiting
// ═══════════════════════════════════════════════════════════════════

const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES_PER_MIN = 10;
const COOLDOWN_MS = 60_000;

// Ensure rate limit table exists (idempotent)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS internal_auth_rate_limits (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    )
  `);
  const rows = db.prepare(
    'SELECT ip, count, reset_at FROM internal_auth_rate_limits WHERE reset_at > ?'
  ).all(Date.now()) as Array<{ ip: string; count: number; reset_at: number }>;
  for (const row of rows) {
    failedAttempts.set(row.ip, { count: row.count, resetAt: row.reset_at });
  }
} catch {}

const persistStmt = (() => {
  try {
    return db.prepare(
      'INSERT OR REPLACE INTO internal_auth_rate_limits (ip, count, reset_at) VALUES (?, ?, ?)'
    );
  } catch { return null; }
})();
const deleteStmt = (() => {
  try {
    return db.prepare('DELETE FROM internal_auth_rate_limits WHERE ip = ?');
  } catch { return null; }
})();

// ═══════════════════════════════════════════════════════════════════
// Middleware
// ═══════════════════════════════════════════════════════════════════

/**
 * Authentication + Authorization middleware for internal endpoints.
 *
 * 1. Rate limit check
 * 2. Token validation (per-service HMAC) → sets verifiedService
 * 3. Endpoint ACL check → verifiedService must be in allow list
 *
 * Returns 401 for auth failures, 403 for ACL violations, 429 for rate limits.
 */
const SESSION_AUTHED_PATHS = new Set([
  '/api/internal/git-credentials',
]);

export async function requireInternalTokenMiddleware(c: Context, next: Next): Promise<Response | void> {
  if (SESSION_AUTHED_PATHS.has(c.req.path)) {
    return next();
  }

  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '127.0.0.1';
  const now = Date.now();

  // ── Rate limit ──
  const limiter = failedAttempts.get(ip);
  if (limiter && limiter.count >= MAX_FAILURES_PER_MIN && now < limiter.resetAt) {
    return c.json({ error: 'Too many failed authentication attempts' }, 429);
  }

  // ── Layer 1: Authentication ──
  const authHeader = c.req.header('Authorization');
  const claimedService = c.req.header('x-service-name');

  if (!validateInternalToken(authHeader, claimedService || undefined)) {
    if (limiter && now < limiter.resetAt) {
      limiter.count++;
    } else {
      failedAttempts.set(ip, { count: 1, resetAt: now + COOLDOWN_MS });
    }
    const entry = failedAttempts.get(ip)!;
    try { persistStmt?.run(ip, entry.count, entry.resetAt); } catch {}

    return c.json({ error: 'Unauthorized — internal token required' }, 401);
  }

  // Set verified service identity on context
  const verified = getVerifiedService(authHeader);
  const verifiedService = verified || claimedService || 'unknown';
  c.set('verifiedService', verifiedService);

  // Clear failure count on success
  failedAttempts.delete(ip);
  try { deleteStmt?.run(ip); } catch {}

  // ── Layer 2: Authorization (Endpoint ACL) ──
  const requestPath = c.req.path;
  const requestMethod = c.req.method;
  const allowedServices = findAclEntry(requestPath, requestMethod);

  if (allowedServices === null) {
    // No ACL entry → default deny (unknown endpoint)
    console.warn(`[shield] ACL DENY: ${verifiedService} → ${requestMethod} ${requestPath} (no ACL entry)`);
    return c.json({
      error: `IPC misconfigured: no ACL entry for ${requestMethod} ${requestPath}. This is a platform bug — please report.`,
      code: 'IPC_NOT_AUTHORIZED',
    }, 403);
  }

  if (allowedServices.length === 0) {
    // Explicitly empty allow list (e.g., git-credentials — no IPC service should call)
    console.warn(`[shield] ACL DENY: ${verifiedService} → ${requestMethod} ${requestPath} (endpoint blocked for IPC)`);
    return c.json({
      error: `IPC misconfigured: ${requestPath} is not callable via IPC. This is a platform bug — please report.`,
      code: 'IPC_NOT_AUTHORIZED',
    }, 403);
  }

  if (!allowedServices.includes(verifiedService as InternalService)) {
    console.warn(`[shield] ACL DENY: ${verifiedService} → ${requestMethod} ${requestPath} (allowed: ${allowedServices.join(', ')})`);
    return c.json({
      error: `IPC misconfigured: '${verifiedService}' not authorized for ${requestPath} (allowed: ${allowedServices.join(', ')}). This is a platform bug — please report.`,
      code: 'IPC_NOT_AUTHORIZED',
    }, 403);
  }

  await next();
}

// Periodic cleanup of stale rate limit entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, limiter] of failedAttempts) {
    if (now >= limiter.resetAt) {
      failedAttempts.delete(ip);
    }
  }
  try {
    db.prepare('DELETE FROM internal_auth_rate_limits WHERE reset_at <= ?').run(now);
  } catch {}
}, 5 * 60_000);

// ═══════════════════════════════════════════════════════════════════
// Exports for testing
// ═══════════════════════════════════════════════════════════════════

/** @internal — exported for unit tests only */
export { findAclEntry, matchesAclPattern, ACL_POLICY };
