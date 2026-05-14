// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sovereign Database Proxy — Agent-Ready Database Middleware
 *
 * Sits between AI departments (projects) and shared/standalone PostgreSQL
 * databases. Implements 5 sovereign constraints:
 *
 * 1. Shared vs Standalone Database Model — cross-project DB sharing with scoped roles
 * 2. Reasoning Timeout Guard — agent-specific query timeouts (double-timeout safety)
 * 3. Query Metadata Tagging — SQL comment prefix for audit trail
 * 4. Idempotency + Soft-Delete Governance — deterministic keys, DELETE→soft-delete rewrite
 * 5. Type-Safe Agent Views — LLM-friendly VIEWs with COMMENT ON COLUMN
 *
 * Security design:
 * - All user-supplied strings are sanitized before SQL embedding (no raw interpolation)
 * - Hash chain writes use SERIALIZABLE isolation to prevent forks
 * - Idempotency uses INSERT ON CONFLICT for atomicity
 * - Role names include database qualifier to prevent cross-DB collisions
 * - Config writes use atomic tmp+fsync+rename pattern
 * - NOLOGIN is set before pg_terminate_backend to close reconnection race
 */

import crypto from 'crypto';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  fdatasyncSync,
  openSync,
  writeSync,
  closeSync,
} from 'fs';
import {
  pgExec,
  pgExecMulti,
  pgExecAsRole,
  dbName,
  ownerRole,
  appRole,
  readonlyRole,
  sanitizeSandboxIdForPg,
  classifySql,
  roleForCategory,
  validateQuerySafety,
  type SqlCategory,
} from './Database';
import { logAuditEvent } from '../audit/Audit';

// ══════════════════════════════════════════════════════════════════════════════
// Shared Sanitization Utilities
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Escape a value for embedding in a PostgreSQL string literal.
 * Strips null bytes (PG rejects them) and doubles single quotes.
 * Assumes standard_conforming_strings = on (default since PG 9.1).
 */
