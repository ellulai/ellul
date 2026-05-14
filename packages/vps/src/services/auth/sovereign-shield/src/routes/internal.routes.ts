// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Inter-service API (file-api, agent-bridge, enforcer). Gated by requireInternalTokenMiddleware.

import type { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { db } from '../database';
import { getServiceUser, SHIELD_DATA_DIR } from '../config';
import { getClientIp } from '../auth/fingerprint';
import { logAuditEvent } from '../application/audit/Audit';
import {
  cleanupSandboxSecrets,
  readCliKeys,
  readSecrets,
  setSecretPlain,
  deleteSecret,
  isValidEnvironment,
  type SecretEnvironment,
} from '../application/vault/Secrets';
import { classifySql, executeQuery, executeQueryOnDb } from '../application/database/Database';
import { isGateOpen, getGateStatus, getGateRemainingMs, type GateType } from '../application/gates/Gate';
import { getExposureAlertSummary } from '../application/audit/Exposure';
import {
  grantCrossProjectAccess,
  revokeCrossProjectAccess,
  listCrossProjectAccess,
  listAllCrossProjectAccess,
  cleanupSandboxCrossProjectAccess,
  reconcileSharedSnapshots,
} from '../application/organization/CrossProject';
import { parseSandboxId, SandboxIdSchema, InvalidSandboxIdError } from '@ellul.ai/types';
import { z } from 'zod';
import {
  getAllSessionPolicies,
  updateSessionPolicy,
  enforceNewPolicy,
} from '../application/platform/SessionPolicy';
import { getTokenForService } from '../application/credentials/InternalToken';
import { reloadCaddy } from '@vps/shared/caddy';
import { createSession, createSessionExchangeCode, setSessionCookie } from '../auth/session';

export function registerInternalRoutes(app: Hono, hostname: string): void {

  app.delete('/api/internal/secrets/:sandboxId', async (c) => {
    const raw = c.req.param('sandboxId');
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';

    const parsedSandbox = SandboxIdSchema.safeParse(raw);
    if (!parsedSandbox.success) {
      return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = parsedSandbox.data;

    try {
      const deleted = cleanupSandboxSecrets(sandboxId);
      logAuditEvent({
        type: 'secrets_cleanup',
        ip,
        sandboxId,
        details: { deleted, caller },
      });
      return c.json({ success: true, deleted });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // Backup auth DB + tier marker before hibernate (shield owns the DB).
  app.post('/api/internal/backup-identity', async (c) => {
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';
    const svcUser = getServiceUser();
    const svcHome = `/home/${svcUser}`;
    const BACKUP_DIR = path.join(svcHome, '.ellul-identity');

    try {
      // Provisioning creates .ellul-identity as empty FILE marker — remove before mkdir.
      if (fs.existsSync(BACKUP_DIR) && !fs.statSync(BACKUP_DIR).isDirectory()) {
        fs.unlinkSync(BACKUP_DIR);
      }
      fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });

      const AUTH_DB = '/etc/ellul/shield-data/local-auth.db';
      let backedUp = false;

      if (fs.existsSync(AUTH_DB)) {
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}

        fs.copyFileSync(AUTH_DB, path.join(BACKUP_DIR, 'local-auth.db'));
        for (const ext of ['-wal', '-shm']) {
          if (fs.existsSync(AUTH_DB + ext)) {
            fs.copyFileSync(AUTH_DB + ext, path.join(BACKUP_DIR, 'local-auth.db' + ext));
          }
        }
        backedUp = true;
      }

      // Tier marker so restore can detect web_locked.
      const tierFile = '/etc/ellul/security-tier';
      if (fs.existsSync(tierFile)) {
        const tier = fs.readFileSync(tierFile, 'utf8').trim();
        if (tier !== 'standard') {
          fs.writeFileSync(path.join(BACKUP_DIR, '.web_locked_activated'), '1');
        } else {
          try { fs.unlinkSync(path.join(BACKUP_DIR, '.web_locked_activated')); } catch {}
        }
      }

      try {
        if (/^[a-zA-Z0-9_-]+$/.test(svcUser)) {
          const { execFileSync } = await import('child_process');
          execFileSync('chown', ['-R', `${svcUser}:${svcUser}`, BACKUP_DIR], { timeout: 5_000 });
        }
      } catch {}

      logAuditEvent({
        type: 'identity_backup',
        ip,
        details: { backedUp, caller },
      });

      console.log(`[shield] Identity backup: ${backedUp ? 'backed up' : 'no auth DB found'}`);
      return c.json({ success: true, backed_up: backedUp });
    } catch (e) {
      console.error('[shield] Identity backup failed:', (e as Error).message);
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // Shield (shield group) reads /var/log/ellul/apps/ and applies secret redaction.
  app.get('/api/internal/logs/:sandboxId', async (c) => {
    const sandboxId = c.req.param('sandboxId');
    const linesParam = parseInt(c.req.query('lines') || '100', 10);
    const lines = Math.min(Math.max(linesParam, 1), 500);
    const logType = c.req.query('type') || 'all';

    if (!['out', 'err', 'all'].includes(logType)) {
      return c.json({ error: 'Invalid type parameter (out, err, all)' }, 400);
    }

    // Sanitize (path traversal).
    const safeName = sandboxId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const logDir = `/var/log/ellul/apps/${safeName}`;

    const readLogTail = (filePath: string, type: 'out' | 'err'): Array<{ line: string; type: 'out' | 'err' }> => {
      try {
        if (!fs.existsSync(filePath)) return [];
        const content = fs.readFileSync(filePath, 'utf8');
        const allLines = content.split('\n').filter((l: string) => l.trim());
        return allLines.slice(-lines).map((line: string) => ({ line, type }));
      } catch {
        return [];
      }
    };

    const result: Array<{ line: string; type: 'out' | 'err' }> = [];

    if (logType === 'out' || logType === 'all') {
      result.push(...readLogTail(path.join(logDir, 'out.log'), 'out'));
    }
    if (logType === 'err' || logType === 'all') {
      result.push(...readLogTail(path.join(logDir, 'error.log'), 'err'));
    }

    // Secret redaction — defense-in-depth against console.log(process.env.SECRET).
    try {
      const parsed = SandboxIdSchema.safeParse(sandboxId);
      if (parsed.success) {
        const { readSecrets } = await import('../application/vault/Secrets');
        const secrets = readSecrets(parsed.data);
        if (secrets.size > 0) {
          for (const entry of result) {
            for (const [name, value] of secrets) {
              if (value.length >= 4) {
                entry.line = entry.line.replaceAll(value, `[REDACTED:${name}]`);
              }
            }
          }
        }
      }
    } catch {}

    const limited = result.slice(-lines);
    return c.json({ logs: limited, name: sandboxId });
  });

  app.get('/api/internal/exposure-alerts/:sandboxId', async (c) => {
    const parsed = SandboxIdSchema.safeParse(c.req.param('sandboxId'));
    if (!parsed.success) {
      return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const summary = getExposureAlertSummary(parsed.data);
    return c.json(summary);
  });

  // ── IDE Terminal Env Injection (Zero-Possession) ───────────────────────
  // ellul-code-terminal sources export lines inside the namespace, then deletes them.
  // Secrets never touch disk inside the namespace.
  // Values are single-quote escaped; env names POSIX-validated (shell injection defense).
  app.get('/api/internal/env/:project', async (c) => {
    const project = c.req.param('project');
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';

    const sandboxParse = SandboxIdSchema.safeParse(project);
    if (!sandboxParse.success) {
      logAuditEvent({
        type: 'internal_env_rejected',
        ip,
        details: { project: project.slice(0, 64), reason: 'invalid_sandbox_id', caller },
      });
      return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = sandboxParse.data;

    const lines: string[] = [];

    // 1. Runtime env (sandbox + org-overlay reserved; includes DATABASE_URL).
    const { readRuntimeEnv } = await import('../application/vault/Secrets');
    const appSecrets = readRuntimeEnv(sandboxId, 'production');
    for (const [name, value] of appSecrets) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) continue;
      // Replace ' with '\'' (close quote, escaped quote, reopen).
      const escaped = value.replace(/'/g, "'\\''");
      lines.push(`export ${name}='${escaped}'`);
    }

    // 2. CLI keys (global, e.g. ANTHROPIC_API_KEY). Don't override app values.
    const cliKeys = readCliKeys();
    for (const [name, value] of cliKeys) {
      if (appSecrets.has(name)) continue;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) continue;
      const escaped = value.replace(/'/g, "'\\''");
      lines.push(`export ${name}='${escaped}'`);
    }

    // Counts only — never log values.
    logAuditEvent({
      type: 'internal_env_accessed',
      ip,
      details: {
        project,
        caller,
        app_secrets_count: appSecrets.size,
        cli_keys_count: cliKeys.size,
        total_lines: lines.length,
      },
    });

    return c.text(lines.join('\n'));
  });

  // ── Agent-facing secrets CRUD (plaintext, internal-token) ─────────────────
  // Called by agent-bridge platform tools AFTER the `env` gate is user-approved.
  // Two-layer gate: MCP gateway pre-dispatch + this route re-checks isGateOpen(gate, threadId, app).
  // Gate grants are (threadId, gate) with TTL — no cross-session reuse.
  // Plaintext (not PQC): trust-boundary service + open passkey-approved gate.

  const ENV_VAR_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  const THREAD_ID_RE = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

  function resolveEnv(raw: unknown): SecretEnvironment | { error: string } {
    if (raw === undefined || raw === null || raw === '') return 'production';
    if (typeof raw !== 'string') return { error: 'env must be a string' };
    if (!isValidEnvironment(raw)) return { error: `Invalid env: ${raw} (expected production|development)` };
    return raw;
  }

  // Re-check gate at route boundary — MCP gateway bug/misconfig cannot bypass.
  function enforceGate(
    gate: GateType,
    threadId: unknown,
    sandboxId: string,
  ): { status: number; error: string } | null {
    if (typeof threadId !== 'string' || !THREAD_ID_RE.test(threadId)) {
      return {
        status: 400,
        error: `threadId required (24 hex chars or UUID). Received: ${typeof threadId === 'string' ? `"${threadId.slice(0, 48)}" (len=${threadId.length})` : typeof threadId}`,
      };
    }
    if (!isGateOpen(gate, threadId, sandboxId)) {
      // Verbose diagnostic — off happy path; surfaces into chat messages table for review.
      const remainingMs = getGateRemainingMs(gate, threadId);
      const allGates = getGateStatus(threadId);
      const openGates = Object.entries(allGates).filter(([, v]) => v).map(([k]) => k);
      return {
        status: 403,
        error:
          `Gate "${gate}" is not open for thread ${threadId.slice(0, 8)} (app=${sandboxId}). ` +
          `Remaining ms for this gate: ${remainingMs}. ` +
          `Gates currently open for this thread: [${openGates.join(', ') || 'none'}]. ` +
          `If a grant was just issued for this gate+thread and isGateOpen still reports false, ` +
          `the grant was stored against a different threadId or sandboxId — check the gate_granted ` +
          `broadcast and the /api/internal/gate/grant call site.`,
      };
    }
    return null;
  }

  // Names only — no gate (names already written to {sandboxId}.names as 664 group-readable).
  app.get('/api/internal/secrets/:project', async (c) => {
    const raw = c.req.param('project');
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';

    const parsed = SandboxIdSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = parsed.data;

    const envResult = resolveEnv(c.req.query('env'));
    if (typeof envResult !== 'string') return c.json({ error: envResult.error }, 400);

    const gateErr = enforceGate('env', c.req.query('threadId'), sandboxId);
    if (gateErr) {
      logAuditEvent({
        type: 'secret_internal_list_rejected',
        ip,
        sandboxId,
        details: { env: envResult, caller, reason: gateErr.error },
      });
      return c.json({ error: gateErr.error }, gateErr.status as 400 | 403);
    }

    const secrets = readSecrets(sandboxId, envResult);
    const names = Array.from(secrets.keys());

    logAuditEvent({
      type: 'secret_internal_list',
      ip,
      sandboxId,
      details: { env: envResult, count: names.length, caller },
    });

    return c.json({ sandboxId, env: envResult, names });
  });

  app.get('/api/internal/secrets/:project/:name', async (c) => {
    const raw = c.req.param('project');
    const name = c.req.param('name');
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';

    const parsed = SandboxIdSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = parsed.data;
    if (!ENV_VAR_NAME_RE.test(name)) {
      return c.json({ error: 'Invalid secret name' }, 400);
    }

    const envResult = resolveEnv(c.req.query('env'));
    if (typeof envResult !== 'string') return c.json({ error: envResult.error }, 400);

    const gateErr = enforceGate('env', c.req.query('threadId'), sandboxId);
    if (gateErr) {
      logAuditEvent({
        type: 'secret_internal_read_rejected',
        ip,
        sandboxId,
        details: { env: envResult, name, caller, reason: gateErr.error },
      });
      return c.json({ error: gateErr.error }, gateErr.status as 400 | 403);
    }

    const { readRuntimeEnv } = await import('../application/vault/Secrets');
    const merged = readRuntimeEnv(sandboxId, envResult);
    const value = merged.get(name);

    logAuditEvent({
      type: 'secret_internal_read',
      ip,
      sandboxId,
      details: { env: envResult, name, present: value !== undefined, caller },
    });

    if (value === undefined) {
      return c.json({ error: `Secret "${name}" not found for sandbox ${sandboxId}` }, 404);
    }

    return c.json({ sandboxId, env: envResult, name, value });
  });

  app.put('/api/internal/secrets/:project/:name', async (c) => {
    const raw = c.req.param('project');
    const name = c.req.param('name');
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';

    const parsed = SandboxIdSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = parsed.data;
    if (!ENV_VAR_NAME_RE.test(name)) {
      return c.json({ error: 'Invalid secret name' }, 400);
    }

    const body = await c.req.json().catch(() => null) as {
      value?: unknown; env?: unknown; threadId?: unknown;
    } | null;
    if (!body || typeof body.value !== 'string') {
      return c.json({ error: 'Body must include string "value"' }, 400);
    }

    const envResult = resolveEnv(body.env);
    if (typeof envResult !== 'string') return c.json({ error: envResult.error }, 400);

    const gateErr = enforceGate('env', body.threadId, sandboxId);
    if (gateErr) {
      logAuditEvent({
        type: 'secret_internal_write_rejected',
        ip,
        sandboxId,
        details: { env: envResult, name, caller, reason: gateErr.error },
      });
      return c.json({ error: gateErr.error }, gateErr.status as 400 | 403);
    }

    const MAX_VALUE_BYTES = 64 * 1024;
    if (Buffer.byteLength(body.value, 'utf8') > MAX_VALUE_BYTES) {
      return c.json({ error: `Secret value exceeds ${MAX_VALUE_BYTES} bytes` }, 413);
    }

    try {
      setSecretPlain(name, body.value, sandboxId, envResult);
    } catch (e) {
      const msg = (e as Error).message;
      logAuditEvent({
        type: 'secret_internal_write_failed',
        ip,
        sandboxId,
        details: { env: envResult, name, error: msg, caller },
      });
      return c.json({ error: msg }, 400);
    }

    logAuditEvent({
      type: 'secret_internal_write',
      ip,
      sandboxId,
      details: { env: envResult, name, caller },
    });

    return c.json({ success: true, sandboxId, env: envResult, name });
  });

  // Idempotent: existed:false if absent.
  app.delete('/api/internal/secrets/:project/:name', async (c) => {
    const raw = c.req.param('project');
    const name = c.req.param('name');
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';

    const parsed = SandboxIdSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = parsed.data;
    if (!ENV_VAR_NAME_RE.test(name)) {
      return c.json({ error: 'Invalid secret name' }, 400);
    }

    const envResult = resolveEnv(c.req.query('env'));
    if (typeof envResult !== 'string') return c.json({ error: envResult.error }, 400);

    const gateErr = enforceGate('env', c.req.query('threadId'), sandboxId);
    if (gateErr) {
      logAuditEvent({
        type: 'secret_internal_delete_rejected',
        ip,
        sandboxId,
        details: { env: envResult, name, caller, reason: gateErr.error },
      });
      return c.json({ error: gateErr.error }, gateErr.status as 400 | 403);
    }

    const existed = deleteSecret(name, sandboxId, envResult);

    logAuditEvent({
      type: 'secret_internal_delete',
      ip,
      sandboxId,
      details: { env: envResult, name, existed, caller },
    });

    return c.json({ success: true, sandboxId, env: envResult, name, existed });
  });

  // ── Agent-facing DB query ────────────────────────────────────────────────
  // classify(sql) must be ≤ declared mode (else 403). Admin SQL rejected. Cap 10k rows.

  type QueryMode = 'read' | 'write' | 'migrate';
  const MODE_LEVELS: Record<QueryMode, number> = { read: 0, write: 1, migrate: 2 };

  app.post('/api/internal/db/query', async (c) => {
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';

    const body = await c.req.json().catch(() => null) as {
      sandboxId?: unknown;
      sql?: unknown;
      database?: unknown;
      mode?: unknown;
      threadId?: unknown;
    } | null;

    if (!body) {
      return c.json({ error: 'JSON body required' }, 400);
    }

    if (typeof body.sandboxId !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(body.sandboxId)) {
      return c.json({ error: 'sandboxId must be a non-empty slug' }, 400);
    }
    if (typeof body.sql !== 'string' || !body.sql.trim()) {
      return c.json({ error: 'sql must be a non-empty string' }, 400);
    }
    if (body.mode !== 'read' && body.mode !== 'write' && body.mode !== 'migrate') {
      return c.json({ error: 'mode must be "read", "write", or "migrate"' }, 400);
    }
    const database = typeof body.database === 'string' && body.database.trim() ? body.database.trim() : null;
    if (database !== null && !/^[a-zA-Z0-9_-]{1,63}$/.test(database)) {
      return c.json({ error: 'database must match [a-zA-Z0-9_-]{1,63}' }, 400);
    }

    const sandboxId = body.sandboxId;
    const sql = body.sql.trim();
    const mode = body.mode as QueryMode;

    // Caller-declared mode must have its gate open — stolen internal-token alone is not enough.
    const modeToGate: Record<QueryMode, GateType> = {
      read: 'db_read',
      write: 'db_write',
      migrate: 'db_migrate',
    };
    const gateErr = enforceGate(modeToGate[mode], body.threadId, sandboxId);
    if (gateErr) {
      logAuditEvent({
        type: 'db_internal_query_rejected',
        ip,
        details: { sandboxId, mode, caller, reason: gateErr.error },
      });
      return c.json({ error: gateErr.error }, gateErr.status as 400 | 403);
    }

    const category = classifySql(sql);
    if (category === 'admin') {
      logAuditEvent({
        type: 'db_internal_query_rejected',
        ip,
        details: { sandboxId, mode, category, caller, reason: 'admin_category' },
      });
      return c.json({ error: 'Administrative SQL is not permitted via this endpoint' }, 403);
    }
    if (MODE_LEVELS[category] > MODE_LEVELS[mode]) {
      logAuditEvent({
        type: 'db_internal_query_rejected',
        ip,
        details: { sandboxId, mode, category, caller, reason: 'mode_escalation' },
      });
      return c.json({
        error: `SQL classifies as "${category}" but caller declared mode "${mode}" — request the higher gate first`,
      }, 403);
    }

    const MAX_ROWS = 10_000;
    const limitedSql = category === 'read' ? sql.replace(/;?\s*$/, '') + ` LIMIT ${MAX_ROWS + 1}` : sql;

    try {
      const result = database
        ? await executeQueryOnDb(sandboxId, database, limitedSql, category)
        : await executeQuery(sandboxId, limitedSql, category);

      const truncated = result.rows.length > MAX_ROWS;
      if (truncated) result.rows = result.rows.slice(0, MAX_ROWS);

      logAuditEvent({
        type: 'db_internal_query',
        ip,
        details: {
          sandboxId,
          mode,
          category,
          command: result.command,
          rowCount: truncated ? MAX_ROWS : result.rowCount,
          database,
          truncated,
          caller,
        },
      });

      return c.json({
        rows: result.rows,
        rowCount: truncated ? MAX_ROWS : result.rowCount,
        command: result.command,
        category,
        truncated,
      });
    } catch (e) {
      const msg = (e as Error).message;
      logAuditEvent({
        type: 'db_internal_query_failed',
        ip,
        details: { sandboxId, mode, category, error: msg, caller },
      });
      return c.json({ error: msg || 'Query execution failed' }, 500);
    }
  });

  // ── Cross-project read access (Phase 5) ───────────────────────────────────
  // Namespace script queries at spawn time. Management endpoints in secrets.routes.ts.

  app.get('/api/internal/cross-project-access/:sandboxId', async (c) => {
    const raw = c.req.param('sandboxId');
    try {
      const sandboxId = parseSandboxId(raw);
      const access = listCrossProjectAccess(sandboxId);
      return c.json({
        shared: access.map((a) => ({
          sandboxId: a.sharedSandboxId,
          preview: a.sharePreview,
        })),
      });
    } catch (e) {
      if (e instanceof InvalidSandboxIdError) {
        return c.json({ error: e.message, code: e.code }, 400);
      }
      throw e;
    }
  });

  app.get('/api/internal/cross-project-access', async (c) => {
    const rules = listAllCrossProjectAccess();
    return c.json({
      rules: rules.map((r) => ({
        sandboxId: r.sandboxId,
        sharedSandboxId: r.sharedSandboxId,
        grantedAt: r.grantedAt,
        sharePreview: r.sharePreview,
      })),
    });
  });

  const crossProjectGrantSchema = z.object({
    sandboxId: SandboxIdSchema,
    sharedSandboxId: SandboxIdSchema,
    sharePreview: z.boolean().optional().default(false),
  });

  app.post('/api/internal/cross-project-access', async (c) => {
    const ip = getClientIp(c);
    const raw = await c.req.json().catch(() => null);
    const parsed = crossProjectGrantSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
    }
    const { sandboxId, sharedSandboxId, sharePreview } = parsed.data;

    try {
      grantCrossProjectAccess(sandboxId, sharedSandboxId, sharePreview);
      logAuditEvent({
        type: 'xproject.grant',
        ip,
        sandboxId,
        details: { sharedSandboxId, sharePreview },
      });
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  const crossProjectRevokeSchema = z.object({
    sandboxId: SandboxIdSchema,
    sharedSandboxId: SandboxIdSchema,
  });

  app.delete('/api/internal/cross-project-access', async (c) => {
    const ip = getClientIp(c);
    const raw = await c.req.json().catch(() => null);
    const parsed = crossProjectRevokeSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
    }
    const { sandboxId, sharedSandboxId } = parsed.data;

    try {
      const revoked = revokeCrossProjectAccess(sandboxId, sharedSandboxId);
      if (!revoked) {
        return c.json({ error: 'No such access rule' }, 404);
      }
      logAuditEvent({
        type: 'xproject.revoke',
        ip,
        sandboxId,
        details: { sharedSandboxId },
      });
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post('/api/internal/cross-project-access/reconcile', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = z.object({ sandboxId: SandboxIdSchema }).safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
    }
    try {
      const count = reconcileSharedSnapshots(parsed.data.sandboxId);
      return c.json({ success: true, populated: count });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // Preview port registry — namespace script reads ONLY shield-data copy (agent cannot tamper).
  const PREVIEW_PORTS_FILE = `${SHIELD_DATA_DIR}/preview-ports.json`;

  app.post('/api/internal/preview-ports', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.registry !== 'object' || Array.isArray(body.registry)) {
      return c.json({ error: 'registry object required' }, 400);
    }

    // Validate: name regex + port in 4000-4099.
    const registry = body.registry as Record<string, unknown>;
    const validated: Record<string, number> = {};
    for (const [name, port] of Object.entries(registry)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 4000 || port > 4099) continue;
      validated[name] = port;
    }

    const tmp = PREVIEW_PORTS_FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o640);
    try {
      fs.writeSync(fd, JSON.stringify(validated, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, PREVIEW_PORTS_FILE);

    return c.json({ success: true, count: Object.keys(validated).length });
  });

  app.get('/api/internal/preview-ports', async (c) => {
    try {
      const data = fs.readFileSync(PREVIEW_PORTS_FILE, 'utf8');
      return c.json({ registry: JSON.parse(data) });
    } catch {
      return c.json({ registry: {} });
    }
  });

  // ── Session policy (per-tier TTL) ────────────────────────────────────────

  app.get('/api/internal/session-policy', async (c) => {
    const policies = getAllSessionPolicies();
    return c.json({ policies });
  });

  // Constraints: sessionTtlMs ∈ [1h, 24h]; absoluteMaxMs ∈ [sessionTtlMs, 72h].
  app.put('/api/internal/session-policy/:tier', async (c) => {
    const tier = c.req.param('tier');
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';

    const VALID_TIERS = new Set(['free', 'paid']);
    if (!VALID_TIERS.has(tier)) {
      return c.json({ error: `Invalid tier: ${tier}` }, 400);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.sessionTtlMs !== 'number' || typeof body.absoluteMaxMs !== 'number') {
      return c.json({ error: 'sessionTtlMs and absoluteMaxMs required (numbers)' }, 400);
    }

    const MIN_TTL = 60 * 60 * 1000;
    const MAX_TTL = 24 * 60 * 60 * 1000;
    const MAX_ABSOLUTE = 72 * 60 * 60 * 1000;

    if (body.sessionTtlMs < MIN_TTL || body.sessionTtlMs > MAX_TTL) {
      return c.json({ error: `sessionTtlMs must be between ${MIN_TTL} and ${MAX_TTL}` }, 400);
    }
    if (body.absoluteMaxMs < body.sessionTtlMs || body.absoluteMaxMs > MAX_ABSOLUTE) {
      return c.json({ error: `absoluteMaxMs must be between sessionTtlMs and ${MAX_ABSOLUTE}` }, 400);
    }

    const maxConcurrent = body.maxConcurrentSessions;
    if (maxConcurrent !== undefined) {
      if (typeof maxConcurrent !== 'number' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 10) {
        return c.json({ error: 'maxConcurrentSessions must be an integer between 1 and 10' }, 400);
      }
    }

    const MIN_IDLE = 5 * 60 * 1000;
    const MAX_IDLE = 4 * 60 * 60 * 1000;
    const idleTimeout = body.idleTimeoutMs;
    if (idleTimeout !== undefined) {
      if (typeof idleTimeout !== 'number' || idleTimeout < MIN_IDLE || idleTimeout > MAX_IDLE) {
        return c.json({ error: `idleTimeoutMs must be between ${MIN_IDLE} and ${MAX_IDLE}` }, 400);
      }
    }

    const policy = updateSessionPolicy(
      tier as 'free' | 'paid',
      body.sessionTtlMs,
      body.absoluteMaxMs,
      { maxConcurrentSessions: maxConcurrent, idleTimeoutMs: idleTimeout }
    );

    // Kill sessions exceeding new policy, clamp the rest.
    const enforcement = enforceNewPolicy(body.sessionTtlMs, body.absoluteMaxMs);

    if (enforcement.killed > 0) {
      const BRIDGE_PORT = 7700;
      for (const sessionId of enforcement.killedSessionIds) {
        fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/internal/session-revoked`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': getTokenForService('agent-bridge'),
          },
          body: JSON.stringify({ sessionId, reason: 'policy_changed' }),
        }).catch(() => {});
      }
    }

    logAuditEvent({
      type: 'session_policy_updated',
      ip,
      details: {
        tier,
        session_ttl_ms: body.sessionTtlMs,
        absolute_max_ms: body.absoluteMaxMs,
        idle_timeout_ms: policy.idle_timeout_ms,
        max_concurrent_sessions: policy.max_concurrent_sessions,
        sessions_killed: enforcement.killed,
        sessions_clamped: enforcement.clamped,
        caller,
      },
    });

    return c.json({
      success: true,
      policy,
      sessionsKilled: enforcement.killed,
      sessionsClamped: enforcement.clamped,
    });
  });

  // ── Admin session management (internal-token) ───────────────────────────

  app.get('/api/internal/sessions', async (c) => {
    const sessions = db.prepare(`
      SELECT s.id, s.credential_id, s.ip, s.fingerprint_status, s.country_code,
             s.created_at, s.last_activity, s.expires_at, s.absolute_expiry,
             c.name as credential_name
      FROM sessions s
      LEFT JOIN credential c ON s.credential_id = c.id
      ORDER BY s.last_activity DESC
    `).all() as Array<{
      id: string; credential_id: string; ip: string; fingerprint_status: string;
      country_code: string | null; created_at: number; last_activity: number;
      expires_at: number; absolute_expiry: number; credential_name: string | null;
    }>;

    const now = Date.now();
    return c.json({
      sessions: sessions.map(s => ({
        id: s.id.substring(0, 8) + '...',
        fullId: s.id,
        credentialId: s.credential_id.substring(0, 8) + '...',
        credentialName: s.credential_name,
        ip: s.ip,
        fingerprintStatus: s.fingerprint_status,
        countryCode: s.country_code,
        createdAt: s.created_at,
        lastActivity: s.last_activity,
        expiresAt: s.expires_at,
        absoluteExpiry: s.absolute_expiry,
        isExpired: now > s.expires_at,
        isAbsoluteExpired: now > s.absolute_expiry,
      })),
      total: sessions.length,
    });
  });

  // SECURITY-CRITICAL: mints session without WebAuthn ceremony. Gated by:
  //   1. Internal-token middleware (enforcer-only)
  //   2. RECENT-UNLOCK marker file (written post-PRF-unlock, short window — prevents IPC replay)
  //   3. Marker is consumed on use (single-shot per unlock event)
  app.post('/api/internal/bootstrap-session', async (c) => {
    const ip = getClientIp(c);

    const MARKER_PATH = '/run/shield/recent-prf-unlock';
    const MARKER_MAX_AGE_MS = 60_000;
    let markerOk = false;
    try {
      const fsMod = await import('node:fs');
      const st = fsMod.statSync(MARKER_PATH);
      if (Date.now() - st.mtimeMs <= MARKER_MAX_AGE_MS) {
        markerOk = true;
        // Consume immediately — window-stale replay refused.
        try { fsMod.unlinkSync(MARKER_PATH); } catch { /* already gone */ }
      }
    } catch { /* missing → refuse */ }
    if (!markerOk) {
      logAuditEvent({
        type: 'bootstrap_session_refused',
        ip,
        details: { reason: 'no_recent_prf_unlock_marker' },
      });
      return c.json({ error: 'no recent PRF unlock' }, 403);
    }

    // First registered credential — user just proved ownership via PRF.
    const cred = db.prepare('SELECT id FROM credential LIMIT 1').get() as { id: string } | undefined;
    if (!cred) {
      return c.json({ error: 'No credentials registered' }, 400);
    }

    const session = createSession(cred.id, ip, null);
    setSessionCookie(c, session.id, hostname);

    const exchangeCode = createSessionExchangeCode(session.id);

    logAuditEvent({
      type: 'bootstrap_session_created',
      ip,
      sessionId: session.id,
      credentialId: cred.id,
      details: { reason: 'sovereign_unlock' },
    });

    return c.json({ exchangeCode });
  });

  app.delete('/api/internal/sessions/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';

    const session = db.prepare('SELECT id, credential_id FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; credential_id: string } | undefined;

    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    logAuditEvent({
      type: 'admin_session_revoked',
      ip,
      sessionId,
      credentialId: session.credential_id,
      details: { caller, method: 'single' },
    });

    return c.json({ success: true, revoked: sessionId.substring(0, 8) + '...' });
  });

  app.post('/api/internal/sessions/revoke-all', async (c) => {
    const ip = getClientIp(c);
    const caller = c.get('verifiedService') || 'unknown';
    const body = await c.req.json().catch(() => ({})) as { reason?: string };

    const count = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    db.prepare('DELETE FROM sessions').run();

    logAuditEvent({
      type: 'admin_all_sessions_revoked',
      ip,
      details: {
        caller,
        revoked_count: count.count,
        reason: body.reason || 'admin_action',
      },
    });

    return c.json({ success: true, revokedCount: count.count });
  });

  app.get('/api/internal/sessions/:sessionId/audit', async (c) => {
    const sessionId = c.req.param('sessionId');
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);

    const entries = db.prepare(
      'SELECT timestamp, event, ip, details FROM audit_log WHERE session_id = ? ORDER BY id DESC LIMIT ?'
    ).all(sessionId, limit) as Array<{
      timestamp: number; event: string; ip: string | null; details: string | null;
    }>;

    return c.json({
      sessionId: sessionId.substring(0, 8) + '...',
      entries: entries.map(e => ({
        timestamp: e.timestamp,
        event: e.event,
        ip: e.ip,
        details: e.details ? JSON.parse(e.details) : null,
      })),
      total: entries.length,
    });
  });

  // ── Caddy config (mediated writes — keeps file-api out of caddy group) ──

  app.post('/api/internal/caddy/write-route', async (c) => {
    const caller = c.get('verifiedService') || 'unknown';
    const body = await c.req.json() as { filename?: string; config?: string; directory?: string };

    const { filename, config, directory } = body;
    if (!filename || !config || !directory) {
      return c.json({ error: 'Missing required fields: filename, config, directory' }, 400);
    }

    const ALLOWED_DIRS: Record<string, string> = {
      'app-routes.d': '/etc/caddy/app-routes.d',
      'sites-enabled': '/etc/caddy/sites-enabled',
    };
    const targetDir = ALLOWED_DIRS[directory];
    if (!targetDir) {
      return c.json({ error: `Invalid directory: ${directory}. Allowed: ${Object.keys(ALLOWED_DIRS).join(', ')}` }, 400);
    }

    // Filename regex: path traversal defense.
    if (!/^[a-zA-Z0-9._-]+\.caddy$/.test(filename)) {
      return c.json({ error: 'Invalid filename: must match [a-zA-Z0-9._-]+.caddy' }, 400);
    }

    const filePath = path.join(targetDir, filename);
    const tmpPath = `${filePath}.tmp.${process.pid}`;

    try {
      const fd = fs.openSync(tmpPath, 'w', 0o644);
      fs.writeSync(fd, config);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmpPath, filePath);

      logAuditEvent({
        type: 'caddy_route_write',
        ip: getClientIp(c) || '',
        details: { caller, filename, directory },
      });

      return c.json({ success: true, path: filePath });
    } catch (err: any) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return c.json({ error: `Failed to write route: ${err.message}` }, 500);
    }
  });

  app.post('/api/internal/caddy/remove-route', async (c) => {
    const caller = c.get('verifiedService') || 'unknown';
    const body = await c.req.json() as { filename?: string; directory?: string };

    const { filename, directory } = body;
    if (!filename || !directory) {
      return c.json({ error: 'Missing required fields: filename, directory' }, 400);
    }

    const ALLOWED_DIRS: Record<string, string> = {
      'app-routes.d': '/etc/caddy/app-routes.d',
      'sites-enabled': '/etc/caddy/sites-enabled',
    };
    const targetDir = ALLOWED_DIRS[directory];
    if (!targetDir) {
      return c.json({ error: `Invalid directory: ${directory}` }, 400);
    }

    if (!/^[a-zA-Z0-9._-]+\.caddy$/.test(filename)) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const filePath = path.join(targetDir, filename);

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      logAuditEvent({
        type: 'caddy_route_remove',
        ip: getClientIp(c) || '',
        details: { caller, filename, directory },
      });

      return c.json({ success: true });
    } catch (err: any) {
      return c.json({ error: `Failed to remove route: ${err.message}` }, 500);
    }
  });

  app.post('/api/internal/caddy/reload', async (c) => {
    const caller = c.get('verifiedService') || 'unknown';

    try {
      await reloadCaddy();

      logAuditEvent({
        type: 'caddy_reload',
        ip: getClientIp(c) || '',
        details: { caller },
      });

      return c.json({ success: true });
    } catch (err: any) {
      return c.json({ error: `Caddy reload failed: ${err.message}` }, 500);
    }
  });

}
