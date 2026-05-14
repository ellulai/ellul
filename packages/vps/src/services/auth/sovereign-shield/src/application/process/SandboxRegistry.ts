// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sandbox Registry
 *
 * Canonical record of every sandbox that exists on this VPS. Every
 * sandbox-scoped security table (env_exposures, env_classifications,
 * cross_project_access, …) has a foreign key to `sandboxes(id)` with
 * ON DELETE CASCADE — which means:
 *
 *   1. A sandbox id must be registered here BEFORE any security table can
 *      reference it. Services that write sandbox-scoped rows MUST call
 *      `ensureSandbox()` first (idempotent).
 *
 *   2. Deleting a sandbox row cascades through every security surface in
 *      one transaction — no orphan secrets, no stale gate grants, no
 *      dangling cross-project rules. `deleteSandbox()` is the single
 *      entrypoint for teardown.
 *
 * Typing: all operations accept the branded `SandboxId` type. The
 * compile-time brand plus the DB-level CHECK constraint form a two-layer
 * defense against malformed slugs ever reaching storage.
 */

import type { SandboxId } from '@ellul.ai/types';
import { db } from '../../database';

// ── Prepared statements (lazy) ───────────────────────────────────────────────

let ensureStmt: ReturnType<typeof db.prepare> | null = null;
let softDeleteStmt: ReturnType<typeof db.prepare> | null = null;
let hardDeleteStmt: ReturnType<typeof db.prepare> | null = null;
let existsStmt: ReturnType<typeof db.prepare> | null = null;
let listStmt: ReturnType<typeof db.prepare> | null = null;

function init(): void {
  if (ensureStmt) return;
  ensureStmt = db.prepare(
    `INSERT INTO sandboxes (id, created_at, deleted_at) VALUES (?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET deleted_at = NULL
     WHERE sandboxes.deleted_at IS NOT NULL`,
  );
  softDeleteStmt = db.prepare(
    `UPDATE sandboxes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
  );
  hardDeleteStmt = db.prepare(`DELETE FROM sandboxes WHERE id = ?`);
  existsStmt = db.prepare(
    `SELECT 1 FROM sandboxes WHERE id = ? AND deleted_at IS NULL`,
  );
  listStmt = db.prepare(
    `SELECT id, created_at, deleted_at FROM sandboxes WHERE deleted_at IS NULL ORDER BY created_at ASC`,
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a sandbox or revive a soft-deleted one. Idempotent — calling
 * this for an already-registered sandbox is a no-op. Call this at
 * sandbox creation time and also defensively at the start of every
 * write to a sandbox-scoped table (cheap, guarantees FK parent exists).
 */
export function ensureSandbox(sandboxId: SandboxId): void {
  init();
  ensureStmt!.run(sandboxId, Date.now());
}

/**
 * Soft-delete a sandbox: marks `deleted_at` but keeps the row so
 * audit trails and foreign keys remain valid. Prefer this over a
 * hard delete unless the sandbox genuinely never existed.
 *
 * Returns `true` if the soft delete took effect (row was live),
 * `false` if it was already gone.
 */
export function softDeleteSandbox(sandboxId: SandboxId): boolean {
  init();
  const result = softDeleteStmt!.run(Date.now(), sandboxId);
  return result.changes > 0;
}

/**
 * Hard-delete a sandbox AND cascade-delete every sandbox-scoped row
 * that references it. Irreversible. Triggers FK CASCADE on:
 *   - env_exposures
 *   - env_classifications
 *   - cross_project_access (both `sandbox_id` and `shared_sandbox_id`)
 *   - (future sandbox-scoped tables that reference sandboxes(id))
 *
 * Returns the number of sandbox rows deleted (0 or 1).
 */
export function hardDeleteSandbox(sandboxId: SandboxId): number {
  init();
  const result = hardDeleteStmt!.run(sandboxId);
  return result.changes;
}

/**
 * Check whether a sandbox is currently registered and live.
 */
export function isSandboxRegistered(sandboxId: SandboxId): boolean {
  init();
  return existsStmt!.get(sandboxId) !== undefined;
}

/**
 * List every live sandbox on this VPS, oldest first.
 */
export function listSandboxes(): Array<{ id: SandboxId; createdAt: number; deletedAt: number | null }> {
  init();
  const rows = listStmt!.all() as Array<{
    id: string;
    created_at: number;
    deleted_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id as SandboxId,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
  }));
}
