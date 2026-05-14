// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Per-tool permission routes — the console's direct REST surface for setting
 * per-tool overrides on the running agent's MCP gateway.
 *
 * Mirrors the posture of /_auth/context-mode: session-authenticated, operator
 * signature required on every write, audit-logged, proxied to agent-bridge
 * over the internal-token + localhost gate.
 *
 * Endpoints (all under /_auth/tool-permissions):
 *   POST /_auth/tool-permissions
 *     body: { connectionId, toolName, permission, operatorSignature, operatorTimestamp }
 *     signed payload: `tool-permission|${connectionId}|${toolName}|${permission}`
 *
 *   POST /_auth/tool-permissions/reset
 *     body: { connectionId, toolName, operatorSignature, operatorTimestamp }
 *     signed payload: `tool-permission-reset|${connectionId}|${toolName}`
 */

import type { Hono } from 'hono';
import { AGENT_BRIDGE_PORT } from '@vps/shared/ports';
import { getClientIp } from '../auth/fingerprint';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import { verifyOperatorSignature } from '../application/platform/OperatorSignature';
import { getCurrentTier } from '../application/gates/Tier';
import { getTokenForService } from '../application/credentials/InternalToken';

const VALID_PERMISSIONS: ReadonlySet<string> = new Set([
  'ask',
  'allow_session',
  'allow_always',
  'never',
]);

const SET_UPSTREAM = `http://127.0.0.1:${AGENT_BRIDGE_PORT}/api/internal/tool-permissions`;
const RESET_UPSTREAM = `http://127.0.0.1:${AGENT_BRIDGE_PORT}/api/internal/tool-permissions/reset`;

// Defense-in-depth: agent-bridge re-validates these, but rejecting at the
// edge keeps the audit trail clean of obvious junk.
function isValidIdentifier(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 256;
}

export function registerToolPermissionRoutes(app: Hono): void {
  app.post('/_auth/tool-permissions', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const body = (await c.req.json().catch(() => null)) as {
      connectionId?: string;
      toolName?: string;
      permission?: string;
      operatorSignature?: string;
      operatorTimestamp?: string;
    } | null;

    if (!body) return c.json({ error: 'Invalid JSON' }, 400);
    if (!isValidIdentifier(body.connectionId)) return c.json({ error: 'Missing connectionId' }, 400);
    if (!isValidIdentifier(body.toolName)) return c.json({ error: 'Missing toolName' }, 400);
    if (!isValidIdentifier(body.permission)) return c.json({ error: 'Missing permission' }, 400);
    if (!VALID_PERMISSIONS.has(body.permission)) {
      return c.json({ error: 'Invalid permission' }, 400);
    }

    const auth = c.get('tierGateAuth') as { sessionId?: string; userId?: string; jwtId?: string } | undefined;
    if (!auth || (!auth.sessionId && !auth.userId)) return c.json({ error: 'Authentication required' }, 401);

    const tpTier = getCurrentTier();
    if (tpTier === 'web_locked' || tpTier === 'private_locked') {
      const err = await verifyOperatorSignature(
        auth.sessionId!,
        `tool-permission|${body.connectionId}|${body.toolName}|${body.permission}`,
        body,
        ip,
      );
      if (err) return c.json({ error: err }, 403);
    }

    try {
      const resp = await fetch(SET_UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': getTokenForService('agent-bridge'),
        },
        body: JSON.stringify({
          connectionId: body.connectionId,
          toolName: body.toolName,
          permission: body.permission,
        }),
      });
      const upstream = await resp
        .json()
        .catch(() => ({ error: `Upstream HTTP ${resp.status}` }));
      if (resp.ok) {
        logAuditEvent({
          type: 'tool_permission_set',
          ip,
          sessionId: auth.sessionId ?? auth.jwtId,
          details: {
            connectionId: body.connectionId,
            toolName: body.toolName,
            permission: body.permission,
          },
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

  app.post('/_auth/tool-permissions/reset', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const body = (await c.req.json().catch(() => null)) as {
      connectionId?: string;
      toolName?: string;
      operatorSignature?: string;
      operatorTimestamp?: string;
    } | null;

    if (!body) return c.json({ error: 'Invalid JSON' }, 400);
    if (!isValidIdentifier(body.connectionId)) return c.json({ error: 'Missing connectionId' }, 400);
    if (!isValidIdentifier(body.toolName)) return c.json({ error: 'Missing toolName' }, 400);

    const auth = c.get('tierGateAuth') as { sessionId?: string; userId?: string; jwtId?: string } | undefined;
    if (!auth || (!auth.sessionId && !auth.userId)) return c.json({ error: 'Authentication required' }, 401);

    const tprTier = getCurrentTier();
    if (tprTier === 'web_locked' || tprTier === 'private_locked') {
      const err = await verifyOperatorSignature(
        auth.sessionId!,
        `tool-permission-reset|${body.connectionId}|${body.toolName}`,
        body,
        ip,
      );
      if (err) return c.json({ error: err }, 403);
    }

    try {
      const resp = await fetch(RESET_UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': getTokenForService('agent-bridge'),
        },
        body: JSON.stringify({
          connectionId: body.connectionId,
          toolName: body.toolName,
        }),
      });
      const upstream = await resp
        .json()
        .catch(() => ({ error: `Upstream HTTP ${resp.status}` }));
      if (resp.ok) {
        logAuditEvent({
          type: 'tool_permission_reset',
          ip,
          sessionId: auth.sessionId ?? auth.jwtId,
          details: { connectionId: body.connectionId, toolName: body.toolName },
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
