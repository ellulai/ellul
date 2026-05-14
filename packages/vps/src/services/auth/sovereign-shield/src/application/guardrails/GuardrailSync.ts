// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Guardrail Rule Store — Local Sovereign Model
 *
 * The Source of Truth is a local SQLite database on the VPS host, NOT a
 * central cloud service. Zero-knowledge: the platform never sees user rules.
 *
 * Architecture (Host vs. Guest):
 *   - HOST (Sovereign Shield, trusted): owns the rule store, writes .scm files
 *   - GUEST (Agent namespace, untrusted): can only read the .scm files via
 *     read-only mount. Cannot access the SQLite DB, the management API, or
 *     any host process.
 *
 * Rule store location:
 *   /var/lib/ellul-shielded/guardrail-rules/
 *   ├── rules.db            ← SQLite database (Source of Truth, host-only)
 *   ├── global/             ← .scm files materialized from DB (read by binary)
 *   ├── workspace/          ← .scm files materialized from DB (read by binary)
 *   ├── analyzers.json      ← engine config materialized from DB
 *   └── .version            ← materialization watermark
 *
 * The guardrail binary reads .scm files from the materialized directories.
 * It never touches the SQLite DB directly. Sovereign-shield materializes
 * the DB contents into .scm files whenever rules change.
 *
 * HITL loop: When the agent proposes a rule change, the proposal is stored
 * in the local SQLite DB. The user sees it next time they open the dashboard
 * for this VPS. No cloud notification, no phone home.
 *
 * Default rules: On first boot (empty DB), sovereign-shield seeds the DB
 * with platform default rules. The user can then modify or remove any rule
 * via the local management API (passkey-gated).
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { logAuditEvent } from '../audit/Audit';

const STORE_DIR = '/var/lib/ellul-shielded/guardrail-rules';
const DB_PATH = path.join(STORE_DIR, 'rules.db');
const GLOBAL_DIR = path.join(STORE_DIR, 'global');
const WORKSPACE_DIR = path.join(STORE_DIR, 'workspace');
const ANALYZERS_PATH = path.join(STORE_DIR, 'analyzers.json');

// Type matches pattern in audit.service.ts, tier.service.ts, rate-limiter.ts
let db: Database | null = null;

// ── Schema ──────────────────────────────────────────────────

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

// ── Initialization ──────────────────────────────────────────

/**
 * Initialize the local rule store. Creates directories, opens SQLite DB,
 * applies schema, and seeds default rules if the DB is empty.
 *
 * Called once at sovereign-shield startup.
 */
export function initRuleStore(): void {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o755 });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true, mode: 0o755 });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // SECURITY: Restrict DB file permissions to owner-only (root:root 600).
  // Without this, the file inherits umask defaults (typically 644), making it
  // readable by the agent inside the namespace. The agent doesn't need to read
  // the DB — it reads the materialized .scm files instead.
  try {
    fs.chmodSync(DB_PATH, 0o600);
    // WAL and SHM journal files also need restricted permissions
    fs.chmodSync(DB_PATH + '-wal', 0o600);
  } catch {
    // WAL file may not exist yet on first write
  }

  // Seed default rules if DB is empty (first boot)
  const count = db.prepare('SELECT COUNT(*) as count FROM guardrail_rules').get() as { count: number };
  if (count.count === 0) {
    seedDefaultRules();
  }

  // Materialize .scm files from DB state
  materializeRules();
}

// ── Default Rule Seeding ────────────────────────────────────

interface SeedRule {
  name: string;
  description: string;
  query_scm: string;
  message: string;
  locked: boolean;
}

// Multi-language seed rules using ; @lang sections.
// One rule = one concept = one .scm file with per-language query sections.
// The Go binary's query_loader.go parses @lang markers and compiles each
// section against the correct grammar.
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
    message: 'ELLUL_SAFETY_ERROR: SQL string contains "DROP TABLE". This operation is blocked. If you need to drop a table, request the db_migrate gate via ellul_gate_request and use a migration framework.',
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
    message: 'ELLUL_SAFETY_ERROR: SQL string contains "DROP DATABASE". This operation is blocked.',
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

