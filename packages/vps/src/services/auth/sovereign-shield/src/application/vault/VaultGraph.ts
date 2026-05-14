// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault Graph Service
 *
 * Provides graph queries over the vault knowledge structure.
 * All results are scoped — this service ALWAYS operates on the principal-resolved
 * graph view, never on raw edges directly.
 *
 * Graph operations:
 *   - Full scoped graph (all in-scope nodes + edges)
 *   - Neighborhood expansion (ego-graph from a center node)
 *   - Scoped backlink queries with context snippets
 *
 * Security:
 *   - Every graph response is filtered through scope membership
 *   - Default agent mode: no phantom/boundary nodes (hidden edges fully removed)
 *   - Elevated mode (boundary_disclosure): terminal phantom nodes with opaque IDs
 *   - Node limit (500) prevents large vault enumeration
 *   - Expansion budget enforced per vault session
 */

import type Database from 'better-sqlite3';
import {
  VAULT_GRAPH_NODE_LIMIT,
  VAULT_GRAPH_DEFAULT_DEPTH,
  clampBacklinkCount,
  type GraphNode,
  type GraphEdge,
  type GraphResponse,
  type BacklinkEntry,
  type NodeVisibility,
  type ClampedCount,
  type VaultScope,
  type VaultSession,
} from '@vps/shared/vault-types';
import {
  getScopedNoteIds,
  isNoteInScope,
  generatePhantomId,
  countScopedBacklinks,
} from './VaultScope';

// ═══════════════════════════════════════════════════════════════════
// Graph Types (internal)
// ═══════════════════════════════════════════════════════════════════

interface GraphQueryOptions {
  /** Center note ID for neighborhood queries (null = full graph) */
  centerId?: string;
  /** Depth for neighborhood expansion (default: 2) */
  depth?: number;
  /** Maximum nodes to return (default: 500) */
  limit?: number;
  /** Scope to filter by (null = owner/full access) */
  scopeId?: number;
  /** Scope rules for boundary disclosure check */
  scope?: VaultScope;
  /** Vault session for phantom key generation */
  vaultSession?: VaultSession;
}

// ═══════════════════════════════════════════════════════════════════
// Full Scoped Graph
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the full scoped graph view for a principal.
 *
 * For owner/admin: returns all nodes and edges.
 * For agent with scope: returns only in-scope nodes and edges between them.
 * Boundary edges handled based on scope's boundary_disclosure setting.
 */
export function getScopedGraph(db: Database, opts: GraphQueryOptions): GraphResponse {
  const limit = opts.limit ?? VAULT_GRAPH_NODE_LIMIT;

  if (opts.centerId) {
    return getNeighborhood(db, opts);
  }

  // Full graph (scoped or unscoped)
  if (!opts.scopeId) {
    // Owner view — all notes
    return getUnfilteredGraph(db, limit);
  }

  return getFilteredGraph(db, opts.scopeId, opts.scope, opts.vaultSession, limit);
}

/**
 * Unfiltered graph — used for owner/admin view only.
 */
function getUnfilteredGraph(db: Database, limit: number): GraphResponse {
  const noteRows = db.prepare(`
    SELECT id, title, path, tags FROM notes ORDER BY path LIMIT ?
  `).all(limit) as Array<{ id: string; title: string; path: string; tags: string | null }>;

  const truncated = noteRows.length >= limit;
  const noteIds = new Set(noteRows.map(n => n.id));

  const nodes: GraphNode[] = noteRows.map(n => ({
    id: n.id,
    title: n.title,
    path: n.path,
    tags: n.tags ? JSON.parse(n.tags) : [],
    visibility: 'visible' as NodeVisibility,
  }));

  // Get edges between visible notes
  const edges = getEdgesBetween(db, noteIds);

  return { nodes, edges, restrictedCount: 0, truncated };
}

/**
 * Filtered graph — only in-scope nodes and edges between them.
 * Boundary handling based on scope's boundary_disclosure setting.
 */
