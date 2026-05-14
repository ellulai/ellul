// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sovereign Proxy Routes
 *
 * Internal API endpoints for the Sovereign Database Proxy.
 * All endpoints are under /api/internal/db/sovereign-* and /api/internal/db/shared/*
 * and are protected by requireInternalTokenMiddleware (applied in index.ts).
 *
 * Endpoints:
 * - POST   /api/internal/db/sovereign-query    - Tagged, timed, role-resolved query
 * - POST   /api/internal/db/sovereign-write    - Governance write with idempotency
 * - POST   /api/internal/db/shared             - Create a shared database
 * - GET    /api/internal/db/shared/list        - List shared databases
 * - POST   /api/internal/db/shared/grant       - Grant project access
 * - POST   /api/internal/db/shared/revoke      - Revoke project access
 * - POST   /api/internal/db/shared/bind        - Bind project to shared DB
 * - POST   /api/internal/db/shared/unbind      - Unbind project
 * - GET    /api/internal/db/agent-views        - List agent views
 * - POST   /api/internal/db/agent-view         - Create agent view
 * - DELETE /api/internal/db/agent-view         - Drop agent view
 */

import type { Hono } from 'hono';
import { SandboxIdSchema, type SandboxId } from '@ellul.ai/types';
import { getClientIp } from '../auth/fingerprint';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { isPostgresAvailable, ensurePostgresAvailable } from '../application/database/Database';
import {
  createSharedDatabase,
  grantProjectAccess,
  revokeProjectAccess,
  listSharedDatabases,
  bindProjectToSharedDb,
  unbindProjectFromSharedDb,
  getProjectDatabaseMode,
  executeSovereignQuery,
  executeSovereignWrite,
  createAgentView,
  dropAgentView,
  listAgentViews,
  generateViewSql,
  type ProjectRole,
  type AgentViewDefinition,
  type SovereignQueryRequest,
  type SovereignWriteRequest,
} from '../application/database/SovereignProxy';

// ── Helpers ──

function validateSandboxScope(raw: unknown): SandboxId | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = SandboxIdSchema.safeParse(raw.trim());
  return parsed.success ? parsed.data : null;
}

async function requirePostgres(c: any): Promise<boolean> {
  if (!(await ensurePostgresAvailable())) {
    c.status(503);
    return false;
  }
  return true;
}

// ── Route Registration ──

