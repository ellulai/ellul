// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Integration-style race tests for the permission state machine.
 *
 * Covers the multi-device convergence invariants the plan promises:
 *   - Two concurrent resolves on the same id → first wins, second gets
 *     409 with the authoritative current state (no double-grant).
 *   - Two concurrent creates with the same argsHash → one row, one id.
 *   - Resolve-during-revoke ordering → whichever landed first wins,
 *     second reports the final status cleanly.
 *
 * These exercise the SQLite transaction + unique partial index layer,
 * which is the only place those guarantees are enforced — unit tests
 * would not catch a regression here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase as setAuditDb } from '../audit/Audit';
import {
  setPermissionDb,
  createRequest,
  resolveRequest,
  revokeRequest,
} from '../gates/Permission';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE sandboxes (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL, event TEXT NOT NULL,
      ip TEXT, fingerprint TEXT, credential_id TEXT, session_id TEXT,
      sandbox_id TEXT, details TEXT, prev_hash TEXT, hash TEXT NOT NULL
    );
    CREATE TABLE permission_requests (
      id TEXT PRIMARY KEY, gate TEXT NOT NULL, thread_id TEXT NOT NULL,
      sandbox_id TEXT REFERENCES sandboxes(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL, scope_json TEXT, reason TEXT,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','granted','denied','revoked','expired','superseded')),
      resolution_json TEXT, credential_id TEXT, session_id TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, resolved_at INTEGER
    );
    CREATE UNIQUE INDEX idx_permreq_pending_hash
      ON permission_requests(request_hash) WHERE status = 'pending';
  `);
  return db;
}

describe('permission service — convergence under race', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    db.prepare('INSERT INTO sandboxes(id, created_at) VALUES (?, ?)')
      .run('sbx-aaaaaaa', Date.now());
    setPermissionDb(db);
    setAuditDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('two concurrent resolves on the same id → first wins, second 409s', async () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });

    // Simulate two devices grabbing the same pending id simultaneously.
    // Even though both calls enter from the same tick, each one goes
    // through BEGIN...COMMIT and the UPDATE guards on `status='pending'`.
    // Only one row transitions; the second sees status!=pending and
    // returns the 409-equivalent already_resolved.
    const [a, b] = await Promise.all([
      Promise.resolve(resolveRequest({ id: request.id, action: 'grant_timed' })),
      Promise.resolve(resolveRequest({ id: request.id, action: 'deny' })),
    ]);

    const winners = [a, b].filter((r) => 'request' in r);
    const losers = [a, b].filter((r) => 'code' in r);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser must surface the winner's state so the UI can reconcile
    // with "resolved on another device" rather than an opaque error.
    if ('code' in losers[0]) {
      expect(losers[0].code).toBe('already_resolved');
      expect(['granted', 'denied']).toContain(losers[0].current.status);
    }
  });

  it('concurrent creates with same argsHash → one row, two callers see same id', async () => {
    const input = {
      gate: 'env' as const,
      threadId: 'thread-1',
      sandboxId: 'sbx-aaaaaaa' as const,
      requestedBy: { toolName: 'read_env', argsHash: 'same' },
    };
    const [a, b] = await Promise.all([
      Promise.resolve(createRequest(input)),
      Promise.resolve(createRequest(input)),
    ]);

    expect(a.request.id).toBe(b.request.id);
    // Exactly one call created the row. Which one depends on transaction
    // ordering — we don't care as long as the IDs agree.
    const createdCount = [a.created, b.created].filter(Boolean).length;
    expect(createdCount).toBe(1);

    // Verify the DB state: exactly one pending row for this input.
    const pending = db.prepare(
      `SELECT COUNT(*) as c FROM permission_requests
         WHERE thread_id = ? AND gate = ? AND status = 'pending'`
    ).get('thread-1', 'env') as { c: number };
    expect(pending.c).toBe(1);
  });

  it('resolve racing with revoke → terminal state is consistent', async () => {
    const { request } = createRequest({
      gate: 'env', threadId: 'thread-1', sandboxId: 'sbx-aaaaaaa', requestedBy: {},
    });

    const [resolveRes, revokeRes] = await Promise.all([
      Promise.resolve(resolveRequest({ id: request.id, action: 'grant_timed' })),
      Promise.resolve(revokeRequest(request.id)),
    ]);

    // Whatever the order, the row must end up in a terminal state that
    // matches one of {granted, revoked} — never in a mixed state.
    const final = db.prepare('SELECT status FROM permission_requests WHERE id = ?')
      .get(request.id) as { status: string };
    expect(['granted', 'revoked']).toContain(final.status);

    // Both calls must have returned a self-consistent result for that
    // state; no throw, no silent swallowing.
    expect(resolveRes).toBeDefined();
    expect(revokeRes).toBeDefined();
  });

  it('100 parallel creates dedupe to a single row', async () => {
    const input = {
      gate: 'env' as const,
      threadId: 'thread-stress',
      sandboxId: 'sbx-aaaaaaa' as const,
      requestedBy: { toolName: 'read_env', argsHash: 'stress' },
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve(createRequest(input))),
    );
    const uniqueIds = new Set(results.map((r) => r.request.id));
    expect(uniqueIds.size).toBe(1);
    const createdCount = results.filter((r) => r.created).length;
    expect(createdCount).toBe(1);

    const rows = db.prepare(
      `SELECT COUNT(*) as c FROM permission_requests WHERE status = 'pending'`
    ).get() as { c: number };
    expect(rows.c).toBe(1);
  });
});
