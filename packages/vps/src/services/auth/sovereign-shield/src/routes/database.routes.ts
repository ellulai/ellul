// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Database Routes
 *
 * Browser-authenticated database management for per-app PostgreSQL databases.
 * Authentication is enforced by the tier-gate middleware before handlers run
 * (passkey + PoP for web_locked, JWT for standard).
 *
 * Endpoints:
 * - GET    /_auth/db/status           - Check if PostgreSQL is available
 * - GET    /_auth/db/info?sandboxId=xxx - Get database info for an app
 * - POST   /_auth/db/provision        - Create database for an app
 * - POST   /_auth/db/query            - Execute a read-only SQL query
 * - POST   /_auth/db/execute          - Execute any SQL (read/write/migrate, blocks admin)
 * - GET    /_auth/db/schema?sandboxId=xxx - Get database schema
 * - POST   /_auth/db/delete           - Delete an app's database
 * - GET    /_auth/db/backups?sandboxId=xxx - List backups (with file sizes)
 * - POST   /_auth/db/backup             - Create pg_dump backup (60s cooldown)
 * - POST   /_auth/db/restore            - Restore from a backup file (60s cooldown)
 */

import { existsSync } from 'fs';
import type { Hono } from 'hono';
import { getClientIp } from '../auth/fingerprint';
import { logAuditEvent } from '../application/audit/Audit';
import { cryptoAudit } from '../application/audit/CryptoAudit';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import {
  isPostgresAvailable,
  ensurePostgresAvailable,
  createAppDatabase,
  getAppDatabaseInfo,
  deleteAppDatabase,
  classifySql,
  executeQuery,
  executeQueryOnDb,
  backupAppDatabase,
  restoreAppDatabase,
  listAppBackups,
  listAppBackupsDetailed,
  loadDbConfig,
  saveDbConfig,
  validateConnectionUrl,
  resolveConnectionUrl,
  createNamedDatabase,
  deleteNamedDatabase,
  listAppDatabases,
  setPreviewDb,
  setDeployedDb,
  canonicalSandboxScope,
} from '../application/database/Database';
import {
  testConnection as testExternalConnAsync,
  saveEncryptedUrl,
} from '../application/database/ExternalPg';
import { readEnvFile, writeEnvFile } from '../application/vault/Secrets';
import { SandboxIdSchema, sandboxIdFromPath, type SandboxId } from '@ellul.ai/types';

// ── Helpers ──

/**
 * Validate and canonicalize scope from query or body. Every database
 * operation is sandbox-scoped (one DB pool per sandbox); app-nested paths
 * (`sbx-xxx/my-app`) fold up to the enclosing sandbox.
 *
 * Returns a branded `SandboxId` on success, `null` on invalid input —
 * caller should return 400 with `code: 'INVALID_SANDBOX_ID'`.
 */
function validateSandboxScope(raw: unknown): SandboxId | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  try {
    // Accept either bare slug or nested app path — fold to sandbox.
    return sandboxIdFromPath(trimmed);
  } catch {
    return null;
  }
}

/**
 * Check if the database is reachable.
 * For local: ensures PostgreSQL is up (with auto-recovery).
 * For external: tests connectivity with a SELECT 1.
 * Returns false if the database is unreachable.
 */
async function ensureDbAvailable(sandboxId: string): Promise<boolean> {
  const config = loadDbConfig(sandboxId);
  if (config.type === 'external') {
    const url = resolveConnectionUrl(sandboxId);
    if (!url) return false;
    return testExternalConnAsync(sandboxId, url);
  }
  return ensurePostgresAvailable();
}

// ── Route Registration ──