function getFilteredGraph(
  db: Database,
  scopeId: number,
  scope: VaultScope | undefined,
  vaultSession: VaultSession | undefined,
  limit: number,
): GraphResponse {
  const scopedIds = getScopedNoteIds(db, scopeId);
  const boundaryDisclosure = scope?.rules?.boundary_disclosure ?? false;

  // Get in-scope notes (up to limit)
  const noteRows = db.prepare(`
    SELECT n.id, n.title, n.path, n.tags
    FROM notes n
    JOIN scope_membership sm ON sm.note_id = n.id AND sm.scope_id = ?
    ORDER BY n.path
    LIMIT ?
  `).all(scopeId, limit) as Array<{ id: string; title: string; path: string; tags: string | null }>;

  const truncated = noteRows.length >= limit;
  const visibleIds = new Set(noteRows.map(n => n.id));

  const nodes: GraphNode[] = noteRows.map(n => ({
    id: n.id,
    title: n.title,
    path: n.path,
    tags: n.tags ? JSON.parse(n.tags) : [],
    visibility: 'visible' as NodeVisibility,
  }));

  const edges: GraphEdge[] = [];
  const phantomIds = new Set<string>();

  // Get all edges FROM in-scope notes
  const edgeRows = db.prepare(`
    SELECT e.source_id, e.target_id, e.link_type, e.target_path
    FROM edges e
    JOIN scope_membership sm ON sm.note_id = e.source_id AND sm.scope_id = ?
    WHERE e.target_id IS NOT NULL
  `).all(scopeId) as Array<{
    source_id: string;
    target_id: string;
    link_type: string;
    target_path: string | null;
  }>;

  for (const e of edgeRows) {
    if (visibleIds.has(e.target_id)) {
      // Both source and target in scope — fully visible edge
      edges.push({ source: e.source_id, target: e.target_id, type: e.link_type as any });
    } else if (boundaryDisclosure && vaultSession && e.target_path) {
      // Target out of scope, but boundary_disclosure is enabled
      // Create phantom node
      const phantomId = generatePhantomId(vaultSession.phantomKey, e.target_path);
      if (!phantomIds.has(phantomId)) {
        phantomIds.add(phantomId);
        nodes.push({
          id: phantomId,
          title: '',
          path: '',
          tags: [],
          visibility: 'phantom',
        });
      }
      edges.push({ source: e.source_id, target: phantomId, type: e.link_type as any });
    }
    // Else: default mode — boundary edge is fully hidden (no phantom, no edge)
  }

  // Count total restricted (out-of-scope) notes that have edges to in-scope notes
  const totalNotes = (db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number }).c;
  const restrictedCount = totalNotes - scopedIds.size;

  return { nodes, edges, restrictedCount, truncated };
}

// ═══════════════════════════════════════════════════════════════════
// Neighborhood Expansion (Ego-Graph)
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the neighborhood of a center note up to a given depth.
 * Respects scope boundaries — only expands through in-scope notes.
 */