export function registerSovereignProxyRoutes(app: Hono): void {

  // ════════════════════════════════════════════════════════════
  // Sovereign Query — tagged, timed, role-resolved
  // ════════════════════════════════════════════════════════════

  app.post('/api/internal/db/sovereign-query', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);
    if (!(await requirePostgres(c))) return c.json({ error: 'PostgreSQL not available' }, 503);

    const body = await c.req.json<SovereignQueryRequest>();
    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);
    if (!body.sql?.trim()) return c.json({ error: 'SQL required' }, 400);

    try {
      const result = executeSovereignQuery({ ...body, sandboxId });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ════════════════════════════════════════════════════════════
  // Sovereign Write — idempotency + soft-delete + event log
  // ════════════════════════════════════════════════════════════

  app.post('/api/internal/db/sovereign-write', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);
    if (!(await requirePostgres(c))) return c.json({ error: 'PostgreSQL not available' }, 503);

    const body = await c.req.json<SovereignWriteRequest>();
    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);
    if (!body.sql?.trim()) return c.json({ error: 'SQL required' }, 400);
    if (!body.taskId?.trim()) return c.json({ error: 'taskId required' }, 400);
    if (!body.operation?.trim()) return c.json({ error: 'operation required' }, 400);
    if (!body.threadId?.trim()) return c.json({ error: 'threadId required' }, 400);

    try {
      const result = executeSovereignWrite({ ...body, sandboxId });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ════════════════════════════════════════════════════════════
  // Shared Database Management
  // ════════════════════════════════════════════════════════════

  app.post('/api/internal/db/shared', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);
    if (!(await requirePostgres(c))) return c.json({ error: 'PostgreSQL not available' }, 503);

    const { dbName: name } = await c.req.json<{ dbName: string }>();
    if (!name?.trim() || !/^[a-z0-9_]+$/i.test(name)) {
      return c.json({ error: 'Invalid database name: alphanumeric + underscores only' }, 400);
    }

    try {
      const fullDbName = createSharedDatabase(name);
      return c.json({ ok: true, dbName: fullDbName });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.get('/api/internal/db/shared/list', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);

    try {
      const databases = listSharedDatabases();
      return c.json({ databases });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/internal/db/shared/grant', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);
    if (!(await requirePostgres(c))) return c.json({ error: 'PostgreSQL not available' }, 503);

    const { dbName: name, sandboxId: rawApp, maxRole } = await c.req.json<{
      dbName: string;
      sandboxId: string;
      maxRole: ProjectRole;
    }>();

    const sandboxId = validateSandboxScope(rawApp);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);
    if (!name?.trim()) return c.json({ error: 'dbName required' }, 400);
    if (!['readonly', 'app', 'owner'].includes(maxRole)) {
      return c.json({ error: 'maxRole must be readonly, app, or owner' }, 400);
    }

    try {
      grantProjectAccess(name, sandboxId, maxRole);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/internal/db/shared/revoke', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);
    if (!(await requirePostgres(c))) return c.json({ error: 'PostgreSQL not available' }, 503);

    const { dbName: name, sandboxId: rawApp } = await c.req.json<{
      dbName: string;
      sandboxId: string;
    }>();

    const sandboxId = validateSandboxScope(rawApp);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);
    if (!name?.trim()) return c.json({ error: 'dbName required' }, 400);

    try {
      revokeProjectAccess(name, sandboxId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/internal/db/shared/bind', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);

    const { dbName: name, sandboxId: rawApp } = await c.req.json<{
      dbName: string;
      sandboxId: string;
    }>();

    const sandboxId = validateSandboxScope(rawApp);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);
    if (!name?.trim()) return c.json({ error: 'dbName required' }, 400);

    try {
      bindProjectToSharedDb(sandboxId, name);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/internal/db/shared/unbind', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);

    const { sandboxId: rawApp } = await c.req.json<{ sandboxId: string }>();
    const sandboxId = validateSandboxScope(rawApp);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);

    try {
      unbindProjectFromSharedDb(sandboxId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ════════════════════════════════════════════════════════════
  // Agent Views — LLM-friendly database views
  // ════════════════════════════════════════════════════════════

  app.get('/api/internal/db/agent-views', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);
    if (!(await requirePostgres(c))) return c.json({ error: 'PostgreSQL not available' }, 503);

    const rawApp = c.req.query('sandboxId');
    const sandboxId = validateSandboxScope(rawApp);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);

    try {
      const views = listAgentViews(sandboxId);
      return c.json({ views });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/internal/db/agent-view', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);
    if (!(await requirePostgres(c))) return c.json({ error: 'PostgreSQL not available' }, 503);

    const body = await c.req.json<{ sandboxId: string; viewDef: AgentViewDefinition; dryRun?: boolean }>();
    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);
    if (!body.viewDef) return c.json({ error: 'viewDef required' }, 400);

    const { viewDef, dryRun } = body;

    // Validate view definition
    if (!viewDef.viewName?.startsWith('v_agent_')) {
      return c.json({ error: 'viewName must start with "v_agent_"' }, 400);
    }
    if (!viewDef.sourceTable?.trim()) return c.json({ error: 'sourceTable required' }, 400);
    if (!viewDef.columns?.length) return c.json({ error: 'At least one column mapping required' }, 400);
    if (!viewDef.description?.trim()) return c.json({ error: 'description required' }, 400);

    try {
      if (dryRun) {
        const sql = generateViewSql(sandboxId, viewDef);
        return c.json({ ok: true, sql });
      }

      createAgentView(sandboxId, viewDef);
      return c.json({ ok: true, viewName: viewDef.viewName });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.delete('/api/internal/db/agent-view', async (c) => {
    const ip = getClientIp(c);
    if (!checkApiRateLimit(ip)) return c.json({ error: 'Rate limited' }, 429);
    if (!(await requirePostgres(c))) return c.json({ error: 'PostgreSQL not available' }, 503);

    const body = await c.req.json<{ sandboxId: string; viewName: string }>();
    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);
    if (!body.viewName?.startsWith('v_agent_')) {
      return c.json({ error: 'viewName must start with "v_agent_"' }, 400);
    }

    try {
      dropAgentView(sandboxId, body.viewName);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ════════════════════════════════════════════════════════════
  // Project Database Mode — check current mode
  // ════════════════════════════════════════════════════════════

  app.get('/api/internal/db/project-mode', async (c) => {
    const rawApp = c.req.query('sandboxId');
    const sandboxId = validateSandboxScope(rawApp);
    if (!sandboxId) return c.json({ error: 'Invalid sandboxId' }, 400);

    const mode = getProjectDatabaseMode(sandboxId);
    return c.json(mode);
  });
}
