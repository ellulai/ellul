// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault Routes — Browser-Facing API
 *
 * All endpoints prefixed with /_auth/vault/. Auth enforced by tier-gate
 * middleware (SESSION routes — passkey or JWT required).
 *
 * These routes serve the vault owner/admin and human collaborators.
 * Agent access goes through vault-internal.routes.ts via IPC.
 *
 * Security:
 *   - All scope filtering is server-side (no client-side graph filtering)
 *   - Uniform 404 for out-of-scope AND non-existent (no existence leakage)
 *   - Note path traversal prevented by vault root validation
 *   - Raw HTML in imports/notes must be sanitized client-side before rendering
 *   - Rate limiting via shield's checkApiRateLimit pattern
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Hono } from 'hono';
import { getClientIp } from '../auth/fingerprint';
import { logAuditEvent } from '../application/audit/Audit';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import {
  getVaultDb,
  getVaultRoot,
  rebuildVaultIndex,
  indexNote,
  resolveAllLinks,
  getNoteById,
  getNoteByPath,
  listNotes,
  searchNotes,
  getIndexStatus,
  deleteNoteFromIndex,
  getHeadings,
  getBlocks,
  getForwardLinks,
  getBacklinks,
  parseMarkdown,
} from '../application/vault/VaultIndex';
import {
  createScope,
  updateScope,
  deleteScope,
  listScopes,
  getScopeById,
  isNoteInScope,
} from '../application/vault/VaultScope';
import {
  getScopedGraph,
  getScopedBacklinks,
} from '../application/vault/VaultGraph';
import {
  createShareLink,
  resolveShareLink,
  revokeShareLink,
  createCapabilityToken,
  resolveCapabilityToken,
} from '../application/vault/VaultLinks';
import { startWatching, onVaultChange } from '../application/vault/VaultWatcher';
import {
  computeNoteId,
  VAULT_MAX_NOTE_SIZE,
  VAULT_NOTE_EXTENSIONS,
  VAULT_IMPORT_STRIP_PATTERNS,
  VAULT_IMPORT_SKIP_DOTFILES,
  type ScopeRuleSet,
  type VaultAuditEvent,
} from '@vps/shared/vault-types';

import { SandboxIdSchema, type SandboxId } from '@ellul.ai/types';

/**
 * Validate a vault project parameter. Vault scope is the sandbox — an
 * app-nested path inside a sandbox is rejected here because vault indexing
 * spans the whole sandbox tree. Callers that have an app directory must
 * fold to the enclosing sandbox via `sandboxIdFromPath` first.
 */
function validateProject(project: string | undefined): SandboxId {
  const parsed = SandboxIdSchema.safeParse(project);
  if (!parsed.success) {
    throw new Error('Invalid project parameter (sandbox slug required)');
  }
  return parsed.data;
}

function auditVault(event: VaultAuditEvent, ip: string | null, details: Record<string, unknown>): void {
  logAuditEvent({ type: event, ip, details });
}

/**
 * Register browser-facing vault routes on the Hono app.
 */
