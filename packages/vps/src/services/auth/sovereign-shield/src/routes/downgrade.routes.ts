// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Downgrade Routes — VPS endpoints for VPS → local repatriation
 *
 * Three-phase protocol:
 *   POST /_auth/downgrade/init     — Receive LOCAL's ML-KEM ek, return challenge
 *   POST /_auth/downgrade/export   — Gather state, encapsulate to LOCAL's ek, return encrypted blob
 *   POST /_auth/downgrade/finalize — Archive project on VPS (only after local confirms success)
 */

import type { Hono } from 'hono';
import { getClientIp } from '../auth/fingerprint';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import { initDowngrade, exportDowngrade, finalizeDowngrade, isProjectArchived } from '../application/process/Downgrade';

export function registerDowngradeRoutes(app: Hono): void {
  app.post('/_auth/downgrade/init', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const body = await c.req.json().catch(() => null);
    if (!body?.projectSlug || !body?.downgradeId || !body?.mlkem_ek) {
      return c.json({ error: 'Missing projectSlug, downgradeId, or mlkem_ek' }, 400);
    }

    const auth = c.get('tierGateAuth') as { sessionId?: string; jwtId?: string } | undefined;
    const sessionId = auth?.sessionId || auth?.jwtId;
    if (!sessionId) return c.json({ error: 'No authenticated session' }, 401);

    if (isProjectArchived(body.projectSlug)) {
      return c.json({ error: 'Project is already archived' }, 409);
    }

    try {
      const result = await initDowngrade(body.downgradeId, sessionId, body.projectSlug, body.mlkem_ek);
      logAuditEvent({ type: 'downgrade_init', ip, details: { projectSlug: body.projectSlug, downgradeId: body.downgradeId } });
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  app.post('/_auth/downgrade/export', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const body = await c.req.json().catch(() => null);
    if (!body?.downgradeId) return c.json({ error: 'Missing downgradeId' }, 400);

    const auth = c.get('tierGateAuth') as { sessionId?: string; jwtId?: string } | undefined;
    const sessionId = auth?.sessionId || auth?.jwtId;
    if (!sessionId) return c.json({ error: 'No authenticated session' }, 401);

    try {
      const result = await exportDowngrade(body.downgradeId, sessionId);
      logAuditEvent({ type: 'downgrade_export', ip, details: { downgradeId: body.downgradeId } });
      return c.json(result);
    } catch (err) {
      logAuditEvent({ type: 'downgrade_export_failed', ip, details: { error: (err as Error).message } });
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/_auth/downgrade/finalize', async (c) => {
    const ip = getClientIp(c);
    const body = await c.req.json().catch(() => null);
    if (!body?.downgradeId || !body?.projectSlug) {
      return c.json({ error: 'Missing downgradeId or projectSlug' }, 400);
    }

    try {
      const result = await finalizeDowngrade(body.downgradeId, body.projectSlug);
      logAuditEvent({ type: 'downgrade_finalized', ip, details: { projectSlug: body.projectSlug } });
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
}
