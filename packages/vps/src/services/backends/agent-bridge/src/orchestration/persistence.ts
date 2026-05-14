// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type Database from "better-sqlite3";

let db: Database | null = null;

export function setOrchestrationDb(database: Database): void {
  db = database;
}

function requireDb(): Database {
  if (!db) throw new Error("orchestration persistence not initialized");
  return db;
}

// ──────────────── Thread activities ────────────────

export interface ThreadActivityRow {
  readonly id: string;
  readonly threadId: string;
  readonly tone: "info" | "tool" | "approval" | "error";
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly turnId: string | null;
  readonly sequence: number | null;
  readonly createdAt: number;
}

export function appendThreadActivity(row: ThreadActivityRow): void {
  requireDb()
    .prepare(
      `INSERT OR REPLACE INTO thread_activities
        (id, thread_id, tone, kind, summary, payload, turn_id, sequence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.threadId,
      row.tone,
      row.kind,
      row.summary,
      row.payload === undefined ? null : JSON.stringify(row.payload),
      row.turnId,
      row.sequence,
      row.createdAt,
    );
}

export function listThreadActivities(
  threadId: string,
  limit = 200,
): ReadonlyArray<ThreadActivityRow> {
  const rows = requireDb()
    .prepare(
      `SELECT id, thread_id, tone, kind, summary, payload, turn_id, sequence, created_at
       FROM thread_activities WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(threadId, limit) as Array<{
      id: string;
      thread_id: string;
      tone: string;
      kind: string;
      summary: string;
      payload: string | null;
      turn_id: string | null;
      sequence: number | null;
      created_at: number;
    }>;
  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    tone: r.tone as ThreadActivityRow["tone"],
    kind: r.kind,
    summary: r.summary,
    payload: r.payload ? JSON.parse(r.payload) : null,
    turnId: r.turn_id,
    sequence: r.sequence,
    createdAt: r.created_at,
  }));
}

// ──────────────── Proposed plans ────────────────

export interface ProposedPlanRow {
  readonly id: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly planMarkdown: string;
  readonly implementedAt: number | null;
  readonly implementationThreadId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function upsertProposedPlan(row: ProposedPlanRow): void {
  requireDb()
    .prepare(
      `INSERT INTO proposed_plans
        (id, thread_id, turn_id, plan_markdown, implemented_at, implementation_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         plan_markdown = excluded.plan_markdown,
         implemented_at = excluded.implemented_at,
         implementation_thread_id = excluded.implementation_thread_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      row.id,
      row.threadId,
      row.turnId,
      row.planMarkdown,
      row.implementedAt,
      row.implementationThreadId,
      row.createdAt,
      row.updatedAt,
    );
}

export function listProposedPlans(threadId: string): ReadonlyArray<ProposedPlanRow> {
  const rows = requireDb()
    .prepare(
      `SELECT id, thread_id, turn_id, plan_markdown, implemented_at,
              implementation_thread_id, created_at, updated_at
       FROM proposed_plans WHERE thread_id = ? ORDER BY created_at ASC`,
    )
    .all(threadId) as Array<{
      id: string;
      thread_id: string;
      turn_id: string | null;
      plan_markdown: string;
      implemented_at: number | null;
      implementation_thread_id: string | null;
      created_at: number;
      updated_at: number;
    }>;
  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    turnId: r.turn_id,
    planMarkdown: r.plan_markdown,
    implementedAt: r.implemented_at,
    implementationThreadId: r.implementation_thread_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function markProposedPlanImplemented(
  planId: string,
  implementationThreadId: string,
  atMs: number = Date.now(),
): void {
  requireDb()
    .prepare(
      `UPDATE proposed_plans SET implemented_at = ?, implementation_thread_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(atMs, implementationThreadId, atMs, planId);
}

// ──────────────── Composer drafts ────────────────

export interface ComposerDraft {
  readonly threadId: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
  readonly updatedAt: number;
}

export function setComposerDraft(draft: Omit<ComposerDraft, "updatedAt">): void {
  requireDb()
    .prepare(
      `INSERT INTO composer_drafts (thread_id, text, attachments_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         text = excluded.text,
         attachments_json = excluded.attachments_json,
         updated_at = excluded.updated_at`,
    )
    .run(draft.threadId, draft.text, JSON.stringify(draft.attachments), Date.now());
}

export function getComposerDraft(threadId: string): ComposerDraft | null {
  const row = requireDb()
    .prepare(
      `SELECT thread_id, text, attachments_json, updated_at FROM composer_drafts WHERE thread_id = ?`,
    )
    .get(threadId) as
    | { thread_id: string; text: string; attachments_json: string | null; updated_at: number }
    | undefined;
  if (!row) return null;
  return {
    threadId: row.thread_id,
    text: row.text,
    attachments: row.attachments_json ? JSON.parse(row.attachments_json) : [],
    updatedAt: row.updated_at,
  };
}

export function clearComposerDraft(threadId: string): void {
  requireDb().prepare(`DELETE FROM composer_drafts WHERE thread_id = ?`).run(threadId);
}

// ──────────────── User UI state ────────────────

export function setUserUiState(scopeKey: string, value: unknown): void {
  requireDb()
    .prepare(
      `INSERT INTO user_ui_state (scope_key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(scopeKey, JSON.stringify(value), Date.now());
}

export function getUserUiState<T = unknown>(scopeKey: string): T | null {
  const row = requireDb()
    .prepare(`SELECT value_json FROM user_ui_state WHERE scope_key = ?`)
    .get(scopeKey) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

// ──────────────── Model recent selections ────────────────

export function recordModelSelection(provider: string, modelId: string): void {
  const now = Date.now();
  requireDb()
    .prepare(
      `INSERT INTO model_recent_selections (provider, model_id, last_used_at, use_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(provider, model_id) DO UPDATE SET
         last_used_at = excluded.last_used_at,
         use_count = use_count + 1`,
    )
    .run(provider, modelId, now);
}

export interface ModelRecentSelection {
  readonly provider: string;
  readonly modelId: string;
  readonly lastUsedAt: number;
  readonly useCount: number;
}

export function listRecentModels(
  provider: string,
  limit = 5,
): ReadonlyArray<ModelRecentSelection> {
  const rows = requireDb()
    .prepare(
      `SELECT provider, model_id, last_used_at, use_count FROM model_recent_selections
       WHERE provider = ? ORDER BY last_used_at DESC LIMIT ?`,
    )
    .all(provider, limit) as Array<{
      provider: string;
      model_id: string;
      last_used_at: number;
      use_count: number;
    }>;
  return rows.map((r) => ({
    provider: r.provider,
    modelId: r.model_id,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
  }));
}