(call
  function: (attribute
    object: (identifier) @pkg2
    attribute: (identifier) @method2)
  (#eq? @pkg2 "os")
  (#eq? @method2 "removedirs")) @violation

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
    message: 'ELLUL_SAFETY_ERROR: Recursive deletion is blocked. Remove files individually or request explicit permission from the human user.',
    locked: true,
  },
];

function seedDefaultRules(): void {
  if (!db) return;

  const insert = db.prepare(`
    INSERT INTO guardrail_rules (id, scope, language, name, description, query_scm, severity, message, enabled, locked)
    VALUES (?, 'global', 'multi', ?, ?, ?, 'error', ?, 1, ?)
  `);

  const seedTx = db.transaction(() => {
    for (const rule of DEFAULT_RULES) {
      const id = `default:${rule.name}`;
      insert.run(id, rule.name, rule.description, rule.query_scm, rule.message, rule.locked ? 1 : 0);
    }

    // Seed default analyzer config
    db!.prepare(`
      INSERT OR IGNORE INTO guardrail_analyzers (name, config, enabled)
      VALUES ('aesthetics_max_depth', '{"threshold": 2}', 1)
    `).run();
  });

  seedTx();
}

// ── Materialization ─────────────────────────────────────────

/**
 * Materialize the SQLite DB state into .scm files and analyzers.json.
 *
 * The guardrail binary reads .scm files, not SQLite. This function is the
 * bridge between the Source of Truth (SQLite) and the execution engine.
 *
 * Called after any rule modification (add, update, delete, enable/disable).
 */
export function materializeRules(): void {
  if (!db) return;

  // Clear existing materialized files
  clearDir(GLOBAL_DIR);
  clearDir(WORKSPACE_DIR);

  // Materialize enabled rules
  const rows = db.prepare(`
    SELECT scope, language, name, description, query_scm, severity, message
    FROM guardrail_rules WHERE enabled = 1
  `).all() as Array<{
    scope: string;
    language: string;
    name: string;
    description: string;
    query_scm: string;
    severity: string;
    message: string;
  }>;

  for (const row of rows) {
    const dir = row.scope === 'global' ? GLOBAL_DIR : WORKSPACE_DIR;
    // Multi-language rules: just <name>.scm. Single-language: <lang>_<name>.scm.
    const filename = row.language === 'multi'
      ? `${row.name}.scm`
      : `${row.language}_${row.name}.scm`;
    const fullPath = path.join(dir, filename);

    // SECURITY: Defense-in-depth — verify the resolved path stays within the
    // expected directory. Prevents path traversal even if validation is bypassed.
    const resolvedPath = path.resolve(fullPath);
    const resolvedDir = path.resolve(dir);
    if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
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
  const analyzers = db.prepare(`
    SELECT name, config FROM guardrail_analyzers WHERE enabled = 1
  `).all() as Array<{ name: string; config: string }>;

  const analyzerConfig: Record<string, Record<string, unknown>> = {};
  for (const row of analyzers) {
    try {
      const parsed = JSON.parse(row.config);
      analyzerConfig[row.name] = { enabled: true, ...parsed };
    } catch { /* skip malformed config */ }
  }

  fs.writeFileSync(ANALYZERS_PATH, JSON.stringify(analyzerConfig, null, 2), { mode: 0o644 });

  // Materialize read-only .scm files into each workspace's .ellul/policies/ folder.
  // The agent reads these to understand its constraints. Files are root:root 0444.
  materializeWorkspacePolicies(rows);

  // Refresh CLI context files (CLAUDE.md, AGENTS.md) so the guardrail rules
  // are injected into the agent's system prompt via the Code Guardrails section.
  refreshAllProjectContexts();
}

// ── Workspace Policies Folder ────────────────────────────────

const PROJECTS_DIR = '/var/lib/ellul-shielded/projects';

/**
 * Materialize active rules as read-only .scm files into each workspace's
 * .ellul/policies/ folder. This is the agent-visible policy mirror.
 *
 * Permissions:
 *   .ellul/policies/*.scm  — root:root 0444 (agent can read, cannot modify/delete)
 *   .ellul/policies/proposed/ — svcUser:svcUser 0755 (agent can write proposals)
 *
 * The guardrail binary reads .ellul/policies/ as one of its --rules directories.
 * The proposed/ subdirectory is NOT read by the binary — only active rules in the
 * parent folder are enforced.
 */
function materializeWorkspacePolicies(
  rows: Array<{ scope: string; language: string; name: string; query_scm: string; severity: string; message: string }>,
): void {
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR);
  } catch { return; }

  const svcUser = fs.existsSync('/home/coder') ? 'coder' : 'dev';
  const { execFileSync } = require('child_process') as typeof import('child_process');

  for (const projectDir of projectDirs) {
    const workspaceDir = path.join(PROJECTS_DIR, projectDir, 'workspace');
    if (!fs.existsSync(workspaceDir)) continue;

    const policiesDir = path.join(workspaceDir, '.ellul', 'policies');
    const proposedDir = path.join(policiesDir, 'proposed');

    // Ensure directories exist
    fs.mkdirSync(policiesDir, { recursive: true });
    fs.mkdirSync(proposedDir, { recursive: true });

    // Clear existing read-only .scm files from policies/ root.
    // Need to chmod 0644 first since root owns them at 0444.
    try {
      for (const file of fs.readdirSync(policiesDir)) {
        if (!file.endsWith('.scm')) continue;
        const fp = path.join(policiesDir, file);
        try {
          fs.chmodSync(fp, 0o644);
          fs.unlinkSync(fp);
        } catch { /* skip if can't delete */ }
      }
    } catch { /* dir may not exist */ }

    // Write active rules as read-only .scm files
    for (const row of rows) {
      const filename = `${row.language}_${row.name}.scm`;
      const fullPath = path.join(policiesDir, filename);

      // Path traversal defense-in-depth
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(policiesDir) + path.sep)) continue;

      const content = [
        `; Rule: ${row.name}`,
        `; Severity: ${row.severity}`,
        `; Message: ${row.message}`,
        `; Scope: ${row.scope}`,
        `; Locked: ${row.scope === 'global' ? 'true' : 'false'}`,
        '',
        row.query_scm,
      ].join('\n');

      fs.writeFileSync(fullPath, content, { mode: 0o444 });
    }

    // Ensure proposed/ is writable by service user for agent proposals.
    // The parent policies/ dir stays root-owned — only proposed/ is agent-writable.
    try {
      execFileSync('chown', ['-R', `${svcUser}:${svcUser}`, proposedDir], { stdio: 'ignore' });
    } catch { /* non-fatal */ }
  }
}

