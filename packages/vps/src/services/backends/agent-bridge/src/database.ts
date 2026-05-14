// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Bridge-local state DB. Orchestration (threads, messages, turns, activities,
// proposed plans, checkpoints) lives in ORCHESTRATION_DB_PATH; this file
// owns the remaining bridge-local state: composer drafts, UI scope state,
// model recents, project context-mode, bridge settings.

import BetterSqlite from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { CHAT_DB_PATH } from "./config";

const dbDir = path.dirname(CHAT_DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = BetterSqlite(CHAT_DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_settings (
    project TEXT PRIMARY KEY,
    context_mode TEXT NOT NULL DEFAULT 'base',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS composer_drafts (
    thread_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    attachments_json TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_ui_state (
    scope_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS model_recent_selections (
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    last_used_at INTEGER NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, model_id)
  );
  CREATE INDEX IF NOT EXISTS idx_model_recent_last_used ON model_recent_selections(provider, last_used_at DESC);

  CREATE TABLE IF NOT EXISTS thread_archive (
    thread_id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL,
    archived_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_thread_archive_sandbox_active ON thread_archive(sandbox_id, archived_at, updated_at DESC);
`);

const THREAD_STATE_DIR = `${require("os").homedir()}/.ellul/threads`;
if (!fs.existsSync(THREAD_STATE_DIR)) {
  fs.mkdirSync(THREAD_STATE_DIR, { recursive: true });
}