export function registerDatabaseRoutes(app: Hono): void {

  /**
   * Check if PostgreSQL is available on this VPS.
   */
  app.get('/_auth/db/status', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    try {
      const available = await ensurePostgresAvailable();
      return c.json({ available });
    } catch (err) {
      return c.json({ error: 'Failed to check PostgreSQL status' }, 500);
    }
  });

  /**
   * Get database info for an app.
   */
  app.get('/_auth/db/info', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const sandboxId = validateSandboxScope(c.req.query('sandboxId'));
    if (!sandboxId) {
      return c.json({ error: 'sandboxId query parameter required' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }
      const info = getAppDatabaseInfo(sandboxId);
      return c.json(info);
    } catch (err) {
      return c.json({ error: 'Failed to get database info' }, 500);
    }
  });

  /**
   * Provision a new database for an app.
   * Auto-injects DATABASE_URL into the app's secrets.
   */
  app.post('/_auth/db/provision', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.sandboxId !== 'string') {
      return c.json({ error: 'Missing sandboxId in request body' }, 400);
    }

    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) {
      return c.json({ error: 'Invalid sandboxId' }, 400);
    }

    try {
      // External provider: store the URL, no local DB creation
      if (typeof body.connectionUrl === 'string' && body.connectionUrl.trim()) {
        validateConnectionUrl(body.connectionUrl);

        // Verify connectivity before saving (async — uses connection pool)
        if (!(await testExternalConnAsync(sandboxId, body.connectionUrl))) {
          return c.json({ error: 'Cannot connect to external database. Verify the connection URL and ensure the database is reachable.' }, 502);
        }

        const config = loadDbConfig(sandboxId);
        config.type = 'external';
        config.connectionUrl = 'encrypted'; // Sentinel — real URL in encrypted at-rest storage
        if (config.databases.length === 0) {
          config.databases = [{ label: 'default', dbName: 'external', createdAt: Date.now() }];
        }
        config.previewDb = config.previewDb ?? 'default';
        config.deployedDb = config.deployedDb ?? 'default';
        saveDbConfig(sandboxId, config);

        // Encrypt and store URL at rest (AES-256-GCM + RSA-OAEP key wrap)
        saveEncryptedUrl(sandboxId, body.connectionUrl);

        // Inject DATABASE_URL into the app's env file
        try {
          const secrets = readEnvFile(sandboxId);
          secrets.set('DATABASE_URL', body.connectionUrl);
          writeEnvFile(secrets, sandboxId);
        } catch (envErr) {
          logAuditEvent({
            type: 'database_env_inject_failed',
            ip,
            details: { sandboxId, error: (envErr as Error).message },
          });
        }

        logAuditEvent({
          type: 'database_provisioned',
          ip,
          details: { sandboxId, database: 'external', type: 'external' },
        });
        cryptoAudit('database_provisioned', 'passkey', { sandboxId, database: 'external' });

        return c.json({
          success: true,
          type: 'external',
          database: 'external',
        });
      }

      // Local PostgreSQL path (existing behavior)
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      const { databaseUrl, info } = createAppDatabase(sandboxId);

      // Auto-inject DATABASE_URL into the app's env file
      try {
        const secrets = readEnvFile(sandboxId);
        secrets.set('DATABASE_URL', databaseUrl);
        writeEnvFile(secrets, sandboxId);
      } catch (envErr) {
        // Database was created but env injection failed — log but don't fail the whole request
        logAuditEvent({
          type: 'database_env_inject_failed',
          ip,
          details: { sandboxId, error: (envErr as Error).message },
        });
      }

      logAuditEvent({
        type: 'database_provisioned',
        ip,
        details: {
          sandboxId,
          database: info.database,
          type: 'local',
          roles: {
            owner: info.ownerRole,
            app: info.appRole,
            readonly: info.readonlyRole,
          },
        },
      });
      cryptoAudit('database_provisioned', 'passkey', { sandboxId, database: info.database });

      // Do NOT return databaseUrl — it contains credentials
      return c.json({
        success: true,
        type: 'local',
        database: info.database,
        roles: {
          owner: info.ownerRole,
          app: info.appRole,
          readonly: info.readonlyRole,
        },
      });
    } catch (err) {
      logAuditEvent({
        type: 'database_provision_failed',
        ip,
        details: { sandboxId, error: (err as Error).message },
      });
      return c.json({ error: 'Failed to provision database' }, 500);
    }
  });

  /**
   * Execute a read-only SQL query (for the browser database browser).
   * Only 'read' category queries are allowed from the browser.
   */
  app.post('/_auth/db/query', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.sandboxId !== 'string' || typeof body.sql !== 'string') {
      return c.json({ error: 'Missing sandboxId or sql in request body' }, 400);
    }

    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) {
      return c.json({ error: 'Invalid sandboxId' }, 400);
    }

    const sql = body.sql.trim();
    if (!sql) {
      return c.json({ error: 'Empty SQL query' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      // Classify the SQL and enforce read-only from browser
      const category = classifySql(sql);
      if (category !== 'read') {
        return c.json(
          { error: 'Only read queries are allowed from the browser. Write operations must go through the agent gate system.' },
          403,
        );
      }

      // SECURITY: Enforce result set size limit to prevent DoS via unbounded
      // SELECT queries that exhaust memory (e.g. SELECT * FROM huge_table).
      const MAX_ROWS = 10_000;
      const limitedSql = sql.replace(/;?\s*$/, '') + ` LIMIT ${MAX_ROWS + 1}`;

      // Optional: target a specific named database
      const database = typeof body.database === 'string' ? body.database.trim() : null;
      const result = database
        ? await executeQueryOnDb(sandboxId, database, limitedSql, 'read')
        : await executeQuery(sandboxId, limitedSql, 'read');

      const truncated = result.rows.length > MAX_ROWS;
      if (truncated) result.rows = result.rows.slice(0, MAX_ROWS);

      logAuditEvent({
        type: 'database_browser_query',
        ip,
        details: { sandboxId, command: result.command, rowCount: result.rowCount, database, truncated },
      });

      return c.json({
        rows: result.rows,
        rowCount: truncated ? MAX_ROWS : result.rowCount,
        command: result.command,
        truncated,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message || 'Query execution failed' }, 500);
    }
  });

  /**
   * Execute any SQL query (read, write, or migrate) from the browser database console.
   * The authenticated human user has full authority over their database.
   * Only 'admin' category queries (SET, VACUUM, etc.) are blocked.
   * The classified category determines which database role is used:
   *   - 'read' → readonly role
   *   - 'write' → app role
   *   - 'migrate' → owner role
   */
  app.post('/_auth/db/execute', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.sandboxId !== 'string' || typeof body.sql !== 'string') {
      return c.json({ error: 'Missing sandboxId or sql in request body' }, 400);
    }

    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) {
      return c.json({ error: 'Invalid sandboxId' }, 400);
    }

    const sql = body.sql.trim();
    if (!sql) {
      return c.json({ error: 'Empty SQL query' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      const category = classifySql(sql);
      if (category === 'admin') {
        return c.json(
          { error: 'Administrative SQL commands (SET, VACUUM, etc.) are not allowed from the browser console.' },
          403,
        );
      }

      // Optional: target a specific named database
      const database = typeof body.database === 'string' ? body.database.trim() : null;
      const result = database
        ? await executeQueryOnDb(sandboxId, database, sql, category)
        : await executeQuery(sandboxId, sql, category);

      logAuditEvent({
        type: 'database_browser_execute',
        ip,
        details: { sandboxId, category, command: result.command, rowCount: result.rowCount, database },
      });

      // Crypto-audit write/migrate operations for tamper-evident trail
      if (category === 'write' || category === 'migrate') {
        cryptoAudit('database_browser_write', 'passkey', {
          sandboxId, category, command: result.command, rowCount: result.rowCount, database,
        });
      }

      return c.json({
        rows: result.rows,
        rowCount: result.rowCount,
        command: result.command,
        category,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message || 'Query execution failed' }, 500);
    }
  });

  /**
   * Get database schema: tables, columns, types, and row counts.
   */
  app.get('/_auth/db/schema', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const sandboxId = validateSandboxScope(c.req.query('sandboxId'));
    if (!sandboxId) {
      return c.json({ error: 'sandboxId query parameter required' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      // Optional: target a specific named database
      const database = typeof c.req.query('database') === 'string' ? c.req.query('database')!.trim() : null;

      // Verify the database exists
      const info = getAppDatabaseInfo(sandboxId);
      if (!database && !info.exists) {
        return c.json({ error: 'Database does not exist for this app' }, 404);
      }

      // Helper to run queries on the right database
      const runQuery = (sql: string) =>
        database
          ? executeQueryOnDb(sandboxId, database, sql, 'read')
          : executeQuery(sandboxId, sql, 'read');

      // Use pg_catalog instead of information_schema for schema introspection.
      // pg_catalog tables are visible to all roles regardless of privileges,
      // so we don't need to escalate to the owner/migrate role. This avoids
      // the issue where information_schema hides tables the current role
      // doesn't have explicit grants on (e.g. newly created tables).
      const tablesResult = await runQuery(
        `SELECT tablename AS table_name FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );

      const tables: Array<{
        name: string;
        columns: Array<{ name: string; type: string; nullable: boolean; default: string | null }>;
        rowCount: number;
      }> = [];

      for (const row of tablesResult.rows) {
        const tableName = row.table_name;

        // SECURITY: Validate table name from pg_catalog against strict allowlist.
        // Even though tableName comes from pg_tables, a prior db_write could have
        // created a table with a malicious name containing SQL injection payloads.
        // Only allow safe identifiers: letters, digits, underscores, hyphens.
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
          continue; // Skip tables with unusual names
        }

        // pg_attribute + pg_class for column info — visible to all roles
        // SECURITY: Use quote_ident() to safely embed table names in SQL.
        // The regex filter above guarantees [a-zA-Z_][a-zA-Z0-9_]* but
        // quote_ident() provides defense-in-depth against any bypass.
        const safeIdent = `quote_ident('${tableName.replace(/'/g, "''")}')`;
        const columnsResult = await runQuery(
          `SELECT a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, NOT a.attnotnull AS is_nullable, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS column_default FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE a.attrelid = (SELECT oid FROM pg_class WHERE relname = (SELECT ${safeIdent})::name AND relnamespace = 'public'::regnamespace) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        );

        const columns = columnsResult.rows.map((col: any) => ({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable === 't' || col.is_nullable === true,
          default: col.column_default ?? null,
        }));

        // Get row count — use pg_class estimate for safety (avoids seq scan + injection)
        const countResult = await runQuery(
          `SELECT GREATEST(c.reltuples::bigint, 0) AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = (SELECT ${safeIdent})::name AND n.nspname = 'public'`,
        );

        const rowCount = parseInt(countResult.rows[0]?.count ?? '0', 10);

        tables.push({ name: tableName, columns, rowCount });
      }

      return c.json({ tables });
    } catch (err) {
      return c.json({ error: (err as Error).message || 'Failed to fetch schema' }, 500);
    }
  });

  /**
   * Delete an app's database and remove DATABASE_URL from secrets.
   */
  app.post('/_auth/db/delete', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.sandboxId !== 'string') {
      return c.json({ error: 'Missing sandboxId in request body' }, 400);
    }

    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) {
      return c.json({ error: 'Invalid sandboxId' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      deleteAppDatabase(sandboxId);

      // Remove DATABASE_URL from app secrets
      try {
        const secrets = readEnvFile(sandboxId);
        if (secrets.has('DATABASE_URL')) {
          secrets.delete('DATABASE_URL');
          writeEnvFile(secrets, sandboxId);
        }
      } catch {
        // Best-effort — database is already deleted
      }

      logAuditEvent({
        type: 'database_deleted',
        ip,
        details: { sandboxId },
      });
      cryptoAudit('database_deleted', 'passkey', { sandboxId });

      return c.json({ success: true });
    } catch (err) {
      logAuditEvent({
        type: 'database_delete_failed',
        ip,
        details: { sandboxId, error: (err as Error).message },
      });
      return c.json({ error: 'Failed to delete database' }, 500);
    }
  });

  // ── Multi-Database Routes ──

  /**
   * List all named databases for an app with sizes and role assignments.
   */
  app.get('/_auth/db/list', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const sandboxId = validateSandboxScope(c.req.query('sandboxId'));
    if (!sandboxId) {
      return c.json({ error: 'sandboxId query parameter required' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      const databases = listAppDatabases(sandboxId);
      return c.json({ databases });
    } catch (err) {
      return c.json({ error: (err as Error).message || 'Failed to list databases' }, 500);
    }
  });

  /**
   * Create a named database for an app.
   */
  app.post('/_auth/db/create', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.sandboxId !== 'string' || typeof body.label !== 'string') {
      return c.json({ error: 'Missing sandboxId or label in request body' }, 400);
    }

    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) {
      return c.json({ error: 'Invalid sandboxId' }, 400);
    }

    const label = body.label.trim();
    if (!label) {
      return c.json({ error: 'label is required' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      const result = createNamedDatabase(sandboxId, label);

      logAuditEvent({
        type: 'named_database_created',
        ip,
        details: { sandboxId, label, dbName: result.dbName },
      });

      return c.json({ success: true, label, dbName: result.dbName });
    } catch (err) {
      logAuditEvent({
        type: 'named_database_create_failed',
        ip,
        details: { sandboxId, label, error: (err as Error).message },
      });
      return c.json({ error: (err as Error).message || 'Failed to create database' }, 500);
    }
  });

  /**
   * Drop a named database for an app.
   */
  app.post('/_auth/db/drop', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.sandboxId !== 'string' || typeof body.label !== 'string') {
      return c.json({ error: 'Missing sandboxId or label in request body' }, 400);
    }

    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) {
      return c.json({ error: 'Invalid sandboxId' }, 400);
    }

    const label = body.label.trim();
    if (!label) {
      return c.json({ error: 'label is required' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      deleteNamedDatabase(sandboxId, label);

      logAuditEvent({
        type: 'named_database_dropped',
        ip,
        details: { sandboxId, label },
      });
      cryptoAudit('database_dropped', 'passkey', { sandboxId, label });

      return c.json({ success: true });
    } catch (err) {
      logAuditEvent({
        type: 'named_database_drop_failed',
        ip,
        details: { sandboxId, label, error: (err as Error).message },
      });
      return c.json({ error: (err as Error).message || 'Failed to drop database' }, 500);
    }
  });

  /**
   * Assign a named database to a preview or deployed role.
   */
  app.post('/_auth/db/assign', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.sandboxId !== 'string' || typeof body.role !== 'string') {
      return c.json({ error: 'Missing sandboxId or role in request body' }, 400);
    }

    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) {
      return c.json({ error: 'Invalid sandboxId' }, 400);
    }

    const role = body.role;
    if (role !== 'preview' && role !== 'deployed') {
      return c.json({ error: 'role must be "preview" or "deployed"' }, 400);
    }

    const label: string | null = body.label === null ? null : (typeof body.label === 'string' ? body.label.trim() : null);
    if (body.label !== null && (typeof body.label !== 'string' || !body.label.trim())) {
      return c.json({ error: 'label must be a string or null' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      if (role === 'preview') {
        setPreviewDb(sandboxId, label);
      } else {
        setDeployedDb(sandboxId, label);
      }

      logAuditEvent({
        type: 'database_role_assigned',
        ip,
        details: { sandboxId, label, role },
      });

      return c.json({ success: true });
    } catch (err) {
      logAuditEvent({
        type: 'database_role_assign_failed',
        ip,
        details: { sandboxId, label, role, error: (err as Error).message },
      });
      return c.json({ error: (err as Error).message || 'Failed to assign database role' }, 500);
    }
  });

  /**
   * List backups for an app's database.
   */
  app.get('/_auth/db/backups', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const sandboxId = validateSandboxScope(c.req.query('sandboxId'));
    if (!sandboxId) {
      return c.json({ error: 'sandboxId query parameter required' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      const backups = listAppBackupsDetailed(sandboxId);
      return c.json({ backups });
    } catch (err) {
      return c.json({ error: 'Failed to list backups' }, 500);
    }
  });

  /**
   * Create a backup of an app's database.
   * Throttled: max 1 backup per 60 seconds per IP (pg_dump is expensive).
   */
  const backupCooldowns = new Map<string, number>();

  app.post('/_auth/db/backup', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // Tighter cooldown: 1 backup per 60s per IP
    const now = Date.now();
    const lastBackup = backupCooldowns.get(ip) ?? 0;
    if (now - lastBackup < 60_000) {
      const wait = Math.ceil((60_000 - (now - lastBackup)) / 1000);
      return c.json({ error: `Backup cooldown: try again in ${wait}s` }, 429);
    }

    const body = await c.req.json().catch(() => null);
    const sandboxId = validateSandboxScope(body?.sandboxId);
    if (!sandboxId) {
      return c.json({ error: 'sandboxId required' }, 400);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      backupCooldowns.set(ip, Date.now());
      const dumpFile = backupAppDatabase(sandboxId);
      // Return only filename, not full server path
      const fileName = dumpFile.split('/').pop() ?? dumpFile;
      return c.json({ success: true, file: fileName });
    } catch (err) {
      console.error('[shield] Backup route error:', (err as Error).message);
      return c.json({ error: 'Backup failed' }, 500);
    }
  });

  /**
   * Restore an app's database from a backup file.
   * Throttled: max 1 restore per 60 seconds per IP.
   */
  app.post('/_auth/db/restore', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // 60s cooldown (shared with backup)
    const now = Date.now();
    const lastOp = backupCooldowns.get(ip) ?? 0;
    if (now - lastOp < 60_000) {
      const wait = Math.ceil((60_000 - (now - lastOp)) / 1000);
      return c.json({ error: `Restore cooldown: try again in ${wait}s` }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.sandboxId !== 'string' || typeof body.file !== 'string') {
      return c.json({ error: 'Missing sandboxId or file in request body' }, 400);
    }

    const sandboxId = validateSandboxScope(body.sandboxId);
    if (!sandboxId) {
      return c.json({ error: 'Invalid sandboxId' }, 400);
    }

    const file = body.file;
    // Strict filename validation — prevent path traversal
    if (!/^[a-z0-9_\-\.]+\.sql\.gz$/i.test(file)) {
      return c.json({ error: 'Invalid backup filename' }, 400);
    }

    const resolvedPath = `/var/backups/ellul/postgres/${file}`;
    if (!existsSync(resolvedPath)) {
      return c.json({ error: 'Backup file not found' }, 404);
    }

    try {
      if (!(await ensureDbAvailable(sandboxId))) {
        return c.json({ error: 'Database is not available' }, 503);
      }

      backupCooldowns.set(ip, Date.now());
      restoreAppDatabase(sandboxId, resolvedPath);

      logAuditEvent({
        type: 'database_restore',
        ip,
        details: { sandboxId, file },
      });
      cryptoAudit('database_restored', 'passkey', { sandboxId, file });

      return c.json({ success: true });
    } catch (err) {
      console.error('[shield] Restore route error:', (err as Error).message);
      return c.json({ error: 'Restore failed' }, 500);
    }
  });
}
