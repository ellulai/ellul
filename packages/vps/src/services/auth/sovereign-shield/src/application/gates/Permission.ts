// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Permission Service — enterprise-grade HITL permission lifecycle.
 *
 * Server-authoritative state machine for permission requests that require
 * human approval. Agent-bridge is a relay; vps-ui is a signer; the console
 * is a view. This service is the single source of truth.
 *
 * Status machine:
 *   pending   → granted | denied | revoked | expired | superseded
 *   granted   → revoked | expired
 *   everything else is terminal
 *
 * Every transition emits an audit_log row and a live event over the
 * inbox event bus (see permissions.routes.ts for the SSE plumbing).
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import { isSandboxId } from '@ellul.ai/types';
import { logAuditEvent } from '../audit/Audit';
import { ensureSandbox } from '../process/SandboxRegistry';
import type { GateType } from './Gate';

// ── Injected DB handle ──────────────────────────────────────────────────

let db: Database;
export function setPermissionDb(database: Database): void { db = database; }

// ── Types ───────────────────────────────────────────────────────────────

export type PermissionStatus =
  | 'pending' | 'granted' | 'denied' | 'revoked' | 'expired' | 'superseded';

export interface RequestedBy {
  agentId?: string;
  cliKind?: string;
  toolName?: string;
  argsHash?: string;
}

export interface Resolution {
  action: 'grant_timed' | 'grant_session' | 'grant_always' | 'deny' | 'deny_always';
  ttlMs?: number | null;
  expiresAt?: number | null;
  resolvedAt: number;
  sessionId?: string | null;
  credentialId?: string | null;
  popNonce?: string | null;
  popTimestamp?: string | null;
  device?: { ip?: string | null; userAgent?: string | null } | null;
}

export interface PermissionRequest {
  id: string;
  gate: GateType;
  threadId: string;
  sandboxId: string | null;
  requestedBy: RequestedBy;
  scope: Record<string, unknown> | null;
  reason: string | null;
  status: PermissionStatus;
  resolution: Resolution | null;
  createdAt: number;
  lastSeenAt: number | null;
  resolvedAt: number | null;
}

interface Row {
  id: string;
  gate: string;
  thread_id: string;
  sandbox_id: string | null;
  requested_by: string;
  scope_json: string | null;
  reason: string | null;
  request_hash: string;
  status: PermissionStatus;
  resolution_json: string | null;
  credential_id: string | null;
  session_id: string | null;
  created_at: number;
  last_seen_at: number | null;
  resolved_at: number | null;
}

// ── Event bus (fed into SSE by the public routes) ───────────────────────

export type PermissionEvent =
  | { type: 'request.created';  request: PermissionRequest }
  | { type: 'request.resolved'; request: PermissionRequest }
  | { type: 'request.revoked';  request: PermissionRequest }
  | { type: 'request.expired';  request: PermissionRequest }
  | { type: 'request.seen';     request: PermissionRequest };

export const permissionBus = new EventEmitter();
permissionBus.setMaxListeners(0);

function emit(event: PermissionEvent): void {
  try { permissionBus.emit('event', event); } catch {}
}

// ── Helpers ─────────────────────────────────────────────────────────────

