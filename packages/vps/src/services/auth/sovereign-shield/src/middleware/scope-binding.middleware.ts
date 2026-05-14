// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Scope-binding middleware.
 *
 * Prevents an authenticated session for sandbox A from issuing a request
 * that targets sandbox B. The authenticated session carries an immutable
 * sandbox scope claim (attached upstream by the STS / tier-gate middleware
 * under the key `c.get('stsProject')`). Every security-sensitive route
 * accepts a `sandboxId` from the request (query / body / path). If the two
 * don't match, the request is rejected with `403 SCOPE_MISMATCH` and an
 * audit event is emitted — repeated hits indicate a compromised session
 * or a buggy client; either way the route MUST NOT proceed.
 *
 * This is defense-in-depth on top of the typed `SandboxId` brand: the
 * brand catches "never validated", this middleware catches "validated but
 * to the wrong sandbox".
 */

import type { Context, Next } from 'hono';
import {
  SandboxIdSchema,
  ScopeMismatchError,
  tryParseSandboxId,
  type SandboxId,
} from '@ellul.ai/types';
import { logAuditEvent } from '../application/audit/Audit';
import { getClientIp } from '../auth/fingerprint';

/**
 * How the middleware extracts the "requested" sandbox from a particular
 * request. Returned value must already be a branded `SandboxId` — if the
 * request's scope is absent or malformed, return `null` and the caller is
 * allowed through unchanged (some routes have no sandbox scope at all —
 * e.g. server-wide settings).
 */
export type RequestScopeExtractor = (c: Context) => SandboxId | null;

/**
 * Extract the sandbox scope the caller's authenticated session is bound
 * to. Returns null if no session claim is present — these are routes that
 * aren't behind the tier-gate (e.g. public health checks). Middleware
 * becomes a no-op in that case; the downstream route itself decides
 * whether unauthenticated access is acceptable.
 */
function sessionSandbox(c: Context): SandboxId | null {
  const raw = c.get('stsProject') as unknown;
  if (typeof raw !== 'string') return null;
  return tryParseSandboxId(raw);
}

/**
 * Build a scope-binding middleware for a route group.
 *
 * `extractRequestScope` returns the sandbox id the caller wants to act on.
 * Pull it from wherever the route places it: a query param, a JSON body
 * field, a URL path segment. Returning null means "no scope argument on
 * this request" — the middleware allows the request through; the session's
 * scope will still be available via `c.get('sessionSandbox')` for the
 * handler's own use.
 *
 * A successful scope check attaches the (branded) requested sandbox to
 * `c.set('sessionSandbox', ...)` so downstream handlers have a single
 * authoritative source rather than reparsing.
 */
export function scopeBindingMiddleware(
  extractRequestScope: RequestScopeExtractor,
) {
  return async function scopeBinding(c: Context, next: Next): Promise<Response | void> {
    const sessionScope = sessionSandbox(c);
    const requestedScope = extractRequestScope(c);

    // No session claim? Middleware is transparent — route decides auth.
    if (!sessionScope) {
      if (requestedScope) c.set('sessionSandbox', requestedScope);
      await next();
      return;
    }

    // Session claim present, no request scope — session scope wins and is
    // surfaced to the handler.
    if (!requestedScope) {
      c.set('sessionSandbox', sessionScope);
      await next();
      return;
    }

    if (sessionScope !== requestedScope) {
      const err = new ScopeMismatchError(sessionScope, requestedScope);
      logAuditEvent({
        type: 'scope.mismatch',
        ip: getClientIp(c),
        sandboxId: sessionScope,
        details: {
          code: err.code,
          sessionScope,
          requestedScope,
          route: c.req.path,
          method: c.req.method,
        },
      });
      return c.json(
        {
          error: err.message,
          code: err.code,
          sessionScope,
          requestedScope,
        },
        403,
      );
    }

    // Scopes agree — stamp the validated value on the context so downstream
    // handlers don't reparse.
    c.set('sessionSandbox', sessionScope);
    await next();
  };
}

/**
 * Extractor: read sandboxId from a named query param, parse via
 * `SandboxIdSchema`. Returns null on missing or malformed — the handler is
 * then responsible for rejecting empty input (this middleware is about
 * cross-scope forgery, not input validation).
 */
export function queryScope(paramName = 'sandboxId'): RequestScopeExtractor {
  return (c) => {
    const raw = c.req.query(paramName);
    if (raw === undefined) return null;
    const parsed = SandboxIdSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };
}

/**
 * Extractor: read sandboxId from a URL path parameter.
 */
export function paramScope(paramName: string): RequestScopeExtractor {
  return (c) => {
    const raw = c.req.param(paramName);
    if (!raw) return null;
    const parsed = SandboxIdSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };
}
