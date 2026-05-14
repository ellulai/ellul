// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { db } from "../../database";
import type { ThreadStore, ThreadRow } from "./ThreadArchive";

export function makeSqliteThreadStore(): ThreadStore {
  const upsertStmt = db.prepare(
    `INSERT INTO thread_archive (thread_id, sandbox_id, archived_at, updated_at)
     VALUES (@threadId, @sandboxId, @archivedAt, @updatedAt)
     ON CONFLICT(thread_id) DO UPDATE SET
       sandbox_id = excluded.sandbox_id,
       updated_at = excluded.updated_at`,
  );
  const setArchivedStmt = db.prepare(
    `UPDATE thread_archive SET archived_at = @archivedAt, updated_at = @updatedAt WHERE thread_id = @threadId`,
  );
  const listStmt = db.prepare(
    `SELECT thread_id as threadId, sandbox_id as sandboxId, archived_at as archivedAt, updated_at as updatedAt
     FROM thread_archive WHERE sandbox_id = @sandboxId
     ORDER BY archived_at IS NULL DESC, updated_at DESC`,
  );

  return {
    async listForSandbox(sandboxId) {
      return listStmt.all({ sandboxId }) as ReadonlyArray<ThreadRow>;
    },
    async setArchivedAt(threadId, at) {
      const r = setArchivedStmt.run({ threadId, archivedAt: at, updatedAt: Date.now() });
      if (r.changes === 0) {
        upsertStmt.run({ threadId, sandboxId: "", archivedAt: at, updatedAt: Date.now() });
      }
    },
  };
}

export function recordThreadActivity(threadId: string, sandboxId: string): void {
  db.prepare(
    `INSERT INTO thread_archive (thread_id, sandbox_id, archived_at, updated_at)
     VALUES (@threadId, @sandboxId, NULL, @updatedAt)
     ON CONFLICT(thread_id) DO UPDATE SET
       sandbox_id = excluded.sandbox_id,
       updated_at = excluded.updated_at`,
  ).run({ threadId, sandboxId, updatedAt: Date.now() });
}