/**
 * Ingest agent-proposed .scm files from .ellul/policies/proposed/.
 *
 * Called before the guardrail scan in exec.routes.ts. Any .scm files the agent
 * dropped in the proposed/ folder are ingested as pending proposals in the
 * SQLite DB, then deleted from the folder.
 *
 * The proposals require human approval via the dashboard. They are NOT
 * immediately active — the guardrail binary does not read from proposed/.
 *
 * Security:
 *   - Agent can only ADD proposals, not modify or delete active rules
 *   - Proposals are rate-limited (max 10 pending in createProposal)
 *   - Malformed .scm files are silently skipped
 *   - The .scm file is deleted after ingestion regardless of success
 */
export function ingestProposedPolicies(workspaceDir: string): void {
  const proposedDir = path.join(workspaceDir, '.ellul', 'policies', 'proposed');

  let files: string[];
  try {
    files = fs.readdirSync(proposedDir).filter(f => f.endsWith('.scm'));
  } catch { return; }

  if (files.length === 0) {
    // Clean up stale .rejected files older than 1 hour
    try {
      const allFiles = fs.readdirSync(proposedDir);
      const oneHourAgo = Date.now() - 3600_000;
      for (const f of allFiles) {
        if (!f.endsWith('.rejected')) continue;
        const fp = path.join(proposedDir, f);
        try {
          if (fs.statSync(fp).mtimeMs < oneHourAgo) fs.unlinkSync(fp);
        } catch {}
      }
    } catch {}
    return;
  }

  for (const file of files) {
    const filePath = path.join(proposedDir, file);

    // Path traversal defense
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(proposedDir) + path.sep)) continue;

    let src: string;
    try {
      // Size limit per .scm file to prevent abuse
      const stat = fs.statSync(filePath);
      if (stat.size > 10240) {
        rejectProposal(proposedDir, file, filePath,
          `File exceeds size limit (${stat.size} bytes). Reduce the query size.`);
        continue;
      }
      src = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    // Parse filename: go_no-logging.scm → language=go, name=no-logging
    const basename = file.replace('.scm', '');
    const underscoreIdx = basename.indexOf('_');
    if (underscoreIdx < 1) {
      rejectProposal(proposedDir, file, filePath,
        `Invalid filename format. Expected <language>_<rule-name>.scm (e.g., go_no-panic.scm). ` +
        `Got "${file}".`);
      continue;
    }

    const language = basename.slice(0, underscoreIdx);
    const ruleName = basename.slice(underscoreIdx + 1);

    // Validate language
    if (!VALID_LANGUAGES.has(language)) {
      rejectProposal(proposedDir, file, filePath,
        `Unknown language "${language}". Supported: ${[...VALID_LANGUAGES].join(', ')}. ` +
        `Rename the file to use a valid language prefix.`);
      continue;
    }

    // Validate rule name
    if (!SAFE_IDENTIFIER.test(ruleName)) {
      rejectProposal(proposedDir, file, filePath,
        `Invalid rule name "${ruleName}". Must match /^[a-z][a-z0-9-]*$/ ` +
        `(lowercase letters, digits, hyphens only, starting with a letter).`);
      continue;
    }
    if (ruleName.length > 64) {
      rejectProposal(proposedDir, file, filePath,
        `Rule name "${ruleName}" is too long (${ruleName.length} chars). Max 64 characters.`);
      continue;
    }

    // Extract metadata from .scm header comments
    const meta = parseQueryMeta(Buffer.from(src));
    const queryBody = stripQueryComments(Buffer.from(src));

    if (!queryBody.trim()) {
      rejectProposal(proposedDir, file, filePath,
        `Empty query body. The .scm file must contain a tree-sitter S-expression query ` +
        `after the header comments. Example:\n` +
        `(call_expression\n  function: (identifier) @fn\n  (#eq? @fn "panic")) @violation`);
      continue;
    }

    // Create as proposal (NOT active rule). Requires human approval.
    try {
      createProposal({
        action: 'create',
        reason: `Agent proposed policy: ${language}/${ruleName}` +
          (meta.message ? ` — ${meta.message}` : ''),
        payload: {
          scope: 'workspace',
          language,
          name: ruleName,
          query_scm: queryBody,
          severity: meta.severity === 1 ? 'warning' : 'error', // 1 = SeverityWarning
          message: meta.message || `Custom policy: ${ruleName}`,
        },
      });

      logAuditEvent({
        type: 'guardrail_proposal_ingested',
        details: { file, language, ruleName, message: meta.message },
      });
    } catch (err) {
      rejectProposal(proposedDir, file, filePath,
        `Proposal rejected: ${(err as Error).message}`);
      continue;
    }

    // Success — delete the .scm file (it's now in the DB as a pending proposal)
    try { fs.unlinkSync(filePath); } catch {}
  }
}

