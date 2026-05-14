// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Permissions API — console-facing inbox REST routes.
 *
 * Endpoints (all under /_auth/permissions):
 *   GET  /pending              — inbox hydration (returns pending rows)
 *   GET  /:id                  — single-request detail
 *   GET  /history?threadId=X   — resolved rows for a thread
 *   POST /:id/seen             — client acks a request has been surfaced
 *   GET  /metrics              — Prometheus-format permission counters
 *
 * Live deltas are delivered via WS broadcast (agent-bridge gate-routes →
 * broadcastToAllSessions → console PermissionInboxContext).
 */

import type { Hono } from 'hono';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { getClientIp } from '../auth/fingerprint';
import {
  getRequest,
  listPending,
  listForThread,
  markSeen,
  resolveRequest,
} from '../application/gates/Permission';
import { isGateOpenForApp } from '../application/gates/Gate';
import { renderMetrics } from '../application/gates/PermissionMetrics';

/**
 * Resolve the sandbox scope the caller is allowed to see.
 * Returns the STS-bound sandbox slug (set by tier-gate middleware) or
 * null if the caller hasn't presented one — in which case we must
 * not expose any rows (fail-closed).
 */
function resolveScope(c: { get: (k: string) => unknown }): string | null {
  const stsSlug = c.get('stsProject') as string | undefined;
  return stsSlug || null;
}

export function registerPermissionsRoutes(app: Hono): void {
  /**
   * GET /_auth/permissions/pending
   * Returns all pending requests the caller is scoped to see.
   * This is the cold-start hydration source for the console inbox.
   */
  app.get('/_auth/permissions/pending', (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const scope = resolveScope(c);
    const threadId = c.req.query('threadId') || undefined;
    const rows = listPending({
      sandboxId: scope,
      threadId,
      limit: 200,
    });
    const live: typeof rows = [];
    for (const row of rows) {
      if (row.sandboxId && isGateOpenForApp(row.gate, row.sandboxId)) {
        try {
          resolveRequest({ id: row.id, action: 'grant_timed', sessionId: null });
        } catch {}
        continue;
      }
      live.push(row);
    }
    return c.json({ requests: live });
  });

  /**
   * GET /_auth/permissions/:id
   * Single-request detail — used by the modal to render a resolved
   * request's metadata ("granted by Device X at 12:04").
   */
  app.get('/_auth/permissions/:id', (c) => {
    const id = c.req.param('id');
    const req = getRequest(id);
    if (!req) return c.json({ error: 'not found' }, 404);

    const scope = resolveScope(c);
    if (scope && req.sandboxId && req.sandboxId !== scope) {
      return c.json({ error: 'not found' }, 404); // avoid cross-sandbox probe
    }
    return c.json({ request: req });
  });

  /**
   * GET /_auth/permissions/history?threadId=X
   * Resolved requests for a thread (granted|denied|revoked|expired).
   * Drives the per-thread activity rail in the modal.
   */
  app.get('/_auth/permissions/history', (c) => {
    const threadId = c.req.query('threadId');
    if (!threadId) return c.json({ error: 'threadId required' }, 400);
    const scope = resolveScope(c);
    // Push the sandbox scope into the SQL query so enforcement is server-side.
    // `scope` null (no STS) returns rows across sandboxes for the VPS owner's
    // inbox view — see SCOPING MODEL in the file header.
    const rows = listForThread(threadId, {
      includeResolved: true,
      limit: 200,
      sandboxId: scope,
    });
    return c.json({ requests: rows });
  });

  /**
   * POST /_auth/permissions/:id/seen
   * Bumps lastSeenAt — drives "don't re-toast the same request."
   */
  app.post('/_auth/permissions/:id/seen', (c) => {
    const id = c.req.param('id');
    const updated = markSeen(id);
    if (!updated) return c.json({ error: 'not found' }, 404);
    const scope = resolveScope(c);
    if (scope && updated.sandboxId && updated.sandboxId !== scope) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json({ success: true, lastSeenAt: updated.lastSeenAt });
  });

  /**
   * GET /_auth/permissions/metrics
   * Prometheus text-format metrics for the permission subsystem.
   * The endpoint is authenticated (tier-gate middleware) but intentionally
   * carries no sensitive data — only counts, latencies, and rejection
   * reasons. Scrapable by the console's ops dashboard or an external
   * Prometheus agent running on the trust boundary.
   */
  app.get('/_auth/permissions/metrics', (c) => {
    return c.text(renderMetrics(), 200, {
      'Content-Type': 'text/plain; version=0.1.0; charset=utf-8',
    });
  });

}
