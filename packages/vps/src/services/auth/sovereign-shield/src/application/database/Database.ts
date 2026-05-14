// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Per-app Postgres (local peer auth + external Neon/Supabase).
// Local roles: owner/app/readonly/temp-migrate. External: TLS + circuit breaker + AES-256-GCM.
// Agent → DB ONLY via query proxy (SQL classified → gate permissions).

import crypto from 'crypto';
import { execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { parseSandboxId, sandboxIdFromPath, type SandboxId } from '@ellul.ai/types';
import { logAuditEvent } from '../audit/Audit';
import { readEnvFile, writeEnvFile } from '../vault/Secrets';

// Defense-in-depth re-parse at the secrets.service boundary — raw cast would skip canonical regex.
function toSandboxId(sandboxId: string): SandboxId {
  return parseSandboxId(sandboxId);
}
import {
  queryExternal,
  testConnection as testExternalConn,
  destroyPool,
  enforceTls,
  saveEncryptedUrl,
  loadEncryptedUrl,
  removeEncryptedUrl,
} from './ExternalPg';

// ── Types ──

export interface DatabaseInfo {
  database: string;
  ownerRole: string;
  appRole: string;
  readonlyRole: string;
  exists: boolean;
  sizeBytes?: number;
}

export interface TempMigrateRole {
  roleName: string;
  password: string;
  database: string;
  sandboxId: string;
  createdAt: number;
  expiresAt: number;
}

// ── State ──

/** Active temporary migrate roles — cleaned up on gate revoke or TTL expiry. */
const activeTempRoles = new Map<string, TempMigrateRole>();

// ── Naming helpers ──

// Fold nested paths to sandbox slug. Legacy non-sandbox names throw.
// Thin re-export of sandboxIdFromPath — SoT lives in @ellul.ai/types.
export function canonicalSandboxScope(input: string | null | undefined): string {
  if (!input) throw new Error('canonicalSandboxScope called with empty input');
  return sandboxIdFromPath(input);
}

export function sanitizeSandboxIdForPg(sandboxId: string): string {
  // PostgreSQL identifiers: lowercase, alnum + underscores only
  return sandboxId.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 48);
}

export function dbName(sandboxId: string): string {
  return `shield_${sanitizeSandboxIdForPg(sandboxId)}`;
}

export function ownerRole(sandboxId: string): string {
  return `shield_${sanitizeSandboxIdForPg(sandboxId)}_owner`;
}

export function appRole(sandboxId: string): string {
  return `shield_${sanitizeSandboxIdForPg(sandboxId)}_app`;
}

export function readonlyRole(sandboxId: string): string {
  return `shield_${sanitizeSandboxIdForPg(sandboxId)}_readonly`;
}

// ── PostgreSQL execution ──