/**
 * Reject a proposed .scm file: delete it, write a .rejected feedback file
 * so the agent knows WHY its proposal failed, and log an audit event so
 * the human can see it in the dashboard.
 *
 * The .rejected file is written to the same proposed/ directory with the
 * same name + .rejected suffix. The agent can read this to understand the
 * error and fix its next attempt.
 */
function rejectProposal(
  proposedDir: string,
  originalFile: string,
  filePath: string,
  reason: string,
): void {
  // Delete the malformed .scm file
  try { fs.unlinkSync(filePath); } catch {}

  // Write feedback file so the agent can read the rejection reason.
  // .rejected files are plain text — the agent reads them to self-correct.
  const rejectPath = path.join(proposedDir, `${originalFile}.rejected`);
  try {
    const feedback = [
      `PROPOSAL REJECTED: ${originalFile}`,
      `Timestamp: ${new Date().toISOString()}`,
      '',
      `Reason: ${reason}`,
      '',
      'To fix: correct the issue described above and drop a new .scm file',
      'into .ellul/policies/proposed/ with the proper format:',
      '',
      '  Filename: <language>_<rule-name>.scm',
      '  Languages: go, python, javascript, typescript, rust',
      '  Header: ; Rule: <name>',
      '          ; Severity: error|warning',
      '          ; Message: <what this rule blocks and how to fix>',
      '  Body: tree-sitter S-expression query with @violation capture',
    ].join('\n');

    fs.writeFileSync(rejectPath, feedback, { mode: 0o644 });
  } catch { /* non-fatal — feedback is best-effort */ }

  // Audit event — visible in dashboard so the human knows the agent
  // is attempting (and failing) to propose policy changes.
  logAuditEvent({
    type: 'guardrail_proposal_rejected',
    details: { file: originalFile, reason },
  });
}

