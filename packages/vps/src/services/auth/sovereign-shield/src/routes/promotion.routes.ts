// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Promotion Routes — VPS endpoints for local → VPS state promotion
 *
 * Two-phase protocol:
 *   POST /_auth/promotion/init     — ML-KEM key exchange + challenge
 *   POST /_auth/promotion/complete — Encrypted payload + bind proof → atomic import
 *
 * Both require: authenticated session + scoped promotion token.
 * The promotion token is single-use, bound to projectSlug + sessionId + promotionId.
 */

import type { Hono } from 'hono';
import { getClientIp } from '../auth/fingerprint';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import { initPromotion, completePromotion } from '../application/process/Promotion';

export function registerPromotionRoutes(app: Hono): void {
  /**
   * POST /_auth/promotion/init
   *
   * Initiates ML-KEM-1024 key exchange for promotion.
   * Returns ephemeral encapsulation key + challenge.
   *
   * Requires: scoped promotion token (validated by caller/middleware)
   */
  app.post('/_auth/promotion/init', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.projectSlug !== 'string' || typeof body.promotionId !== 'string') {
      return c.json({ error: 'Missing projectSlug or promotionId' }, 400);
    }

    // Get session ID from tier-gate auth context
    const auth = c.get('tierGateAuth') as { sessionId?: string; jwtId?: string } | undefined;
    const sessionId = auth?.sessionId || auth?.jwtId;
    if (!sessionId) {
      return c.json({ error: 'No authenticated session' }, 401);
    }

    try {
      const result = await initPromotion(body.projectSlug, sessionId, body.projectSlug);

      logAuditEvent({
        type: 'promotion_init',
        ip,
        details: { projectSlug: body.projectSlug, promotionId: body.promotionId },
      });

      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  /**
   * POST /_auth/promotion/complete
   *
   * Receives encrypted promotion payload, decrypts, and atomically imports state.
   * Returns signed import receipt.
   *
   * Replay prevention:
   *   - Promotion token consumed (single-use)
   *   - ML-KEM decapsulation key deleted on first retrieval
   *   - Bind proof verified against session + slug + promotionId
   */
  app.post('/_auth/promotion/complete', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || !body._promotion || body._version !== 1) {
      return c.json({ error: 'Invalid promotion payload' }, 400);
    }

    if (!body.promotionId || !body.projectSlug || !body.mlkem_ct ||
        !body.bindProof || !body.iv || !body.ciphertext || !body.authTag) {
      return c.json({ error: 'Missing required fields in encrypted payload' }, 400);
    }

    const auth = c.get('tierGateAuth') as { sessionId?: string; jwtId?: string } | undefined;
    const sessionId = auth?.sessionId || auth?.jwtId;
    if (!sessionId) {
      return c.json({ error: 'No authenticated session' }, 401);
    }

    try {
      const receipt = await completePromotion(body, sessionId);

      logAuditEvent({
        type: 'promotion_complete',
        ip,
        details: {
          projectSlug: receipt.projectSlug,
          promotionId: receipt.promotionId,
          secretsImported: receipt.secretsImported,
          rulesImported: receipt.rulesImported,
          gatePoliciesImported: receipt.gatePoliciesImported,
        },
      });

      return c.json(receipt);
    } catch (err) {
      logAuditEvent({
        type: 'promotion_failed',
        ip,
        details: { error: (err as Error).message, projectSlug: body.projectSlug },
      });
      return c.json({ error: (err as Error).message }, 400);
    }
  });
}
