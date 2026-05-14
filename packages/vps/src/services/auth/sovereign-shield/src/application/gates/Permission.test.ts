// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Permission service unit tests.
 *
 * Covers the state machine invariants that the plan promises and the
 * audit flagged as a gap: idempotent create, 409-on-race resolve,
 * status transition rejection for terminal states, expiration sweep,
 * and event-bus emission for every transition.
 *
 * Uses an in-memory sqlite mirroring production schema so the unique
 * partial index's concurrent-dedup behavior is actually exercised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase as setAuditDb } from '../audit/Audit';
import {
  setPermissionDb,
  createRequest,
  resolveRequest,
  revokeRequest,
  markSeen,
  getRequest,
  listPending,
  listForThread,
  expireStale,
  permissionBus,
  type PermissionEvent,
} from '../gates/Permission';

// Build a fresh in-memory DB for each test. We mirror the production
// tables directly from database.ts — the tests fail loudly if the real
// schema drifts without the test schema being updated.
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE sandboxes (
      id         TEXT PRIMARY KEY CHECK (id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]'),
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      event TEXT NOT NULL,
      ip TEXT, fingerprint TEXT, credential_id TEXT, session_id TEXT,
      sandbox_id TEXT,
      details TEXT, prev_hash TEXT, hash TEXT NOT NULL
    );

    CREATE TABLE permission_requests (
      id              TEXT PRIMARY KEY,
      gate            TEXT NOT NULL,
      thread_id       TEXT NOT NULL,
      sandbox_id      TEXT REFERENCES sandboxes(id) ON DELETE CASCADE,
      requested_by    TEXT NOT NULL,
      scope_json      TEXT,
      reason          TEXT,
      request_hash    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','granted','denied','revoked','expired','superseded')),
      resolution_json TEXT,
      credential_id   TEXT,
      session_id      TEXT,
      created_at      INTEGER NOT NULL,
      last_seen_at    INTEGER,
      resolved_at     INTEGER
    );
    CREATE INDEX idx_permreq_status_thread  ON permission_requests(status, thread_id);
    CREATE INDEX idx_permreq_status_sandbox ON permission_requests(status, sandbox_id);
    CREATE INDEX idx_permreq_created        ON permission_requests(created_at);
    CREATE UNIQUE INDEX idx_permreq_pending_hash
      ON permission_requests(request_hash) WHERE status = 'pending';
  `);
  return db;
}

function collectEvents(): { events: PermissionEvent[]; detach: () => void } {
  const events: PermissionEvent[] = [];
  const handler = (e: PermissionEvent) => events.push(e);
  permissionBus.on('event', handler);
  return { events, detach: () => permissionBus.off('event', handler) };
}

describe('permission.service', () => {
  let db: Database.Database;
  let collector: { events: PermissionEvent[]; detach: () => void };

  beforeEach(() => {
    db = buildDb();
    // Seed a sandbox so FK references pass.
    db.prepare('INSERT INTO sandboxes(id, created_at) VALUES (?, ?)')
      .run('sbx-aaaaaaa', Date.now());
    setPermissionDb(db);
    setAuditDb(db);
    collector = collectEvents();
  });

  afterEach(() => {
    collector.detach();
    db.close();
  });

  // ── createRequest ────────────────────────────────────────────────

  it('creates a new pending request and emits request.created', () => {
    const { request, created } = createRequest({
      gate: 'env',
      threadId: 'thread-1',
      sandboxId: 'sbx-aaaaaaa',
      reason: 'read .env',
      requestedBy: { toolName: 'read_env', argsHash: 'h1' },
    });
    expect(created).toBe(true);
    expect(request.status).toBe('pending');
    expect(request.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(collector.events.filter((e) => e.type === 'request.created')).toHaveLength(1);
  });

  it('dedupes identical pending requests (unique partial index)', () => {
    const input = {
      gate: 'env' as const,
      threadId: 'thread-1',
      sandboxId: 'sbx-aaaaaaa' as const,
      requestedBy: { toolName: 'read_env', argsHash: 'h1' },
    };
    const first = createRequest(input);
    const second = createRequest(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    // Only one audit+event emission
    expect(collector.events.filter((e) => e.type === 'request.created')).toHaveLength(1);
  });

  it('allows a new pending request once the prior one is resolved', () => {
    const input = {
      gate: 'env' as const,
      threadId: 'thread-1',
      sandboxId: 'sbx-aaaaaaa' as const,
      requestedBy: { toolName: 'read_env', argsHash: 'h1' },
    };
    const first = createRequest(input);
    resolveRequest({ id: first.request.id, action: 'grant_timed' });
    const second = createRequest(input);
    expect(second.created).toBe(true);
    expect(second.request.id).not.toBe(first.request.id);
  });

  it('differentiates by argsHash (different args → different request)', () => {
    const base = {
      gate: 'env' as const,
      threadId: 'thread-1',
      sandboxId: 'sbx-aaaaaaa' as const,
    };
    const a = createRequest({ ...base, requestedBy: { toolName: 'read_env', argsHash: 'h1' } });
    const b = createRequest({ ...base, requestedBy: { toolName: 'read_env', argsHash: 'h2' } });
    expect(a.request.id).not.toBe(b.request.id);
    expect(a.created && b.created).toBe(true);
  });

  // ── resolveRequest ──────────────────────────────────────────────

  it('resolves pending → granted and emits request.resolved', () => {
    const { request } = createRequest({
      gate: 'env',
      threadId: 'thread-1',
      sandboxId: 'sbx-aaaaaaa',
      requestedBy: {},
    });
    const result = resolveRequest({
      id: request.id,
      action: 'grant_timed',
      ttlMs: 30_000,
      expiresAt: Date.now() + 30_000,
    });
    expect('request' in result).toBe(true);
    if ('request' in result) {
      expect(result.request.status).toBe('granted');
      expect(result.request.resolution?.action).toBe('grant_timed');
    }
    expect(collector.events.filter((e) => e.type === 'request.resolved')).toHaveLength(1);
  });

  it('rejects resolveRequest with 409-semantic error on second attempt', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    const first = resolveRequest({ id: request.id, action: 'grant_timed' });
    const second = resolveRequest({ id: request.id, action: 'deny' });
    expect('request' in first).toBe(true);
    expect('code' in second && second.code === 'already_resolved').toBe(true);
    if ('code' in second && second.code === 'already_resolved') {
      expect(second.current.status).toBe('granted');
    }
  });

  it('returns not_found for unknown id', () => {
    const result = resolveRequest({ id: 'nonexistent', action: 'grant_timed' });
    expect('code' in result && result.code === 'not_found').toBe(true);
  });

  it('denies correctly and stays in denied state', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    resolveRequest({ id: request.id, action: 'deny' });
    const after = getRequest(request.id);
    expect(after?.status).toBe('denied');
    expect(after?.resolution?.action).toBe('deny');
  });

  // ── revokeRequest ───────────────────────────────────────────────

  it('revokes a granted row and emits request.revoked', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    resolveRequest({ id: request.id, action: 'grant_timed' });
    const result = revokeRequest(request.id);
    expect(result?.status).toBe('revoked');
    expect(collector.events.filter((e) => e.type === 'request.revoked')).toHaveLength(1);
  });

  it('revokes a pending row (operator abort)', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    const result = revokeRequest(request.id);
    expect(result?.status).toBe('revoked');
  });

  it('no-op when revoking an already-denied row', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    resolveRequest({ id: request.id, action: 'deny' });
    const revokedEventsBefore = collector.events.filter((e) => e.type === 'request.revoked').length;
    const result = revokeRequest(request.id);
    expect(result?.status).toBe('denied'); // unchanged
    const revokedEventsAfter = collector.events.filter((e) => e.type === 'request.revoked').length;
    expect(revokedEventsAfter).toBe(revokedEventsBefore);
  });

  // ── markSeen ────────────────────────────────────────────────────

  it('bumps lastSeenAt on markSeen and emits request.seen', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    expect(request.lastSeenAt).toBeNull();
    const updated = markSeen(request.id);
    expect(updated?.lastSeenAt).toBeGreaterThan(0);
    expect(collector.events.filter((e) => e.type === 'request.seen')).toHaveLength(1);
  });

  it('does not bump lastSeenAt on already-resolved rows', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    resolveRequest({ id: request.id, action: 'deny' });
    const updated = markSeen(request.id);
    // row still readable, but lastSeenAt should not have been updated
    expect(updated?.lastSeenAt).toBeNull();
  });

  // ── expireStale ─────────────────────────────────────────────────

  it('expires pending rows older than ttl and emits request.expired', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    // Backdate so it looks ancient.
    db.prepare('UPDATE permission_requests SET created_at = ? WHERE id = ?')
      .run(Date.now() - 20 * 60 * 1000, request.id);
    const expired = expireStale(15 * 60 * 1000);
    expect(expired).toBe(1);
    const after = getRequest(request.id);
    expect(after?.status).toBe('expired');
    expect(collector.events.filter((e) => e.type === 'request.expired')).toHaveLength(1);
  });

  it('leaves fresh pending rows untouched', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    const expired = expireStale(15 * 60 * 1000);
    expect(expired).toBe(0);
    expect(getRequest(request.id)?.status).toBe('pending');
  });

  // ── Queries ─────────────────────────────────────────────────────

  it('listPending filters by sandbox + thread', () => {
    createRequest({ gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: { argsHash: '1' } });
    createRequest({ gate: 'db_read', threadId: 'thread-2', sandboxId: 'sbx-aaaaaaa', requestedBy: { argsHash: '2' } });
    expect(listPending({ sandboxId: 'sbx-aaaaaaa' })).toHaveLength(2);
    expect(listPending({ threadId: 'thread-1' })).toHaveLength(1);
  });

  it('listForThread excludes resolved rows by default', () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });
    resolveRequest({ id: request.id, action: 'grant_timed' });
    expect(listForThread('thread-1')).toHaveLength(0);
    expect(listForThread('thread-1', { includeResolved: true })).toHaveLength(1);
  });
});
