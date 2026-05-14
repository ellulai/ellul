// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Session Policy Service
 *
 * Per-billing-tier session configuration. Allows the owner to tune
 * session windows, idle timeouts, and concurrency limits without
 * code changes. Defaults seeded in database.ts.
 *
 * Two independent clocks per session:
 *   - expires_at (absolute cap): created_at + session_ttl_ms — never extended
 *   - idle timeout: last_activity + idle_timeout_ms — resets on real user requests
 */

import type Database from 'better-sqlite3';
import { SESSION_TTL_MS, ABSOLUTE_MAX_MS } from '../../config';
import { BILLING_TIER, type BillingTier } from '../../middleware/product-gate.middleware';

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

let db: Database;

export function setDatabase(database: Database): void {
  db = database;
}

export interface SessionPolicy {
  billing_tier: BillingTier;
  session_ttl_ms: number;
  absolute_max_ms: number;
  idle_timeout_ms: number;
  max_concurrent_sessions: number;
  updated_at: number;
}

interface PolicyRow {
  session_ttl_ms: number;
  absolute_max_ms: number;
  idle_timeout_ms: number;
  max_concurrent_sessions: number;
}

export interface FullPolicy {
  sessionTtlMs: number;
  absoluteMaxMs: number;
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
}

/**
 * Get full session policy for the current billing tier.
 */
export function getSessionPolicy(): FullPolicy {
  return getSessionPolicyForTier(BILLING_TIER);
}

/**
 * Get session TTLs for the current billing tier (convenience alias).
 */
export function getSessionTTL(): { sessionTtlMs: number; absoluteMaxMs: number } {
  const policy = getSessionPolicy();
  return { sessionTtlMs: policy.sessionTtlMs, absoluteMaxMs: policy.absoluteMaxMs };
}

/**
 * Get session policy for a specific billing tier.
 */
export function getSessionPolicyForTier(tier: BillingTier): FullPolicy {
  const row = db.prepare(
    'SELECT session_ttl_ms, absolute_max_ms, idle_timeout_ms, max_concurrent_sessions FROM session_policy WHERE billing_tier = ?'
  ).get(tier) as PolicyRow | undefined;

  if (!row) {
    return {
      sessionTtlMs: SESSION_TTL_MS,
      absoluteMaxMs: ABSOLUTE_MAX_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      maxConcurrentSessions: 1,
    };
  }

  return {
    sessionTtlMs: row.session_ttl_ms,
    absoluteMaxMs: row.absolute_max_ms,
    idleTimeoutMs: row.idle_timeout_ms,
    maxConcurrentSessions: row.max_concurrent_sessions,
  };
}

/**
 * Update session policy for a billing tier.
 */
export function updateSessionPolicy(
  tier: BillingTier,
  sessionTtlMs: number,
  absoluteMaxMs: number,
  opts?: { maxConcurrentSessions?: number; idleTimeoutMs?: number }
): SessionPolicy {
  const now = Date.now();
  const current = getSessionPolicyForTier(tier);
  const concurrent = opts?.maxConcurrentSessions ?? current.maxConcurrentSessions;
  const idle = opts?.idleTimeoutMs ?? current.idleTimeoutMs;

  db.prepare(
    `INSERT INTO session_policy (billing_tier, session_ttl_ms, absolute_max_ms, idle_timeout_ms, max_concurrent_sessions, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(billing_tier) DO UPDATE SET
       session_ttl_ms = excluded.session_ttl_ms,
       absolute_max_ms = excluded.absolute_max_ms,
       idle_timeout_ms = excluded.idle_timeout_ms,
       max_concurrent_sessions = excluded.max_concurrent_sessions,
       updated_at = excluded.updated_at`
  ).run(tier, sessionTtlMs, absoluteMaxMs, idle, concurrent, now);

  return {
    billing_tier: tier,
    session_ttl_ms: sessionTtlMs,
    absolute_max_ms: absoluteMaxMs,
    idle_timeout_ms: idle,
    max_concurrent_sessions: concurrent,
    updated_at: now,
  };
}

/**
 * Get all session policies.
 */
export function getAllSessionPolicies(): SessionPolicy[] {
  return db.prepare('SELECT * FROM session_policy ORDER BY billing_tier').all() as SessionPolicy[];
}

/**
 * Enforce a new TTL policy on all existing sessions.
 * - Sessions that already exceed the new policy: KILLED (force re-auth)
 * - Sessions still within the new policy: clamped to the new max
 *
 * Returns { killed, clamped } counts and the IDs of killed sessions
 * (so the caller can push revocation events).
 */
export function enforceNewPolicy(sessionTtlMs: number, absoluteMaxMs: number): {
  killed: number;
  clamped: number;
  killedSessionIds: string[];
} {
  const now = Date.now();

  // 1. Find and kill sessions that already exceed the new policy
  const expiredRows = db.prepare(`
    SELECT id FROM sessions
    WHERE created_at + ? < ? OR created_at + ? < ?
  `).all(sessionTtlMs, now, absoluteMaxMs, now) as { id: string }[];

  const killedSessionIds = expiredRows.map(r => r.id);
  let killed = 0;

  if (killedSessionIds.length > 0) {
    const placeholders = killedSessionIds.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...killedSessionIds);
    killed = result.changes;
  }

  // 2. Clamp remaining sessions to the new policy
  const clamped = db.prepare(`
    UPDATE sessions SET
      expires_at = MIN(expires_at, created_at + ?),
      absolute_expiry = MIN(absolute_expiry, created_at + ?)
    WHERE expires_at > created_at + ? OR absolute_expiry > created_at + ?
  `).run(sessionTtlMs, absoluteMaxMs, sessionTtlMs, absoluteMaxMs);

  return { killed, clamped: clamped.changes, killedSessionIds };
}
