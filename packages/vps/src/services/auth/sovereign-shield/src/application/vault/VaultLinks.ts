// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault Links Service
 *
 * Manages two distinct link primitives:
 *
 * 1. Share Links (human UX navigation):
 *    - Durable, shareable URLs for note access
 *    - Governed by explicit sharing policy and expiry rules
 *    - Created by humans, subject to sharing policy
 *    - Not session-bound
 *
 * 2. Capability Tokens (security-bearing access artifacts):
 *    - Session-bound internal navigation tokens
 *    - Used for: approved agent follow-ups, narrow privileged workflows
 *    - NOT general share primitives
 *    - Agent-created tokens require human approval
 *    - Bound to issuing session + vault session (agent only)
 *
 * These are intentionally distinct. Share links are a convenience feature;
 * capability tokens are a security primitive. Conflating them would turn
 * "convenient note link" into a security-bearing token primitive everywhere.
 */

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import {
  type ShareLink,
  type CapabilityToken,
  type SharingPolicy,
  type PrincipalType,
  type FragmentType,
} from '@vps/shared/vault-types';
import { isNoteInScope } from './VaultScope';

// ═══════════════════════════════════════════════════════════════════
// Share Links
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a share link for a note.
 * Policy-checked: the caller must verify the principal has sharing rights.
 */
