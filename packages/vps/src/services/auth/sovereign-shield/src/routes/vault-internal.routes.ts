// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault Internal Routes — Agent Access via IPC
 *
 * All endpoints prefixed with /api/internal/vault/. Auth enforced by
 * internal-auth middleware (per-service IPC token). Only agent-bridge
 * is allowed (ACL: BRIDGE only).
 *
 * Every request requires:
 *   - project: the project slug
 *   - scope: the scope ID (mandatory for agents — agents always operate within a scope)
 *   - vault_session: the vault session ID (for projection version validation)
 *
 * Security:
 *   - ALL results filtered through scope membership server-side
 *   - Uniform 404 for out-of-scope AND non-existent (no existence leakage)
 *   - Projection version checked on every request (stale session = 403)
 *   - Default: no phantom/boundary nodes (hidden edges fully removed)
 *   - Rate limiting and per-session expansion budget enforced
 *   - Denied access events are audit-logged
 */

import fs from 'fs';
import path from 'path';
import type { Hono } from 'hono';
import { logAuditEvent } from '../application/audit/Audit';
import {
  getVaultDb,
  getVaultRoot,
  getNoteById,
  listNotes,
  searchNotes,
  getHeadings,
  getBlocks,
} from '../application/vault/VaultIndex';
import {
  validateVaultSession,
  isNoteInScope,
  getScopeById,
  getScopedNoteIds,
} from '../application/vault/VaultScope';
import {
  getScopedGraph,
  getScopedBacklinks,
} from '../application/vault/VaultGraph';
import type { VaultAuditEvent } from '@vps/shared/vault-types';

const PROJECT_RE = /^[a-zA-Z0-9_\/.@-]+$/;

// Per-session graph expansion budget tracking (in-memory)
const expansionBudgets = new Map<string, number>();
const MAX_EXPANSION_BUDGET = 50;

function auditVault(event: VaultAuditEvent, details: Record<string, unknown>): void {
  logAuditEvent({ type: event, details });
}

/**
 * Register internal vault routes for agent-bridge IPC.
 */