function hashRequest(
  gate: string, threadId: string, sandboxId: string | null, requestedBy: RequestedBy,
): string {
  const payload = JSON.stringify({
    g: gate,
    t: threadId,
    s: sandboxId || '',
    a: requestedBy.argsHash || '',
    tool: requestedBy.toolName || '',
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function rowToRequest(row: Row): PermissionRequest {
  return {
    id: row.id,
    gate: row.gate as GateType,
    threadId: row.thread_id,
    sandboxId: row.sandbox_id,
    requestedBy: JSON.parse(row.requested_by) as RequestedBy,
    scope: row.scope_json ? JSON.parse(row.scope_json) as Record<string, unknown> : null,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution_json ? JSON.parse(row.resolution_json) as Resolution : null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  };
}

// ── Lifecycle API ───────────────────────────────────────────────────────

export interface CreateRequestInput {
  gate: GateType;
  threadId: string;
  sandboxId?: string | null;
  requestedBy: RequestedBy;
  scope?: Record<string, unknown> | null;
  reason?: string | null;
}

export interface CreateRequestResult {
  request: PermissionRequest;
  /** true if this call created a new row; false if a pending duplicate was returned. */
  created: boolean;
}

/**
 * Idempotent create — if a pending row already exists for the same
 * (gate, threadId, sandboxId, toolName, argsHash), return it instead
 * of creating a duplicate. This is what keeps rapid re-requests from
 * the agent from filling the inbox with noise.
 */
export function createRequest(input: CreateRequestInput): CreateRequestResult {
  if (input.sandboxId && isSandboxId(input.sandboxId)) {
    ensureSandbox(input.sandboxId);
  }

  const id = crypto.randomUUID();
  const requestHash = hashRequest(
    input.gate, input.threadId, input.sandboxId || null, input.requestedBy,
  );
  const now = Date.now();
  const requestedByJson = JSON.stringify(input.requestedBy);
  const scopeJson = input.scope ? JSON.stringify(input.scope) : null;

  // The unique partial index on (request_hash) WHERE status='pending'
  // enforces dedup atomically. INSERT-then-fallback-to-SELECT is safe
  // because the index rejects any concurrent duplicate.
  const tx = db.transaction(() => {
    try {
      db.prepare(
        `INSERT INTO permission_requests
          (id, gate, thread_id, sandbox_id, requested_by, scope_json, reason,
           request_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(
        id, input.gate, input.threadId, input.sandboxId || null,
        requestedByJson, scopeJson, input.reason || null,
        requestHash, now,
      );
      const row = db.prepare('SELECT * FROM permission_requests WHERE id = ?')
        .get(id) as Row;
      return { row, created: true };
    } catch (e) {
      // UNIQUE violation on the partial index → a pending duplicate exists.
      const existing = db.prepare(
        `SELECT * FROM permission_requests
          WHERE request_hash = ? AND status = 'pending'`,
      ).get(requestHash) as Row | undefined;
      if (!existing) throw e;
      return { row: existing, created: false };
    }
  });

  const { row, created } = tx() as { row: Row; created: boolean };
  const request = rowToRequest(row);
  if (created) {
    logAuditEvent({
      type: 'permission_request_created',
      sandboxId: request.sandboxId,
      details: {
        id: request.id, gate: request.gate,
        threadId: request.threadId.slice(0, 8),
        requestedBy: request.requestedBy,
      },
    });
    emit({ type: 'request.created', request });
  }
  return { request, created };
}

export function getRequest(id: string): PermissionRequest | null {
  const row = db.prepare('SELECT * FROM permission_requests WHERE id = ?')
    .get(id) as Row | undefined;
  return row ? rowToRequest(row) : null;
}

export interface ResolveInput {
  id: string;
  action: Resolution['action'];
  ttlMs?: number | null;
  expiresAt?: number | null;
  sessionId?: string | null;
  credentialId?: string | null;
  popNonce?: string | null;
  popTimestamp?: string | null;
  device?: Resolution['device'];
}

export type ResolveError =
  | { code: 'not_found' }
  | { code: 'already_resolved'; current: PermissionRequest };

/**
 * Atomic pending → granted/denied transition. Returns the 409-style
 * current state if the row has already been resolved — this is how
 * multi-device convergence works.
 */
export function resolveRequest(
  input: ResolveInput,
): { request: PermissionRequest } | ResolveError {
  const isGrant = input.action.startsWith('grant');
  const newStatus: PermissionStatus = isGrant ? 'granted' : 'denied';

  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM permission_requests WHERE id = ?')
      .get(input.id) as Row | undefined;
    if (!row) return { code: 'not_found' as const };
    if (row.status !== 'pending') {
      return { code: 'already_resolved' as const, current: rowToRequest(row) };
    }

    const now = Date.now();
    const resolution: Resolution = {
      action: input.action,
      ttlMs: input.ttlMs ?? null,
      expiresAt: input.expiresAt ?? null,
      resolvedAt: now,
      sessionId: input.sessionId ?? null,
      credentialId: input.credentialId ?? null,
      popNonce: input.popNonce ?? null,
      popTimestamp: input.popTimestamp ?? null,
      device: input.device ?? null,
    };

    db.prepare(
      `UPDATE permission_requests
         SET status = ?, resolution_json = ?, resolved_at = ?,
             session_id = ?, credential_id = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(
      newStatus, JSON.stringify(resolution), now,
      input.sessionId ?? null, input.credentialId ?? null,
      input.id,
    );

    const updated = db.prepare('SELECT * FROM permission_requests WHERE id = ?')
      .get(input.id) as Row;
    return { request: rowToRequest(updated) };
  });

  const result = tx() as { request: PermissionRequest } | ResolveError;
  if ('code' in result) return result;
  const request = result.request;
  logAuditEvent({
    type: isGrant ? 'permission_granted' : 'permission_denied',
    sandboxId: request.sandboxId,
    sessionId: input.sessionId ?? null,
    credentialId: input.credentialId ?? null,
    details: {
      id: request.id, gate: request.gate,
      threadId: request.threadId.slice(0, 8),
      action: input.action, ttlMs: input.ttlMs ?? null,
    },
  });
  emit({ type: 'request.resolved', request });
  return { request };
}

export function revokeRequest(id: string): PermissionRequest | null {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM permission_requests WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) return null;
    if (row.status !== 'granted' && row.status !== 'pending') return row;

    const now = Date.now();
    db.prepare(
      `UPDATE permission_requests
         SET status = 'revoked', resolved_at = ?
       WHERE id = ?`,
    ).run(now, id);

    return db.prepare('SELECT * FROM permission_requests WHERE id = ?')
      .get(id) as Row;
  });

  const row = tx() as Row | null;
  if (!row) return null;
  const request = rowToRequest(row);
  if (request.status === 'revoked') {
    logAuditEvent({
      type: 'permission_revoked',
      sandboxId: request.sandboxId,
      details: { id: request.id, gate: request.gate },
    });
    emit({ type: 'request.revoked', request });
  }
  return request;
}

export function markSeen(id: string): PermissionRequest | null {
  const now = Date.now();
  const result = db.prepare(
    `UPDATE permission_requests SET last_seen_at = ?
       WHERE id = ? AND status = 'pending'`,
  ).run(now, id);
  if (result.changes === 0) return getRequest(id);

  const request = getRequest(id);
  if (request) emit({ type: 'request.seen', request });
  return request;
}

/**
 * Sweep pending rows older than TTL → expired. Idempotent.
 * Called from a periodic timer in the shield boot path.
 */
export function expireStale(ttlMs: number): number {
  const cutoff = Date.now() - ttlMs;
  const rows = db.prepare(
    `SELECT * FROM permission_requests
       WHERE status = 'pending' AND created_at < ?`,
  ).all(cutoff) as Row[];
  if (rows.length === 0) return 0;

  const expireOne = db.prepare(
    `UPDATE permission_requests SET status = 'expired', resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
  );
  const now = Date.now();

  // better-sqlite3's `db.transaction` is overloaded such that the typed
  // callback signature resolves to `(...args: unknown[]) => unknown`;
  // close over the row set instead of passing it as an argument so the
  // inner function stays strictly typed.
  const txRun = db.transaction(() => {
    let changed = 0;
    for (const r of rows) {
      const res = expireOne.run(now, r.id);
      if (res.changes > 0) changed++;
    }
    return changed;
  });
  const changed = txRun() as number;

  for (const row of rows) {
    const fresh = db.prepare('SELECT * FROM permission_requests WHERE id = ?')
      .get(row.id) as Row | undefined;
    if (fresh && fresh.status === 'expired') {
      const request = rowToRequest(fresh);
      logAuditEvent({
        type: 'permission_expired',
        sandboxId: request.sandboxId,
        details: { id: request.id, gate: request.gate, ageMs: now - request.createdAt },
      });
      emit({ type: 'request.expired', request });
    }
  }
  return changed;
}

// ── Queries ─────────────────────────────────────────────────────────────

const STALE_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function listPending(opts: {
  sandboxId?: string | null;
  threadId?: string;
  limit?: number;
} = {}): PermissionRequest[] {
  const limit = Math.min(opts.limit ?? 200, 500);
  const cutoff = Date.now() - STALE_PENDING_TTL_MS;
  const clauses: string[] = [`status = 'pending'`, `created_at > ?`];
  const args: (string | number)[] = [cutoff];
  if (opts.sandboxId) { clauses.push('sandbox_id = ?'); args.push(opts.sandboxId); }
  if (opts.threadId)  { clauses.push('thread_id = ?');  args.push(opts.threadId); }
  const sql =
    `SELECT * FROM permission_requests
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?`;
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as Row[];
  return rows.map(rowToRequest);
}

export function listForThread(
  threadId: string,
  opts: { includeResolved?: boolean; limit?: number; sandboxId?: string | null } = {},
): PermissionRequest[] {
  const limit = Math.min(opts.limit ?? 100, 500);
  const clauses: string[] = ['thread_id = ?'];
  const args: (string | number)[] = [threadId];
  if (!opts.includeResolved) clauses.push(`status = 'pending'`);
  // When the caller supplies a sandbox scope, push it into the SQL so the
  // filter is enforced at the storage layer, not by client-side .filter().
  // This matches listPending's model and keeps scope enforcement
  // server-side even if a future caller forgets to post-filter.
  if (opts.sandboxId) { clauses.push('sandbox_id = ?'); args.push(opts.sandboxId); }
  const sql = `SELECT * FROM permission_requests WHERE ${clauses.join(' AND ')}
                 ORDER BY created_at DESC LIMIT ?`;
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as Row[];
  return rows.map(rowToRequest);
}