/**
 * Refresh CLI context files (CLAUDE.md, AGENTS.md, GEMINI.md) for all projects.
 *
 * The context script (ellul-ctx) reads the materialized .scm files from
 * the guardrail-rules directory and appends a "Code Guardrails" section to
 * the generated context files. This means the agent sees ALL rules in its
 * system prompt before writing any code — zero wasted tokens on discovery.
 *
 * Called after every rule change (add, update, delete, enable/disable).
 */
function refreshAllProjectContexts(): void {
  const CONTEXT_SCRIPT = '/usr/local/bin/ellul-ctx';
  const PROJECTS_DIR = '/var/lib/ellul-shielded/projects';

  try {
    if (!fs.existsSync(CONTEXT_SCRIPT)) return;

    const projectDirs = fs.readdirSync(PROJECTS_DIR);
    for (const projectDir of projectDirs) {
      const workspaceDir = path.join(PROJECTS_DIR, projectDir, 'workspace');
      if (!fs.existsSync(workspaceDir)) continue;

      try {
        const { execFileSync } = require('child_process') as typeof import('child_process');
        execFileSync(CONTEXT_SCRIPT, [workspaceDir], { timeout: 10000, stdio: 'ignore' });
      } catch {
        // Non-fatal — context refresh failure doesn't block rule changes
      }
    }
  } catch {
    // No projects yet or PROJECTS_DIR doesn't exist — skip silently
  }
}

// ── Rule CRUD (called by management API routes) ─────────────

// SECURITY: Strict validation for rule identifiers to prevent path traversal
// in materializeRules() which writes to `${language}_${name}.scm`.
const SAFE_IDENTIFIER = /^[a-z][a-z0-9-]*$/;
const VALID_LANGUAGES = new Set(['go', 'python', 'javascript', 'typescript', 'rust', 'multi']);

function validateRuleIdentifier(field: string, value: string): void {
  if (!value || value.length > 64) {
    throw new Error(`Rule ${field} must be 1-64 characters`);
  }
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Rule ${field} "${value}" contains invalid characters. Only lowercase letters, digits, and hyphens allowed.`);
  }
}

/**
 * Add a new rule. Returns the rule ID.
 * Locked rules can only be added by the system (not user).
 */
export function addRule(params: {
  scope: 'global' | 'workspace';
  language: string;
  name: string;
  description?: string;
  query_scm: string;
  severity?: 'error' | 'warning';
  message: string;
  locked?: boolean;
}): string {
  if (!db) throw new Error('Rule store not initialized');

  // SECURITY: Validate identifiers to prevent path traversal in materializeRules().
  // filename = `${language}_${name}.scm` — if name contains "../", file writes outside dir.
  if (!VALID_LANGUAGES.has(params.language)) {
    throw new Error(`Invalid language "${params.language}". Supported: ${[...VALID_LANGUAGES].join(', ')}`);
  }
  validateRuleIdentifier('name', params.name);

  const id = `${params.scope}:${params.language}:${params.name}`;
  db.prepare(`
    INSERT INTO guardrail_rules (id, scope, language, name, description, query_scm, severity, message, locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.scope,
    params.language,
    params.name,
    params.description || '',
    params.query_scm,
    params.severity || 'error',
    params.message,
    params.locked ? 1 : 0,
  );

  materializeRules();
  return id;
}

