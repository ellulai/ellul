// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Local Rule Store — SQLite rule management + materialization
 *
 * Source of Truth is a local SQLite database. Rules are materialized as .scm
 * files that the guardrail binary reads. The binary NEVER touches SQLite.
 *
 * Architecture:
 *   SQLite (source of truth) → materializeRules() → .scm files → guardrail binary
 *
 * Security:
 *   - rules.db at ~/.ellul/guardrails/rules.db (mode 0600)
 *   - Materialized .scm files at ~/.ellul/guardrails/{global,workspace}/
 *   - Workspace .ellul/policies/ is informational mirror only (scanner never reads)
 *   - Proposal flow: agent proposes → pending in SQLite → human approves → materialized
 *   - Locked rules cannot be disabled/modified/deleted
 *
 * Extracted and adapted from:
 *   packages/vps/src/services/auth/sovereign-shield/src/services/guardrail-sync.service.ts
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

// ── Constants ──

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS guardrail_rules (
    id          TEXT PRIMARY KEY,
    scope       TEXT NOT NULL CHECK(scope IN ('global', 'workspace')),
    language    TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    query_scm   TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT 'error' CHECK(severity IN ('error', 'warning')),
    message     TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    locked      INTEGER NOT NULL DEFAULT 0,
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope, language, name)
  );

  CREATE TABLE IF NOT EXISTS guardrail_analyzers (
    name        TEXT PRIMARY KEY,
    config      TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS guardrail_proposals (
    id          TEXT PRIMARY KEY,
    rule_id     TEXT,
    action      TEXT NOT NULL CHECK(action IN ('create', 'modify', 'disable', 'delete')),
    reason      TEXT NOT NULL,
    proposed_by TEXT NOT NULL DEFAULT 'agent',
    payload     TEXT,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
    decided_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (rule_id) REFERENCES guardrail_rules(id)
  );
`;

const MAX_PENDING_PROPOSALS = 10;
const SAFE_IDENTIFIER = /^[a-z][a-z0-9-]*$/;
const VALID_LANGUAGES = new Set(['go', 'python', 'javascript', 'typescript', 'rust', 'multi']);

// ── Default Rules ──

interface SeedRule {
  name: string;
  description: string;
  query_scm: string;
  message: string;
  locked: boolean;
}

const DEFAULT_RULES: SeedRule[] = [
  {
    name: 'no-drop-table',
    description: 'Blocks SQL DROP TABLE statements in string literals across all languages.',
    query_scm: `; @lang go
(interpreted_string_literal) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\\\s+[Tt][Aa][Bb][Ll][Ee]")

; @lang python
(string) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\\\s+[Tt][Aa][Bb][Ll][Ee]")

; @lang javascript typescript
(string
  (string_fragment) @violation
  (#match? @violation "[Dd][Rr][Oo][Pp]\\\\s+[Tt][Aa][Bb][Ll][Ee]"))

; @lang rust
(string_literal) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\\\s+[Tt][Aa][Bb][Ll][Ee]")`,
    message: 'SQL string contains "DROP TABLE". This operation is blocked by guardrail policy.',
    locked: true,
  },
  {
    name: 'no-drop-database',
    description: 'Blocks SQL DROP DATABASE statements in string literals across all languages.',
    query_scm: `; @lang go
(interpreted_string_literal) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\\\s+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]")

; @lang python
(string) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\\\s+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]")

; @lang javascript typescript
(string
  (string_fragment) @violation
  (#match? @violation "[Dd][Rr][Oo][Pp]\\\\s+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]"))

; @lang rust
(string_literal) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\\\s+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]")`,
    message: 'SQL string contains "DROP DATABASE". This operation is blocked by guardrail policy.',
    locked: true,
  },
  {
    name: 'no-recursive-delete',
    description: 'Blocks recursive filesystem deletion functions across all languages.',
    query_scm: `; @lang go
(call_expression
  function: (selector_expression
    operand: (identifier) @pkg
    field: (field_identifier) @method)
  (#eq? @pkg "os")
  (#eq? @method "RemoveAll")) @violation

; @lang python
(call
  function: (attribute
    object: (identifier) @pkg
    attribute: (identifier) @method)
  (#eq? @pkg "shutil")
  (#eq? @method "rmtree")) @violation

; @lang javascript typescript
(call_expression
  function: (member_expression
    object: (identifier) @pkg
    property: (property_identifier) @method)
  (#eq? @pkg "fs")
  (#match? @method "^(rmSync|rmdirSync)$")) @violation

; @lang rust
(call_expression
  function: (scoped_identifier
    path: (identifier) @pkg
    name: (identifier) @method)
  (#eq? @pkg "fs")
  (#eq? @method "remove_dir_all")) @violation`,
    message: 'Recursive deletion is blocked. Remove files individually or request explicit permission.',
    locked: true,
  },
];

// ── Types ──

export interface RuleRow {
  id: string;
  scope: string;
  language: string;
  name: string;
  description: string;
  query_scm: string;
  severity: string;
  message: string;
  enabled: number;
  locked: number;
}

export interface ProposalRow {
  id: string;
  rule_id: string | null;
  action: string;
  reason: string;
  proposed_by: string;
  payload: string | null;
  status: string;
  decided_at: string | null;
  created_at: string;
}

export interface RuleInput {
  scope?: string;
  language: string;
  name: string;
  description?: string;
  query_scm: string;
  severity?: string;
  message: string;
}

export interface ProposalInput {
  ruleId?: string;
  action: string;
  reason: string;
  payload?: Record<string, unknown>;
}

// ── Rule Store ──

export class LocalRuleStore {
  private db: InstanceType<typeof Database>;
  private storeDir: string;
  private globalDir: string;
  private workspaceDir: string;
  private analyzersPath: string;

  constructor(storeDir: string) {
    this.storeDir = storeDir;
    this.globalDir = path.join(storeDir, 'global');
    this.workspaceDir = path.join(storeDir, 'workspace');
    this.analyzersPath = path.join(storeDir, 'analyzers.json');

    fs.mkdirSync(this.globalDir, { recursive: true });
    fs.mkdirSync(this.workspaceDir, { recursive: true });

    const dbPath = path.join(storeDir, 'rules.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    // Restrict DB permissions
    try { fs.chmodSync(dbPath, 0o600); } catch { /* first open */ }

    // Seed default rules if empty
    const count = this.db.prepare('SELECT COUNT(*) as count FROM guardrail_rules').get() as { count: number };
    if (count.count === 0) {
      this.seedDefaultRules();
    }

    // Materialize on startup
    this.materializeRules();
  }

  // ── Seeding ──

  private seedDefaultRules(): void {
    const insert = this.db.prepare(`
      INSERT INTO guardrail_rules (id, scope, language, name, description, query_scm, severity, message, enabled, locked)
      VALUES (?, 'global', 'multi', ?, ?, ?, 'error', ?, 1, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const rule of DEFAULT_RULES) {
        insert.run(`default:${rule.name}`, rule.name, rule.description, rule.query_scm, rule.message, rule.locked ? 1 : 0);
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO guardrail_analyzers (name, config, enabled)
        VALUES ('aesthetics_max_depth', '{"threshold": 2}', 1)
      `).run();
    });

    tx();
  }

  // ── CRUD ──

  listRules(): RuleRow[] {
    return this.db.prepare(`
      SELECT id, scope, language, name, description, query_scm, severity, message, enabled, locked
      FROM guardrail_rules ORDER BY scope, language, name
    `).all() as RuleRow[];
  }

  addRule(input: RuleInput): string {
    const id = `custom:${input.language}_${input.name}`;
    this.db.prepare(`
      INSERT INTO guardrail_rules (id, scope, language, name, description, query_scm, severity, message, enabled, locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
    `).run(
      id,
      input.scope || 'workspace',
      input.language,
      input.name,
      input.description || '',
      input.query_scm,
      input.severity || 'error',
      input.message,
    );
    this.materializeRules();
    return id;
  }

  deleteRule(id: string): void {
    const rule = this.db.prepare('SELECT locked FROM guardrail_rules WHERE id = ?').get(id) as { locked: number } | undefined;
    if (!rule) throw new Error(`Rule not found: ${id}`);
    if (rule.locked) throw new Error(`Cannot delete locked rule: ${id}`);
    this.db.prepare('DELETE FROM guardrail_rules WHERE id = ?').run(id);
    this.materializeRules();
  }

  setRuleEnabled(id: string, enabled: boolean): void {
    const rule = this.db.prepare('SELECT locked FROM guardrail_rules WHERE id = ?').get(id) as { locked: number } | undefined;
    if (!rule) throw new Error(`Rule not found: ${id}`);
    if (rule.locked && !enabled) throw new Error(`Cannot disable locked rule: ${id}`);
    this.db.prepare('UPDATE guardrail_rules SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(enabled ? 1 : 0, id);
    this.materializeRules();
  }

  // ── Proposals ──

  createProposal(input: ProposalInput): string {
    // Rate limit: max pending proposals
    const pending = this.db.prepare(
      "SELECT COUNT(*) as count FROM guardrail_proposals WHERE status = 'pending'",
    ).get() as { count: number };
    if (pending.count >= MAX_PENDING_PROPOSALS) {
      throw new Error(`Maximum pending proposals (${MAX_PENDING_PROPOSALS}) reached. Approve or deny existing proposals first.`);
    }

    const id = `prop_${crypto.randomBytes(6).toString('hex')}`;
    this.db.prepare(`
      INSERT INTO guardrail_proposals (id, rule_id, action, reason, payload, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(id, input.ruleId || null, input.action, input.reason, input.payload ? JSON.stringify(input.payload) : null);

    return id;
  }

  listPendingProposals(): ProposalRow[] {
    return this.db.prepare(
      "SELECT * FROM guardrail_proposals WHERE status = 'pending' ORDER BY created_at",
    ).all() as ProposalRow[];
  }

  approveProposal(id: string): void {
    const proposal = this.db.prepare('SELECT * FROM guardrail_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    if (!proposal) throw new Error(`Proposal not found: ${id}`);
    if (proposal.status !== 'pending') throw new Error(`Proposal already ${proposal.status}`);

    const payload = proposal.payload ? JSON.parse(proposal.payload) as Record<string, string> : null;

    const tx = this.db.transaction(() => {
      switch (proposal.action) {
        case 'create':
          if (payload) {
            this.db.prepare(`
              INSERT INTO guardrail_rules (id, scope, language, name, description, query_scm, severity, message, enabled, locked)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
            `).run(
              `proposal:${id}`,
              payload.scope || 'workspace',
              payload.language || 'multi',
              payload.name || id,
              payload.description || '',
              payload.query_scm || '',
              payload.severity || 'error',
              payload.message || '',
            );
          }
          break;
        case 'disable':
          if (proposal.rule_id) {
            const rule = this.db.prepare('SELECT locked FROM guardrail_rules WHERE id = ?').get(proposal.rule_id) as { locked: number } | undefined;
            if (rule && !rule.locked) {
              this.db.prepare('UPDATE guardrail_rules SET enabled = 0, updated_at = datetime(\'now\') WHERE id = ?')
                .run(proposal.rule_id);
            }
          }
          break;
        case 'delete':
          if (proposal.rule_id) {
            const rule = this.db.prepare('SELECT locked FROM guardrail_rules WHERE id = ?').get(proposal.rule_id) as { locked: number } | undefined;
            if (rule && !rule.locked) {
              this.db.prepare('DELETE FROM guardrail_rules WHERE id = ?').run(proposal.rule_id);
            }
          }
          break;
      }

      this.db.prepare("UPDATE guardrail_proposals SET status = 'approved', decided_at = datetime('now') WHERE id = ?")
        .run(id);
    });

    tx();
    this.materializeRules();
  }

  denyProposal(id: string): void {
    const proposal = this.db.prepare('SELECT status FROM guardrail_proposals WHERE id = ?').get(id) as { status: string } | undefined;
    if (!proposal) throw new Error(`Proposal not found: ${id}`);
    if (proposal.status !== 'pending') throw new Error(`Proposal already ${proposal.status}`);

    this.db.prepare("UPDATE guardrail_proposals SET status = 'denied', decided_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  // ── Materialization ──

  /**
   * Materialize SQLite rules as .scm files in the daemon-controlled directories.
   * Also updates checksums.json for integrity restoration.
   */
  materializeRules(): void {
    // Clear existing files
    this.clearDir(this.globalDir);
    this.clearDir(this.workspaceDir);

    const rows = this.db.prepare(`
      SELECT scope, language, name, description, query_scm, severity, message
      FROM guardrail_rules WHERE enabled = 1
    `).all() as Array<{
      scope: string; language: string; name: string; description: string;
      query_scm: string; severity: string; message: string;
    }>;

    for (const row of rows) {
      const dir = row.scope === 'global' ? this.globalDir : this.workspaceDir;
      const filename = row.language === 'multi'
        ? `${row.name}.scm`
        : `${row.language}_${row.name}.scm`;
      const fullPath = path.join(dir, filename);

      // Path traversal defense
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(dir) + path.sep) && resolved !== path.resolve(dir)) {
        continue;
      }

      const content = [
        `; Rule: ${row.name}`,
        `; Severity: ${row.severity}`,
        `; Description: ${row.description}`,
        `; Message: ${row.message}`,
        '',
        row.query_scm,
      ].join('\n');

      fs.writeFileSync(fullPath, content, { mode: 0o644 });
    }

    // Materialize analyzer config
    const analyzers = this.db.prepare(
      'SELECT name, config FROM guardrail_analyzers WHERE enabled = 1',
    ).all() as Array<{ name: string; config: string }>;

    const analyzerConfig: Record<string, Record<string, unknown>> = {};
    for (const row of analyzers) {
      try {
        analyzerConfig[row.name] = { enabled: true, ...JSON.parse(row.config) };
      } catch { /* skip malformed */ }
    }

    fs.writeFileSync(this.analyzersPath, JSON.stringify(analyzerConfig, null, 2), { mode: 0o644 });

    // Update checksums
    this.updateChecksums();
  }

  private updateChecksums(): void {
    const checksums: Record<string, string> = {};

    for (const dir of [this.globalDir, this.workspaceDir]) {
      try {
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.scm')) continue;
          const content = fs.readFileSync(path.join(dir, file));
          checksums[file] = crypto.createHash('sha256').update(content).digest('hex');
        }
      } catch { /* dir may not exist */ }
    }

    fs.writeFileSync(
      path.join(this.storeDir, 'checksums.json'),
      JSON.stringify(checksums, null, 2),
      { mode: 0o600 },
    );
  }

  private clearDir(dir: string): void {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.scm')) {
          fs.unlinkSync(path.join(dir, file));
        }
      }
    } catch { /* dir may not exist */ }
  }

  // ── Proposal Ingestion ──

  /**
   * Ingest agent-proposed .scm files from a workspace's proposed/ directory.
   * Creates pending proposals in SQLite. Deletes .scm files after ingestion.
   */
  ingestProposedPolicies(workspaceDir: string): void {
    const proposedDir = path.join(workspaceDir, '.ellul', 'policies', 'proposed');
    let files: string[];
    try {
      files = fs.readdirSync(proposedDir).filter(f => f.endsWith('.scm'));
    } catch { return; }

    if (files.length === 0) return;

    for (const file of files) {
      const filePath = path.join(proposedDir, file);

      // Path traversal defense
      if (!path.resolve(filePath).startsWith(path.resolve(proposedDir) + path.sep)) continue;

      let src: string;
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 10240) { // 10KB limit
          try { fs.unlinkSync(filePath); } catch {}
          continue;
        }
        src = fs.readFileSync(filePath, 'utf8');
      } catch { continue; }

      // Parse filename: go_no-logging.scm → language=go, name=no-logging
      const basename = file.replace('.scm', '');
      const underscoreIdx = basename.indexOf('_');
      if (underscoreIdx < 1) { try { fs.unlinkSync(filePath); } catch {} continue; }

      const language = basename.slice(0, underscoreIdx);
      const ruleName = basename.slice(underscoreIdx + 1);

      if (!VALID_LANGUAGES.has(language)) { try { fs.unlinkSync(filePath); } catch {} continue; }
      if (!SAFE_IDENTIFIER.test(ruleName)) { try { fs.unlinkSync(filePath); } catch {} continue; }

      try {
        this.createProposal({
          action: 'create',
          reason: `Agent proposed: ${language}/${ruleName}`,
          payload: {
            scope: 'workspace',
            language,
            name: ruleName,
            query_scm: src.trim(),
            severity: 'error',
            message: `Custom policy: ${ruleName}`,
          },
        });
      } catch {
        // Max proposals reached or other error
      }

      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  /** Close the database. */
  close(): void {
    this.db.close();
  }
}
