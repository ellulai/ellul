// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault Scope Service
 *
 * Manages scoped knowledge projections — the policy layer that determines
 * what each principal can see in a vault.
 *
 * Core concepts:
 *   - Scope: A named rule set (folder globs, tags, frontmatter, explicit paths)
 *   - Scope Membership: Materialized set of note IDs that match a scope's rules
 *   - Vault Session: Binds an agent to a specific scope for the duration of a gate grant
 *   - Phantom Nodes: Opaque boundary indicators (when boundary_disclosure = true)
 *   - Backlink Clamping: Quantized restricted backlink counts (anti-side-channel)
 *
 * Security invariants:
 *   - Scope membership is materialized at the scope level; principal-specific
 *     restrictions are applied at query resolution time
 *   - Agents do NOT see phantom/boundary nodes by default
 *   - Graph traversal is always against the principal-resolved scoped graph view,
 *     never against the raw edges table
 *   - Uniform 404 for out-of-scope AND non-existent (no existence leakage)
 *   - Vault session projection_ver checked on every request (stale = rejected)
 */

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import path from 'path';
import {
  type ScopeRuleSet,
  type ScopeRule,
  type VaultScope,
  type VaultSession,
  type ClampedCount,
  clampBacklinkCount,
} from '@vps/shared/vault-types';

// ═══════════════════════════════════════════════════════════════════
// Simple Glob Matching (no external dependency)
// ═══════════════════════════════════════════════════════════════════

/**
 * Simple glob match -- supports *, **, and ? patterns.
 * Case-insensitive. No external dependency.
 */