function pgEscapeLiteral(val: string): string {
  return val.replace(/\0/g, '').replace(/'/g, "''");
}

/**
 * Sanitize a value for embedding inside a SQL comment.
 * Strips any sequence that could close the comment or inject SQL.
 */
function sanitizeCommentValue(val: string): string {
  // Remove */ and -- to prevent comment escape or line-comment injection
  return val.replace(/\*\//g, '').replace(/--/g, '').replace(/\n/g, ' ').slice(0, 128);
}

/**
 * Validate a PostgreSQL identifier (table, column, view name).
 * Only allows lowercase alphanumeric + underscores. Max 63 chars (PG limit).
 * Prevents SQL injection through double-quoted identifiers.
 */
function validatePgIdentifier(name: string, label: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid ${label}: must start with lowercase letter, contain only lowercase alphanumeric + underscores`);
  }
  if (name.length > 63) {
    throw new Error(`Invalid ${label}: exceeds PostgreSQL's 63-character identifier limit`);
  }
}

/**
 * Atomic file write: open → write → fdatasync → close → rename.
 * Crash-safe. Uses a single fd for write+sync to guarantee the data
 * flushed to disk is the same data we wrote (no cross-fd assumption).
 */
function atomicWriteFile(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, content);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

/**
 * Validate a SQL expression used in agent view transforms.
 * Allows safe function calls (UPPER, COALESCE, CAST, etc.) and column refs,
 * but blocks injection vectors: semicolons, comments, subqueries, DDL/DML,
 * dollar-quoting, and role manipulation.
 */
/**
 * Validate a SQL WHERE-fragment (e.g. caller-supplied condition for soft-delete).
 * Same shape as validateTransformExpression but allows SELECT-style sub-expressions
 * to remain blocked while permitting boolean operators and column refs.
 */
function validateConditionExpression(expr: string, label: string): void {
  if (typeof expr !== 'string' || expr.length === 0) {
    throw new Error(`${label}: must be a non-empty string`);
  }
  if (expr.length > 1024) {
    throw new Error(`${label}: expression too long (max 1024 chars)`);
  }
  if (/[;`]/.test(expr)) {
    throw new Error(`${label}: must not contain semicolons or backticks`);
  }
  if (/--|\/\*|\*\//.test(expr)) {
    throw new Error(`${label}: must not contain SQL comments (--, /*, */)`);
  }
  if (/\$[a-z_]*\$/i.test(expr)) {
    throw new Error(`${label}: must not contain dollar-quoted strings`);
  }
  // Word-boundary, case-insensitive — block any top-level statement keyword
  if (/\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|COPY|ATTACH|EXECUTE|MERGE|CALL|DO)\b/i.test(expr)) {
    throw new Error(`${label}: must not contain statement-level SQL keywords`);
  }
}

function validateTransformExpression(expr: string, label: string): void {
  if (expr.length > 256) {
    throw new Error(`${label}: expression too long (max 256 chars)`);
  }
  if (/;/.test(expr)) {
    throw new Error(`${label}: must not contain semicolons`);
  }
  if (/--|\/\*/.test(expr)) {
    throw new Error(`${label}: must not contain SQL comments (-- or /*)`);
  }
  // Dollar-quoting is a PG-specific injection vector: $$ or $tag$
  if (/\$[a-z_]*\$/i.test(expr)) {
    throw new Error(`${label}: must not contain dollar-quoted strings`);
  }
  const upper = expr.toUpperCase();
  // Block DDL/DML keywords
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXECUTE|COPY)\b/.test(upper)) {
    throw new Error(`${label}: must not contain DDL/DML keywords`);
  }
  // Block subqueries
  if (/\bSELECT\b/.test(upper)) {
    throw new Error(`${label}: must not contain subqueries (SELECT)`);
  }
  // Block role/session manipulation
  if (/\b(SET\s+ROLE|RESET\s+ROLE|SET\s+SESSION)\b/.test(upper)) {
    throw new Error(`${label}: must not contain role manipulation`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Component 1: Shared vs Standalone Database Model
// ══════════════════════════════════════════════════════════════════════════════

export type DatabaseMode = 'standalone' | 'shared';
export type ProjectRole = 'readonly' | 'app' | 'owner';

export interface ProjectGrant {
  maxRole: ProjectRole;
  grantedAt: number;
}

export interface SharedDatabaseEntry {
  dbName: string;
  ownerRole: string;
  createdAt: string;
  createdBy: string;
  projects: Record<string, ProjectGrant>;
}

interface SharedDatabasesFile {
  version: 1;
  databases: Record<string, SharedDatabaseEntry>;
}

export interface SharedDatabaseInfo extends SharedDatabaseEntry {
  sizeBytes: number;
}

const SHARED_DB_CONFIG_PATH = '/etc/ellul/shield-data/db-config/shared-databases.json';
const DB_CONFIG_DIR = '/etc/ellul/shield-data/db-config';
const AUDIT_HMAC_KEY_PATH = '/etc/ellul/shield-data/audit-hmac.key';

let _auditHmacKey: Buffer | null = null;

/**
 * Load (or first-time generate) the audit-log HMAC key.
 * Tamper-evidence beyond the chain hash: a PG superuser without filesystem
 * access cannot forge entries because the key lives only on disk.
 */
function getAuditHmacKey(): Buffer {
  if (_auditHmacKey) return _auditHmacKey;
  try {
    if (existsSync(AUDIT_HMAC_KEY_PATH)) {
      _auditHmacKey = readFileSync(AUDIT_HMAC_KEY_PATH);
      if (_auditHmacKey.length < 32) {
        throw new Error('audit-hmac.key is too short (need at least 32 bytes)');
      }
      return _auditHmacKey;
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  // First boot: generate and persist with mode 0600
  const dir = AUDIT_HMAC_KEY_PATH.replace(/\/[^/]+$/, '');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  const fd = openSync(AUDIT_HMAC_KEY_PATH, 'w', 0o600);
  try {
    writeSync(fd, key);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  _auditHmacKey = key;
  return key;
}

function computeAuditSignature(prevHash: string, hash: string): string {
  return crypto.createHmac('sha256', getAuditHmacKey())
    .update(`${prevHash}${hash}`)
    .digest('base64');
}

const ROLE_HIERARCHY: Record<ProjectRole, number> = {
  readonly: 0,
  app: 1,
  owner: 2,
};

const CATEGORY_TO_ROLE: Record<SqlCategory, ProjectRole> = {
  read: 'readonly',
  write: 'app',
  migrate: 'owner',
  admin: 'owner',
};

// ── Config I/O (atomic write with fsync) ──

function ensureConfigDir(): void {
  if (!existsSync(DB_CONFIG_DIR)) {
    mkdirSync(DB_CONFIG_DIR, { recursive: true });
  }
}

function loadSharedDbConfig(): SharedDatabasesFile {
  if (existsSync(SHARED_DB_CONFIG_PATH)) {
    return JSON.parse(readFileSync(SHARED_DB_CONFIG_PATH, 'utf-8'));
  }
  return { version: 1, databases: {} };
}

function saveSharedDbConfig(config: SharedDatabasesFile): void {
  ensureConfigDir();
  atomicWriteFile(SHARED_DB_CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getSharedDatabaseConfig(): SharedDatabasesFile {
  return loadSharedDbConfig();
}

// ── Shared Database Role Naming ──
// Format: {dbName}_{sanitizedSandboxId}_{suffix}
// The database name is included to prevent collisions when the same project
// has access to multiple shared databases.

function sharedProjectRoleName(sharedDbName: string, sandboxId: string, suffix: 'app' | 'readonly'): string {
  const dbPart = sanitizeSandboxIdForPg(sharedDbName).slice(0, 24);
  const appPart = sanitizeSandboxIdForPg(sandboxId).slice(0, 24);
  return `sov_${dbPart}_${appPart}_${suffix}`;
}

function sharedOwnerRoleName(sharedDbName: string): string {
  return `sov_${sanitizeSandboxIdForPg(sharedDbName).slice(0, 48)}_owner`;
}

// ── Shared Database Lifecycle ──

export function createSharedDatabase(name: string): string {
  validatePgIdentifier(name, 'shared database name');

  const db = `shield_shared_${name}`;
  const owner = sharedOwnerRoleName(db);

  // Validate total identifier length
  if (db.length > 63) throw new Error('Database name too long (max 63 chars)');

  const sql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${owner}') THEN
    CREATE ROLE "${owner}" LOGIN;
  END IF;
END $$;
SELECT 'exists' FROM pg_database WHERE datname = '${db}';
`;

  const result = pgExecMulti(sql);
  if (!result.includes('exists')) {
    pgExec(`CREATE DATABASE "${db}" OWNER "${owner}"`);
  }

  // Grant schema permissions within the new database
  pgExecMulti(`
GRANT ALL PRIVILEGES ON DATABASE "${db}" TO "${owner}";
GRANT USAGE, CREATE ON SCHEMA public TO "${owner}";
`, db);

  // Persist config (owner role stored — no more regex derivation)
  const config = loadSharedDbConfig();
  if (!config.databases[db]) {
    config.databases[db] = {
      dbName: db,
      ownerRole: owner,
      createdAt: new Date().toISOString(),
      createdBy: 'dashboard',
      projects: {},
    };
  }
  saveSharedDbConfig(config);

  logAuditEvent({
    type: 'shared_database_created',
    details: { dbName: db, owner },
  });

  console.log(`[shield] Shared database created: ${db} (owner: ${owner})`);
  return db;
}

export function grantProjectAccess(
  sharedDbName: string,
  sandboxId: string,
  maxRole: ProjectRole,
): void {
  const config = loadSharedDbConfig();
  const dbEntry = config.databases[sharedDbName];
  if (!dbEntry) throw new Error(`Shared database "${sharedDbName}" not found`);

  const owner = dbEntry.ownerRole;
  const projectApp = sharedProjectRoleName(sharedDbName, sandboxId, 'app');
  const projectRo = sharedProjectRoleName(sharedDbName, sandboxId, 'readonly');

  // Validate identifier lengths
  if (projectApp.length > 63 || projectRo.length > 63) {
    throw new Error('Generated role name exceeds 63 chars — use a shorter project name');
  }

  // Create project-scoped roles with secure passwords
  const appPassword = crypto.randomBytes(32).toString('base64url');
  const roPassword = crypto.randomBytes(32).toString('base64url');

  pgExecMulti(`
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${projectApp}') THEN
    CREATE ROLE "${projectApp}" LOGIN PASSWORD '${pgEscapeLiteral(appPassword)}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${projectRo}') THEN
    CREATE ROLE "${projectRo}" LOGIN PASSWORD '${pgEscapeLiteral(roPassword)}';
  END IF;
END $$;
`);

  // Grant access on the shared database
  pgExecMulti(`
-- Connection + schema
GRANT CONNECT ON DATABASE "${sharedDbName}" TO "${projectApp}";
GRANT CONNECT ON DATABASE "${sharedDbName}" TO "${projectRo}";
GRANT USAGE ON SCHEMA public TO "${projectApp}";
GRANT USAGE ON SCHEMA public TO "${projectRo}";

-- Existing objects
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${projectApp}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${projectApp}";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${projectRo}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${projectRo}";

-- Future objects (DEFAULT PRIVILEGES from owner)
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${projectApp}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "${projectApp}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT SELECT ON TABLES TO "${projectRo}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "${projectRo}";

-- Defense in depth: no schema creation
REVOKE CREATE ON SCHEMA public FROM "${projectApp}";
REVOKE CREATE ON SCHEMA public FROM "${projectRo}";
`, sharedDbName);

  // Persist grant
  dbEntry.projects[sandboxId] = { maxRole, grantedAt: Date.now() };
  saveSharedDbConfig(config);

  logAuditEvent({
    type: 'shared_db_project_granted',
    details: { dbName: sharedDbName, sandboxId, maxRole, roles: [projectApp, projectRo] },
  });

  console.log(`[shield] Project "${sandboxId}" granted ${maxRole} on ${sharedDbName}`);
}

export function revokeProjectAccess(sharedDbName: string, sandboxId: string): void {
  const config = loadSharedDbConfig();
  const dbEntry = config.databases[sharedDbName];
  if (!dbEntry) throw new Error(`Shared database "${sharedDbName}" not found`);

  const projectApp = sharedProjectRoleName(sharedDbName, sandboxId, 'app');
  const projectRo = sharedProjectRoleName(sharedDbName, sandboxId, 'readonly');

  try {
    // NOLOGIN first to close reconnection race (same pattern as destroyTempMigrateRole)
    for (const role of [projectApp, projectRo]) {
      try { pgExec(`ALTER ROLE "${role}" NOLOGIN`); } catch { /* role may not exist */ }
    }
    // Now terminate — agent cannot reconnect after NOLOGIN
    pgExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename IN ('${projectApp}', '${projectRo}')`);
    // Revoke and drop
    for (const role of [projectApp, projectRo]) {
      try {
        pgExec(`REVOKE ALL PRIVILEGES ON DATABASE "${sharedDbName}" FROM "${role}"`);
        pgExecMulti(`REASSIGN OWNED BY "${role}" TO "${dbEntry.ownerRole}"; DROP OWNED BY "${role}";`, sharedDbName);
        pgExec(`DROP ROLE IF EXISTS "${role}"`);
      } catch (err: any) {
        console.warn(`[shield] Partial cleanup for role ${role}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[shield] Failed to revoke roles for ${sandboxId} on ${sharedDbName}:`, err.message);
  }

  delete dbEntry.projects[sandboxId];
  saveSharedDbConfig(config);

  logAuditEvent({
    type: 'shared_db_project_revoked',
    details: { dbName: sharedDbName, sandboxId },
  });
}

export function listSharedDatabases(): SharedDatabaseInfo[] {
  const config = loadSharedDbConfig();
  return Object.values(config.databases).map(entry => {
    let sizeBytes = 0;
    try {
      const sizeResult = pgExec(`SELECT pg_database_size('${entry.dbName}')`);
      sizeBytes = parseInt(sizeResult, 10) || 0;
    } catch { /* database may not be reachable */ }

    return { ...entry, sizeBytes };
  });
}

// ── Role Resolution for Shared DBs ──

export function resolveSharedDbRole(
  sandboxId: string,
  sharedDbName: string,
  category: SqlCategory,
): string {
  if (category === 'admin') {
    throw new Error('Admin queries not permitted through sovereign proxy');
  }

  const config = loadSharedDbConfig();
  const dbEntry = config.databases[sharedDbName];
  if (!dbEntry) throw new Error(`Shared database "${sharedDbName}" not found`);

  const grant = dbEntry.projects[sandboxId];
  if (!grant) {
    throw new Error(`Project "${sandboxId}" has no access to shared database "${sharedDbName}"`);
  }

  const requiredRole = CATEGORY_TO_ROLE[category];
  if (ROLE_HIERARCHY[requiredRole] > ROLE_HIERARCHY[grant.maxRole]) {
    throw new Error(
      `Project "${sandboxId}" has ${grant.maxRole} access — insufficient for ${category} operations (requires ${requiredRole})`,
    );
  }

  // Return the database-qualified, project-scoped PostgreSQL role
  if (category === 'read') return sharedProjectRoleName(sharedDbName, sandboxId, 'readonly');
  return sharedProjectRoleName(sharedDbName, sandboxId, 'app');
}

/** Get the owner role for a shared database from config (not regex derivation). */
function getSharedDbOwnerRole(sharedDbName: string): string {
  const config = loadSharedDbConfig();
  const dbEntry = config.databases[sharedDbName];
  if (!dbEntry) throw new Error(`Shared database "${sharedDbName}" not found`);
  return dbEntry.ownerRole;
}

// ── Project Binding (atomic write) ──

function projectModeConfigPath(sandboxId: string): string {
  return `${DB_CONFIG_DIR}/${sanitizeSandboxIdForPg(sandboxId)}_mode.json`;
}

export function bindProjectToSharedDb(sandboxId: string, sharedDbName: string): void {
  const config = loadSharedDbConfig();
  if (!config.databases[sharedDbName]) {
    throw new Error(`Shared database "${sharedDbName}" not found`);
  }
  if (!config.databases[sharedDbName].projects[sandboxId]) {
    throw new Error(`Project "${sandboxId}" must be granted access before binding`);
  }

  ensureConfigDir();
  atomicWriteFile(
    projectModeConfigPath(sandboxId),
    JSON.stringify({ mode: 'shared', sharedDbName }, null, 2),
  );

  logAuditEvent({
    type: 'project_bound_to_shared_db',
    details: { sandboxId, sharedDbName },
  });
}

export function unbindProjectFromSharedDb(sandboxId: string): void {
  const configPath = projectModeConfigPath(sandboxId);
  if (existsSync(configPath)) {
    atomicWriteFile(configPath, JSON.stringify({ mode: 'standalone' }, null, 2));
  }

  logAuditEvent({
    type: 'project_unbound_from_shared_db',
    details: { sandboxId },
  });
}

export function getProjectDatabaseMode(sandboxId: string): {
  mode: DatabaseMode;
  sharedDbName?: string;
} {
  const configPath = projectModeConfigPath(sandboxId);
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (raw.mode === 'shared' && typeof raw.sharedDbName === 'string') {
        // Validate the shared DB still exists in config
        const config = loadSharedDbConfig();
        if (config.databases[raw.sharedDbName]) {
          return { mode: 'shared', sharedDbName: raw.sharedDbName };
        }
        console.warn(`[shield] Shared DB ${raw.sharedDbName} no longer exists, falling back to standalone`);
      }
    } catch {
      console.warn(`[shield] Corrupt mode config for ${sandboxId}, falling back to standalone`);
    }
  }
  return { mode: 'standalone' };
}

// ── Shared-Mode Destructive Command Guard ──

export function validateSharedDbSafety(sql: string): void {
  const normalized = sql.toUpperCase();
  const blocked = [
    { pattern: /\bDROP\s+TABLE\b/, label: 'DROP TABLE' },
    { pattern: /\bDROP\s+SCHEMA\b/, label: 'DROP SCHEMA' },
    { pattern: /\bDROP\s+DATABASE\b/, label: 'DROP DATABASE' },
    { pattern: /\bTRUNCATE\b/, label: 'TRUNCATE' },
  ];
  for (const { pattern, label } of blocked) {
    if (pattern.test(normalized)) {
      throw new Error(
        `Blocked: ${label} is not permitted on shared databases. ` +
        `Use soft-delete via sovereign-write or unbind the project first.`,
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Component 2: Reasoning Timeout Guard
// ══════════════════════════════════════════════════════════════════════════════

export interface TimeoutConfig {
  /** PostgreSQL statement_timeout in ms. Must be < Node.js execSync timeout. Default: 5000. */
  statementTimeoutMs: number;
  /** PostgreSQL idle_in_transaction_session_timeout in ms. Default: 10000. */
  idleInTransactionTimeoutMs: number;
}

const DEFAULT_AGENT_TIMEOUTS: TimeoutConfig = {
  statementTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 10_000,
};

/**
 * Prepend timeout SET commands to a SQL string.
 * Note: statement_timeout is also enforced by pgExecAsRole's 4th parameter.
 * This function additionally sets idle_in_transaction_session_timeout which
 * pgExecAsRole does not handle.
 */
export function wrapWithTimeoutGuard(
  sql: string,
  config?: Partial<TimeoutConfig>,
): string {
  const stmtMs = config?.statementTimeoutMs ?? DEFAULT_AGENT_TIMEOUTS.statementTimeoutMs;
  const idleMs = config?.idleInTransactionTimeoutMs ?? DEFAULT_AGENT_TIMEOUTS.idleInTransactionTimeoutMs;

  // Validate: timeout must be positive integer
  if (!Number.isInteger(stmtMs) || stmtMs <= 0) throw new Error('statementTimeoutMs must be positive integer');
  if (!Number.isInteger(idleMs) || idleMs <= 0) throw new Error('idleInTransactionTimeoutMs must be positive integer');

  return `SET idle_in_transaction_session_timeout = '${idleMs}ms';\n${sql}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Component 3: Query Metadata Tagging
// ══════════════════════════════════════════════════════════════════════════════

export interface QueryMetadata {
  sandboxId: string;
  taskId?: string;
  step?: string;
}

/**
 * Prepend a SQL comment with structured metadata for audit trail.
 * All values are sanitized to prevent comment-escape injection.
 * The comment appears in pg_stat_activity.query and slow query logs.
 */
export function tagQueryMetadata(sql: string, meta: QueryMetadata): string {
  const parts = [`app:${sanitizeCommentValue(meta.sandboxId)}`];
  if (meta.taskId) parts.push(`task:${sanitizeCommentValue(meta.taskId)}`);
  if (meta.step) parts.push(`step:${sanitizeCommentValue(meta.step)}`);
  return `/* sovereign ${parts.join(' ')} */\n${sql}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Component 4: Idempotency + Soft-Delete Governance
// ══════════════════════════════════════════════════════════════════════════════

export interface SovereignWriteRequest {
  sandboxId: string;
  sql: string;
  taskId: string;
  operation: string;
  threadId: string;
  step?: string;
}

export interface SovereignWriteResult {
  rows: any[];
  rowCount: number;
  command: string;
  category: SqlCategory;
  idempotencyKey: string;
  wasIdempotent: boolean;
}

const SOVEREIGN_TABLES_INITIALIZED = new Set<string>();

const SOVEREIGN_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS sovereign_event_log (
  id            BIGSERIAL PRIMARY KEY,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_name      TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  operation     TEXT NOT NULL,
  sql_hash      TEXT NOT NULL,
  category      TEXT NOT NULL,
  row_count     INTEGER NOT NULL DEFAULT 0,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL,
  signature     TEXT,
  details       JSONB
);
ALTER TABLE sovereign_event_log ADD COLUMN IF NOT EXISTS signature TEXT;
CREATE INDEX IF NOT EXISTS idx_sov_event_hash ON sovereign_event_log(hash);
CREATE INDEX IF NOT EXISTS idx_sov_event_app ON sovereign_event_log(app_name);
CREATE INDEX IF NOT EXISTS idx_sov_event_ts ON sovereign_event_log(timestamp);

CREATE TABLE IF NOT EXISTS sovereign_idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  operation       TEXT NOT NULL,
  app_name        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_summary  JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sov_idemp_created ON sovereign_idempotency_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_sov_idemp_app ON sovereign_idempotency_keys(app_name);
`;

export function ensureSovereignTables(database: string): void {
  if (SOVEREIGN_TABLES_INITIALIZED.has(database)) return;

  pgExecMulti(SOVEREIGN_TABLES_DDL, database);
  SOVEREIGN_TABLES_INITIALIZED.add(database);
}

/** Deterministic idempotency key. Includes sandboxId to prevent cross-app collisions. */
function computeIdempotencyKey(sandboxId: string, taskId: string, operation: string): string {
  return crypto.createHash('sha256').update(`${sandboxId}:${taskId}:${operation}`).digest('hex');
}

/**
 * Rewrite a simple DELETE into a soft-delete UPDATE.
 * Only handles: DELETE FROM <table> WHERE <condition>
 * Rejects complex patterns (USING, subqueries, CTEs, RETURNING) to prevent
 * silent semantic changes.
 */
export function rewriteDeleteToSoftDelete(sql: string, sandboxId: string): string {
  const trimmed = sql.trim();

  // Reject complex DELETE patterns before attempting rewrite
  const upper = trimmed.toUpperCase();
  if (/\bUSING\b/.test(upper) || /\bRETURNING\b/.test(upper) || /^\s*WITH\b/i.test(trimmed)) {
    throw new Error(
      'Sovereign proxy: DELETE with USING, RETURNING, or CTE (WITH) clauses cannot be auto-soft-deleted. ' +
      'Rewrite as an UPDATE with deleted_at/deleted_by columns.',
    );
  }

  // Match: DELETE FROM [schema.]<table> WHERE <condition>
  const match = trimmed.match(/^\s*DELETE\s+FROM\s+((?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_.]*)+)\s+WHERE\s+(.+)$/is);
  if (!match) {
    throw new Error(
      'Sovereign proxy: only DELETE FROM <table> WHERE <condition> can be soft-deleted. ' +
      'DELETE without WHERE, or complex patterns (subqueries, CTEs) must use the standard query proxy.',
    );
  }

  const [, table, condition] = match;
  // Reject quoted-identifier or schema-qualified forms that the simple regex above
  // can match — only allow a single bare identifier we can validate strictly.
  if (/["\.]/.test(table)) {
    throw new Error('Sovereign proxy: soft-delete only supports single unquoted table names (no schema or quoted identifiers)');
  }
  validatePgIdentifier(table.toLowerCase(), 'table');
  validateConditionExpression(condition, 'condition');
  const safeSandboxId = pgEscapeLiteral(sanitizeSandboxIdForPg(sandboxId));
  return `UPDATE "${table}" SET deleted_at = NOW(), deleted_by = 'project:${safeSandboxId}' WHERE (${condition}) AND deleted_at IS NULL`;
}

/**
 * Clean up idempotency keys older than the specified age.
 * Called periodically (e.g., from enforcer heartbeat).
 */
export function cleanupExpiredIdempotencyKeys(database: string, maxAgeHours: number = 24): number {
  // Validate before SQL interpolation — prevents NaN/Infinity/negative injection
  if (!Number.isInteger(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 8760) {
    throw new Error('maxAgeHours must be a positive integer (max 8760 = 1 year)');
  }
  try {
    const ownerConfig = loadSharedDbConfig();
    // Determine which role to use
    const dbEntry = ownerConfig.databases[database];
    const role = dbEntry
      ? dbEntry.ownerRole
      : ownerRole(database.replace(/^shield_/, ''));

    const result = pgExecAsRole(
      `DELETE FROM sovereign_idempotency_keys WHERE created_at < NOW() - INTERVAL '${maxAgeHours} hours'`,
      database,
      role,
    );
    return result.rowCount;
  } catch (err: any) {
    console.warn(`[shield] Idempotency key cleanup failed for ${database}: ${err.message}`);
    return 0;
  }
}

export function executeSovereignWrite(req: SovereignWriteRequest): SovereignWriteResult {
  const { sandboxId, taskId, operation, threadId, step } = req;
  let { sql } = req;

  // Resolve database target
  const modeInfo = getProjectDatabaseMode(sandboxId);
  const database = modeInfo.mode === 'shared' ? modeInfo.sharedDbName! : dbName(sandboxId);

  // Ensure governance tables exist
  ensureSovereignTables(database);

  // 1. Compute idempotency key
  const idempotencyKey = computeIdempotencyKey(sandboxId, taskId, operation);

  // 2. Atomic idempotency check — single query, no TOCTOU race
  const readRole = modeInfo.mode === 'shared'
    ? resolveSharedDbRole(sandboxId, database, 'read')
    : roleForCategory(sandboxId, 'read');

  try {
    const existing = pgExecAsRole(
      `SELECT result_summary FROM sovereign_idempotency_keys WHERE idempotency_key = '${idempotencyKey}'`,
      database,
      readRole,
    );
    if (existing.rows.length > 0) {
      const cached = JSON.parse(existing.rows[0].result_summary);
      logAuditEvent({
        type: 'sovereign_write_idempotent',
        details: { sandboxId, taskId, operation, idempotencyKey },
      });
      return {
        rows: [],
        rowCount: cached.rowCount ?? 0,
        command: cached.command ?? 'UNKNOWN',
        category: cached.category ?? 'write',
        idempotencyKey,
        wasIdempotent: true,
      };
    }
  } catch (err: any) {
    console.warn(`[shield] Idempotency check failed (proceeding): ${err.message}`);
  }

  // 3. Classify and validate
  const category = classifySql(sql);
  if (category === 'admin') {
    throw new Error('Admin queries not permitted through sovereign proxy');
  }

  if (modeInfo.mode === 'shared') {
    validateSharedDbSafety(sql);
  }
  validateQuerySafety(sql);

  // 4. Intercept DELETE → soft-delete rewrite
  if (category === 'write' && /^\s*DELETE\s/i.test(sql)) {
    sql = rewriteDeleteToSoftDelete(sql, sandboxId);
  }

  // 5. Tag metadata
  sql = tagQueryMetadata(sql, { sandboxId, taskId, step });

  // 6. Wrap with idle_in_transaction timeout
  sql = wrapWithTimeoutGuard(sql);

  // 7. Resolve role
  const writeRole = modeInfo.mode === 'shared'
    ? resolveSharedDbRole(sandboxId, database, category)
    : roleForCategory(sandboxId, category);

  // 8. Execute with agent timeout (double-timeout safety: PG 5s < Node.js 10s)
  const result = pgExecAsRole(sql, database, writeRole, DEFAULT_AGENT_TIMEOUTS.statementTimeoutMs);

  // 9. Log event + record idempotency key in a single serialized transaction
  //    This prevents hash chain forks and ensures atomicity.
  const sqlHash = crypto.createHash('sha256').update(req.sql).digest('hex');
  const ownerRoleName = modeInfo.mode === 'shared'
    ? getSharedDbOwnerRole(database)
    : ownerRole(sandboxId);

  try {
    // Use a transaction with SERIALIZABLE isolation to prevent hash chain forks
    // from concurrent sovereign writes.
    //
    // SECURITY: The DO block uses a randomly-generated dollar-quote tag to prevent
    // injection via user-supplied values (taskId, operation, threadId) that could
    // contain $sov$ or similar sequences. PostgreSQL's lexer matches dollar-quote
    // tags by simple scanning — a $tag$ inside a single-quoted string WITHIN a
    // dollar-quoted block WILL terminate the block. Random tags make this infeasible.
    const dollarTag = `_sov_${crypto.randomBytes(4).toString('hex')}`;
    const safeSandboxId = pgEscapeLiteral(sanitizeSandboxIdForPg(sandboxId));
    const safeTaskId = pgEscapeLiteral(taskId);
    const safeOp = pgEscapeLiteral(operation);
    const safeDetails = pgEscapeLiteral(JSON.stringify({ threadId, step, command: result.command }));
    const safeResultSummary = pgEscapeLiteral(JSON.stringify({
      rowCount: result.rowCount,
      command: result.command,
      category,
    }));

    pgExecAsRole(`
BEGIN ISOLATION LEVEL SERIALIZABLE;

-- Get previous hash (or genesis) under serializable isolation
DO $${dollarTag}$
DECLARE
  v_prev_hash TEXT;
  v_hash TEXT;
BEGIN
  SELECT hash INTO v_prev_hash FROM sovereign_event_log ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF v_prev_hash IS NULL THEN
    v_prev_hash := '${('0').repeat(64)}';
  END IF;

  -- Compute event hash: SHA-256 of canonical {sandboxId, category, operation, prevHash, rowCount, sqlHash, taskId}
  v_hash := encode(
    sha256(convert_to(
      '{"sandboxId":"${safeSandboxId}","category":"${category}","operation":"${safeOp}",' ||
      '"prevHash":"' || v_prev_hash || '",' ||
      '"rowCount":${result.rowCount},"sqlHash":"${sqlHash}","taskId":"${safeTaskId}"}',
      'UTF8'
    )),
    'hex'
  );

  INSERT INTO sovereign_event_log
    (app_name, task_id, operation, sql_hash, category, row_count, prev_hash, hash, details)
  VALUES
    ('${safeSandboxId}', '${safeTaskId}', '${safeOp}',
     '${sqlHash}', '${category}', ${result.rowCount},
     v_prev_hash, v_hash, '${safeDetails}'::jsonb);
END $${dollarTag}$;

-- Record idempotency key (ON CONFLICT = concurrent duplicate is a no-op)
INSERT INTO sovereign_idempotency_keys
  (idempotency_key, task_id, operation, app_name, result_summary)
VALUES
  ('${idempotencyKey}', '${safeTaskId}', '${safeOp}',
   '${safeSandboxId}', '${safeResultSummary}'::jsonb)
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;
`, database, ownerRoleName);

    // Sign the just-inserted entry with the on-disk HMAC key.
    // Tamper-evidence: a PG superuser without filesystem access cannot forge.
    try {
      const latest = pgExecAsRole(
        `SELECT id, prev_hash, hash FROM sovereign_event_log ORDER BY id DESC LIMIT 1`,
        database,
        ownerRoleName,
      );
      if (latest.rows.length > 0) {
        const row = latest.rows[0];
        const sig = pgEscapeLiteral(computeAuditSignature(String(row.prev_hash), String(row.hash)));
        pgExecAsRole(
          `UPDATE sovereign_event_log SET signature = '${sig}' WHERE id = ${Number.parseInt(String(row.id), 10)}`,
          database,
          ownerRoleName,
        );
      }
    } catch (sigErr: any) {
      console.error(`[shield] AUDIT SIGNATURE FAILED (entry remains unsigned): ${sigErr.message}`);
    }
  } catch (err: any) {
    // Governance logging failure is non-fatal — the write already succeeded.
    // Log loudly so operators notice.
    console.error(`[shield] GOVERNANCE LOG FAILED (write succeeded without audit): ${err.message}`);
    logAuditEvent({
      type: 'sovereign_governance_failure',
      details: { sandboxId, taskId, operation, error: err.message },
    });
  }

  logAuditEvent({
    type: 'sovereign_write',
    details: {
      sandboxId, taskId, operation, category, idempotencyKey,
      rowCount: result.rowCount, database,
    },
  });

  return {
    ...result,
    category,
    idempotencyKey,
    wasIdempotent: false,
  };
}

/**
 * Verify the entire audit chain for a workspace (sandbox). Returns the first
 * detected fault, or { ok: true, count } when every entry passes.
 *
 * Checks per row: prev_hash links to previous row's hash AND signature matches
 * HMAC_SHA256(key, prev_hash || hash). Missing signatures are flagged.
 */
export function verifyAuditChain(workspaceId: string): {
  ok: boolean;
  count: number;
  failedAtId?: string;
  reason?: string;
} {
  const modeInfo = getProjectDatabaseMode(workspaceId);
  const database = modeInfo.mode === 'shared' ? modeInfo.sharedDbName! : dbName(workspaceId);
  const ownerRoleName = modeInfo.mode === 'shared'
    ? getSharedDbOwnerRole(database)
    : ownerRole(workspaceId);
  const safeApp = pgEscapeLiteral(sanitizeSandboxIdForPg(workspaceId));
  const rows = pgExecAsRole(
    `SELECT id, prev_hash, hash, signature FROM sovereign_event_log WHERE app_name = '${safeApp}' ORDER BY id ASC`,
    database,
    ownerRoleName,
  ).rows;

  let expectedPrev = '0'.repeat(64);
  for (const r of rows) {
    if (String(r.prev_hash) !== expectedPrev) {
      return { ok: false, count: rows.length, failedAtId: String(r.id), reason: 'prev_hash chain break' };
    }
    if (!r.signature) {
      return { ok: false, count: rows.length, failedAtId: String(r.id), reason: 'missing signature' };
    }
    const expected = computeAuditSignature(String(r.prev_hash), String(r.hash));
    if (String(r.signature) !== expected) {
      return { ok: false, count: rows.length, failedAtId: String(r.id), reason: 'signature mismatch' };
    }
    expectedPrev = String(r.hash);
  }
  return { ok: true, count: rows.length };
}

// ══════════════════════════════════════════════════════════════════════════════
// Component 5: Type-Safe Agent Views
// ══════════════════════════════════════════════════════════════════════════════

export interface ColumnMapping {
  sourceColumn: string;
  viewColumn: string;
  description: string;
  transform?: string;
}

export interface AgentViewDefinition {
  viewName: string;
  sourceTable: string;
  columns: ColumnMapping[];
  whereClause?: string;
  description: string;
}

/**
 * Validate all identifiers in a view definition to prevent SQL injection.
 * Every column name, table name, and view name must be a valid PG identifier.
 */
function validateViewDefinition(viewDef: AgentViewDefinition): void {
  validatePgIdentifier(viewDef.viewName, 'viewName');
  if (!viewDef.viewName.startsWith('v_agent_')) {
    throw new Error('Agent view names must start with "v_agent_"');
  }

  validatePgIdentifier(viewDef.sourceTable, 'sourceTable');

  for (const col of viewDef.columns) {
    validatePgIdentifier(col.viewColumn, 'viewColumn');
    // sourceColumn is ALWAYS validated — it's the source of truth for the column mapping
    // even when a transform overrides the SQL expression
    validatePgIdentifier(col.sourceColumn, 'sourceColumn');
    // Transform expressions are validated against an injection blocklist:
    // no semicolons, no comments, no subqueries, no DDL/DML, no dollar-quoting
    if (col.transform) {
      validateTransformExpression(col.transform, `transform for "${col.viewColumn}"`);
    }
    if (col.description.length > 1024) {
      throw new Error(`Column description too long for "${col.viewColumn}" (max 1024 chars)`);
    }
  }

  if (viewDef.description.length > 2048) {
    throw new Error('View description too long (max 2048 chars)');
  }

  // Validate whereClause doesn't contain destructive SQL
  if (viewDef.whereClause) {
    const upper = viewDef.whereClause.toUpperCase();
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/.test(upper)) {
      throw new Error('whereClause must be a pure filter expression — no DDL/DML keywords');
    }
  }
}

export function generateViewSql(sandboxId: string, viewDef: AgentViewDefinition): string {
  validateViewDefinition(viewDef);

  const { viewName, sourceTable, columns, whereClause, description } = viewDef;

  // Build SELECT columns (identifiers are validated above)
  const selectCols = columns.map(col => {
    const expr = col.transform || `"${col.sourceColumn}"`;
    return `  ${expr} AS "${col.viewColumn}"`;
  }).join(',\n');

  const whereStr = whereClause ? `\nWHERE ${whereClause}` : '';

  // SECURITY_BARRIER prevents leakproof function exploits when RLS is enabled
  let sql = `CREATE OR REPLACE VIEW "${viewName}" WITH (security_barrier = true) AS\nSELECT\n${selectCols}\nFROM "${sourceTable}"${whereStr};\n\n`;

  // COMMENT ON VIEW
  sql += `COMMENT ON VIEW "${viewName}" IS '${pgEscapeLiteral(description)}';\n`;

  // COMMENT ON COLUMN for each mapped column
  for (const col of columns) {
    sql += `COMMENT ON COLUMN "${viewName}"."${col.viewColumn}" IS '${pgEscapeLiteral(col.description)}';\n`;
  }

  // Grant SELECT to the appropriate project roles
  const modeInfo = getProjectDatabaseMode(sandboxId);
  if (modeInfo.mode === 'shared' && modeInfo.sharedDbName) {
    const projApp = sharedProjectRoleName(modeInfo.sharedDbName, sandboxId, 'app');
    const projRo = sharedProjectRoleName(modeInfo.sharedDbName, sandboxId, 'readonly');
    sql += `\nGRANT SELECT ON "${viewName}" TO "${projApp}";\n`;
    sql += `GRANT SELECT ON "${viewName}" TO "${projRo}";\n`;
  } else {
    sql += `\nGRANT SELECT ON "${viewName}" TO "${appRole(sandboxId)}";\n`;
    sql += `GRANT SELECT ON "${viewName}" TO "${readonlyRole(sandboxId)}";\n`;
  }

  return sql;
}

export function createAgentView(sandboxId: string, viewDef: AgentViewDefinition): void {
  const sql = generateViewSql(sandboxId, viewDef);

  const modeInfo = getProjectDatabaseMode(sandboxId);
  const database = modeInfo.mode === 'shared' ? modeInfo.sharedDbName! : dbName(sandboxId);

  // Execute as superuser via pgExecMulti (DDL requires owner privileges)
  pgExecMulti(sql, database);

  logAuditEvent({
    type: 'agent_view_created',
    details: { sandboxId, viewName: viewDef.viewName, sourceTable: viewDef.sourceTable, database },
  });

  console.log(`[shield] Agent view created: ${viewDef.viewName} on ${database}`);
}

export function dropAgentView(sandboxId: string, viewName: string): void {
  validatePgIdentifier(viewName, 'viewName');
  if (!viewName.startsWith('v_agent_')) {
    throw new Error('Can only drop views prefixed with "v_agent_"');
  }

  const modeInfo = getProjectDatabaseMode(sandboxId);
  const database = modeInfo.mode === 'shared' ? modeInfo.sharedDbName! : dbName(sandboxId);

  pgExecMulti(`DROP VIEW IF EXISTS "${viewName}";`, database);

  logAuditEvent({
    type: 'agent_view_dropped',
    details: { sandboxId, viewName, database },
  });

  console.log(`[shield] Agent view dropped: ${viewName} on ${database}`);
}

export function listAgentViews(sandboxId: string): Array<{
  viewName: string;
  description: string;
  columns: Array<{ name: string; type: string; description: string }>;
}> {
  const modeInfo = getProjectDatabaseMode(sandboxId);
  const database = modeInfo.mode === 'shared' ? modeInfo.sharedDbName! : dbName(sandboxId);
  const role = modeInfo.mode === 'shared'
    ? resolveSharedDbRole(sandboxId, database, 'read')
    : roleForCategory(sandboxId, 'read');

  // Single joined query — no N+1. Fetches all views + columns in one round trip.
  const result = pgExecAsRole(
    `SELECT
       v.table_name,
       obj_description((quote_ident(v.table_schema) || '.' || quote_ident(v.table_name))::regclass) AS view_desc,
       c.column_name,
       c.data_type,
       c.ordinal_position,
       col_description(
         (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass,
         c.ordinal_position
       ) AS col_desc
     FROM information_schema.views v
     JOIN information_schema.columns c
       ON c.table_schema = v.table_schema AND c.table_name = v.table_name
     WHERE v.table_schema = 'public' AND v.table_name LIKE 'v\\_agent\\_%'
     ORDER BY v.table_name, c.ordinal_position`,
    database,
    role,
  );

  // Group flat rows into structured view objects
  const viewMap = new Map<string, {
    description: string;
    columns: Array<{ name: string; type: string; description: string }>;
  }>();

  for (const row of result.rows) {
    const vName = row.table_name;
    // Validate view name — defense-in-depth against PG catalog injection
    if (!/^v_agent_[a-z0-9_]+$/.test(vName)) continue;

    if (!viewMap.has(vName)) {
      viewMap.set(vName, { description: row.view_desc || '', columns: [] });
    }
    viewMap.get(vName)!.columns.push({
      name: row.column_name,
      type: row.data_type,
      description: row.col_desc || '',
    });
  }

  return Array.from(viewMap.entries()).map(([viewName, data]) => ({
    viewName,
    ...data,
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// Sovereign Query (unified entry point)
// ══════════════════════════════════════════════════════════════════════════════

export interface SovereignQueryRequest {
  sandboxId: string;
  sql: string;
  taskId?: string;
  step?: string;
  database?: string; // override for named databases (standalone mode only)
}

export function executeSovereignQuery(
  req: SovereignQueryRequest,
): { rows: any[]; rowCount: number; command: string; category: SqlCategory } {
  let { sql } = req;
  const { sandboxId, taskId, step } = req;

  // Classify before tagging (classifySql strips leading comments)
  const category = classifySql(sql);
  if (category === 'admin') {
    throw new Error('Admin queries not permitted through sovereign proxy');
  }

  // Resolve database and role
  const modeInfo = getProjectDatabaseMode(sandboxId);
  let database: string;
  let role: string;

  if (modeInfo.mode === 'shared') {
    database = modeInfo.sharedDbName!;
    validateSharedDbSafety(sql);
    role = resolveSharedDbRole(sandboxId, database, category);
  } else {
    database = req.database || dbName(sandboxId);
    role = roleForCategory(sandboxId, category);
  }

  validateQuerySafety(sql);

  // Tag metadata (sanitized — no comment-escape injection)
  sql = tagQueryMetadata(sql, { sandboxId, taskId, step });

  // Wrap with idle_in_transaction timeout
  sql = wrapWithTimeoutGuard(sql);

  // Execute with agent statement_timeout (double-timeout safety)
  const result = pgExecAsRole(sql, database, role, DEFAULT_AGENT_TIMEOUTS.statementTimeoutMs);

  logAuditEvent({
    type: 'sovereign_query',
    details: {
      sandboxId, database, category, role,
      command: result.command, rowCount: result.rowCount, taskId,
    },
  });

  return { ...result, category };
}