function getNeighborhood(db: Database, opts: GraphQueryOptions): GraphResponse {
  const centerId = opts.centerId!;
  const depth = opts.depth ?? VAULT_GRAPH_DEFAULT_DEPTH;
  const limit = opts.limit ?? VAULT_GRAPH_NODE_LIMIT;
  const scopeId = opts.scopeId;
  const scope = opts.scope;
  const vaultSession = opts.vaultSession;
  const boundaryDisclosure = scope?.rules?.boundary_disclosure ?? false;

  // BFS from center
  const visited = new Set<string>([centerId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: centerId, depth: 0 }];
  const edgeSet: GraphEdge[] = [];
  const phantomIds = new Set<string>();

  while (queue.length > 0 && visited.size < limit) {
    const current = queue.shift()!;
    if (current.depth >= depth) continue;

    // Get forward links
    const forwardEdges = db.prepare(`
      SELECT target_id, link_type, target_path FROM edges WHERE source_id = ? AND target_id IS NOT NULL
    `).all(current.id) as Array<{ target_id: string; link_type: string; target_path: string | null }>;

    // Get backlinks
    const backEdges = db.prepare(`
      SELECT source_id, link_type FROM edges WHERE target_id = ?
    `).all(current.id) as Array<{ source_id: string; link_type: string }>;

    for (const e of forwardEdges) {
      const inScope = !scopeId || isNoteInScope(db, scopeId, e.target_id);
      if (inScope) {
        edgeSet.push({ source: current.id, target: e.target_id, type: e.link_type as any });
        if (!visited.has(e.target_id)) {
          visited.add(e.target_id);
          queue.push({ id: e.target_id, depth: current.depth + 1 });
        }
      } else if (boundaryDisclosure && vaultSession && e.target_path) {
        const phantomId = generatePhantomId(vaultSession.phantomKey, e.target_path);
        phantomIds.add(phantomId);
        edgeSet.push({ source: current.id, target: phantomId, type: e.link_type as any });
      }
    }

    for (const e of backEdges) {
      const inScope = !scopeId || isNoteInScope(db, scopeId, e.source_id);
      if (inScope) {
        edgeSet.push({ source: e.source_id, target: current.id, type: e.link_type as any });
        if (!visited.has(e.source_id)) {
          visited.add(e.source_id);
          queue.push({ id: e.source_id, depth: current.depth + 1 });
        }
      }
    }
  }

  // Build nodes from visited set
  const nodes: GraphNode[] = [];
  for (const noteId of visited) {
    const row = db.prepare('SELECT id, title, path, tags FROM notes WHERE id = ?').get(noteId) as any;
    if (row) {
      nodes.push({
        id: row.id,
        title: row.title,
        path: row.path,
        tags: row.tags ? JSON.parse(row.tags) : [],
        visibility: 'visible',
      });
    }
  }

  // Add phantom nodes
  for (const phantomId of phantomIds) {
    nodes.push({
      id: phantomId,
      title: '',
      path: '',
      tags: [],
      visibility: 'phantom',
    });
  }

  return {
    nodes,
    edges: edgeSet,
    restrictedCount: phantomIds.size,
    truncated: visited.size >= limit,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Scoped Backlinks
// ═══════════════════════════════════════════════════════════════════

/**
 * Get backlinks to a note, filtered by scope.
 * Returns visible backlink entries + clamped restricted count.
 */
export function getScopedBacklinks(
  db: Database,
  noteId: string,
  scopeId?: number,
): { backlinks: BacklinkEntry[]; restrictedCount: ClampedCount } {
  // Get all backlinks with context
  const rows = db.prepare(`
    SELECT e.source_id, e.source_offset, e.raw_link,
           n.path as source_path, n.title as source_title
    FROM edges e
    JOIN notes n ON n.id = e.source_id
    WHERE e.target_id = ?
    ORDER BY n.title
  `).all(noteId) as Array<{
    source_id: string;
    source_offset: number;
    raw_link: string;
    source_path: string;
    source_title: string;
  }>;

  if (!scopeId) {
    // Owner view — all backlinks visible
    return {
      backlinks: rows.map(r => ({
        sourceNoteId: r.source_id,
        sourcePath: r.source_path,
        sourceTitle: r.source_title,
        context: `…links to [[${r.raw_link}]]…`,
        lineNumber: 0, // Could compute from offset
      })),
      restrictedCount: 'none',
    };
  }

  // Scoped view — filter by membership
  const inScope: BacklinkEntry[] = [];
  let outOfScopeCount = 0;

  for (const r of rows) {
    if (isNoteInScope(db, scopeId, r.source_id)) {
      inScope.push({
        sourceNoteId: r.source_id,
        sourcePath: r.source_path,
        sourceTitle: r.source_title,
        context: `…links to [[${r.raw_link}]]…`,
        lineNumber: 0,
      });
    } else {
      outOfScopeCount++;
    }
  }

  return {
    backlinks: inScope,
    restrictedCount: clampBacklinkCount(outOfScopeCount),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Get all edges between a set of note IDs (both source and target must be in the set).
 */
function getEdgesBetween(db: Database, noteIds: Set<string>): GraphEdge[] {
  if (noteIds.size === 0) return [];

  // For small sets, use IN clause; for large sets, use temp table
  const ids = [...noteIds];

  const rows = db.prepare(`
    SELECT source_id, target_id, link_type FROM edges
    WHERE target_id IS NOT NULL
  `).all() as Array<{ source_id: string; target_id: string; link_type: string }>;

  return rows
    .filter(r => noteIds.has(r.source_id) && noteIds.has(r.target_id))
    .map(r => ({
      source: r.source_id,
      target: r.target_id,
      type: r.link_type as any,
    }));
}

// Re-export clampBacklinkCount for use in routes
export { clampBacklinkCount } from '@vps/shared/vault-types';