/**
 * Enable or disable a rule. Locked rules cannot be disabled.
 */
export function setRuleEnabled(ruleId: string, enabled: boolean): void {
  if (!db) throw new Error('Rule store not initialized');

  // Check lock
  const rule = db.prepare('SELECT locked FROM guardrail_rules WHERE id = ?').get(ruleId) as { locked: number } | undefined;
  if (!rule) throw new Error(`Rule ${ruleId} not found`);
  if (rule.locked && !enabled) throw new Error(`Rule ${ruleId} is locked and cannot be disabled`);

  db.prepare(`UPDATE guardrail_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(enabled ? 1 : 0, ruleId);

  materializeRules();
}

/**
 * Delete a rule. Locked rules cannot be deleted.
 */
export function deleteRule(ruleId: string): void {
  if (!db) throw new Error('Rule store not initialized');

  const rule = db.prepare('SELECT locked FROM guardrail_rules WHERE id = ?').get(ruleId) as { locked: number } | undefined;
  if (!rule) throw new Error(`Rule ${ruleId} not found`);
  if (rule.locked) throw new Error(`Rule ${ruleId} is locked and cannot be deleted`);

  db.prepare('DELETE FROM guardrail_rules WHERE id = ?').run(ruleId);
  materializeRules();
}

/**
 * List all rules (for dashboard display).
 */
export function listRules(): Array<{
  id: string;
  scope: string;
  language: string;
  name: string;
  description: string;
  severity: string;
  message: string;
  query_scm: string;
  enabled: boolean;
  locked: boolean;
}> {
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM guardrail_rules ORDER BY scope, language, name').all() as any[];
  return rows.map(r => ({
    id: r.id,
    scope: r.scope,
    language: r.language,
    name: r.name,
    description: r.description || '',
    severity: r.severity,
    message: r.message,
    query_scm: r.query_scm,
    enabled: !!r.enabled,
    locked: !!r.locked,
  }));
}

// ── Agent Proposals (HITL) ──────────────────────────────────

/**
 * Create a proposal from the agent. Stored locally, visible in dashboard.
 * No cloud notification. No phone home.
 */
export function createProposal(params: {
  ruleId?: string;
  action: 'create' | 'modify' | 'disable' | 'delete';
  reason: string;
  payload?: Record<string, unknown>;
}): string {
  if (!db) throw new Error('Rule store not initialized');

  // SECURITY: Block ALL proposals targeting locked rules (disable, delete, AND modify).
  // Without this check, an agent could propose modifying a locked rule's query_scm to
  // neuter the safety rule (e.g., change DROP TABLE detection to match comments instead).
  if (params.ruleId) {
    const rule = db.prepare('SELECT locked FROM guardrail_rules WHERE id = ?').get(params.ruleId) as { locked: number } | undefined;
    if (rule?.locked) {
      throw new Error(`Rule ${params.ruleId} is locked by the platform. It cannot be modified, disabled, or deleted.`);
    }
  }

  // Rate limit: max 10 pending proposals per VPS to prevent disk-fill DoS
  const pendingCount = db.prepare('SELECT COUNT(*) as count FROM guardrail_proposals WHERE status = ?').get('pending') as { count: number };
  if (pendingCount.count >= 10) {
    throw new Error('Too many pending proposals. Approve or deny existing proposals before submitting new ones.');
  }

  const id = `proposal:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO guardrail_proposals (id, rule_id, action, reason, payload, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(id, params.ruleId || null, params.action, params.reason, JSON.stringify(params.payload || {}));

  return id;
}

/**
 * List pending proposals (for dashboard).
 */
export function listPendingProposals(): Array<{
  id: string;
  rule_id: string | null;
  action: string;
  reason: string;
  payload: string;
  created_at: string;
}> {
  if (!db) return [];
  return db.prepare(`
    SELECT id, rule_id, action, reason, payload, created_at
    FROM guardrail_proposals WHERE status = 'pending'
    ORDER BY created_at DESC
  `).all() as any[];
}

/**
 * Approve a proposal. Applies the change to the rule store.
 */
export function approveProposal(proposalId: string): void {
  if (!db) throw new Error('Rule store not initialized');

  const proposal = db.prepare('SELECT * FROM guardrail_proposals WHERE id = ?').get(proposalId) as any;
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  if (proposal.status !== 'pending') throw new Error(`Proposal ${proposalId} is already ${proposal.status}`);

  // SECURITY: Defense-in-depth — re-check locked flag at approval time.
  // The proposal creation already blocks locked rules, but a rule could have
  // been locked AFTER the proposal was created. Belt AND suspenders.
  if (proposal.rule_id) {
    const targetRule = db.prepare('SELECT locked FROM guardrail_rules WHERE id = ?').get(proposal.rule_id) as { locked: number } | undefined;
    if (targetRule?.locked) {
      // Auto-deny: mark as denied and return
      db.prepare(`UPDATE guardrail_proposals SET status = 'denied', decided_at = datetime('now') WHERE id = ?`)
        .run(proposalId);
      throw new Error(`Rule ${proposal.rule_id} is locked. Proposal auto-denied.`);
    }
  }

  // Apply the action
  const payload = JSON.parse(proposal.payload || '{}');

  switch (proposal.action) {
    case 'disable':
      if (proposal.rule_id) setRuleEnabled(proposal.rule_id, false);
      break;
    case 'delete':
      if (proposal.rule_id) deleteRule(proposal.rule_id);
      break;
    case 'create':
      addRule(payload as any);
      break;
    case 'modify':
      if (proposal.rule_id && payload.query_scm) {
        // Locked check already done above — this is for non-locked rules only
        db.prepare(`UPDATE guardrail_rules SET query_scm = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(payload.query_scm, proposal.rule_id);
        materializeRules();
      }
      break;
  }

  // Mark approved
  db.prepare(`UPDATE guardrail_proposals SET status = 'approved', decided_at = datetime('now') WHERE id = ?`)
    .run(proposalId);
}

/**
 * Deny a proposal.
 */
export function denyProposal(proposalId: string): void {
  if (!db) throw new Error('Rule store not initialized');
  db.prepare(`UPDATE guardrail_proposals SET status = 'denied', decided_at = datetime('now') WHERE id = ?`)
    .run(proposalId);
}

// ── Helpers ─────────────────────────────────────────────────

function clearDir(dirPath: string): void {
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (file.endsWith('.scm')) {
        fs.unlinkSync(path.join(dirPath, file));
      }
    }
  } catch { /* dir may not exist yet */ }
}

/**
 * Parse metadata from .scm file header comments.
 * Extracts ; Rule:, ; Severity:, ; Message: fields.
 */
function parseQueryMeta(src: Buffer): { name: string; severity: number; message: string } {
  const meta = { name: '', severity: 0, message: '' }; // 0 = error, 1 = warning
  for (const line of src.toString('utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(';')) continue;
    const content = trimmed.slice(1).trim();
    if (content.startsWith('Rule:')) {
      meta.name = content.slice(5).trim();
    } else if (content.startsWith('Severity:')) {
      meta.severity = content.slice(9).trim().toLowerCase() === 'warning' ? 1 : 0;
    } else if (content.startsWith('Message:')) {
      meta.message = content.slice(8).trim();
    }
  }
  return meta;
}

/**
 * Strip comment lines from .scm source, leaving only the query body.
 */
function stripQueryComments(src: Buffer): string {
  return src
    .toString('utf8')
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith(';');
    })
    .join('\n');
}