// Peer auth via sudoers: `shield-runner ALL=(postgres) NOPASSWD: shield-pg-wrapper`.
// argv form (execFileSync) — no /bin/sh, so $(...)/backticks inside any string
// are passed literally to psql instead of being expanded by the shell.
export function pgExec(sql: string, database?: string): string {
  const args = ['-u', 'postgres', '/usr/local/bin/shield-pg-wrapper', '/usr/bin/psql'];
  if (database) args.push('-d', database);
  args.push('-At', '-c', sql);
  try {
    return execFileSync('sudo', args, {
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    throw new Error(`PostgreSQL error: ${stderr || err.message}`);
  }
}

export function pgExecMulti(sql: string, database?: string): string {
  const args = ['-u', 'postgres', '/usr/local/bin/shield-pg-wrapper', '/usr/bin/psql'];
  if (database) args.push('-d', database);
  args.push('-At');
  try {
    return execFileSync('sudo', args, {
      input: sql,
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    throw new Error(`PostgreSQL error: ${stderr || err.message}`);
  }
}

// Double-timeout: PG statement_timeout < Node execSync timeout (5s buffer) so PG kills first
// with clean 57014 query_canceled, not a socket hangup.
export function pgExecAsRole(
  sql: string,
  database: string,
  role: string,
  statementTimeoutMs?: number,
): { rows: any[]; rowCount: number; command: string } {
  // Validate role name to prevent injection
  if (!/^[a-z0-9_-]+$/i.test(role)) {
    throw new Error('Invalid role name');
  }

  const pgTimeoutMs = statementTimeoutMs ?? 30_000;
  const execTimeoutMs = pgTimeoutMs + 5_000; // Double-timeout: always 5s buffer

  // Wrap user SQL with role + timeout. \set QUIET suppresses SET confirmations
  // so only query output appears. We intentionally omit -t (tuples_only) because
  // --csv mode needs headers for the parser to map column names correctly.
  const wrappedSql = `\\set QUIET on
SET ROLE ${JSON.stringify(role)};
SET statement_timeout = '${pgTimeoutMs}ms';
\\set QUIET off
${sql}`;

  const dbArg = `-d ${JSON.stringify(database)}`;
  const cmd = `sudo -u postgres /usr/local/bin/shield-pg-wrapper /usr/bin/psql ${dbArg} -A --csv`;

  try {
    const output = execSync(cmd, {
      input: wrappedSql,
      timeout: execTimeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    return parsePsqlCsvOutput(output, sql);
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    throw new Error(stderr || err.message);
  }
}

/** Simple CSV line parser (handles quoted fields). */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parsePsqlCsvOutput(output: string, sql: string): { rows: any[]; rowCount: number; command: string } {
  const lines = output.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { rows: [], rowCount: 0, command: sql.trim().split(/\s+/)[0]?.toUpperCase() || 'UNKNOWN' };
  }

  const command = sql.trim().split(/\s+/)[0]?.toUpperCase() || 'UNKNOWN';

  if (command === 'SELECT' || command === 'EXPLAIN' || command === 'WITH' || command === 'TABLE') {
    if (lines.length < 2) {
      return { rows: [], rowCount: 0, command };
    }
    const headers = parseCSVLine(lines[0]!);
    const rows = lines.slice(1).map(line => {
      const values = parseCSVLine(line);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
      return row;
    });
    return { rows, rowCount: rows.length, command };
  }

  // DML/DDL commands output a command tag like "INSERT 0 1", "UPDATE 3",
  // "CREATE TABLE", "DROP TABLE", etc. Extract row count from it.
  const lastLine = lines[lines.length - 1] || '';
  const countMatch = lastLine.match(/\b(\d+)$/);
  const rowCount = countMatch?.[1] ? parseInt(countMatch[1], 10) : 0;
  return { rows: [], rowCount, command };
}

// ── External Database Support ──

export function validateConnectionUrl(url: string): void {
  if (url.length > 2048) {
    throw new Error('Connection URL exceeds maximum length (2048 characters)');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid connection URL format');
  }

  const scheme = parsed.protocol.replace(/:$/, '');
  if (scheme !== 'postgresql' && scheme !== 'postgres') {
    throw new Error('Connection URL must use postgresql:// or postgres:// scheme');
  }
  if (!parsed.hostname) {
    throw new Error('Connection URL must include a hostname');
  }
  if (parsed.port && (!/^\d+$/.test(parsed.port) || parseInt(parsed.port, 10) > 65535)) {
    throw new Error('Connection URL port must be a valid number (1-65535)');
  }
}

// Password-stripped URL + PGPASSWORD env. argv exposes creds via /proc/[pid]/cmdline.
function parseConnectionUrl(connectionUrl: string): {
  safeUrl: string;
  env: Record<string, string>;
} {
  const parsed = new URL(connectionUrl);
  const password = decodeURIComponent(parsed.password);

  // Build a URL without the password for the command line.
  // Setting password='' can leave `user:@host` — replace the `user:@` with `user@`
  const safeParsed = new URL(connectionUrl);
  safeParsed.password = '';
  const safeUrl = safeParsed.toString().replace(/:@/, '@');

  // Inherit current env and add PGPASSWORD
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (password) {
    env.PGPASSWORD = password;
  }
  // Disable .pgpass file to prevent unexpected credential sources
  env.PGPASSFILE = '/dev/null';

  return { safeUrl, env };
}

// External URL (no sudo/SET ROLE). Password via PGPASSWORD; same double-timeout as pgExecAsRole.
export function pgExecViaUrl(
  sql: string,
  connectionUrl: string,
  statementTimeoutMs?: number,
): { rows: any[]; rowCount: number; command: string } {
  const pgTimeoutMs = statementTimeoutMs ?? 30_000;
  const execTimeoutMs = pgTimeoutMs + 5_000;

  const wrappedSql = `\\set QUIET on
SET statement_timeout = '${pgTimeoutMs}ms';
\\set QUIET off
${sql}`;

  const { safeUrl, env } = parseConnectionUrl(connectionUrl);
  const cmd = `/usr/bin/psql ${JSON.stringify(safeUrl)} -A --csv`;

  try {
    const output = execSync(cmd, {
      input: wrappedSql,
      timeout: execTimeoutMs,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    return parsePsqlCsvOutput(output, sql);
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    // Sanitize error: strip connection URLs and credentials from error messages
    const sanitized = (stderr || err.message)
      .replace(/postgresql?:\/\/[^\s"']+/gi, '[REDACTED_URL]')
      .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]');
    throw new Error(`External database error: ${sanitized}`);
  }
}

// pg_dump/psql via URL; PGPASSWORD only, never argv.
function execExternalPgCommand(
  command: string,
  connectionUrl: string,
  opts?: { timeout?: number },
): string {
  const { safeUrl, env } = parseConnectionUrl(connectionUrl);
  const fullCmd = command.replace('$PGURL', JSON.stringify(safeUrl));

  try {
    return execSync(fullCmd, {
      timeout: opts?.timeout ?? 300_000,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    const sanitized = (stderr || err.message)
      .replace(/postgresql?:\/\/[^\s"']+/gi, '[REDACTED_URL]')
      .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]');
    throw new Error(`External database command failed: ${sanitized}`);
  }
}

export function testExternalConnection(connectionUrl: string): boolean {
  try {
    pgExecViaUrl('SELECT 1', connectionUrl, 5_000);
    return true;
  } catch {
    return false;
  }
}

// ── Public API ──

export function isPostgresAvailable(): boolean {
  try {
    execSync('sudo -u postgres /usr/local/bin/shield-pg-wrapper /usr/bin/psql -c "SELECT 1" -At', {
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// Auto-recovery via shield-pg-ensure wrapper. Async, debounced, 35s bounded.
let activeRecovery: Promise<boolean> | null = null;

export async function ensurePostgresAvailable(): Promise<boolean> {
  if (isPostgresAvailable()) return true;

  if (activeRecovery) {
    console.log('[shield] Recovery already in-flight — waiting');
    return activeRecovery;
  }

  console.log('[shield] PostgreSQL unavailable — attempting auto-recovery via shield-pg-ensure');

  activeRecovery = new Promise<boolean>((resolve) => {
    const { spawn } = require('child_process') as typeof import('child_process');
    const child = spawn('sudo', ['/usr/local/bin/shield-pg-ensure'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 35_000,
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code: number | null) => {
      activeRecovery = null;
      if (code === 0) {
        console.log('[shield] PostgreSQL recovered successfully');
        resolve(true);
      } else {
        console.error(`[shield] Auto-recovery failed (exit ${code}):`, stderr.slice(0, 500));
        resolve(false);
      }
    });

    child.on('error', (err: Error) => {
      activeRecovery = null;
      console.error('[shield] Auto-recovery spawn error:', err.message);
      resolve(false);
    });
  });

  return activeRecovery;
}

// Idempotent; returns DATABASE_URL for the app role.
export function createAppDatabase(sandboxId: string): { databaseUrl: string; info: DatabaseInfo } {
  const db = dbName(sandboxId);
  const owner = ownerRole(sandboxId);
  const app = appRole(sandboxId);
  const ro = readonlyRole(sandboxId);

  const appPassword = crypto.randomBytes(32).toString('base64url');

  const sql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${owner}') THEN
    CREATE ROLE "${owner}" LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${app}') THEN
    CREATE ROLE "${app}" LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ro}') THEN
    CREATE ROLE "${ro}" LOGIN PASSWORD '${crypto.randomBytes(32).toString('base64url').replace(/'/g, "''")}';
  END IF;
END $$;

-- Create database if not exists
SELECT 'exists' FROM pg_database WHERE datname = '${db}';
`;

  const result = pgExecMulti(sql);
  const dbExists = result.includes('exists');

  if (!dbExists) {
    // CREATE DATABASE cannot run inside a transaction
    pgExec(`CREATE DATABASE "${db}" OWNER "${owner}"`);
  }

  // Set up schema permissions within the database
  const schemaSql = `
-- Owner gets full access
GRANT ALL PRIVILEGES ON DATABASE "${db}" TO "${owner}";

-- App role: DML (connect + usage, grant table/seq privs via default)
GRANT CONNECT ON DATABASE "${db}" TO "${app}";
GRANT CONNECT ON DATABASE "${db}" TO "${ro}";

-- Set default privileges so new tables auto-grant to app and readonly
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${app}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "${app}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT SELECT ON TABLES TO "${ro}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "${ro}";

-- Grant usage on public schema
GRANT USAGE ON SCHEMA public TO "${app}";
GRANT USAGE ON SCHEMA public TO "${ro}";

-- Grant on existing tables/sequences (idempotent)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${app}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${app}";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${ro}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${ro}";

-- Revoke public schema creation from app/readonly (defense in depth)
REVOKE CREATE ON SCHEMA public FROM "${app}";
REVOKE CREATE ON SCHEMA public FROM "${ro}";

-- SECURITY: Revoke dangerous built-in roles that allow OS command execution
-- and filesystem access. COPY TO/FROM PROGRAM requires pg_execute_server_program.
-- Without these revokes, a db_write holder could execute arbitrary shell commands
-- via COPY (SELECT 1) TO PROGRAM 'malicious-command'.
REVOKE pg_execute_server_program FROM "${app}";
REVOKE pg_execute_server_program FROM "${ro}";
REVOKE pg_read_server_files FROM "${app}";
REVOKE pg_read_server_files FROM "${ro}";
REVOKE pg_write_server_files FROM "${app}";
REVOKE pg_write_server_files FROM "${ro}";
`;

  pgExecMulti(schemaSql, db);

  // Update app role password (in case it was already created with a different one)
  pgExec(`ALTER ROLE "${app}" PASSWORD '${appPassword.replace(/'/g, "''")}'`);

  const databaseUrl = `postgresql://${app}:${appPassword}@127.0.0.1:5432/${db}`;

  logAuditEvent({
    type: 'database_created',
    details: { sandboxId, database: db, roles: [owner, app, ro] },
  });

  console.log(`[shield] Database created: ${db} (owner: ${owner}, app: ${app}, readonly: ${ro})`);

  return {
    databaseUrl,
    info: {
      database: db,
      ownerRole: owner,
      appRole: app,
      readonlyRole: ro,
      exists: true,
    },
  };
}

export function getAppDatabaseInfo(sandboxId: string): DatabaseInfo {
  const config = loadDbConfig(sandboxId);

  // External databases — always "exist" if a URL is configured
  if (config.type === 'external' && config.connectionUrl) {
    return {
      database: 'external',
      ownerRole: 'external',
      appRole: 'external',
      readonlyRole: 'external',
      exists: true,
    };
  }

  const db = dbName(sandboxId);
  const owner = ownerRole(sandboxId);
  const app = appRole(sandboxId);
  const ro = readonlyRole(sandboxId);

  try {
    const exists = pgExec(`SELECT 1 FROM pg_database WHERE datname = '${db}'`);
    if (!exists) {
      return { database: db, ownerRole: owner, appRole: app, readonlyRole: ro, exists: false };
    }

    const sizeResult = pgExec(`SELECT pg_database_size('${db}')`);
    const sizeBytes = parseInt(sizeResult, 10) || 0;

    return { database: db, ownerRole: owner, appRole: app, readonlyRole: ro, exists: true, sizeBytes };
  } catch {
    return { database: db, ownerRole: owner, appRole: app, readonlyRole: ro, exists: false };
  }
}

export function deleteAppDatabase(sandboxId: string): void {
  const config = loadDbConfig(sandboxId);

  // External: remove config, encrypted credentials, and drain connection pool
  if (config.type === 'external') {
    const configFile = dbConfigPath(sandboxId);
    if (existsSync(configFile)) {
      require('fs').unlinkSync(configFile);
    }
    removeEncryptedUrl(sandboxId);
    destroyPool(sandboxId).catch(() => {});
    logAuditEvent({ type: 'database_deleted', details: { sandboxId, database: 'external' } });
    console.log(`[shield] External database config removed for: ${sandboxId}`);
    return;
  }

  const db = dbName(sandboxId);
  const owner = ownerRole(sandboxId);
  const app = appRole(sandboxId);
  const ro = readonlyRole(sandboxId);

  // Clean up any active temp roles first
  cleanupTempRolesForApp(sandboxId);

  try {
    // Terminate all connections to the database
    pgExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`);

    // Drop database
    pgExec(`DROP DATABASE IF EXISTS "${db}"`);

    // Drop roles (must drop database first since roles own it)
    pgExec(`DROP ROLE IF EXISTS "${ro}"`);
    pgExec(`DROP ROLE IF EXISTS "${app}"`);
    pgExec(`DROP ROLE IF EXISTS "${owner}"`);

    logAuditEvent({
      type: 'database_deleted',
      details: { sandboxId, database: db },
    });

    console.log(`[shield] Database deleted: ${db}`);
  } catch (err: any) {
    console.error(`[shield] Database deletion failed for ${db}:`, err.message);
  }
}

// ── SQL Classification ──

export type SqlCategory = 'read' | 'write' | 'migrate' | 'admin';

// SQL → gate category: read/write/migrate/admin(deny).
// Layer 1: pgsql-ast-parser AST; Layer 2: regex fallback. Unknown → admin (deny).
// Both layers block multi-statement queries and dangerous function calls.

import { parse as parsePgSql, astVisitor } from 'pgsql-ast-parser';

// Functions that can side-effect from within a SELECT.
const DANGEROUS_FUNCTION_NAMES = new Set([
  // dblink — remote/local query execution with full SQL
  'dblink', 'dblink_exec', 'dblink_connect', 'dblink_send_query',
  // lo_ — large object manipulation (can write files via lo_export)
  'lo_export', 'lo_import', 'lo_unlink', 'lo_create', 'lo_write',
  // pg_execute / pg_query_params — dynamic SQL execution
  'pg_execute', 'pg_query', 'pg_query_params',
  // pg_terminate/cancel_backend — DoS other connections
  'pg_terminate_backend', 'pg_cancel_backend',
  // pg_read/write_file — filesystem access
  'pg_read_file', 'pg_write_file',
  // pg_reload_conf — change server config at runtime
  'pg_reload_conf',
  // set_config — change session/server settings
  'set_config',
  // pg_sleep — DoS via long-running queries
  'pg_sleep',
  // Notify — can be used for data exfiltration channels
  'pg_notify',
]);

/** Regex fallback patterns for dangerous functions (used when AST parse fails) */
const DANGEROUS_FUNCTION_REGEX = [
  /\bdblink(?:_exec|_connect|_send_query)?\s*\(/i,
  /\blo_(?:export|import|unlink|create|write)\s*\(/i,
  /\bCOPY\b.*\bFROM\s+PROGRAM\b/i,
  /\bCOPY\b.*\bTO\s+PROGRAM\b/i,
  /\bpg_(?:execute|query_params?|query)\s*\(/i,
  /\bpg_(?:terminate|cancel)_backend\s*\(/i,
  /\bpg_(?:read|write)_file\s*\(/i,
  /\bpg_reload_conf\s*\(/i,
  /\bset_config\s*\(/i,
  /\bpg_sleep\s*\(/i,
  /\bpg_notify\s*\(/i,
];

// Unmapped types → admin (deny).
const AST_TYPE_MAP: Record<string, SqlCategory> = {
  'select': 'read',
  'values': 'read',
  'union': 'read',
  'union all': 'read',
  'insert': 'write',
  'update': 'write',
  'delete': 'write',
  'truncate table': 'write',
  'create table': 'migrate',
  'create index': 'migrate',
  'create sequence': 'migrate',
  'create view': 'migrate',
  'create materialized view': 'migrate',
  'create schema': 'migrate',
  'create extension': 'migrate',
  'create enum': 'migrate',
  'create composite type': 'migrate',
  'create function': 'migrate',
  'alter table': 'migrate',
  'alter sequence': 'migrate',
  'alter index': 'migrate',
  'drop table': 'migrate',
  'drop index': 'migrate',
  'drop sequence': 'migrate',
  'drop view': 'migrate',
  'drop schema': 'migrate',
  'drop extension': 'migrate',
  'drop function': 'migrate',
  'drop type': 'migrate',
  'comment': 'migrate',
  // SET, VACUUM, REINDEX, etc. not listed → fall through to 'admin'
};

function extractFunctionCalls(stmts: any[]): string[] {
  const names: string[] = [];
  try {
    const visitor = astVisitor((m) => ({
      call: (c: any) => {
        const name = c.function?.name;
        if (name) names.push(name.toLowerCase());
        m.super().call(c);
      },
    }));
    for (const stmt of stmts) {
      visitor.statement(stmt);
    }
  } catch {
    // AST visitor failure — treat as potentially dangerous
  }
  return names;
}

function classifyViaAst(sql: string): SqlCategory | null {
  let stmts: any[];
  try {
    stmts = parsePgSql(sql);
  } catch {
    return null; // Parser doesn't support this syntax → fallback to regex
  }

  // Multi-statement → deny
  if (stmts.length > 1) return 'admin';
  if (stmts.length === 0) return 'admin';

  const stmt = stmts[0]!;

  // Check for dangerous function calls anywhere in the AST
  const funcNames = extractFunctionCalls(stmts);
  for (const fn of funcNames) {
    if (DANGEROUS_FUNCTION_NAMES.has(fn)) return 'admin';
  }

  // WITH (CTE) — classify by the inner statement type
  if (stmt.type === 'with') {
    const innerType = (stmt as any).in?.type;
    if (!innerType) return 'admin';
    return AST_TYPE_MAP[innerType] ?? 'admin';
  }

  return AST_TYPE_MAP[stmt.type] ?? 'admin';
}

// Regex fallback; unknown → admin.
function classifyViaRegex(sql: string): SqlCategory {
  const normalized = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

  // Multi-statement check with proper string stripping
  const noStrings = normalized
    .replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  if (/;\s*\S/.test(noStrings)) return 'admin';

  // Dangerous function check
  for (const pattern of DANGEROUS_FUNCTION_REGEX) {
    if (pattern.test(normalized)) return 'admin';
  }

  const firstWord = normalized.split(/[\s(]+/)[0]?.toUpperCase();

  switch (firstWord) {
    case 'SELECT':
    case 'EXPLAIN':
    case 'SHOW':
    case 'TABLE':
    case 'VALUES':
      return 'read';
    case 'WITH':
      if (/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(normalized)) return 'write';
      return 'read';
    case 'INSERT':
    case 'UPDATE':
    case 'DELETE':
    case 'MERGE':
    case 'COPY':
    case 'TRUNCATE':
      return 'write';
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'GRANT':
    case 'REVOKE':
    case 'COMMENT':
      return 'migrate';
    default:
      return 'admin';
  }
}

export function classifySql(sql: string): SqlCategory {
  // Layer 1: AST-based classification (provably correct for supported syntax)
  const astResult = classifyViaAst(sql);
  if (astResult !== null) return astResult;

  // Layer 2: Regex fallback (conservative, for syntax the parser doesn't support)
  return classifyViaRegex(sql);
}

export function requiredGateForSql(category: SqlCategory): 'db_read' | 'db_write' | 'db_migrate' | null {
  switch (category) {
    case 'read': return 'db_read';
    case 'write': return 'db_write';
    case 'migrate': return 'db_migrate';
    case 'admin': return null; // admin queries are blocked entirely
  }
}

export function roleForCategory(sandboxId: string, category: SqlCategory): string {
  switch (category) {
    case 'read': return readonlyRole(sandboxId);
    case 'write': return appRole(sandboxId);
    case 'migrate': return ownerRole(sandboxId);
    case 'admin': throw new Error('Admin queries not permitted through query proxy');
  }
}

// ── Connection URL Resolution ──

// Encrypted storage first, fall back to config.connectionUrl (migration).
export function resolveConnectionUrl(sandboxId: string): string | null {
  // Try encrypted at-rest storage first
  const encrypted = loadEncryptedUrl(sandboxId);
  if (encrypted) return encrypted;

  // Fallback: plaintext in config (pre-encryption migration path)
  const config = loadDbConfig(sandboxId);
  if (config.type === 'external' && config.connectionUrl && config.connectionUrl !== 'encrypted') {
    // Auto-migrate: encrypt and remove plaintext
    saveEncryptedUrl(sandboxId, config.connectionUrl);
    config.connectionUrl = 'encrypted';
    saveDbConfig(sandboxId, config);
    console.log(`[shield] Auto-migrated plaintext connection URL to encrypted storage for ${sandboxId}`);
    return loadEncryptedUrl(sandboxId);
  }

  return null;
}

// ── Query Proxy ──

// Caller must verify gate first. Async for external (pg pool); local is sync (peer socket).
export async function executeQuery(
  sandboxId: string,
  sql: string,
  category: SqlCategory,
): Promise<{ rows: any[]; rowCount: number; command: string; category: SqlCategory }> {
  // Block dangerous statements regardless of provider
  validateQuerySafety(sql);

  const config = loadDbConfig(sandboxId);
  let result: { rows: any[]; rowCount: number; command: string };
  let dbLabel: string;
  let roleLabel: string;

  if (config.type === 'external') {
    const url = resolveConnectionUrl(sandboxId);
    if (!url) throw new Error('External database URL not configured');

    // Async: connection pool + circuit breaker
    result = await queryExternal(sandboxId, url, sql);
    dbLabel = 'external';
    roleLabel = 'external';
  } else {
    // Local: synchronous peer auth path
    const db = dbName(sandboxId);
    const role = roleForCategory(sandboxId, category);
    result = pgExecAsRole(sql, db, role);
    dbLabel = db;
    roleLabel = role;
  }

  logAuditEvent({
    type: 'database_query',
    details: {
      sandboxId,
      database: dbLabel,
      category,
      role: roleLabel,
      command: result.command,
      rowCount: result.rowCount,
    },
  });

  return { ...result, category };
}

export function validateQuerySafety(sql: string): void {
  const normalized = sql.toUpperCase();

  // Block superuser / system-level operations
  const blocked = [
    /\bCREATE\s+ROLE\b/,
    /\bALTER\s+ROLE\b/,
    /\bDROP\s+ROLE\b/,
    /\bCREATE\s+USER\b/,
    /\bALTER\s+USER\b/,
    /\bDROP\s+USER\b/,
    /\bCREATE\s+DATABASE\b/,
    /\bDROP\s+DATABASE\b/,
    /\bCREATE\s+EXTENSION\b/,
    /\bCOPY\s+.*\bFROM\s+PROGRAM\b/,
    /\bLOAD\b/,
    /\bSET\s+ROLE\b/,
    /\bRESET\s+ROLE\b/,
    /\bSET\s+SESSION\s+AUTHORIZATION\b/,
    // SECURITY: Block dangerous functions that bypass read/write classification.
    // These can perform writes, filesystem access, or DoS from within a SELECT.
    /\bDBLINK(?:_EXEC|_CONNECT|_SEND_QUERY)?\s*\(/,
    /\bLO_(?:EXPORT|IMPORT|UNLINK|CREATE|WRITE)\s*\(/,
    /\bPG_(?:READ|WRITE)_FILE\s*\(/,
    /\bPG_RELOAD_CONF\s*\(/,
    /\bPG_(?:TERMINATE|CANCEL)_BACKEND\s*\(/,
  ];

  for (const pattern of blocked) {
    if (pattern.test(normalized)) {
      throw new Error(`Blocked: ${normalized.slice(0, 40)}... — operation not permitted through query proxy`);
    }
  }
}

// ── Temporary Migrate Roles ──

// DDL role for db_migrate gate; auto-cleaned on revoke/expire.
export function createTempMigrateRole(sandboxId: string, ttlMs: number): TempMigrateRole {
  const db = dbName(sandboxId);
  const owner = ownerRole(sandboxId);
  const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const tempRole = `shield_${sanitizeSandboxIdForPg(sandboxId)}_temp_${uuid}`;
  // Generate password as Buffer and zero raw bytes after string extraction.
  // Buffer.fill(0) is a native C++ binding — not optimized away by V8's JIT.
  const passwordBuf = crypto.randomBytes(32);
  const password = passwordBuf.toString('base64url');
  passwordBuf.fill(0);

  // SECURITY: Create the temp role via stdin to pgExecMulti (which pipes through
  // execSync input). This prevents the password from appearing in /proc/[pid]/cmdline
  // where it would be visible to processes that can read /proc (even with hidepid=2,
  // the shield service itself and root can see child cmdlines).
  const sql = `
CREATE ROLE "${tempRole}" LOGIN PASSWORD '${password.replace(/'/g, "''")}';
GRANT "${owner}" TO "${tempRole}";
GRANT CONNECT ON DATABASE "${db}" TO "${tempRole}";
`;
  pgExecMulti(sql);

  // Grant schema access in the target database
  pgExecMulti(`
GRANT USAGE, CREATE ON SCHEMA public TO "${tempRole}";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${tempRole}";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${tempRole}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${tempRole}" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appRole(sandboxId)}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${tempRole}" IN SCHEMA public
  GRANT SELECT ON TABLES TO "${readonlyRole(sandboxId)}";
`, db);

  const entry: TempMigrateRole = {
    roleName: tempRole,
    password,
    database: db,
    sandboxId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };

  activeTempRoles.set(tempRole, entry);

  logAuditEvent({
    type: 'database_temp_role_created',
    details: { sandboxId, tempRole, database: db, ttlMs },
  });

  console.log(`[shield] Temp migrate role created: ${tempRole} for ${db} (TTL: ${ttlMs / 1000}s)`);

  return entry;
}

export function destroyTempMigrateRole(roleName: string): void {
  const entry = activeTempRoles.get(roleName);
  if (!entry) return;

  // Sever reference to password before Map deletion so GC can collect
  // the credential string without the Map keeping it reachable.
  entry.password = '';
  activeTempRoles.delete(roleName);

  try {
    // Step 0: IMMEDIATELY block new connections — no race window.
    // ALTER ROLE NOLOGIN is atomic in PostgreSQL. After this executes,
    // the role CANNOT authenticate new connections, closing the
    // reconnection race (agent can't reconnect between terminate and DROP).
    pgExec(`ALTER ROLE "${roleName}" NOLOGIN`);

    // Step 1: Kill existing connections (agent cannot reconnect — NOLOGIN)
    pgExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${roleName}'`);

    // Revoke all and drop
    pgExec(`REVOKE ALL PRIVILEGES ON DATABASE "${entry.database}" FROM "${roleName}"`);

    // Reassign owned objects to the owner role before dropping
    const owner = ownerRole(entry.sandboxId);
    pgExecMulti(`REASSIGN OWNED BY "${roleName}" TO "${owner}"; DROP OWNED BY "${roleName}";`, entry.database);
    pgExec(`DROP ROLE IF EXISTS "${roleName}"`);

    logAuditEvent({
      type: 'database_temp_role_destroyed',
      details: { sandboxId: entry.sandboxId, tempRole: roleName, database: entry.database },
    });

    console.log(`[shield] Temp migrate role destroyed: ${roleName}`);
  } catch (err: any) {
    console.error(`[shield] Failed to destroy temp role ${roleName}:`, err.message);
  }
}

function cleanupTempRolesForApp(sandboxId: string): void {
  for (const [roleName, entry] of activeTempRoles) {
    if (entry.sandboxId === sandboxId) {
      destroyTempMigrateRole(roleName);
    }
  }
}

// Startup sweep: drop shield_*_temp_* roles from prior crashes.
export function cleanupOrphanedTempRoles(): void {
  try {
    if (!isPostgresAvailable()) return;

    const result = pgExec(`SELECT rolname FROM pg_roles WHERE rolname ~ '^shield_.*_temp_'`);
    if (!result.trim()) return;

    const orphanedRoles = result.split('\n').filter(r => r.trim());
    for (const roleName of orphanedRoles) {
      const name = roleName.trim();
      // Skip if it's tracked in-memory (shouldn't happen on startup, but safe)
      if (activeTempRoles.has(name)) continue;

      try {
        // Same safe teardown as destroyTempMigrateRole: NOLOGIN → terminate → drop
        pgExec(`ALTER ROLE "${name}" NOLOGIN`);
        pgExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${name}'`);
        pgExec(`DROP ROLE IF EXISTS "${name}"`);
        console.log(`[shield] Cleaned up orphaned temp role: ${name}`);
      } catch (err: any) {
        console.warn(`[shield] Failed to clean orphaned role ${name}: ${err.message}`);
      }
    }

    if (orphanedRoles.length > 0) {
      console.log(`[shield] Cleaned up ${orphanedRoles.length} orphaned temp role(s)`);
    }
  } catch (err: any) {
    // PostgreSQL might not be ready yet — non-fatal
    console.warn(`[shield] Orphaned temp role cleanup skipped: ${err.message}`);
  }
}

export function cleanupExpiredTempRoles(): void {
  const now = Date.now();
  for (const [roleName, entry] of activeTempRoles) {
    if (now > entry.expiresAt) {
      console.log(`[shield] Temp role ${roleName} expired, cleaning up`);
      destroyTempMigrateRole(roleName);
    }
  }
}

export function getActiveTempRole(sandboxId: string): TempMigrateRole | undefined {
  for (const entry of activeTempRoles.values()) {
    if (entry.sandboxId === sandboxId && Date.now() < entry.expiresAt) {
      return entry;
    }
  }
  return undefined;
}

// ── Backup ──

export function backupAppDatabase(sandboxId: string, backupDir?: string): string {
  const config = loadDbConfig(sandboxId);
  const isExternal = config.type === 'external';
  const label = isExternal ? `ext_${sanitizeSandboxIdForPg(sandboxId)}` : dbName(sandboxId);
  const dir = backupDir || '/var/backups/ellul/postgres';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = `${dir}/${label}_${timestamp}.sql.gz`;

  try {
    execFileSync('mkdir', ['-p', dir], { stdio: 'pipe' });
    execFileSync('chown', ['root:shield', dir], { stdio: 'pipe' });
    execFileSync('chmod', ['2770', dir], { stdio: 'pipe' });

    if (isExternal) {
      // External: pg_dump via connection URL (password via PGPASSWORD env var)
      const url = resolveConnectionUrl(sandboxId);
      if (!url) throw new Error('External database URL not configured');
      execExternalPgCommand(
        `/usr/bin/pg_dump $PGURL | gzip > ${JSON.stringify(dumpFile)}`,
        url,
        { timeout: 300_000 },
      );
    } else {
      // Local: pg_dump via shield-pg-wrapper → gzip to file
      const db = dbName(sandboxId);
      execSync(
        `sudo -u postgres /usr/local/bin/shield-pg-wrapper /usr/bin/pg_dump "${db}" | gzip > ${JSON.stringify(dumpFile)}`,
        { timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    }

    // Secure the backup file
    execFileSync('chown', ['root:shield', dumpFile], { stdio: 'pipe' });
    execFileSync('chmod', ['640', dumpFile], { stdio: 'pipe' });

    logAuditEvent({
      type: 'database_backup',
      details: { sandboxId, database: label, dumpFile },
    });

    console.log(`[shield] Database backed up: ${dumpFile}`);
    return dumpFile;
  } catch (err: any) {
    console.error(`[shield] Database backup failed for ${label}:`, err.message);
    throw new Error(`Backup failed: ${err.message}`);
  }
}

// Takes pre-restore backup for safety.
export function restoreAppDatabase(sandboxId: string, dumpFile: string): void {
  const config = loadDbConfig(sandboxId);
  const isExternal = config.type === 'external';

  // Safety: backup current state first
  try {
    backupAppDatabase(sandboxId, '/var/backups/ellul/postgres/pre-restore');
  } catch (err: any) {
    console.warn(`[shield] Pre-restore backup failed (continuing): ${err.message}`);
  }

  if (isExternal) {
    // External: restore via connection URL (password via PGPASSWORD env var)
    const url = resolveConnectionUrl(sandboxId);
    if (!url) throw new Error('External database URL not configured');
    if (dumpFile.endsWith('.gz')) {
      execExternalPgCommand(
        `gunzip -c ${JSON.stringify(dumpFile)} | /usr/bin/psql $PGURL`,
        url,
        { timeout: 600_000 },
      );
    } else {
      execExternalPgCommand(
        `/usr/bin/psql $PGURL < ${JSON.stringify(dumpFile)}`,
        url,
        { timeout: 600_000 },
      );
    }
  } else {
    const db = dbName(sandboxId);

    // Terminate connections
    pgExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`);

    if (dumpFile.endsWith('.gz')) {
      execSync(
        `gunzip -c ${JSON.stringify(dumpFile)} | sudo -u postgres /usr/local/bin/shield-pg-wrapper /usr/bin/psql "${db}"`,
        { timeout: 600_000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } else {
      execSync(
        `sudo -u postgres /usr/local/bin/shield-pg-wrapper /usr/bin/psql "${db}" < ${JSON.stringify(dumpFile)}`,
        { timeout: 600_000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    }
  }

  const dbLabel = isExternal ? 'external' : dbName(sandboxId);
  logAuditEvent({
    type: 'database_restore',
    details: { sandboxId, database: dbLabel, dumpFile },
  });

  console.log(`[shield] Database restored: ${dbLabel} from ${dumpFile}`);
}

export function listAppBackups(sandboxId: string): string[] {
  const config = loadDbConfig(sandboxId);
  const label = config.type === 'external' ? `ext_${sanitizeSandboxIdForPg(sandboxId)}` : dbName(sandboxId);
  const dir = '/var/backups/ellul/postgres';

  try {
    const output = execFileSync('bash', ['-c', 'ls -1t "$1"/"$2"_*.sql.gz 2>/dev/null || true', '_', dir, label], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    return output ? output.split('\n') : [];
  } catch {
    return [];
  }
}

export function listAppBackupsDetailed(sandboxId: string): Array<{ file: string; sizeBytes: number }> {
  const files = listAppBackups(sandboxId);
  return files.map(f => {
    try {
      const stat = statSync(f);
      return { file: f.split('/').pop() ?? f, sizeBytes: stat.size };
    } catch {
      return { file: f.split('/').pop() ?? f, sizeBytes: 0 };
    }
  });
}

// ── Multi-Database Support ──

const DB_CONFIG_DIR = '/etc/ellul/shield-data/db-config';

export interface AppDbConfig {
  // local = managed on VPS; external = user-provided URL.
  type: 'local' | 'external';
  // Only set when type === 'external'.
  connectionUrl?: string;
  databases: Array<{ label: string; dbName: string; createdAt: number }>;
  previewDb: string | null;
  deployedDb: string | null;
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 32);
}

function validateLabel(label: string): void {
  if (!/^[a-z0-9_]+$/i.test(label) || label.length === 0 || label.length > 32) {
    throw new Error('Invalid label: must be alphanumeric + underscores only, 1-32 characters');
  }
}

function dbConfigPath(sandboxId: string): string {
  return `${DB_CONFIG_DIR}/${sanitizeSandboxIdForPg(sandboxId)}.json`;
}

// Auto-creates config if legacy DB exists without config file.
export function loadDbConfig(sandboxId: string): AppDbConfig {
  const configFile = dbConfigPath(sandboxId);

  if (existsSync(configFile)) {
    const raw = readFileSync(configFile, 'utf-8');
    const config = JSON.parse(raw) as AppDbConfig;
    if (!config.type) config.type = 'local'; // backward compat
    return config;
  }

  // Check if legacy database exists
  const legacyDb = dbName(sandboxId);
  try {
    const exists = pgExec(`SELECT 1 FROM pg_database WHERE datname = '${legacyDb}'`);
    if (exists) {
      // Auto-create config for legacy database
      const config: AppDbConfig = {
        type: 'local',
        databases: [{ label: 'default', dbName: legacyDb, createdAt: Date.now() }],
        previewDb: 'default',
        deployedDb: 'default',
      };
      saveDbConfig(sandboxId, config);
      return config;
    }
  } catch {
    // postgres not available or query failed
  }

  // No legacy database either — return empty config
  return { type: 'local', databases: [], previewDb: null, deployedDb: null };
}

export function saveDbConfig(sandboxId: string, config: AppDbConfig): void {
  if (!existsSync(DB_CONFIG_DIR)) {
    mkdirSync(DB_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(dbConfigPath(sandboxId), JSON.stringify(config, null, 2), 'utf-8');
}

// Reuses app's existing roles (creates if needed).
export function createNamedDatabase(sandboxId: string, label: string): { databaseUrl: string; dbName: string } {
  validateLabel(label);

  const config = loadDbConfig(sandboxId);

  // Named databases are a local-only concept — external DBs have a single URL
  if (config.type === 'external') {
    throw new Error('Cannot create named databases for external database providers. Use your provider\'s dashboard to manage databases.');
  }

  // Check for duplicate label
  if (config.databases.some(d => d.label === label)) {
    throw new Error(`Database with label "${label}" already exists for app "${sandboxId}"`);
  }

  const sanitized = sanitizeSandboxIdForPg(sandboxId);
  const sanitizedLbl = sanitizeLabel(label);
  const newDbName = `shield_${sanitized}_${sanitizedLbl}`;
  const owner = ownerRole(sandboxId);
  const app = appRole(sandboxId);
  const ro = readonlyRole(sandboxId);

  // Generate a secure password for the app role
  const appPassword = crypto.randomBytes(32).toString('base64url');

  // Create roles if they don't exist (idempotent — same logic as createAppDatabase)
  const rolesSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${owner}') THEN
    CREATE ROLE "${owner}" LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${app}') THEN
    CREATE ROLE "${app}" LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ro}') THEN
    CREATE ROLE "${ro}" LOGIN PASSWORD '${crypto.randomBytes(32).toString('base64url').replace(/'/g, "''")}';
  END IF;
END $$;
`;
  pgExecMulti(rolesSql);

  // Update app role password
  pgExec(`ALTER ROLE "${app}" PASSWORD '${appPassword.replace(/'/g, "''")}'`);

  // Check if database already exists
  const existsResult = pgExec(`SELECT 1 FROM pg_database WHERE datname = '${newDbName}'`);
  if (!existsResult) {
    pgExec(`CREATE DATABASE "${newDbName}" OWNER "${owner}"`);
  }

  // Set up schema permissions (same as createAppDatabase)
  const schemaSql = `
GRANT ALL PRIVILEGES ON DATABASE "${newDbName}" TO "${owner}";
GRANT CONNECT ON DATABASE "${newDbName}" TO "${app}";
GRANT CONNECT ON DATABASE "${newDbName}" TO "${ro}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${app}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "${app}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT SELECT ON TABLES TO "${ro}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "${ro}";
GRANT USAGE ON SCHEMA public TO "${app}";
GRANT USAGE ON SCHEMA public TO "${ro}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${app}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${app}";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${ro}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${ro}";
REVOKE CREATE ON SCHEMA public FROM "${app}";
REVOKE CREATE ON SCHEMA public FROM "${ro}";
REVOKE pg_execute_server_program FROM "${app}";
REVOKE pg_execute_server_program FROM "${ro}";
REVOKE pg_read_server_files FROM "${app}";
REVOKE pg_read_server_files FROM "${ro}";
REVOKE pg_write_server_files FROM "${app}";
REVOKE pg_write_server_files FROM "${ro}";
`;
  pgExecMulti(schemaSql, newDbName);

  // Update config
  config.databases.push({ label, dbName: newDbName, createdAt: Date.now() });
  saveDbConfig(sandboxId, config);

  const databaseUrl = `postgresql://${app}:${appPassword}@127.0.0.1:5432/${newDbName}`;

  logAuditEvent({
    type: 'named_database_created',
    details: { sandboxId, label, database: newDbName },
  });

  console.log(`[shield] Named database created: ${newDbName} (label: ${label})`);

  return { databaseUrl, dbName: newDbName };
}

// Does NOT drop shared roles.
export function deleteNamedDatabase(sandboxId: string, label: string): void {
  const config = loadDbConfig(sandboxId);

  if (config.type === 'external') {
    throw new Error('Cannot delete named databases for external database providers. Use your provider\'s dashboard to manage databases.');
  }

  const entry = config.databases.find(d => d.label === label);
  if (!entry) {
    throw new Error(`No database with label "${label}" found for app "${sandboxId}"`);
  }

  const targetDb = entry.dbName;

  // Terminate connections and drop the database
  try {
    pgExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${targetDb}' AND pid <> pg_backend_pid()`);
    pgExec(`DROP DATABASE IF EXISTS "${targetDb}"`);
  } catch (err: any) {
    console.error(`[shield] Failed to drop named database ${targetDb}:`, err.message);
    throw err;
  }

  // Update config: remove from databases array
  config.databases = config.databases.filter(d => d.label !== label);

  // Clear assignments if they pointed to this label
  if (config.previewDb === label) config.previewDb = null;
  if (config.deployedDb === label) config.deployedDb = null;

  saveDbConfig(sandboxId, config);

  logAuditEvent({
    type: 'named_database_deleted',
    details: { sandboxId, label, database: targetDb },
  });

  console.log(`[shield] Named database deleted: ${targetDb} (label: ${label})`);
}

export function listAppDatabases(sandboxId: string): Array<{
  label: string;
  dbName: string;
  sizeBytes: number;
  createdAt: number;
  isPreview: boolean;
  isDeployed: boolean;
}> {
  const config = loadDbConfig(sandboxId);

  return config.databases.map(entry => {
    let sizeBytes = 0;
    if (config.type !== 'external') {
      try {
        const sizeResult = pgExec(`SELECT pg_database_size('${entry.dbName}')`);
        sizeBytes = parseInt(sizeResult, 10) || 0;
      } catch {
        // Database may not exist anymore
      }
    }

    return {
      label: entry.label,
      dbName: entry.dbName,
      sizeBytes,
      createdAt: entry.createdAt,
      isPreview: config.previewDb === entry.label,
      isDeployed: config.deployedDb === entry.label,
    };
  });
}

export function setPreviewDb(sandboxId: string, label: string | null): void {
  const config = loadDbConfig(sandboxId);

  if (label !== null) {
    const entry = config.databases.find(d => d.label === label);
    if (!entry) {
      throw new Error(`No database with label "${label}" found for app "${sandboxId}"`);
    }
  }

  config.previewDb = label;
  saveDbConfig(sandboxId, config);

  // Update PREVIEW_DATABASE_URL in app secrets
  try {
    const secrets = readEnvFile(toSandboxId(sandboxId));
    if (label !== null) {
      let url: string;
      if (config.type === 'external') {
        const resolved = resolveConnectionUrl(sandboxId);
        if (!resolved) throw new Error('External database URL not configured');
        url = resolved;
      } else {
        const entry = config.databases.find(d => d.label === label)!;
        const app = appRole(sandboxId);
        const appPassword = crypto.randomBytes(32).toString('base64url');
        pgExec(`ALTER ROLE "${app}" PASSWORD '${appPassword.replace(/'/g, "''")}'`);
        url = `postgresql://${app}:${appPassword}@127.0.0.1:5432/${entry.dbName}`;
      }

      if (config.deployedDb !== null) {
        secrets.set('PREVIEW_DATABASE_URL', url);
      } else {
        // No deployed db — use DATABASE_URL
        secrets.set('DATABASE_URL', url);
      }
    } else {
      secrets.delete('PREVIEW_DATABASE_URL');
    }
    writeEnvFile(secrets, toSandboxId(sandboxId));
  } catch (envErr) {
    logAuditEvent({
      type: 'database_env_inject_failed',
      details: { sandboxId, error: (envErr as Error).message },
    });
  }

  logAuditEvent({
    type: 'preview_db_assigned',
    details: { sandboxId, label },
  });
}

export function setDeployedDb(sandboxId: string, label: string | null): void {
  const config = loadDbConfig(sandboxId);

  if (label !== null) {
    const entry = config.databases.find(d => d.label === label);
    if (!entry) {
      throw new Error(`No database with label "${label}" found for app "${sandboxId}"`);
    }
  }

  config.deployedDb = label;
  saveDbConfig(sandboxId, config);

  // Update DATABASE_URL in app secrets
  try {
    const secrets = readEnvFile(toSandboxId(sandboxId));
    if (label !== null) {
      let url: string;
      if (config.type === 'external') {
        const resolved = resolveConnectionUrl(sandboxId);
        if (!resolved) throw new Error('External database URL not configured');
        url = resolved;
      } else {
        const entry = config.databases.find(d => d.label === label)!;
        const app = appRole(sandboxId);
        const appPassword = crypto.randomBytes(32).toString('base64url');
        pgExec(`ALTER ROLE "${app}" PASSWORD '${appPassword.replace(/'/g, "''")}'`);
        url = `postgresql://${app}:${appPassword}@127.0.0.1:5432/${entry.dbName}`;
      }
      secrets.set('DATABASE_URL', url);
    } else {
      secrets.delete('DATABASE_URL');
    }
    writeEnvFile(secrets, toSandboxId(sandboxId));
  } catch (envErr) {
    logAuditEvent({
      type: 'database_env_inject_failed',
      details: { sandboxId, error: (envErr as Error).message },
    });
  }

  logAuditEvent({
    type: 'deployed_db_assigned',
    details: { sandboxId, label },
  });
}

// Validates the database belongs to the app.
export async function executeQueryOnDb(
  sandboxId: string,
  dbNameStr: string,
  sql: string,
  category: SqlCategory,
): Promise<{ rows: any[]; rowCount: number; command: string; category: SqlCategory }> {
  const config = loadDbConfig(sandboxId);

  // External DBs have a single URL — delegate to executeQuery
  if (config.type === 'external') {
    return await executeQuery(sandboxId, sql, category);
  }

  // Validate the database name starts with shield_ and belongs to this app
  const sanitized = sanitizeSandboxIdForPg(sandboxId);
  if (!dbNameStr.startsWith('shield_')) {
    throw new Error('Invalid database name: must start with shield_');
  }
  if (!dbNameStr.startsWith(`shield_${sanitized}`)) {
    throw new Error('Database does not belong to this app');
  }

  const role = roleForCategory(sandboxId, category);

  // Block dangerous statements regardless of role
  validateQuerySafety(sql);

  const result = pgExecAsRole(sql, dbNameStr, role);

  logAuditEvent({
    type: 'database_query',
    details: {
      sandboxId,
      database: dbNameStr,
      category,
      role,
      command: result.command,
      rowCount: result.rowCount,
    },
  });

  return { ...result, category };
}
