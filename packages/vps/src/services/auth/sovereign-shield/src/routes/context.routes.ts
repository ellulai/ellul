// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Context-mode routes — the console's direct REST surface for flipping a
 * project's per-session prompt layering (base / preview / deploy).
 *
 * Mirrors the posture of /_auth/gates/*: session-authenticated, operator
 * signature required on writes, audit-logged. Read posture matches
 * /_auth/gates/operator-status — session-only, no operator sig.
 *
 * Endpoints (all under /_auth/context-mode):
 *   GET  /_auth/context-mode?project=<sandboxId> → { mode }
 *   POST /_auth/context-mode  body: { project, mode, operatorSignature, operatorTimestamp } → { mode }
 *
 * Wire goes console → sovereign-shield → agent-bridge internal HTTP. We do not
 * allow the console to call agent-bridge directly (agent-bridge is localhost-
 * only + internal-token-gated).
 */

import type { Hono } from 'hono';
import { parseSandboxId } from '@ellul.ai/types';
import { AGENT_BRIDGE_PORT } from '@vps/shared/ports';
import { getClientIp } from '../auth/fingerprint';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import { verifyOperatorSignature } from '../application/platform/OperatorSignature';
import { getCurrentTier } from '../application/gates/Tier';
import { getTokenForService } from '../application/credentials/InternalToken';

const VALID_MODES: ReadonlySet<string> = new Set(['base', 'preview', 'deploy']);

const UPSTREAM_BASE = `http://127.0.0.1:${AGENT_BRIDGE_PORT}/api/internal/context-mode`;

export function registerContextRoutes(app: Hono): void {
  app.get('/_auth/context-mode', async (c) => {
    const auth = c.get('tierGateAuth') as { sessionId?: string; userId?: string } | undefined;
    if (!auth || (!auth.sessionId && !auth.userId)) return c.json({ error: 'Authentication required' }, 401);

    const projectRaw = c.req.query('project') ?? '';
    let project: string;
    try {
      project = parseSandboxId(projectRaw);
    } catch {
      return c.json({ error: 'Invalid or missing project' }, 400);
    }

    try {
      const resp = await fetch(
        `${UPSTREAM_BASE}?project=${encodeURIComponent(project)}`,
        {
          method: 'GET',
          headers: { 'X-Internal-Token': getTokenForService('agent-bridge') },
        },
      );
      const body = await resp.json().catch(() => ({ error: `Upstream HTTP ${resp.status}` }));
      return c.json(body, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return c.json({ error: 'Bridge service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 502);
    }
  });

  app.post('/_auth/context-mode', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const body = (await c.req.json().catch(() => null)) as {
      project?: string;
      mode?: string;
      operatorSignature?: string;
      operatorTimestamp?: string;
    } | null;

    if (!body?.project || !body?.mode) {
      return c.json({ error: 'Missing project or mode' }, 400);
    }
    if (!VALID_MODES.has(body.mode)) {
      return c.json({ error: 'Invalid mode' }, 400);
    }
    let project: string;
    try {
      project = parseSandboxId(body.project);
    } catch {
      return c.json({ error: 'Invalid project' }, 400);
    }

    const auth = c.get('tierGateAuth') as { sessionId?: string; userId?: string; jwtId?: string } | undefined;
    if (!auth || (!auth.sessionId && !auth.userId)) return c.json({ error: 'Authentication required' }, 401);

    const ctxTier = getCurrentTier();
    if (ctxTier === 'web_locked' || ctxTier === 'private_locked') {
      const err = await verifyOperatorSignature(
        auth.sessionId!,
        `context-mode|${project}|${body.mode}`,
        body,
        ip,
      );
      if (err) return c.json({ error: err }, 403);
    }

    try {
      const resp = await fetch(UPSTREAM_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': getTokenForService('agent-bridge'),
        },
        body: JSON.stringify({ project, mode: body.mode }),
      });
      const upstream = await resp
        .json()
        .catch(() => ({ error: `Upstream HTTP ${resp.status}` }));
      if (resp.ok) {
        logAuditEvent({
          type: 'context_mode_set',
          ip,
          sessionId: auth.sessionId ?? auth.jwtId,
          details: { project, mode: body.mode },
        });
      }
      return c.json(upstream, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return c.json({ error: 'Bridge service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 502);
    }
  });
}