export function registerVaultRoutes(app: Hono): void {

  // ── Initialize Vault ──
  app.post('/_auth/vault/init', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const body = await c.req.json<{ project: string }>().catch(() => null);
    if (!body?.project) return c.json({ error: 'project is required' }, 400);

    try {
      const project = validateProject(body.project);
      const vaultRoot = getVaultRoot(project);

      if (!fs.existsSync(vaultRoot)) {
        return c.json({ error: 'Project directory not found' }, 404);
      }

      // Initialize the index DB (creates schema if needed)
      const db = getVaultDb(project);

      // Rebuild index from files on disk
      const result = rebuildVaultIndex(project);

      // Start watching for changes
      startWatching(project);

      auditVault('vault.index.rebuild', ip, { project, ...result });
      return c.json({ created: true, ...result });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to initialize vault' }, 400);
    }
  });

  // ── List Notes ──
  app.get('/_auth/vault/notes', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const db = getVaultDb(project);
      const pathPrefix = c.req.query('path') || undefined;
      const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 500);
      const offset = parseInt(c.req.query('offset') || '0', 10);

      const result = listNotes(db, project, { pathPrefix, limit, offset });
      auditVault('vault.note.list', ip, { project, count: result.notes.length });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to list notes' }, 400);
    }
  });

  // ── Get Note by ID ──
  app.get('/_auth/vault/notes/:noteId', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const noteId = c.req.param('noteId');
      const db = getVaultDb(project);

      const note = getNoteById(db, project, noteId);
      if (!note) return c.json({ error: 'not_found' }, 404);

      // Read file content
      const vaultRoot = getVaultRoot(project);
      const fullPath = path.resolve(vaultRoot, note.path);
      // Path traversal check
      if (!fullPath.startsWith(path.resolve(vaultRoot) + path.sep) && fullPath !== path.resolve(vaultRoot)) {
        return c.json({ error: 'not_found' }, 404);
      }

      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        return c.json({ error: 'not_found' }, 404);
      }

      // Get headings, blocks, forward links, backlinks
      const headings = getHeadings(db, noteId);
      const blocks = getBlocks(db, noteId);
      const forwardLinks = getForwardLinks(db, noteId);
      const { backlinks, restrictedCount } = getScopedBacklinks(db, noteId);

      auditVault('vault.note.read', ip, { project, noteId, path: note.path });

      return c.json({
        note,
        content,
        headings,
        blocks,
        forwardLinks,
        backlinks,
        restrictedBacklinks: restrictedCount,
      });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to get note' }, 400);
    }
  });

  // ── Create Note ──
  app.post('/_auth/vault/notes', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const body = await c.req.json<{ project: string; path: string; content: string }>().catch(() => null);
      if (!body?.project || !body?.path || typeof body?.content !== 'string') {
        return c.json({ error: 'project, path, and content are required' }, 400);
      }

      const project = validateProject(body.project);
      const vaultRoot = getVaultRoot(project);
      const fullPath = path.resolve(vaultRoot, body.path);

      // Path traversal check
      if (!fullPath.startsWith(path.resolve(vaultRoot) + path.sep)) {
        return c.json({ error: 'Invalid path' }, 400);
      }

      // Size check
      if (Buffer.byteLength(body.content, 'utf8') > VAULT_MAX_NOTE_SIZE) {
        return c.json({ error: `Note exceeds maximum size (${VAULT_MAX_NOTE_SIZE / 1024 / 1024} MB)` }, 400);
      }

      // Create parent directories if needed
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });

      // Write file
      fs.writeFileSync(fullPath, body.content, 'utf8');
      const stat = fs.statSync(fullPath);

      // Index
      const db = getVaultDb(project);
      const note = indexNote(db, project, body.path, body.content, stat);
      resolveAllLinks(db, project);

      auditVault('vault.note.create', ip, { project, noteId: note.id, path: body.path });
      return c.json({ note }, 201);
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to create note' }, 400);
    }
  });

  // ── Update Note ──
  app.put('/_auth/vault/notes/:noteId', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const body = await c.req.json<{ project: string; content: string }>().catch(() => null);
      if (!body?.project || typeof body?.content !== 'string') {
        return c.json({ error: 'project and content are required' }, 400);
      }

      const project = validateProject(body.project);
      const noteId = c.req.param('noteId');
      const db = getVaultDb(project);

      const note = getNoteById(db, project, noteId);
      if (!note) return c.json({ error: 'not_found' }, 404);

      const vaultRoot = getVaultRoot(project);
      const fullPath = path.resolve(vaultRoot, note.path);

      // Path traversal check
      if (!fullPath.startsWith(path.resolve(vaultRoot) + path.sep)) {
        return c.json({ error: 'not_found' }, 404);
      }

      // Write file
      fs.writeFileSync(fullPath, body.content, 'utf8');
      const stat = fs.statSync(fullPath);

      // Re-index
      const updated = indexNote(db, project, note.path, body.content, stat);
      resolveAllLinks(db, project);

      auditVault('vault.note.update', ip, { project, noteId, path: note.path });
      return c.json({ note: updated });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to update note' }, 400);
    }
  });

  // ── Delete Note ──
  app.delete('/_auth/vault/notes/:noteId', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const noteId = c.req.param('noteId');
      const db = getVaultDb(project);

      const note = getNoteById(db, project, noteId);
      if (!note) return c.json({ error: 'not_found' }, 404);

      // Delete file from disk
      const vaultRoot = getVaultRoot(project);
      const fullPath = path.resolve(vaultRoot, note.path);
      if (fullPath.startsWith(path.resolve(vaultRoot) + path.sep)) {
        try { fs.unlinkSync(fullPath); } catch {}
      }

      // Remove from index (CASCADE handles edges, headings, blocks)
      deleteNoteFromIndex(db, noteId);
      resolveAllLinks(db, project);

      auditVault('vault.note.delete', ip, { project, noteId, path: note.path });
      return c.json({ deleted: true });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to delete note' }, 400);
    }
  });

  // ── Rename/Move Note ──
  app.post('/_auth/vault/notes/:noteId/rename', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const body = await c.req.json<{ project: string; newPath: string }>().catch(() => null);
      if (!body?.project || !body?.newPath) {
        return c.json({ error: 'project and newPath are required' }, 400);
      }

      const project = validateProject(body.project);
      const noteId = c.req.param('noteId');
      const db = getVaultDb(project);

      const note = getNoteById(db, project, noteId);
      if (!note) return c.json({ error: 'not_found' }, 404);

      const vaultRoot = getVaultRoot(project);
      const oldFullPath = path.resolve(vaultRoot, note.path);
      const newFullPath = path.resolve(vaultRoot, body.newPath);

      // Path traversal check for both old and new
      const resolvedRoot = path.resolve(vaultRoot) + path.sep;
      if (!oldFullPath.startsWith(resolvedRoot) || !newFullPath.startsWith(resolvedRoot)) {
        return c.json({ error: 'Invalid path' }, 400);
      }

      // Move file
      fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
      fs.renameSync(oldFullPath, newFullPath);

      // Add old filename as alias (best-effort)
      try {
        let content = fs.readFileSync(newFullPath, 'utf8');
        const oldBasename = path.basename(note.path, path.extname(note.path));
        const parsed = parseMarkdown(content, body.newPath);
        const existingAliases = parsed.aliases;

        if (!existingAliases.includes(oldBasename)) {
          // Inject alias into frontmatter
          if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
            const endIdx = content.indexOf('---', 3);
            if (endIdx !== -1) {
              const before = content.slice(0, endIdx);
              const after = content.slice(endIdx);
              content = before + `aliases:\n  - ${oldBasename}\n` + (existingAliases.length > 0 ? '' : '') + after;
              fs.writeFileSync(newFullPath, content, 'utf8');
            }
          } else {
            // No frontmatter — add it
            content = `---\naliases:\n  - ${oldBasename}\n---\n\n${content}`;
            fs.writeFileSync(newFullPath, content, 'utf8');
          }
        }
      } catch {
        // Alias injection is best-effort — falls back safely
      }

      // Re-index: delete old note, index at new path
      deleteNoteFromIndex(db, noteId);
      const newContent = fs.readFileSync(newFullPath, 'utf8');
      const newStat = fs.statSync(newFullPath);
      const newNote = indexNote(db, project, body.newPath, newContent, newStat);

      // Re-resolve edges (old target paths now point to new location via alias)
      resolveAllLinks(db, project);

      auditVault('vault.note.rename', ip, {
        project, noteId: newNote.id, oldPath: note.path, newPath: body.newPath,
      });
      return c.json({ note: newNote, oldPath: note.path });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to rename note' }, 400);
    }
  });

  // ── Search ──
  app.get('/_auth/vault/search', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const query = c.req.query('q') || '';
      const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
      const db = getVaultDb(project);

      const results = searchNotes(db, project, query, limit);
      auditVault('vault.search.query', ip, { project, query, resultCount: results.length });
      return c.json({ results });
    } catch (err: any) {
      return c.json({ error: err.message || 'Search failed' }, 400);
    }
  });

  // ── Graph ──
  app.get('/_auth/vault/graph', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const centerId = c.req.query('center') || undefined;
      const depth = parseInt(c.req.query('depth') || '2', 10);
      const scopeIdStr = c.req.query('scope');
      const db = getVaultDb(project);

      let scopeId: number | undefined;
      let scope;
      if (scopeIdStr) {
        scopeId = parseInt(scopeIdStr, 10);
        scope = getScopeById(db, scopeId);
        if (!scope) return c.json({ error: 'Scope not found' }, 404);
      }

      const graph = getScopedGraph(db, { centerId, depth, scopeId, scope });
      auditVault('vault.graph.expand', ip, {
        project, centerId, depth, scopeId, nodeCount: graph.nodes.length,
      });
      return c.json(graph);
    } catch (err: any) {
      return c.json({ error: err.message || 'Graph query failed' }, 400);
    }
  });

  // ── Backlinks ──
  app.get('/_auth/vault/backlinks/:noteId', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const noteId = c.req.param('noteId');
      const scopeIdStr = c.req.query('scope');
      const db = getVaultDb(project);

      const note = getNoteById(db, project, noteId);
      if (!note) return c.json({ error: 'not_found' }, 404);

      const scopeId = scopeIdStr ? parseInt(scopeIdStr, 10) : undefined;
      const result = getScopedBacklinks(db, noteId, scopeId);

      auditVault('vault.backlinks.read', ip, {
        project, noteId, visibleCount: result.backlinks.length,
      });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message || 'Backlinks query failed' }, 400);
    }
  });

  // ── Scopes CRUD ──
  app.post('/_auth/vault/scopes', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const body = await c.req.json<{
        project: string;
        name: string;
        rules: ScopeRuleSet;
        description?: string;
        isAgentDefault?: boolean;
      }>().catch(() => null);
      if (!body?.project || !body?.name || !body?.rules) {
        return c.json({ error: 'project, name, and rules are required' }, 400);
      }

      const project = validateProject(body.project);
      const db = getVaultDb(project);
      const scope = createScope(db, body.name, body.rules, body.description, body.isAgentDefault);

      auditVault('vault.scope.create', ip, { project, scopeId: scope.id, name: scope.name });
      return c.json({ scope }, 201);
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to create scope' }, 400);
    }
  });

  app.get('/_auth/vault/scopes', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const db = getVaultDb(project);
      const scopes = listScopes(db);
      return c.json({ scopes });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to list scopes' }, 400);
    }
  });

  app.put('/_auth/vault/scopes/:scopeId', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const body = await c.req.json<{
        project: string;
        rules?: ScopeRuleSet;
        description?: string;
        isAgentDefault?: boolean;
      }>().catch(() => null);
      if (!body?.project) return c.json({ error: 'project is required' }, 400);

      const project = validateProject(body.project);
      const scopeId = parseInt(c.req.param('scopeId'), 10);
      const db = getVaultDb(project);

      const scope = updateScope(db, scopeId, {
        rules: body.rules,
        description: body.description,
        isAgentDefault: body.isAgentDefault,
      });
      if (!scope) return c.json({ error: 'Scope not found' }, 404);

      auditVault('vault.scope.update', ip, { project, scopeId, name: scope.name });
      return c.json({ scope });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to update scope' }, 400);
    }
  });

  app.delete('/_auth/vault/scopes/:scopeId', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const scopeId = parseInt(c.req.param('scopeId'), 10);
      const db = getVaultDb(project);

      const deleted = deleteScope(db, scopeId);
      if (!deleted) return c.json({ error: 'Scope not found' }, 404);

      auditVault('vault.scope.delete', ip, { project, scopeId });
      return c.json({ deleted: true });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to delete scope' }, 400);
    }
  });

  // ── Share Links ──
  app.post('/_auth/vault/share-links', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const body = await c.req.json<{
        project: string;
        noteId: string;
        sharingPolicy?: 'internal' | 'external';
        maxUses?: number;
        expiresInMs?: number;
      }>().catch(() => null);
      if (!body?.project || !body?.noteId) {
        return c.json({ error: 'project and noteId are required' }, 400);
      }

      const project = validateProject(body.project);
      const db = getVaultDb(project);
      const auth = c.get('tierGateAuth');
      const createdBy = auth?.credentialId || 'unknown';

      const link = createShareLink(db, body.noteId, createdBy, {
        sharingPolicy: body.sharingPolicy,
        maxUses: body.maxUses,
        expiresInMs: body.expiresInMs,
      });

      auditVault('vault.share_link.create', ip, { project, noteId: body.noteId, token: link.token });
      return c.json({ link }, 201);
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to create share link' }, 400);
    }
  });

  app.get('/_auth/vault/share-links/:token', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const token = c.req.param('token');
      const db = getVaultDb(project);

      const link = resolveShareLink(db, token);
      if (!link) return c.json({ error: 'not_found' }, 404);

      // Get the note content
      const note = getNoteById(db, project, link.noteId);
      if (!note) return c.json({ error: 'not_found' }, 404);

      const vaultRoot = getVaultRoot(project);
      const fullPath = path.resolve(vaultRoot, note.path);
      let content = '';
      try { content = fs.readFileSync(fullPath, 'utf8'); } catch {}

      auditVault('vault.share_link.resolve', ip, { project, token, noteId: link.noteId });
      return c.json({ note, content });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to resolve share link' }, 400);
    }
  });

  app.delete('/_auth/vault/share-links/:token', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const token = c.req.param('token');
      const db = getVaultDb(project);

      const revoked = revokeShareLink(db, token);
      if (!revoked) return c.json({ error: 'not_found' }, 404);

      auditVault('vault.share_link.revoke', ip, { project, token });
      return c.json({ revoked: true });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to revoke share link' }, 400);
    }
  });

  // ── Capability Tokens ──
  app.post('/_auth/vault/capabilities', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const body = await c.req.json<{
        project: string;
        noteId: string;
        expiresInMs?: number;
      }>().catch(() => null);
      if (!body?.project || !body?.noteId) {
        return c.json({ error: 'project and noteId are required' }, 400);
      }

      const project = validateProject(body.project);
      const db = getVaultDb(project);
      const auth = c.get('tierGateAuth');
      const sessionId = auth?.sessionId || '';

      const cap = createCapabilityToken(db, body.noteId, sessionId, 'human', {
        expiresInMs: body.expiresInMs,
      });

      auditVault('vault.capability.resolve', ip, { project, noteId: body.noteId, token: cap.token });
      return c.json({ capability: cap }, 201);
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to create capability' }, 400);
    }
  });

  app.get('/_auth/vault/capabilities/:token', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const token = c.req.param('token');
      const db = getVaultDb(project);
      const auth = c.get('tierGateAuth');

      const cap = resolveCapabilityToken(db, token, auth?.sessionId);
      if (!cap) {
        auditVault('vault.capability.resolve_denied', ip, { project, token });
        return c.json({ error: 'not_found' }, 404);
      }

      const note = getNoteById(db, project, cap.noteId);
      if (!note) return c.json({ error: 'not_found' }, 404);

      const vaultRoot = getVaultRoot(project);
      const fullPath = path.resolve(vaultRoot, note.path);
      let content = '';
      try { content = fs.readFileSync(fullPath, 'utf8'); } catch {}

      auditVault('vault.capability.resolve', ip, { project, token, noteId: cap.noteId });
      return c.json({ note, content });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to resolve capability' }, 400);
    }
  });

  // ── Index Status ──
  app.get('/_auth/vault/index/status', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const project = validateProject(c.req.query('project'));
      const db = getVaultDb(project);
      const status = getIndexStatus(db, project);
      return c.json(status);
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to get index status' }, 400);
    }
  });

  // ── Force Re-Index ──
  app.post('/_auth/vault/index/rebuild', async (c) => {
    const ip = getClientIp(c);
    const rate = checkApiRateLimit(ip);
    if (rate.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    try {
      const body = await c.req.json<{ project: string }>().catch(() => null);
      if (!body?.project) return c.json({ error: 'project is required' }, 400);

      const project = validateProject(body.project);
      const result = rebuildVaultIndex(project);

      auditVault('vault.index.rebuild', ip, { project, ...result });
      return c.json({ rebuilt: true, ...result });
    } catch (err: any) {
      return c.json({ error: err.message || 'Rebuild failed' }, 400);
    }
  });

  // ── Realtime: notify file-api to broadcast vault changes via WebSocket ──
  onVaultChange(async (project, changedNotes, deletedNotes) => {
    try {
      // Call file-api's broadcast endpoint (localhost:3002)
      await fetch('http://127.0.0.1:3002/api/vault-index-changed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, changedNotes, deletedNotes }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {}); // Best-effort — don't break on failure
    } catch {
      // Silently ignore — realtime is best-effort
    }
  });
}