function simpleGlobMatch(filepath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .split('**')
    .map((segment) =>
      segment
        .split('*')
        .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.'))
        .join('[^/]*'),
    )
    .join('.*');
  try {
    return new RegExp(`^${regexStr}$`, 'i').test(filepath);
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Scope CRUD
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a new scope with the given rules.
 * Only one scope can be the agent default per vault.
 */
export function createScope(
  db: Database,
  name: string,
  rules: ScopeRuleSet,
  description?: string,
  isAgentDefault = false,
): VaultScope {
  validateScopeName(name);
  validateScopeRules(rules);

  const now = Date.now();

  // If this is the new agent default, clear the flag on all existing scopes
  if (isAgentDefault) {
    db.prepare('UPDATE scopes SET is_agent_default = 0 WHERE is_agent_default = 1').run();
  }

  const result = db.prepare(`
    INSERT INTO scopes (name, description, rules, is_agent_default, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(name, description || null, JSON.stringify(rules), isAgentDefault ? 1 : 0, now, now);

  const scopeId = Number(result.lastInsertRowid);

  // Materialize membership immediately
  materializeScopeMembership(db, scopeId, rules);

  return {
    id: scopeId,
    name,
    description: description || null,
    rules,
    isAgentDefault,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update scope rules. Increments version, rebuilds membership,
 * and invalidates all vault sessions using this scope.
 */
export function updateScope(
  db: Database,
  scopeId: number,
  updates: { rules?: ScopeRuleSet; description?: string; isAgentDefault?: boolean },
): VaultScope | null {
  const existing = getScopeById(db, scopeId);
  if (!existing) return null;

  if (updates.rules) validateScopeRules(updates.rules);

  const now = Date.now();
  const newRules = updates.rules ?? existing.rules;
  const newVersion = existing.version + 1;

  if (updates.isAgentDefault) {
    db.prepare('UPDATE scopes SET is_agent_default = 0 WHERE is_agent_default = 1').run();
  }

  db.prepare(`
    UPDATE scopes SET
      rules = ?,
      description = COALESCE(?, description),
      is_agent_default = COALESCE(?, is_agent_default),
      version = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(newRules),
    updates.description ?? null,
    updates.isAgentDefault != null ? (updates.isAgentDefault ? 1 : 0) : null,
    newVersion,
    now,
    scopeId,
  );

  // Rebuild membership
  materializeScopeMembership(db, scopeId, newRules);

  // Invalidate all vault sessions using this scope
  invalidateVaultSessionsByScope(db, scopeId);

  return getScopeById(db, scopeId);
}

/**
 * Delete a scope. CASCADE handles scope_membership cleanup.
 * Invalidates all vault sessions using this scope.
 */
export function deleteScope(db: Database, scopeId: number): boolean {
  invalidateVaultSessionsByScope(db, scopeId);
  const result = db.prepare('DELETE FROM scopes WHERE id = ?').run(scopeId);
  return result.changes > 0;
}

export function getScopeById(db: Database, scopeId: number): VaultScope | null {
  const row = db.prepare('SELECT * FROM scopes WHERE id = ?').get(scopeId) as any;
  return row ? rowToScope(row) : null;
}

export function getScopeByName(db: Database, name: string): VaultScope | null {
  const row = db.prepare('SELECT * FROM scopes WHERE name = ?').get(name) as any;
  return row ? rowToScope(row) : null;
}

export function getAgentDefaultScope(db: Database): VaultScope | null {
  const row = db.prepare('SELECT * FROM scopes WHERE is_agent_default = 1 LIMIT 1').get() as any;
  return row ? rowToScope(row) : null;
}

export function listScopes(db: Database): VaultScope[] {
  const rows = db.prepare('SELECT * FROM scopes ORDER BY name').all();
  return rows.map((r: any) => rowToScope(r));
}

function rowToScope(row: any): VaultScope {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: JSON.parse(row.rules),
    isAgentDefault: row.is_agent_default === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Scope Membership Materialization
// ═══════════════════════════════════════════════════════════════════

/**
 * Evaluate scope rules against a note and return whether it's included.
 * Rules are evaluated top-to-bottom; last matching rule wins.
 */
export function evaluateNoteInScope(
  notePath: string,
  noteTags: string[],
  noteFrontmatter: Record<string, unknown> | null,
  rules: ScopeRuleSet,
): boolean {
  let result = rules.default === 'include';

  for (const rule of rules.rules) {
    const matches = evaluateRule(rule, notePath, noteTags, noteFrontmatter);
    if (matches) {
      result = rule.action === 'include';
    }
  }

  return result;
}

function evaluateRule(
  rule: ScopeRule,
  notePath: string,
  noteTags: string[],
  noteFrontmatter: Record<string, unknown> | null,
): boolean {
  switch (rule.type) {
    case 'folder_glob':
      return simpleGlobMatch(notePath, rule.pattern);

    case 'tag':
      return noteTags.some(t => {
        const ruleTag = rule.tag.startsWith('#') ? rule.tag.slice(1) : rule.tag;
        return t === ruleTag || t.startsWith(ruleTag + '/');
      });

    case 'frontmatter': {
      if (!noteFrontmatter) return rule.op === 'exists' ? false : false;
      const value = noteFrontmatter[rule.key];
      switch (rule.op) {
        case 'exists': return value !== undefined;
        case 'eq': return String(value) === rule.value;
        case 'neq': return String(value) !== rule.value;
        default: return false;
      }
    }

    case 'note_path':
      return notePath.toLowerCase() === rule.path.toLowerCase();

    default:
      return false;
  }
}

/**
 * Rebuild the scope_membership table for a specific scope.
 * Evaluates all notes against the scope rules.
 */
export function materializeScopeMembership(
  db: Database,
  scopeId: number,
  rules: ScopeRuleSet,
): number {
  // Clear existing membership for this scope
  db.prepare('DELETE FROM scope_membership WHERE scope_id = ?').run(scopeId);

  // Evaluate all notes
  const notes = db.prepare('SELECT id, path, tags, frontmatter FROM notes').all() as Array<{
    id: string;
    path: string;
    tags: string | null;
    frontmatter: string | null;
  }>;

  const insertStmt = db.prepare('INSERT INTO scope_membership (scope_id, note_id) VALUES (?, ?)');
  let count = 0;

  const insertTransaction = db.transaction(() => {
    for (const note of notes) {
      const tags = note.tags ? JSON.parse(note.tags) : [];
      const fm = note.frontmatter ? JSON.parse(note.frontmatter) : null;

      if (evaluateNoteInScope(note.path, tags, fm, rules)) {
        insertStmt.run(scopeId, note.id);
        count++;
      }
    }
  });
  insertTransaction();

  return count;
}

/**
 * Rebuild membership for ALL scopes in the database.
 * Called after re-indexing when notes may have changed tags/frontmatter.
 */
export function rebuildAllScopeMemberships(db: Database): void {
  const scopes = db.prepare('SELECT id, rules FROM scopes').all() as Array<{
    id: number;
    rules: string;
  }>;

  for (const scope of scopes) {
    try {
      const rules = JSON.parse(scope.rules) as ScopeRuleSet;
      materializeScopeMembership(db, scope.id, rules);
    } catch (err) {
      console.error(`[vault-scope] Failed to rebuild membership for scope ${scope.id}:`, err);
    }
  }
}

/**
 * Check if a note is in a specific scope.
 * O(1) lookup against materialized membership.
 */
export function isNoteInScope(db: Database, scopeId: number, noteId: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM scope_membership WHERE scope_id = ? AND note_id = ?',
  ).get(scopeId, noteId);
  return !!row;
}

/**
 * Get all note IDs in a scope.
 */
export function getScopedNoteIds(db: Database, scopeId: number): Set<string> {
  const rows = db.prepare('SELECT note_id FROM scope_membership WHERE scope_id = ?').all(scopeId) as Array<{ note_id: string }>;
  return new Set(rows.map(r => r.note_id));
}

// ═══════════════════════════════════════════════════════════════════
// Vault Sessions (Agent Scope Binding)
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a vault session binding an agent to a specific scope.
 * The session includes a phantom HMAC key for opaque boundary node IDs.
 */
export function createVaultSession(
  db: Database,
  sessionId: string,
  project: string,
  scopeId: number,
  scopeName: string,
  projectionVersion: number,
  ttlMs: number,
): VaultSession {
  const id = crypto.randomBytes(32).toString('hex');
  const phantomKey = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + ttlMs;

  db.prepare(`
    INSERT INTO vault_sessions (id, session_id, project, scope_id, scope_name, phantom_key, projection_ver, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, project, scopeId, scopeName, phantomKey, projectionVersion, now, expiresAt);

  return { id, sessionId, project, scopeId, scopeName, phantomKey, projectionVersion, createdAt: now, expiresAt };
}

/**
 * Validate a vault session. Returns the session if valid, null if expired/invalid.
 * Also checks projection version — stale sessions are rejected.
 */
export function validateVaultSession(
  db: Database,
  vaultSessionId: string,
  requiredSessionId?: string,
): VaultSession | null {
  const row = db.prepare('SELECT * FROM vault_sessions WHERE id = ?').get(vaultSessionId) as any;
  if (!row) return null;

  // Check expiry
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM vault_sessions WHERE id = ?').run(vaultSessionId);
    return null;
  }

  // Check shield session binding
  if (requiredSessionId && row.session_id !== requiredSessionId) return null;

  // Check projection version is still current
  const scope = db.prepare('SELECT version FROM scopes WHERE id = ?').get(row.scope_id) as { version: number } | undefined;
  if (!scope || scope.version !== row.projection_ver) {
    // Scope was updated — session is stale
    db.prepare('DELETE FROM vault_sessions WHERE id = ?').run(vaultSessionId);
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    project: row.project,
    scopeId: row.scope_id,
    scopeName: row.scope_name,
    phantomKey: row.phantom_key,
    projectionVersion: row.projection_ver,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Invalidate all vault sessions for a specific scope.
 * Called when scope rules change.
 */
export function invalidateVaultSessionsByScope(db: Database, scopeId: number): number {
  const result = db.prepare('DELETE FROM vault_sessions WHERE scope_id = ?').run(scopeId);
  return result.changes;
}

/**
 * Clean up expired vault sessions.
 */
export function cleanupExpiredVaultSessions(db: Database): number {
  const result = db.prepare('DELETE FROM vault_sessions WHERE expires_at < ?').run(Date.now());
  return result.changes;
}

// ═══════════════════════════════════════════════════════════════════
// Phantom Node Generation
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate an opaque phantom node ID for a boundary target.
 * Uses HMAC-SHA256 with the vault session's phantom key.
 * Per-session — not stable across sessions (prevents cross-session correlation).
 */
export function generatePhantomId(phantomKey: string, notePath: string): string {
  return crypto.createHmac('sha256', phantomKey)
    .update(notePath)
    .digest('hex')
    .slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════
// Scoped Backlink Counting
// ═══════════════════════════════════════════════════════════════════

/**
 * Count backlinks to a note, split by scope membership.
 * Returns the count of in-scope backlinks and the clamped count of out-of-scope backlinks.
 */
export function countScopedBacklinks(
  db: Database,
  noteId: string,
  scopeId: number,
): { visibleCount: number; restrictedCount: ClampedCount } {
  // All backlinks (source notes that link to this note)
  const allBacklinks = db.prepare(`
    SELECT e.source_id FROM edges e WHERE e.target_id = ?
  `).all(noteId) as Array<{ source_id: string }>;

  // In-scope backlinks
  const inScopeBacklinks = db.prepare(`
    SELECT e.source_id FROM edges e
    JOIN scope_membership sm ON sm.note_id = e.source_id AND sm.scope_id = ?
    WHERE e.target_id = ?
  `).all(scopeId, noteId) as Array<{ source_id: string }>;

  const restrictedRaw = allBacklinks.length - inScopeBacklinks.length;

  return {
    visibleCount: inScopeBacklinks.length,
    restrictedCount: clampBacklinkCount(restrictedRaw),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════

function validateScopeName(name: string): void {
  if (!name || typeof name !== 'string') throw new Error('Scope name is required');
  if (name.length > 100) throw new Error('Scope name too long (max 100 chars)');
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Scope name must be alphanumeric with hyphens/underscores');
}

function validateScopeRules(rules: ScopeRuleSet): void {
  if (!rules || typeof rules !== 'object') throw new Error('Rules must be an object');
  if (rules.default !== 'include' && rules.default !== 'exclude') throw new Error("Rules default must be 'include' or 'exclude'");
  if (!Array.isArray(rules.rules)) throw new Error('Rules.rules must be an array');
  if (typeof rules.boundary_disclosure !== 'boolean') throw new Error('boundary_disclosure must be a boolean');
  if (rules.rules.length > 100) throw new Error('Too many rules (max 100)');

  for (const rule of rules.rules) {
    if (!rule || typeof rule !== 'object') throw new Error('Each rule must be an object');
    if (rule.action !== 'include' && rule.action !== 'exclude') throw new Error("Rule action must be 'include' or 'exclude'");

    switch (rule.type) {
      case 'folder_glob':
        if (typeof rule.pattern !== 'string') throw new Error('folder_glob rule requires pattern string');
        break;
      case 'tag':
        if (typeof rule.tag !== 'string') throw new Error('tag rule requires tag string');
        break;
      case 'frontmatter':
        if (typeof rule.key !== 'string') throw new Error('frontmatter rule requires key string');
        if (!['eq', 'neq', 'exists'].includes(rule.op)) throw new Error("frontmatter op must be 'eq', 'neq', or 'exists'");
        break;
      case 'note_path':
        if (typeof rule.path !== 'string') throw new Error('note_path rule requires path string');
        break;
      default:
        throw new Error(`Unknown rule type: ${(rule as any).type}`);
    }
  }
}