export function createShareLink(
  db: Database,
  noteId: string,
  createdBy: string,
  opts?: {
    fragmentType?: FragmentType;
    fragmentId?: string;
    sharingPolicy?: SharingPolicy;
    maxUses?: number;
    expiresInMs?: number;
  },
): ShareLink {
  // Verify note exists
  const note = db.prepare('SELECT id FROM notes WHERE id = ?').get(noteId);
  if (!note) throw new Error('Note not found');

  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = opts?.expiresInMs ? now + opts.expiresInMs : null;

  db.prepare(`
    INSERT INTO share_links (token, note_id, fragment_type, fragment_id, created_by, sharing_policy, max_uses, use_count, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    token,
    noteId,
    opts?.fragmentType || null,
    opts?.fragmentId || null,
    createdBy,
    opts?.sharingPolicy || 'internal',
    opts?.maxUses ?? null,
    now,
    expiresAt,
  );

  return {
    id: Number((db.prepare('SELECT last_insert_rowid() as id').get() as any)?.id ?? 0),
    token,
    noteId,
    fragmentType: opts?.fragmentType || null,
    fragmentId: opts?.fragmentId || null,
    createdBy,
    sharingPolicy: opts?.sharingPolicy || 'internal',
    maxUses: opts?.maxUses ?? null,
    useCount: 0,
    createdAt: now,
    expiresAt,
    revokedAt: null,
  } as ShareLink;
}

/**
 * Resolve a share link token. Returns the link if valid, null otherwise.
 * Increments use_count on successful resolution.
 */
export function resolveShareLink(db: Database, token: string): ShareLink | null {
  const row = db.prepare('SELECT * FROM share_links WHERE token = ?').get(token) as any;
  if (!row) return null;

  // Check revocation
  if (row.revoked_at) return null;

  // Check expiry
  if (row.expires_at && row.expires_at < Date.now()) return null;

  // Check max uses
  if (row.max_uses !== null && row.use_count >= row.max_uses) return null;

  // Increment use count
  db.prepare('UPDATE share_links SET use_count = use_count + 1 WHERE id = ?').run(row.id);

  return rowToShareLink(row);
}

/**
 * Revoke a share link.
 */
export function revokeShareLink(db: Database, token: string): boolean {
  const result = db.prepare(
    'UPDATE share_links SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL',
  ).run(Date.now(), token);
  return result.changes > 0;
}

/**
 * List share links for a note.
 */
export function listShareLinks(db: Database, noteId: string): ShareLink[] {
  const rows = db.prepare(
    'SELECT * FROM share_links WHERE note_id = ? ORDER BY created_at DESC',
  ).all(noteId);
  return rows.map(rowToShareLink);
}

function rowToShareLink(row: any): ShareLink {
  return {
    id: row.id,
    token: row.token,
    noteId: row.note_id,
    fragmentType: row.fragment_type,
    fragmentId: row.fragment_id,
    createdBy: row.created_by,
    sharingPolicy: row.sharing_policy,
    maxUses: row.max_uses,
    useCount: row.use_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Capability Tokens
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a capability token. Session-bound, short-lived.
 *
 * For agents: must be approved by human first (caller verifies this).
 * Agent tokens default to max_uses=1, expire with vault session.
 */
export function createCapabilityToken(
  db: Database,
  noteId: string,
  sessionId: string,
  principalType: PrincipalType,
  opts?: {
    fragmentType?: FragmentType;
    fragmentId?: string;
    scopeId?: number;
    vaultSessionId?: string;
    maxUses?: number;
    expiresInMs?: number;
  },
): CapabilityToken {
  // Verify note exists
  const note = db.prepare('SELECT id FROM notes WHERE id = ?').get(noteId);
  if (!note) throw new Error('Note not found');

  // If scope is specified, verify note is in scope
  if (opts?.scopeId != null) {
    if (!isNoteInScope(db, opts.scopeId, noteId)) {
      throw new Error('Note not in specified scope');
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  // Agent tokens: short-lived (matches vault session TTL)
  // Human tokens: longer-lived (1 hour default)
  const defaultTtl = principalType === 'agent' ? 4 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const expiresAt = now + (opts?.expiresInMs ?? defaultTtl);
  const maxUses = opts?.maxUses ?? (principalType === 'agent' ? 1 : 10);

  db.prepare(`
    INSERT INTO capability_tokens (token, note_id, fragment_type, fragment_id, scope_id, session_id, vault_session_id, principal_type, max_uses, use_count, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    token,
    noteId,
    opts?.fragmentType || null,
    opts?.fragmentId || null,
    opts?.scopeId ?? null,
    sessionId,
    opts?.vaultSessionId || null,
    principalType,
    maxUses,
    now,
    expiresAt,
  );

  return {
    id: Number((db.prepare('SELECT last_insert_rowid() as id').get() as any)?.id ?? 0),
    token,
    noteId,
    fragmentType: opts?.fragmentType || null,
    fragmentId: opts?.fragmentId || null,
    scopeId: opts?.scopeId ?? null,
    sessionId,
    vaultSessionId: opts?.vaultSessionId || null,
    principalType,
    maxUses,
    useCount: 0,
    createdAt: now,
    expiresAt,
    revokedAt: null,
  } as CapabilityToken;
}

/**
 * Resolve a capability token.
 *
 * Validates:
 *   - Token exists and is not revoked
 *   - Not expired
 *   - Use count not exceeded
 *   - Session binding matches (for agents: vault_session_id must match)
 *
 * On success, increments use_count.
 */
export function resolveCapabilityToken(
  db: Database,
  token: string,
  requiredSessionId?: string,
  requiredVaultSessionId?: string,
): CapabilityToken | null {
  const row = db.prepare('SELECT * FROM capability_tokens WHERE token = ?').get(token) as any;
  if (!row) return null;

  // Check revocation
  if (row.revoked_at) return null;

  // Check expiry
  if (row.expires_at < Date.now()) return null;

  // Check max uses
  if (row.use_count >= row.max_uses) return null;

  // Check session binding
  if (requiredSessionId && row.session_id !== requiredSessionId) return null;

  // Check vault session binding (agents only)
  if (row.principal_type === 'agent' && row.vault_session_id) {
    if (requiredVaultSessionId && row.vault_session_id !== requiredVaultSessionId) return null;
  }

  // Increment use count
  db.prepare('UPDATE capability_tokens SET use_count = use_count + 1 WHERE id = ?').run(row.id);

  return rowToCapabilityToken(row);
}

/**
 * Revoke a capability token.
 */
export function revokeCapabilityToken(db: Database, token: string): boolean {
  const result = db.prepare(
    'UPDATE capability_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL',
  ).run(Date.now(), token);
  return result.changes > 0;
}

/**
 * Clean up expired share links and capability tokens.
 */
export function cleanupExpiredLinks(db: Database): { shareLinks: number; capabilities: number } {
  const now = Date.now();
  const sl = db.prepare('DELETE FROM share_links WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
  const ct = db.prepare('DELETE FROM capability_tokens WHERE expires_at < ?').run(now);
  return { shareLinks: sl.changes, capabilities: ct.changes };
}

function rowToCapabilityToken(row: any): CapabilityToken {
  return {
    id: row.id,
    token: row.token,
    noteId: row.note_id,
    fragmentType: row.fragment_type,
    fragmentId: row.fragment_id,
    scopeId: row.scope_id,
    sessionId: row.session_id,
    vaultSessionId: row.vault_session_id,
    principalType: row.principal_type,
    maxUses: row.max_uses,
    useCount: row.use_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}
