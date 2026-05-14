// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import BetterSqlite from "better-sqlite3";
import * as path from "path";

import { ORCHESTRATION_DB_PATH, PROJECTS_DIR } from "../../config";

type DatabaseConnection = ReturnType<typeof BetterSqlite>;

let db: DatabaseConnection | null = null;

function openDb(): DatabaseConnection | null {
  if (db) return db;
  try {
    db = BetterSqlite(ORCHESTRATION_DB_PATH, { readonly: true, fileMustExist: true });
    // Read-only connections can't change the file's journal_mode — that's
    // owned by NodeSqliteClient which writes the orchestration db. Set
    // busy_timeout so that the rare WAL-checkpoint-induced BUSY doesn't
    // surface as a synchronous throw to getActiveThreadId callers.
    db.pragma("busy_timeout = 5000");
    return db;
  } catch {
    db = null;
    return null;
  }
}

export function getActiveThreadId(project: string | null | undefined): string | null {
  if (!project || typeof project !== "string" || project.trim() === "") return null;
  const conn = openDb();
  if (!conn) return null;
  const workspaceRoot = path.join(PROJECTS_DIR, project);
  const row = conn
    .prepare(
      `SELECT t.thread_id AS threadId
       FROM projection_threads t
       JOIN projection_projects p ON p.project_id = t.project_id
       WHERE p.workspace_root = ?
         AND p.deleted_at IS NULL
         AND t.archived_at IS NULL
         AND t.deleted_at IS NULL
       ORDER BY t.updated_at DESC
       LIMIT 1`,
    )
    .get(workspaceRoot) as { threadId: string } | undefined;
  return row?.threadId ?? null;
}
