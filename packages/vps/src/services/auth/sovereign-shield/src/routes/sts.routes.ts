// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * STS Routes — Project-scoped token issuance and refresh
 *
 * Endpoints:
 * - POST /_auth/sts/token    — Issue an STS token for a project
 * - POST /_auth/sts/refresh  — Refresh an existing STS token
 *
 * Both endpoints require an active shield_session (tier-gate middleware).
 * The session ID is embedded in the STS token (sid claim) — session
 * revocation cascades to immediate STS invalidation.
 *
 * Project ownership is validated by checking the project exists on disk
 * (same discovery logic as projects.routes.ts). Since the VPS is
 * single-tenant (one user per VPS), any project on disk belongs to the
 * authenticated user.
 */

import fs from 'fs';
import path from 'path';
import type { Hono } from 'hono';
import { SandboxIdSchema, isSandboxId } from '@ellul.ai/types';
import { SVC_HOME } from '../config';
import { getClientIp } from '../auth/fingerprint';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import {
  signProjectToken,
  verifyProjectToken,
  isStsAvailable,
  STS_TOKEN_TTL_SECONDS,
  STS_EXPIRED_CODE,
  STS_INVALID_CODE,
} from '../application/platform/Sts';

const PROJECTS_DIR = path.join(SVC_HOME, 'projects');
const SECRETS_DIR = '/etc/ellul/secrets';
const SHIELDED_PROJECTS_DIR = '/var/lib/ellul-shielded/projects';

/**
 * Check if a sandbox slug exists on this VPS.
 * A sandbox exists if it has a project directory, a secrets directory,
 * or a shielded workspace.
 */
function projectExists(slug: string): boolean {
  if (!isSandboxId(slug)) return false;

  // Check project directory
  try {
    const stat = fs.statSync(path.join(PROJECTS_DIR, slug));
    if (stat.isDirectory()) return true;
  } catch {}

  // Check secrets directory
  try {
    const stat = fs.statSync(path.join(SECRETS_DIR, slug));
    if (stat.isDirectory()) return true;
  } catch {}

  // Check shielded workspace
  try {
    const stat = fs.statSync(path.join(SHIELDED_PROJECTS_DIR, slug));
    if (stat.isDirectory()) return true;
  } catch {}

  return false;
}

/**
 * Extract session ID from tier-gate auth context.
 * web_locked uses sessionId, standard uses jwtId.
 */
function getSessionId(c: { get: (key: string) => unknown }): string | null {
  const auth = c.get('tierGateAuth') as {
    tier?: string;
    sessionId?: string;
    jwtId?: string;
  } | undefined;

  if (!auth) return null;
  return auth.sessionId || auth.jwtId || null;
}

/**
 * Register STS routes on Hono app.
 */
export function registerStsRoutes(app: Hono): void {
  /**
   * POST /_auth/sts/token — Issue a new STS token for a project.
   *
   * Request body:
   *   { "slug": "sbx-a1b2c3d" }
   *
   * Response:
   *   { "token": "eyJ...", "expiresAt": 1710346200, "slug": "sbx-a1b2c3d" }
   *
   * The token payload contains ONLY the immutable slug (sub), session ID (sid),
   * timestamps, and a unique token ID. No display name — the CLI daemon
   * resolves display names client-side via ProjectRegistry.
   *
   * Requires: valid shield_session (set by tier-gate middleware)
   * Validates: project slug exists on this VPS
   */
  app.post('/_auth/sts/token', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    if (!isStsAvailable()) {
      return c.json({ error: 'STS not available. jwt-secret may be missing.' }, 503);
    }

    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: 'No authenticated session' }, 401);
    }

    const body = await c.req.json().catch(() => null);
    const slugParsed = SandboxIdSchema.safeParse((body?.slug || '').toString().trim());
    if (!slugParsed.success) {
      return c.json({ error: 'Missing or invalid sandbox slug', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const slug = slugParsed.data;

    // Validate project exists on this VPS.
    // Since VPS is single-tenant, existence = ownership.
    if (!projectExists(slug)) {
      logAuditEvent({ type: 'sts_project_not_found', ip, details: { slug } });
      return c.json({ error: 'Project not found' }, 404);
    }

    // Optional TTL override (clamped by signProjectToken)
    const ttl = typeof body.ttl === 'number' ? body.ttl : STS_TOKEN_TTL_SECONDS;

    try {
      const token = signProjectToken(slug, sessionId, ttl);
      const expiresAt = Math.floor(Date.now() / 1000) + Math.min(ttl, 3600);

      logAuditEvent({
        type: 'sts_token_issued',
        ip,
        details: { slug, sessionId: sessionId.slice(0, 8) },
      });

      return c.json({ token, expiresAt, slug });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * POST /_auth/sts/refresh — Refresh an existing STS token.
   *
   * Request body:
   *   { "token": "eyJ..." }
   *
   * Response:
   *   { "token": "eyJ...(new)", "expiresAt": 1710346200, "projectId": "a3f8c1d2..." }
   *
   * The existing token must still be valid (not expired).
   * A new token is minted with a fresh TTL for the same project+session.
   * This validates that the session is still active.
   *
   * NOTE: Expired tokens cannot be refreshed. The client must acquire
   * a new token via POST /_auth/sts/token if the old one expired.
   */
  app.post('/_auth/sts/refresh', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    if (!isStsAvailable()) {
      return c.json({ error: 'STS not available' }, 503);
    }

    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: 'No authenticated session' }, 401);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.token !== 'string') {
      return c.json({ error: 'Missing token in request body' }, 400);
    }

    // Verify the existing token — must be valid and bound to current session
    const existing = verifyProjectToken(body.token, sessionId);
    if (!existing) {
      // Determine if it's expired or invalid for better error reporting (Gotcha #4)
      const withoutSessionCheck = verifyProjectToken(body.token);
      if (withoutSessionCheck) {
        // Token is valid but session doesn't match — session was rotated
        return c.json({ error: 'Token session mismatch', code: STS_INVALID_CODE }, 401);
      }

      // Try to decode just to check if it was an expiry
      try {
        const parts = body.token.split('.');
        if (parts.length === 3 && parts[1]) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
            return c.json({ error: 'Token expired', code: STS_EXPIRED_CODE }, 401);
          }
        }
      } catch {}

      return c.json({ error: 'Invalid token', code: STS_INVALID_CODE }, 401);
    }

    // Verify the project still exists (could have been deleted since token was issued)
    if (!projectExists(existing.sub)) {
      logAuditEvent({ type: 'sts_project_not_found', ip, details: { slug: existing.sub } });
      return c.json({ error: 'Project not found' }, 404);
    }

    // Issue a fresh token for the same slug and session
    try {
      const token = signProjectToken(existing.sub, sessionId);
      const expiresAt = Math.floor(Date.now() / 1000) + STS_TOKEN_TTL_SECONDS;

      logAuditEvent({
        type: 'sts_token_refreshed',
        ip,
        details: { slug: existing.sub },
      });

      return c.json({ token, expiresAt, slug: existing.sub });
    } catch (err) {
      logAuditEvent({
        type: 'sts_refresh_error',
        ip,
        details: { slug: existing.sub, error: (err as Error).message },
      });
      return c.json({ error: 'Token refresh failed' }, 500);
    }
  });
}