export function registerVaultInternalRoutes(app: Hono): void {

  // ── Scoped Note List ──
  app.get('/api/internal/vault/notes', async (c) => {
    const project = c.req.query('project');
    const vaultSessionId = c.req.query('vault_session');

    if (!project || !PROJECT_RE.test(project) || project.includes('..') || project.startsWith('/') || project.includes('//') || !vaultSessionId) {
      return c.json({ error: 'project and vault_session are required' }, 400);
    }

    const db = getVaultDb(project);
    const session = validateVaultSession(db, vaultSessionId);
    if (!session) {
      auditVault('vault.note.read_denied', { project, reason: 'invalid_session' });
      return c.json({ error: 'vault_session_invalid' }, 403);
    }

    // Get scoped note IDs
    const scopedIds = getScopedNoteIds(db, session.scopeId);
    const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 500);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    // List all notes and filter by scope
    const { notes: allNotes, total: allTotal } = listNotes(db, project, { limit: 10000 });
    const scopedNotes = allNotes.filter(n => scopedIds.has(n.id));
    const paged = scopedNotes.slice(offset, offset + limit);

    auditVault('vault.note.list', { project, scope: session.scopeName, count: paged.length });
    return c.json({ notes: paged, total: scopedNotes.length });
  });

  // ── Scoped Note Read ──
  app.get('/api/internal/vault/notes/:noteId', async (c) => {
    const project = c.req.query('project');
    const vaultSessionId = c.req.query('vault_session');
    const noteId = c.req.param('noteId');

    if (!project || !PROJECT_RE.test(project) || project.includes('..') || project.startsWith('/') || project.includes('//') || !vaultSessionId) {
      return c.json({ error: 'project and vault_session are required' }, 400);
    }

    const db = getVaultDb(project);
    const session = validateVaultSession(db, vaultSessionId);
    if (!session) {
      auditVault('vault.note.read_denied', { project, noteId, reason: 'invalid_session' });
      return c.json({ error: 'vault_session_invalid' }, 403);
    }

    // Check scope membership
    if (!isNoteInScope(db, session.scopeId, noteId)) {
      // Uniform 404 — do not reveal whether note exists
      auditVault('vault.note.read_denied', { project, noteId, scope: session.scopeName, reason: 'out_of_scope' });
      return c.json({ error: 'not_found' }, 404);
    }

    const note = getNoteById(db, project, noteId);
    if (!note) return c.json({ error: 'not_found' }, 404);

    // Read file content
    const vaultRoot = getVaultRoot(project);
    const fullPath = path.resolve(vaultRoot, note.path);
    if (!fullPath.startsWith(path.resolve(vaultRoot) + path.sep)) {
      return c.json({ error: 'not_found' }, 404);
    }

    let content = '';
    try { content = fs.readFileSync(fullPath, 'utf8'); } catch {
      return c.json({ error: 'not_found' }, 404);
    }

    const headings = getHeadings(db, noteId);
    const blocks = getBlocks(db, noteId);
    const { backlinks, restrictedCount } = getScopedBacklinks(db, noteId, session.scopeId);

    auditVault('vault.note.read', { project, noteId, scope: session.scopeName });

    return c.json({
      note,
      content,
      headings,
      blocks,
      backlinks,
      restrictedBacklinks: restrictedCount,
    });
  });

  // ── Scoped Search ──
  app.get('/api/internal/vault/search', async (c) => {
    const project = c.req.query('project');
    const vaultSessionId = c.req.query('vault_session');
    const query = c.req.query('q') || '';

    if (!project || !PROJECT_RE.test(project) || project.includes('..') || project.startsWith('/') || project.includes('//') || !vaultSessionId) {
      return c.json({ error: 'project and vault_session are required' }, 400);
    }

    const db = getVaultDb(project);
    const session = validateVaultSession(db, vaultSessionId);
    if (!session) {
      auditVault('vault.search.query_denied', { project, reason: 'invalid_session' });
      return c.json({ error: 'vault_session_invalid' }, 403);
    }

    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);

    // Search returns all matches — we post-filter by scope membership.
    // Out-of-scope results are fully discarded: no count, no snippet, no indication.
    const allResults = searchNotes(db, project, query, limit * 3); // Over-fetch to compensate for filtering
    const scopedIds = getScopedNoteIds(db, session.scopeId);
    const results = allResults.filter(r => scopedIds.has(r.noteId)).slice(0, limit);

    auditVault('vault.search.query', { project, query, scope: session.scopeName, resultCount: results.length });
    return c.json({ results });
  });

  // ── Scoped Graph ──
  app.get('/api/internal/vault/graph', async (c) => {
    const project = c.req.query('project');
    const vaultSessionId = c.req.query('vault_session');

    if (!project || !PROJECT_RE.test(project) || project.includes('..') || project.startsWith('/') || project.includes('//') || !vaultSessionId) {
      return c.json({ error: 'project and vault_session are required' }, 400);
    }

    const db = getVaultDb(project);
    const session = validateVaultSession(db, vaultSessionId);
    if (!session) {
      auditVault('vault.graph.expand_denied', { project, reason: 'invalid_session' });
      return c.json({ error: 'vault_session_invalid' }, 403);
    }

    // Check expansion budget
    const budgetKey = session.id;
    const currentBudget = expansionBudgets.get(budgetKey) ?? MAX_EXPANSION_BUDGET;
    if (currentBudget <= 0) {
      auditVault('vault.graph.expand_denied', {
        project, scope: session.scopeName, reason: 'graph_expansion_budget_exhausted',
      });
      return c.json({ error: 'graph_expansion_budget_exhausted' }, 429);
    }
    expansionBudgets.set(budgetKey, currentBudget - 1);

    const centerId = c.req.query('center') || undefined;
    const depth = parseInt(c.req.query('depth') || '2', 10);
    const scope = getScopeById(db, session.scopeId);

    const graph = getScopedGraph(db, {
      centerId,
      depth,
      scopeId: session.scopeId,
      scope: scope ?? undefined,
      vaultSession: session,
    });

    auditVault('vault.graph.expand', {
      project, scope: session.scopeName, centerId, depth,
      nodeCount: graph.nodes.length, budgetRemaining: currentBudget - 1,
    });
    return c.json(graph);
  });

  // ── Scoped Backlinks ──
  app.get('/api/internal/vault/backlinks/:noteId', async (c) => {
    const project = c.req.query('project');
    const vaultSessionId = c.req.query('vault_session');
    const noteId = c.req.param('noteId');

    if (!project || !PROJECT_RE.test(project) || project.includes('..') || project.startsWith('/') || project.includes('//') || !vaultSessionId) {
      return c.json({ error: 'project and vault_session are required' }, 400);
    }

    const db = getVaultDb(project);
    const session = validateVaultSession(db, vaultSessionId);
    if (!session) {
      auditVault('vault.backlinks.read', { project, noteId, reason: 'invalid_session' });
      return c.json({ error: 'vault_session_invalid' }, 403);
    }

    // Check note is in scope
    if (!isNoteInScope(db, session.scopeId, noteId)) {
      auditVault('vault.note.read_denied', { project, noteId, scope: session.scopeName, reason: 'out_of_scope' });
      return c.json({ error: 'not_found' }, 404);
    }

    const result = getScopedBacklinks(db, noteId, session.scopeId);
    auditVault('vault.backlinks.read', {
      project, noteId, scope: session.scopeName,
      visibleCount: result.backlinks.length,
    });
    return c.json(result);
  });

  // ── Capability Token Request (queued for human approval) ──
  app.post('/api/internal/vault/capability-request', async (c) => {
    const body = await c.req.json<{
      project: string;
      noteId: string;
      vault_session: string;
      reason?: string;
    }>().catch(() => null);

    if (!body?.project || !body?.noteId || !body?.vault_session) {
      return c.json({ error: 'project, noteId, and vault_session are required' }, 400);
    }

    const db = getVaultDb(body.project);
    const session = validateVaultSession(db, body.vault_session);
    if (!session) {
      return c.json({ error: 'vault_session_invalid' }, 403);
    }

    // Log the request — human must approve via the gate SSE stream
    auditVault('vault.capability.request', {
      project: body.project,
      noteId: body.noteId,
      scope: session.scopeName,
      reason: body.reason || 'Agent requested capability token',
    });

    // The actual approval and token creation happens through the gate system.
    // Here we just acknowledge the request was received.
    return c.json({
      queued: true,
      message: 'Capability token request queued for human approval',
    });
  });
}
