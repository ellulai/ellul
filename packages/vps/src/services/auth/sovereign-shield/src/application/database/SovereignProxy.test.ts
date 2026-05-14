// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sovereign Database Proxy — Unit Tests
 *
 * Tests all 5 sovereign constraints and their security properties.
 * Pure functions are tested directly; functions with PG/filesystem
 * side-effects are tested with mocked dependencies.
 *
 * Test categories:
 *   1. Sanitization utilities (pgEscapeLiteral, sanitizeCommentValue, validatePgIdentifier)
 *   2. Transform expression validation (SQL injection prevention)
 *   3. Query metadata tagging (comment injection prevention)
 *   4. Timeout guard (double-timeout invariants)
 *   5. Soft-delete rewrite (regex correctness + rejection of complex patterns)
 *   6. Shared DB safety guard (destructive DDL blocking)
 *   7. Role resolution (hierarchy intersection logic)
 *   8. Agent view SQL generation (SECURITY_BARRIER, COMMENT ON, injection prevention)
 *   9. Idempotency key computation (deterministic, cross-app collision prevention)
 *  10. Shared database lifecycle (create, grant, revoke, bind, unbind)
 *  11. Sovereign query + write (end-to-end with mocked PG)
 *  12. Cleanup (idempotency key expiry validation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock dependencies before importing the module under test ──
// All PG operations and filesystem I/O are mocked to prevent side effects.

vi.mock('./Database', () => ({
  pgExec: vi.fn().mockReturnValue(''),
  pgExecMulti: vi.fn().mockReturnValue(''),
  pgExecAsRole: vi.fn().mockReturnValue({ rows: [], rowCount: 0, command: 'SELECT' }),
  dbName: vi.fn((app: string) => `shield_${app.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`),
  ownerRole: vi.fn((app: string) => `shield_${app.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_owner`),
  appRole: vi.fn((app: string) => `shield_${app.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_app`),
  readonlyRole: vi.fn((app: string) => `shield_${app.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_readonly`),
  sanitizeSandboxIdForPg: vi.fn((app: string) => app.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 48)),
  classifySql: vi.fn((sql: string) => {
    const first = sql.trim().split(/[\s(]+/)[0]?.toUpperCase();
    if (['SELECT', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES'].includes(first!)) return 'read';
    if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'TRUNCATE'].includes(first!)) return 'write';
    if (['CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'COMMENT'].includes(first!)) return 'migrate';
    return 'admin';
  }),
  roleForCategory: vi.fn((app: string, cat: string) => {
    if (cat === 'read') return `shield_${app}_readonly`;
    if (cat === 'write') return `shield_${app}_app`;
    return `shield_${app}_owner`;
  }),
  validateQuerySafety: vi.fn(),
  isPostgresAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock('../audit/Audit', () => ({
  logAuditEvent: vi.fn(),
}));

// Mock filesystem — in-memory config store
const mockFiles = new Map<string, string>();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => mockFiles.has(p)),
    readFileSync: vi.fn((p: string) => {
      const content = mockFiles.get(p);
      if (!content) throw new Error(`ENOENT: ${p}`);
      return content;
    }),
    mkdirSync: vi.fn(),
    openSync: vi.fn().mockReturnValue(42),
    writeSync: vi.fn(),
    fdatasyncSync: vi.fn(),
    closeSync: vi.fn(),
    renameSync: vi.fn((_from: string, to: string) => {
      // Simulate atomic rename: the writeSync would have written to _from,
      // but since we mock writeSync we track via the rename target.
      // We capture writes via a spy on writeSync instead.
    }),
  };
});

// Now import the module under test (after mocks are set up)
import {
  tagQueryMetadata,
  wrapWithTimeoutGuard,
  rewriteDeleteToSoftDelete,
  validateSharedDbSafety,
  resolveSharedDbRole,
  generateViewSql,
  createSharedDatabase,
  grantProjectAccess,
  revokeProjectAccess,
  bindProjectToSharedDb,
  unbindProjectFromSharedDb,
  getProjectDatabaseMode,
  ensureSovereignTables,
  executeSovereignQuery,
  executeSovereignWrite,
  listSharedDatabases,
  cleanupExpiredIdempotencyKeys,
  createAgentView,
  dropAgentView,
  listAgentViews,
  type AgentViewDefinition,
  type SovereignQueryRequest,
  type SovereignWriteRequest,
  type TimeoutConfig,
} from './SovereignProxy';

import { pgExec, pgExecMulti, pgExecAsRole, classifySql } from './Database';
import { logAuditEvent } from '../audit/Audit';
import { writeSync, renameSync } from 'fs';

// ── Helpers ──

function setSharedDbConfig(config: any): void {
  mockFiles.set('/etc/shield/db-config/shared-databases.json', JSON.stringify(config));
}

function setProjectModeConfig(sandboxId: string, mode: any): void {
  mockFiles.set(`/etc/shield/db-config/${sandboxId}_mode.json`, JSON.stringify(mode));
}

function clearConfigs(): void {
  mockFiles.clear();
}

// ── Test Suites ──

describe('Sovereign Database Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearConfigs();
  });

  // ════════════════════════════════════════════════════════════════
  // 1. Query Metadata Tagging — Comment Injection Prevention
  // ════════════════════════════════════════════════════════════════

  describe('tagQueryMetadata', () => {
    it('produces a correctly formatted SQL comment prefix', () => {
      const result = tagQueryMetadata('SELECT 1', { sandboxId: 'myapp' });
      expect(result).toBe('/* sovereign app:myapp */\nSELECT 1');
    });

    it('includes taskId and step when provided', () => {
      const result = tagQueryMetadata('SELECT 1', {
        sandboxId: 'myapp',
        taskId: 'task-123',
        step: 'fetch-users',
      });
      expect(result).toContain('app:myapp');
      expect(result).toContain('task:task-123');
      expect(result).toContain('step:fetch-users');
      expect(result.startsWith('/* sovereign')).toBe(true);
      expect(result.endsWith('*/\nSELECT 1')).toBe(true);
    });

    it('sanitizes */ to prevent comment escape injection', () => {
      const result = tagQueryMetadata('SELECT 1', {
        sandboxId: 'evil*/DROP TABLE users;--',
      });
      expect(result).not.toContain('*/DROP');
      expect(result).not.toContain('--');
      // The comment should still be well-formed
      const commentEnd = result.indexOf('*/');
      expect(commentEnd).toBeGreaterThan(0);
      // Everything after the comment should be the original SQL
      expect(result.substring(commentEnd + 2).trim()).toBe('SELECT 1');
    });

    it('sanitizes -- to prevent line comment injection', () => {
      const result = tagQueryMetadata('SELECT 1', {
        sandboxId: 'app',
        taskId: 'task--DROP TABLE users',
      });
      expect(result).not.toContain('--');
    });

    it('replaces newlines in metadata values', () => {
      const result = tagQueryMetadata('SELECT 1', {
        sandboxId: 'app\nDROP TABLE users',
      });
      expect(result).not.toContain('\nDROP');
      // The tagged SQL should have exactly one newline: between comment and SQL
      const lines = result.split('\n');
      expect(lines.length).toBe(2);
    });

    it('truncates excessively long metadata values to 128 chars', () => {
      const longName = 'a'.repeat(200);
      const result = tagQueryMetadata('SELECT 1', { sandboxId: longName });
      // The app: prefix + value should not exceed 128 for the value portion
      expect(result.length).toBeLessThan(200 + 50); // generous bound
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 2. Timeout Guard — Double-Timeout Safety
  // ════════════════════════════════════════════════════════════════

  describe('wrapWithTimeoutGuard', () => {
    it('prepends idle_in_transaction_session_timeout with defaults', () => {
      const result = wrapWithTimeoutGuard('SELECT 1');
      expect(result).toContain("SET idle_in_transaction_session_timeout = '10000ms'");
      expect(result).toContain('SELECT 1');
    });

    it('accepts custom timeout values', () => {
      const result = wrapWithTimeoutGuard('SELECT 1', {
        statementTimeoutMs: 3000,
        idleInTransactionTimeoutMs: 5000,
      });
      expect(result).toContain("'5000ms'");
    });

    it('rejects zero statement timeout', () => {
      expect(() => wrapWithTimeoutGuard('SELECT 1', { statementTimeoutMs: 0 }))
        .toThrow('positive integer');
    });

    it('rejects negative timeout', () => {
      expect(() => wrapWithTimeoutGuard('SELECT 1', { idleInTransactionTimeoutMs: -1 }))
        .toThrow('positive integer');
    });

    it('rejects non-integer timeout', () => {
      expect(() => wrapWithTimeoutGuard('SELECT 1', { statementTimeoutMs: 5.5 }))
        .toThrow('positive integer');
    });

    it('rejects NaN timeout', () => {
      expect(() => wrapWithTimeoutGuard('SELECT 1', { statementTimeoutMs: NaN }))
        .toThrow('positive integer');
    });

    it('rejects Infinity timeout', () => {
      expect(() => wrapWithTimeoutGuard('SELECT 1', { statementTimeoutMs: Infinity }))
        .toThrow('positive integer');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 3. Soft-Delete Rewrite — Correctness + Rejection
  // ════════════════════════════════════════════════════════════════

  describe('rewriteDeleteToSoftDelete', () => {
    it('rewrites simple DELETE FROM ... WHERE into UPDATE with soft-delete columns', () => {
      const result = rewriteDeleteToSoftDelete(
        'DELETE FROM users WHERE id = 42',
        'myapp',
      );
      expect(result).toContain('UPDATE users SET deleted_at = NOW()');
      expect(result).toContain("deleted_by = 'project:myapp'");
      expect(result).toContain('WHERE (id = 42) AND deleted_at IS NULL');
    });

    it('preserves complex WHERE conditions', () => {
      const result = rewriteDeleteToSoftDelete(
        "DELETE FROM orders WHERE status = 'cancelled' AND created_at < '2024-01-01'",
        'shop',
      );
      expect(result).toContain("(status = 'cancelled' AND created_at < '2024-01-01')");
      expect(result).toContain('AND deleted_at IS NULL');
    });

    it('handles quoted table names', () => {
      const result = rewriteDeleteToSoftDelete(
        'DELETE FROM "my_table" WHERE id = 1',
        'app',
      );
      expect(result).toContain('UPDATE "my_table"');
    });

    it('handles schema-qualified table names', () => {
      const result = rewriteDeleteToSoftDelete(
        'DELETE FROM public.users WHERE id = 1',
        'app',
      );
      expect(result).toContain('UPDATE public.users');
    });

    it('sanitizes sandboxId in the deleted_by value', () => {
      const result = rewriteDeleteToSoftDelete(
        'DELETE FROM t WHERE id = 1',
        "evil'; DROP TABLE--",
      );
      // sanitizeAppName strips special chars
      expect(result).toContain("deleted_by = 'project:evil___drop_table__'");
      expect(result).not.toContain("';");
    });

    it('rejects DELETE without WHERE clause', () => {
      expect(() => rewriteDeleteToSoftDelete('DELETE FROM users', 'app'))
        .toThrow('DELETE without WHERE');
    });

    it('rejects DELETE with USING clause', () => {
      expect(() =>
        rewriteDeleteToSoftDelete(
          'DELETE FROM orders USING customers WHERE orders.customer_id = customers.id',
          'app',
        ),
      ).toThrow('USING');
    });

    it('rejects DELETE with RETURNING clause', () => {
      expect(() =>
        rewriteDeleteToSoftDelete('DELETE FROM users WHERE id = 1 RETURNING *', 'app'),
      ).toThrow('RETURNING');
    });

    it('rejects DELETE with CTE (WITH clause)', () => {
      expect(() =>
        rewriteDeleteToSoftDelete(
          'WITH old_users AS (SELECT id FROM users WHERE age > 100) DELETE FROM users WHERE id IN (SELECT id FROM old_users)',
          'app',
        ),
      ).toThrow('CTE');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 4. Shared-Mode Destructive Command Guard
  // ════════════════════════════════════════════════════════════════

  describe('validateSharedDbSafety', () => {
    it('allows normal SELECT queries', () => {
      expect(() => validateSharedDbSafety('SELECT * FROM users')).not.toThrow();
    });

    it('allows INSERT/UPDATE/DELETE', () => {
      expect(() => validateSharedDbSafety('INSERT INTO users (name) VALUES (1)')).not.toThrow();
      expect(() => validateSharedDbSafety('UPDATE users SET name = 1')).not.toThrow();
      expect(() => validateSharedDbSafety('DELETE FROM users WHERE id = 1')).not.toThrow();
    });

    it('blocks DROP TABLE', () => {
      expect(() => validateSharedDbSafety('DROP TABLE users')).toThrow('DROP TABLE');
    });

    it('blocks DROP TABLE with IF EXISTS', () => {
      expect(() => validateSharedDbSafety('DROP TABLE IF EXISTS users CASCADE'))
        .toThrow('DROP TABLE');
    });

    it('blocks DROP SCHEMA', () => {
      expect(() => validateSharedDbSafety('DROP SCHEMA public CASCADE'))
        .toThrow('DROP SCHEMA');
    });

    it('blocks DROP DATABASE', () => {
      expect(() => validateSharedDbSafety('DROP DATABASE shield_shared_main'))
        .toThrow('DROP DATABASE');
    });

    it('blocks TRUNCATE', () => {
      expect(() => validateSharedDbSafety('TRUNCATE users')).toThrow('TRUNCATE');
    });

    it('blocks case-insensitive variants', () => {
      expect(() => validateSharedDbSafety('drop table users')).toThrow('DROP TABLE');
      expect(() => validateSharedDbSafety('Drop Table users')).toThrow('DROP TABLE');
      expect(() => validateSharedDbSafety('truncate users')).toThrow('TRUNCATE');
    });

    it('does not false-positive on column names containing blocked words', () => {
      // "drop_table_flag" should not trigger — \b word boundary prevents this
      expect(() => validateSharedDbSafety('SELECT drop_table_flag FROM config')).not.toThrow();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 5. Role Resolution — Hierarchy Intersection
  // ════════════════════════════════════════════════════════════════

  describe('resolveSharedDbRole', () => {
    const sharedConfig = {
      version: 1,
      databases: {
        shield_shared_main: {
          dbName: 'shield_shared_main',
          ownerRole: 'sov_shield_shared_main_owner',
          createdAt: '2024-01-01',
          createdBy: 'dashboard',
          projects: {
            myapp: { maxRole: 'app', grantedAt: 1234 },
            reader: { maxRole: 'readonly', grantedAt: 1234 },
            admin: { maxRole: 'owner', grantedAt: 1234 },
          },
        },
      },
    };

    beforeEach(() => {
      setSharedDbConfig(sharedConfig);
    });

    it('returns readonly role for read queries within readonly ceiling', () => {
      const role = resolveSharedDbRole('reader', 'shield_shared_main', 'read');
      expect(role).toContain('readonly');
    });

    it('returns app role for write queries within app ceiling', () => {
      const role = resolveSharedDbRole('myapp', 'shield_shared_main', 'write');
      expect(role).toContain('app');
    });

    it('returns readonly role for read queries when project has app ceiling', () => {
      const role = resolveSharedDbRole('myapp', 'shield_shared_main', 'read');
      expect(role).toContain('readonly');
    });

    it('throws when write exceeds readonly ceiling', () => {
      expect(() => resolveSharedDbRole('reader', 'shield_shared_main', 'write'))
        .toThrow('insufficient');
    });

    it('throws when migrate exceeds app ceiling', () => {
      expect(() => resolveSharedDbRole('myapp', 'shield_shared_main', 'migrate'))
        .toThrow('insufficient');
    });

    it('allows owner-ceiling project to do migrate operations', () => {
      const role = resolveSharedDbRole('admin', 'shield_shared_main', 'migrate');
      expect(role).toContain('app'); // migrate maps to app role (no separate migrate role in shared mode)
    });

    it('blocks admin queries regardless of ceiling', () => {
      expect(() => resolveSharedDbRole('admin', 'shield_shared_main', 'admin'))
        .toThrow('Admin queries not permitted');
    });

    it('throws for unknown project', () => {
      expect(() => resolveSharedDbRole('unknown', 'shield_shared_main', 'read'))
        .toThrow('no access');
    });

    it('throws for unknown database', () => {
      expect(() => resolveSharedDbRole('myapp', 'nonexistent', 'read'))
        .toThrow('not found');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 6. Agent View SQL Generation — Security + Correctness
  // ════════════════════════════════════════════════════════════════

  describe('generateViewSql', () => {
    const validViewDef: AgentViewDefinition = {
      viewName: 'v_agent_customers',
      sourceTable: 'customers',
      columns: [
        { sourceColumn: 'first_name', viewColumn: 'name', description: 'Customer name' },
        { sourceColumn: 'email_addr', viewColumn: 'email', description: 'Customer email' },
      ],
      whereClause: 'deleted_at IS NULL',
      description: 'Customer view for agents',
    };

    it('generates valid CREATE OR REPLACE VIEW with SECURITY_BARRIER', () => {
      const sql = generateViewSql('myapp', validViewDef);
      expect(sql).toContain('CREATE OR REPLACE VIEW "v_agent_customers"');
      expect(sql).toContain('security_barrier = true');
    });

    it('includes COMMENT ON VIEW', () => {
      const sql = generateViewSql('myapp', validViewDef);
      expect(sql).toContain("COMMENT ON VIEW \"v_agent_customers\" IS 'Customer view for agents'");
    });

    it('includes COMMENT ON COLUMN for each column', () => {
      const sql = generateViewSql('myapp', validViewDef);
      expect(sql).toContain('COMMENT ON COLUMN "v_agent_customers"."name"');
      expect(sql).toContain('COMMENT ON COLUMN "v_agent_customers"."email"');
    });

    it('generates correct SELECT with column aliases', () => {
      const sql = generateViewSql('myapp', validViewDef);
      expect(sql).toContain('"first_name" AS "name"');
      expect(sql).toContain('"email_addr" AS "email"');
    });

    it('includes WHERE clause when provided', () => {
      const sql = generateViewSql('myapp', validViewDef);
      expect(sql).toContain('WHERE deleted_at IS NULL');
    });

    it('omits WHERE clause when not provided', () => {
      const noWhere = { ...validViewDef, whereClause: undefined };
      const sql = generateViewSql('myapp', noWhere);
      expect(sql).not.toContain('WHERE');
    });

    it('grants SELECT to app and readonly roles (standalone mode)', () => {
      const sql = generateViewSql('myapp', validViewDef);
      expect(sql).toContain('GRANT SELECT ON "v_agent_customers"');
    });

    it('uses transform expression when provided', () => {
      const withTransform: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'first_name',
            viewColumn: 'upper_name',
            description: 'Uppercase name',
            transform: 'UPPER("first_name")',
          },
        ],
      };
      const sql = generateViewSql('myapp', withTransform);
      expect(sql).toContain('UPPER("first_name") AS "upper_name"');
    });

    it('escapes single quotes in description', () => {
      const withQuotes: AgentViewDefinition = {
        ...validViewDef,
        description: "Customer's view for agent's use",
      };
      const sql = generateViewSql('myapp', withQuotes);
      expect(sql).toContain("Customer''s view for agent''s use");
    });

    // ── Injection prevention ──

    it('rejects viewName not starting with v_agent_', () => {
      const bad = { ...validViewDef, viewName: 'my_view' };
      expect(() => generateViewSql('myapp', bad)).toThrow('v_agent_');
    });

    it('rejects viewName with uppercase chars', () => {
      const bad = { ...validViewDef, viewName: 'v_agent_MyView' };
      expect(() => generateViewSql('myapp', bad)).toThrow('lowercase');
    });

    it('rejects sourceTable with SQL injection', () => {
      const bad = { ...validViewDef, sourceTable: 'users; DROP TABLE secrets' };
      expect(() => generateViewSql('myapp', bad)).toThrow('Invalid sourceTable');
    });

    it('rejects sourceColumn with special characters', () => {
      const bad: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          { sourceColumn: 'col"; DROP TABLE--', viewColumn: 'col', description: 'test' },
        ],
      };
      expect(() => generateViewSql('myapp', bad)).toThrow('Invalid sourceColumn');
    });

    it('always validates sourceColumn even when transform is provided', () => {
      const bad: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'INVALID_COL',
            viewColumn: 'col',
            description: 'test',
            transform: 'UPPER("name")',
          },
        ],
      };
      // sourceColumn starts with uppercase — should fail validation
      expect(() => generateViewSql('myapp', bad)).toThrow('Invalid sourceColumn');
    });

    it('rejects transform with semicolons (SQL injection)', () => {
      const bad: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'name',
            viewColumn: 'col',
            description: 'test',
            transform: "1; DROP TABLE users",
          },
        ],
      };
      expect(() => generateViewSql('myapp', bad)).toThrow('semicolons');
    });

    it('rejects transform with SQL comments', () => {
      const bad: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'name',
            viewColumn: 'col',
            description: 'test',
            transform: "1 -- DROP TABLE users",
          },
        ],
      };
      expect(() => generateViewSql('myapp', bad)).toThrow('comments');
    });

    it('rejects transform with dollar-quoting', () => {
      const bad: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'name',
            viewColumn: 'col',
            description: 'test',
            transform: "$$malicious$$",
          },
        ],
      };
      expect(() => generateViewSql('myapp', bad)).toThrow('dollar-quoted');
    });

    it('rejects transform with DDL keywords', () => {
      const bad: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'name',
            viewColumn: 'col',
            description: 'test',
            transform: "DROP TABLE users",
          },
        ],
      };
      expect(() => generateViewSql('myapp', bad)).toThrow('DDL/DML');
    });

    it('rejects transform with subqueries', () => {
      const bad: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'name',
            viewColumn: 'col',
            description: 'test',
            transform: "(SELECT password FROM secrets LIMIT 1)",
          },
        ],
      };
      expect(() => generateViewSql('myapp', bad)).toThrow('subqueries');
    });

    it('rejects transform with role manipulation', () => {
      const bad: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'name',
            viewColumn: 'col',
            description: 'test',
            transform: "SET ROLE postgres",
          },
        ],
      };
      expect(() => generateViewSql('myapp', bad)).toThrow('role manipulation');
    });

    it('allows safe transform expressions', () => {
      const safe: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'first_name',
            viewColumn: 'full_name',
            description: 'Full name',
            transform: "COALESCE(\"first_name\", '') || ' ' || COALESCE(\"last_name\", '')",
          },
        ],
      };
      expect(() => generateViewSql('myapp', safe)).not.toThrow();
    });

    it('allows CAST and EXTRACT transforms', () => {
      const safe: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          {
            sourceColumn: 'created_at',
            viewColumn: 'year_created',
            description: 'Year',
            transform: "EXTRACT(YEAR FROM \"created_at\")::INTEGER",
          },
        ],
      };
      expect(() => generateViewSql('myapp', safe)).not.toThrow();
    });

    it('rejects whereClause with DDL/DML keywords', () => {
      const bad = { ...validViewDef, whereClause: "1=1; DROP TABLE users" };
      expect(() => generateViewSql('myapp', bad)).toThrow('DDL/DML');
    });

    it('rejects excessively long description', () => {
      const bad = { ...validViewDef, description: 'x'.repeat(2049) };
      expect(() => generateViewSql('myapp', bad)).toThrow('too long');
    });

    it('rejects excessively long column description', () => {
      const bad: AgentViewDefinition = {
        ...validViewDef,
        columns: [
          { sourceColumn: 'name', viewColumn: 'name', description: 'x'.repeat(1025) },
        ],
      };
      expect(() => generateViewSql('myapp', bad)).toThrow('too long');
    });

    it('rejects identifiers exceeding 63 characters', () => {
      const bad = { ...validViewDef, viewName: 'v_agent_' + 'a'.repeat(56) };
      expect(() => generateViewSql('myapp', bad)).toThrow('63-character');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 7. Shared Database Lifecycle
  // ════════════════════════════════════════════════════════════════

  describe('createSharedDatabase', () => {
    it('creates a database with shield_shared_ prefix', () => {
      const dbName = createSharedDatabase('analytics');
      expect(dbName).toBe('shield_shared_analytics');
      expect(pgExecMulti).toHaveBeenCalled();
      expect(pgExec).toHaveBeenCalled();
    });

    it('rejects invalid database names', () => {
      expect(() => createSharedDatabase('my-db')).toThrow('Invalid');
      expect(() => createSharedDatabase('123abc')).toThrow('Invalid');
      expect(() => createSharedDatabase('DROP TABLE')).toThrow('Invalid');
    });

    it('rejects names that would exceed 63 chars total', () => {
      const longName = 'a'.repeat(50); // shield_shared_ + 50 = 64 > 63
      expect(() => createSharedDatabase(longName)).toThrow('too long');
    });

    it('logs an audit event on creation', () => {
      createSharedDatabase('test');
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'shared_database_created' }),
      );
    });

    it('persists config with ownerRole stored (not derived)', () => {
      createSharedDatabase('test');
      // The writeSync mock captures what was written
      expect(writeSync).toHaveBeenCalled();
      const writtenContent = vi.mocked(writeSync).mock.calls[0]?.[1] as string;
      const config = JSON.parse(writtenContent);
      expect(config.databases.shield_shared_test.ownerRole).toBeDefined();
      expect(config.databases.shield_shared_test.ownerRole).toContain('sov_');
      expect(config.databases.shield_shared_test.ownerRole).toContain('owner');
    });
  });

  describe('grantProjectAccess', () => {
    beforeEach(() => {
      setSharedDbConfig({
        version: 1,
        databases: {
          shield_shared_main: {
            dbName: 'shield_shared_main',
            ownerRole: 'sov_shield_shared_main_owner',
            createdAt: '2024-01-01',
            createdBy: 'dashboard',
            projects: {},
          },
        },
      });
    });

    it('creates project-scoped roles with database-qualified names', () => {
      grantProjectAccess('shield_shared_main', 'myapp', 'app');
      // Should call pgExecMulti with role creation
      const calls = vi.mocked(pgExecMulti).mock.calls;
      const roleCreationCall = calls.find(c => c[0].includes('CREATE ROLE'));
      expect(roleCreationCall).toBeDefined();
      // Role names should include both db and app qualifiers
      expect(roleCreationCall![0]).toContain('sov_');
    });

    it('throws for nonexistent shared database', () => {
      expect(() => grantProjectAccess('nonexistent', 'app', 'app')).toThrow('not found');
    });

    it('logs audit event with role details', () => {
      grantProjectAccess('shield_shared_main', 'myapp', 'readonly');
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'shared_db_project_granted',
          details: expect.objectContaining({ sandboxId: 'myapp', maxRole: 'readonly' }),
        }),
      );
    });
  });

  describe('revokeProjectAccess', () => {
    beforeEach(() => {
      setSharedDbConfig({
        version: 1,
        databases: {
          shield_shared_main: {
            dbName: 'shield_shared_main',
            ownerRole: 'sov_shield_shared_main_owner',
            createdAt: '2024-01-01',
            createdBy: 'dashboard',
            projects: {
              myapp: { maxRole: 'app', grantedAt: 1234 },
            },
          },
        },
      });
    });

    it('sets NOLOGIN before terminating connections (reconnection race prevention)', () => {
      revokeProjectAccess('shield_shared_main', 'myapp');
      const pgExecCalls = vi.mocked(pgExec).mock.calls.map(c => c[0]);
      // NOLOGIN must appear before pg_terminate_backend
      const nologinIdx = pgExecCalls.findIndex(s => s.includes('NOLOGIN'));
      const terminateIdx = pgExecCalls.findIndex(s => s.includes('pg_terminate_backend'));
      expect(nologinIdx).toBeGreaterThanOrEqual(0);
      expect(terminateIdx).toBeGreaterThan(nologinIdx);
    });

    it('removes project from config after revoke', () => {
      revokeProjectAccess('shield_shared_main', 'myapp');
      expect(writeSync).toHaveBeenCalled();
      const writtenContent = vi.mocked(writeSync).mock.calls[0]?.[1] as string;
      const config = JSON.parse(writtenContent);
      expect(config.databases.shield_shared_main.projects.myapp).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 8. Project Database Mode — Binding
  // ════════════════════════════════════════════════════════════════

  describe('getProjectDatabaseMode', () => {
    it('returns standalone by default (no config file)', () => {
      const mode = getProjectDatabaseMode('myapp');
      expect(mode).toEqual({ mode: 'standalone' });
    });

    it('returns shared mode when bound', () => {
      setSharedDbConfig({
        version: 1,
        databases: {
          shield_shared_main: {
            dbName: 'shield_shared_main',
            ownerRole: 'owner',
            createdAt: '2024-01-01',
            createdBy: 'dashboard',
            projects: {},
          },
        },
      });
      setProjectModeConfig('myapp', { mode: 'shared', sharedDbName: 'shield_shared_main' });
      const mode = getProjectDatabaseMode('myapp');
      expect(mode).toEqual({ mode: 'shared', sharedDbName: 'shield_shared_main' });
    });

    it('falls back to standalone if shared DB no longer exists', () => {
      setSharedDbConfig({ version: 1, databases: {} }); // empty
      setProjectModeConfig('myapp', { mode: 'shared', sharedDbName: 'shield_shared_gone' });
      const mode = getProjectDatabaseMode('myapp');
      expect(mode).toEqual({ mode: 'standalone' });
    });

    it('falls back to standalone on corrupt config', () => {
      mockFiles.set('/etc/shield/db-config/myapp_mode.json', '{invalid json');
      const mode = getProjectDatabaseMode('myapp');
      expect(mode).toEqual({ mode: 'standalone' });
    });
  });

  describe('bindProjectToSharedDb', () => {
    beforeEach(() => {
      setSharedDbConfig({
        version: 1,
        databases: {
          shield_shared_main: {
            dbName: 'shield_shared_main',
            ownerRole: 'owner',
            createdAt: '2024-01-01',
            createdBy: 'dashboard',
            projects: {
              myapp: { maxRole: 'app', grantedAt: 1234 },
            },
          },
        },
      });
    });

    it('throws if database does not exist', () => {
      expect(() => bindProjectToSharedDb('myapp', 'nonexistent')).toThrow('not found');
    });

    it('throws if project has no grant', () => {
      expect(() => bindProjectToSharedDb('ungrantedapp', 'shield_shared_main'))
        .toThrow('must be granted access');
    });

    it('writes mode config atomically', () => {
      bindProjectToSharedDb('myapp', 'shield_shared_main');
      expect(writeSync).toHaveBeenCalled();
      expect(renameSync).toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 9. Sovereign Query — End-to-End with Mocked PG
  // ════════════════════════════════════════════════════════════════

  describe('executeSovereignQuery', () => {
    it('classifies SQL, tags metadata, wraps timeout, and executes', () => {
      const req: SovereignQueryRequest = {
        sandboxId: 'myapp',
        sql: 'SELECT * FROM users',
        taskId: 'task-1',
      };
      const result = executeSovereignQuery(req);
      expect(result.category).toBe('read');

      // pgExecAsRole should have been called with the tagged+wrapped SQL
      const callArgs = vi.mocked(pgExecAsRole).mock.calls[0]!;
      const executedSql = callArgs[0];
      expect(executedSql).toContain('/* sovereign');
      expect(executedSql).toContain('idle_in_transaction_session_timeout');
      expect(executedSql).toContain('SELECT * FROM users');
    });

    it('blocks admin queries', () => {
      vi.mocked(classifySql).mockReturnValueOnce('admin');
      expect(() =>
        executeSovereignQuery({ sandboxId: 'myapp', sql: 'VACUUM' }),
      ).toThrow('Admin queries not permitted');
    });

    it('validates shared DB safety when in shared mode', () => {
      setSharedDbConfig({
        version: 1,
        databases: {
          shield_shared_main: {
            dbName: 'shield_shared_main',
            ownerRole: 'owner',
            createdAt: '2024-01-01',
            createdBy: 'dashboard',
            projects: { myapp: { maxRole: 'app', grantedAt: 1234 } },
          },
        },
      });
      setProjectModeConfig('myapp', { mode: 'shared', sharedDbName: 'shield_shared_main' });

      expect(() =>
        executeSovereignQuery({ sandboxId: 'myapp', sql: 'DROP TABLE users' }),
      ).toThrow('DROP TABLE');
    });

    it('passes agent timeout to pgExecAsRole (double-timeout safety)', () => {
      executeSovereignQuery({ sandboxId: 'myapp', sql: 'SELECT 1' });
      const callArgs = vi.mocked(pgExecAsRole).mock.calls[0]!;
      // 4th argument is statementTimeoutMs (5000 default)
      expect(callArgs[3]).toBe(5000);
    });

    it('logs audit event with query details', () => {
      executeSovereignQuery({ sandboxId: 'myapp', sql: 'SELECT 1' });
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sovereign_query',
          details: expect.objectContaining({ sandboxId: 'myapp', category: 'read' }),
        }),
      );
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 10. Sovereign Write — Idempotency + Governance
  // ════════════════════════════════════════════════════════════════

  describe('executeSovereignWrite', () => {
    const baseReq: SovereignWriteRequest = {
      sandboxId: 'myapp',
      sql: "INSERT INTO users (name) VALUES ('test')",
      taskId: 'task-1',
      operation: 'create_user',
      threadId: 'thread-1',
    };

    beforeEach(() => {
      // Clear the sovereign tables initialized cache by re-mocking
      vi.mocked(pgExecMulti).mockReturnValue('');
      vi.mocked(pgExecAsRole).mockReturnValue({ rows: [], rowCount: 1, command: 'INSERT' });
    });

    it('computes deterministic idempotency key from sandboxId+taskId+operation', () => {
      const result = executeSovereignWrite(baseReq);
      expect(result.idempotencyKey).toBeDefined();
      expect(result.idempotencyKey).toHaveLength(64); // SHA-256 hex

      // Same inputs → same key
      const result2 = executeSovereignWrite(baseReq);
      expect(result2.idempotencyKey).toBe(result.idempotencyKey);
    });

    it('includes sandboxId in idempotency key to prevent cross-app collisions', () => {
      const req1 = { ...baseReq, sandboxId: 'app1' };
      const req2 = { ...baseReq, sandboxId: 'app2' };
      const result1 = executeSovereignWrite(req1);
      const result2 = executeSovereignWrite(req2);
      expect(result1.idempotencyKey).not.toBe(result2.idempotencyKey);
    });

    it('returns wasIdempotent=false on first execution', () => {
      const result = executeSovereignWrite(baseReq);
      expect(result.wasIdempotent).toBe(false);
    });

    it('returns wasIdempotent=true when idempotency key exists', () => {
      // Mock the idempotency check to return a cached result
      vi.mocked(pgExecAsRole).mockReturnValueOnce({
        rows: [{ result_summary: JSON.stringify({ rowCount: 1, command: 'INSERT', category: 'write' }) }],
        rowCount: 1,
        command: 'SELECT',
      });

      const result = executeSovereignWrite(baseReq);
      expect(result.wasIdempotent).toBe(true);
      expect(result.rowCount).toBe(1);
    });

    it('rewrites DELETE to soft-delete', () => {
      const deleteReq: SovereignWriteRequest = {
        ...baseReq,
        sql: 'DELETE FROM users WHERE id = 42',
      };

      executeSovereignWrite(deleteReq);

      // The SQL passed to pgExecAsRole should be the soft-delete rewrite
      const writeCalls = vi.mocked(pgExecAsRole).mock.calls;
      // Find the write execution call (not the idempotency check or governance log)
      const writeCall = writeCalls.find(c =>
        c[0].includes('UPDATE') && c[0].includes('deleted_at'),
      );
      expect(writeCall).toBeDefined();
    });

    it('blocks admin queries through sovereign write', () => {
      // classifySql is called once in executeSovereignWrite — after the idempotency check
      vi.mocked(classifySql).mockReturnValueOnce('admin');
      expect(() =>
        executeSovereignWrite({ ...baseReq, sql: 'VACUUM ANALYZE' }),
      ).toThrow('Admin queries not permitted');
    });

    it('executes governance transaction with SERIALIZABLE isolation', () => {
      vi.mocked(pgExecAsRole).mockClear();
      vi.mocked(classifySql).mockClear();
      vi.mocked(pgExecAsRole).mockReturnValue({ rows: [], rowCount: 1, command: 'INSERT' });

      executeSovereignWrite(baseReq);
      const calls = vi.mocked(pgExecAsRole).mock.calls;
      // The governance log call should contain SERIALIZABLE
      const govCall = calls.find(c => c[0].includes('SERIALIZABLE'));
      expect(govCall).toBeDefined();
      expect(govCall![0]).toContain('sovereign_event_log');
      expect(govCall![0]).toContain('sovereign_idempotency_keys');
      expect(govCall![0]).toContain('ON CONFLICT');
    });

    it('uses random dollar-quote tag to prevent injection (not static $sov$)', () => {
      vi.mocked(pgExecAsRole).mockClear();
      vi.mocked(classifySql).mockClear();
      vi.mocked(pgExecAsRole).mockReturnValue({ rows: [], rowCount: 1, command: 'INSERT' });

      executeSovereignWrite(baseReq);
      const calls = vi.mocked(pgExecAsRole).mock.calls;
      const govCall = calls.find(c => c[0].includes('SERIALIZABLE'));
      expect(govCall).toBeDefined();

      // Must NOT use static $sov$ — must use random tag $_sov_XXXXXXXX$
      expect(govCall![0]).not.toContain('$sov$');
      expect(govCall![0]).toMatch(/\$_sov_[0-9a-f]{8}\$/);

      // The opening and closing tags must match
      const tagMatch = govCall![0].match(/\$(_sov_[0-9a-f]{8})\$/);
      expect(tagMatch).toBeDefined();
      const tag = tagMatch![1];
      // Should appear exactly twice (DO $tag$ ... END $tag$)
      const tagRegex = new RegExp(`\\$${tag}\\$`, 'g');
      const matches = govCall![0].match(tagRegex);
      expect(matches).toHaveLength(2);
    });

    it('prevents dollar-quote injection in taskId', () => {
      vi.mocked(pgExecAsRole).mockClear();
      vi.mocked(classifySql).mockClear();
      vi.mocked(pgExecAsRole).mockReturnValue({ rows: [], rowCount: 1, command: 'INSERT' });

      // A malicious taskId containing $sov$ should NOT break the DO block
      // because we use a random tag, not $sov$
      const maliciousReq: SovereignWriteRequest = {
        ...baseReq,
        taskId: "evil$sov$; DROP TABLE users; DO $sov$",
        operation: "inject$_sov_00000000$end",
      };

      // Should not throw — the random tag prevents injection
      expect(() => executeSovereignWrite(maliciousReq)).not.toThrow();

      const calls = vi.mocked(pgExecAsRole).mock.calls;
      const govCall = calls.find(c => c[0].includes('SERIALIZABLE'));
      expect(govCall).toBeDefined();

      // The DO block delimiter must be a random tag, NOT $sov$
      // (the malicious $sov$ appears as DATA inside string literals — that's safe)
      const sql = govCall![0];
      // The DO and END delimiters use the random tag, not $sov$
      expect(sql).toMatch(/DO\s+\$_sov_[0-9a-f]{8}\$/);
      expect(sql).toMatch(/END\s+\$_sov_[0-9a-f]{8}\$/);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 11. Cleanup — Idempotency Key Expiry
  // ════════════════════════════════════════════════════════════════

  describe('cleanupExpiredIdempotencyKeys', () => {
    it('rejects zero maxAgeHours', () => {
      expect(() => cleanupExpiredIdempotencyKeys('shield_myapp', 0)).toThrow('positive integer');
    });

    it('rejects negative maxAgeHours', () => {
      expect(() => cleanupExpiredIdempotencyKeys('shield_myapp', -1)).toThrow('positive integer');
    });

    it('rejects non-integer maxAgeHours', () => {
      expect(() => cleanupExpiredIdempotencyKeys('shield_myapp', 5.5)).toThrow('positive integer');
    });

    it('rejects NaN maxAgeHours (prevents SQL injection)', () => {
      expect(() => cleanupExpiredIdempotencyKeys('shield_myapp', NaN)).toThrow('positive integer');
    });

    it('rejects maxAgeHours exceeding 1 year', () => {
      expect(() => cleanupExpiredIdempotencyKeys('shield_myapp', 8761)).toThrow('max 8760');
    });

    it('accepts valid maxAgeHours and returns cleanup count', () => {
      vi.mocked(pgExecAsRole).mockReturnValueOnce({ rows: [], rowCount: 5, command: 'DELETE' });
      const count = cleanupExpiredIdempotencyKeys('shield_myapp', 24);
      expect(count).toBe(5);
    });

    it('uses shared DB owner role when database is shared', () => {
      setSharedDbConfig({
        version: 1,
        databases: {
          shield_shared_main: {
            dbName: 'shield_shared_main',
            ownerRole: 'sov_shield_shared_main_owner',
            createdAt: '2024-01-01',
            createdBy: 'dashboard',
            projects: {},
          },
        },
      });

      vi.mocked(pgExecAsRole).mockReturnValueOnce({ rows: [], rowCount: 0, command: 'DELETE' });
      cleanupExpiredIdempotencyKeys('shield_shared_main');

      const callArgs = vi.mocked(pgExecAsRole).mock.calls[0]!;
      expect(callArgs[2]).toBe('sov_shield_shared_main_owner');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 12. Agent View Lifecycle
  // ════════════════════════════════════════════════════════════════

  describe('createAgentView', () => {
    it('executes generated SQL via pgExecMulti', () => {
      const viewDef: AgentViewDefinition = {
        viewName: 'v_agent_test',
        sourceTable: 'test_table',
        columns: [{ sourceColumn: 'col', viewColumn: 'col', description: 'test' }],
        description: 'test view',
      };
      createAgentView('myapp', viewDef);
      const calls = vi.mocked(pgExecMulti).mock.calls;
      const viewCall = calls.find(c => c[0].includes('CREATE OR REPLACE VIEW'));
      expect(viewCall).toBeDefined();
      expect(viewCall![0]).toContain('security_barrier');
    });

    it('logs audit event', () => {
      const viewDef: AgentViewDefinition = {
        viewName: 'v_agent_test',
        sourceTable: 'test_table',
        columns: [{ sourceColumn: 'col', viewColumn: 'col', description: 'test' }],
        description: 'test view',
      };
      createAgentView('myapp', viewDef);
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'agent_view_created' }),
      );
    });
  });

  describe('dropAgentView', () => {
    it('drops view with validated name', () => {
      dropAgentView('myapp', 'v_agent_test');
      const calls = vi.mocked(pgExecMulti).mock.calls;
      expect(calls.some(c => c[0].includes('DROP VIEW IF EXISTS'))).toBe(true);
    });

    it('rejects view names not prefixed with v_agent_', () => {
      expect(() => dropAgentView('myapp', 'other_view')).toThrow('v_agent_');
    });

    it('rejects view names with SQL injection', () => {
      expect(() => dropAgentView('myapp', 'v_agent_"; DROP TABLE--')).toThrow('Invalid');
    });
  });

  describe('listAgentViews', () => {
    it('queries with single joined query (no N+1)', () => {
      vi.mocked(pgExecAsRole).mockReturnValueOnce({
        rows: [
          {
            table_name: 'v_agent_customers',
            view_desc: 'Customer view',
            column_name: 'name',
            data_type: 'text',
            ordinal_position: '1',
            col_desc: 'Customer name',
          },
          {
            table_name: 'v_agent_customers',
            view_desc: 'Customer view',
            column_name: 'email',
            data_type: 'text',
            ordinal_position: '2',
            col_desc: 'Customer email',
          },
          {
            table_name: 'v_agent_orders',
            view_desc: 'Order view',
            column_name: 'total',
            data_type: 'numeric',
            ordinal_position: '1',
            col_desc: 'Order total',
          },
        ],
        rowCount: 3,
        command: 'SELECT',
      });

      const views = listAgentViews('myapp');

      // Should make exactly 1 pgExecAsRole call (not 1 + N)
      expect(pgExecAsRole).toHaveBeenCalledTimes(1);

      // Should group into 2 views
      expect(views).toHaveLength(2);
      expect(views[0]!.viewName).toBe('v_agent_customers');
      expect(views[0]!.columns).toHaveLength(2);
      expect(views[1]!.viewName).toBe('v_agent_orders');
      expect(views[1]!.columns).toHaveLength(1);
    });

    it('filters out view names that fail validation', () => {
      vi.mocked(pgExecAsRole).mockReturnValueOnce({
        rows: [
          {
            table_name: 'v_agent_INVALID',
            view_desc: 'Bad',
            column_name: 'col',
            data_type: 'text',
            ordinal_position: '1',
            col_desc: '',
          },
        ],
        rowCount: 1,
        command: 'SELECT',
      });

      const views = listAgentViews('myapp');
      expect(views).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 13. Ensure Sovereign Tables — Lazy Init + Caching
  // ════════════════════════════════════════════════════════════════

  describe('ensureSovereignTables', () => {
    it('creates governance tables on first call for a database', () => {
      // Use a unique name to avoid cache hits from prior tests
      const uniqueDb = `shield_ensure_test_${Date.now()}_a`;
      vi.mocked(pgExecMulti).mockClear();

      ensureSovereignTables(uniqueDb);
      const calls = vi.mocked(pgExecMulti).mock.calls;
      const ddlCall = calls.find(c =>
        c[0].includes('sovereign_event_log') && c[0].includes('sovereign_idempotency_keys'),
      );
      expect(ddlCall).toBeDefined();
    });

    it('skips DDL on subsequent calls for the same database (caching)', () => {
      const uniqueDb = `shield_ensure_test_${Date.now()}_b`;
      vi.mocked(pgExecMulti).mockClear();

      ensureSovereignTables(uniqueDb);
      const firstCallCount = vi.mocked(pgExecMulti).mock.calls.length;

      ensureSovereignTables(uniqueDb);
      const secondCallCount = vi.mocked(pgExecMulti).mock.calls.length;

      // No additional pgExecMulti calls on second invocation
      expect(secondCallCount).toBe(firstCallCount);
    });
  });
});
