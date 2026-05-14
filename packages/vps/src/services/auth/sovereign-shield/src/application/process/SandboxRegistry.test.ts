// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sandbox registry + schema constraint tests.
 *
 * Proves the DB-level invariants from `docs/ARCHITECTURE-SCOPE.md`:
 *   I1: CHECK constraint rejects non-sandbox-shape ids.
 *   I4: ON DELETE CASCADE reaps every sandbox-scoped row atomically.
 *
 * Uses an in-memory sqlite to avoid touching the per-VPS shield DB.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { parseSandboxId, type SandboxId } from '@ellul.ai/types';

/**
 * Build an in-memory DB with the sandboxes parent table + FK-cascaded
 * children, mirroring the production schema in `database.ts`. We spin up a
 * fresh DB per test so state never leaks.
 */
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

    CREATE TABLE cross_project_access (
      sandbox_id         TEXT NOT NULL CHECK (sandbox_id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]')
                         REFERENCES sandboxes(id) ON DELETE CASCADE,
      shared_sandbox_id  TEXT NOT NULL CHECK (shared_sandbox_id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]')
                         REFERENCES sandboxes(id) ON DELETE CASCADE,
      granted_at         INTEGER NOT NULL,
      share_preview      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (sandbox_id, shared_sandbox_id),
      CHECK (sandbox_id != shared_sandbox_id)
    );
  `);
  return db;
}

const A: SandboxId = parseSandboxId('sbx-aaaaaaa');
const B: SandboxId = parseSandboxId('sbx-bbbbbbb');

describe('sandboxes table — CHECK constraint', () => {
  let db: Database.Database;
  beforeEach(() => { db = buildDb(); });

  it.each([
    ['lower-hex-7', 'sbx-abc1234'],
    ['all zeroes', 'sbx-0000000'],
  ])('accepts %s (%s)', (_desc, id) => {
    expect(() =>
      db.prepare('INSERT INTO sandboxes (id, created_at) VALUES (?, ?)').run(id, Date.now()),
    ).not.toThrow();
  });

  it.each([
    ['empty', ''],
    ['wrong prefix', 'pre-abcdefg'],
    ['too short', 'sbx-abcdef'],
    ['too long', 'sbx-abcdefgh'],
    ['uppercase', 'sbx-ABCDEFG'],
    ['hyphen inside', 'sbx-abc-efg'],
    ['slash traversal', 'sbx-abc/foo'],
  ])('rejects %s (%s) at INSERT time', (_desc, id) => {
    expect(() =>
      db.prepare('INSERT INTO sandboxes (id, created_at) VALUES (?, ?)').run(id, Date.now()),
    ).toThrow();
  });
});

describe('cross_project_access — FK + CHECK', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = buildDb();
    db.prepare('INSERT INTO sandboxes (id, created_at) VALUES (?, ?)').run(A, Date.now());
    db.prepare('INSERT INTO sandboxes (id, created_at) VALUES (?, ?)').run(B, Date.now());
  });

  it('rejects malformed sandbox_id via CHECK', () => {
    expect(() =>
      db
        .prepare(
          'INSERT INTO cross_project_access (sandbox_id, shared_sandbox_id, granted_at) VALUES (?, ?, ?)',
        )
        .run('nope', B, Date.now()),
    ).toThrow();
  });

  it('rejects references to missing parent via FK', () => {
    expect(() =>
      db
        .prepare(
          'INSERT INTO cross_project_access (sandbox_id, shared_sandbox_id, granted_at) VALUES (?, ?, ?)',
        )
        .run('sbx-cccccccc'.slice(0, 11), B, Date.now()),
    ).toThrow();
  });

  it('rejects self-reference via CHECK (sandbox_id != shared_sandbox_id)', () => {
    expect(() =>
      db
        .prepare(
          'INSERT INTO cross_project_access (sandbox_id, shared_sandbox_id, granted_at) VALUES (?, ?, ?)',
        )
        .run(A, A, Date.now()),
    ).toThrow();
  });

  it('CASCADE reaps child rows when parent sandbox deleted (reader side)', () => {
    db.prepare(
      'INSERT INTO cross_project_access (sandbox_id, shared_sandbox_id, granted_at) VALUES (?, ?, ?)',
    ).run(A, B, Date.now());
    expect(
      db.prepare('SELECT COUNT(*) as c FROM cross_project_access').get() as { c: number },
    ).toEqual({ c: 1 });

    db.prepare('DELETE FROM sandboxes WHERE id = ?').run(A);

    expect(
      db.prepare('SELECT COUNT(*) as c FROM cross_project_access').get() as { c: number },
    ).toEqual({ c: 0 });
  });

  it('CASCADE reaps child rows when parent sandbox deleted (target side)', () => {
    db.prepare(
      'INSERT INTO cross_project_access (sandbox_id, shared_sandbox_id, granted_at) VALUES (?, ?, ?)',
    ).run(A, B, Date.now());
    db.prepare('DELETE FROM sandboxes WHERE id = ?').run(B);
    expect(
      db.prepare('SELECT COUNT(*) as c FROM cross_project_access').get() as { c: number },
    ).toEqual({ c: 0 });
  });
});
