// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Secret Exposure Tracking Service
 *
 * Records which secrets the agent has seen through env gate operations.
 * Uses HMAC-SHA256 keyed with the auth signing secret so hashes are
 * unpredictable without the key (prevents rainbow table attacks).
 *
 * Exposure is informational — it tells the user which secrets the agent
 * has seen and recommends rotation. It cannot un-see the data.
 *
 * Scope: everything here is sandbox-scoped via the branded `SandboxId`.
 * Note on schema: the underlying tables still use column name `sandbox_id`
 * (historical) — the value stored is the sandbox slug. This is an SQL
 * cosmetic to be renamed alongside the env_exposures schema migration
 * (see database.ts for the current column names).
 */

import crypto from 'crypto';
import type { SandboxId } from '@ellul.ai/types';
import { db } from '../../database';
import { getCurrentAuthSecret } from '../../auth/secrets';
import { readSecrets } from '../vault/Secrets';

// Prepared statements (lazy init)
let upsertExposureStmt: ReturnType<typeof db.prepare> | null = null;
let getExposuresStmt: ReturnType<typeof db.prepare> | null = null;
let getClassificationStmt: ReturnType<typeof db.prepare> | null = null;
let upsertClassificationStmt: ReturnType<typeof db.prepare> | null = null;
let acknowledgeStmt: ReturnType<typeof db.prepare> | null = null;

function initStatements() {
  if (upsertExposureStmt) return;
  upsertExposureStmt = db.prepare(`
    INSERT INTO env_exposures (sandbox_id, key_name, value_hash, exposed_at, thread_id, acknowledged_at)
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(sandbox_id, key_name) DO UPDATE SET
      value_hash = excluded.value_hash,
      exposed_at = excluded.exposed_at,
      thread_id = excluded.thread_id,
      acknowledged_at = NULL
  `);
  getExposuresStmt = db.prepare(`
    SELECT sandbox_id, key_name, value_hash, exposed_at, thread_id, acknowledged_at
    FROM env_exposures WHERE sandbox_id = ?
  `);
  getClassificationStmt = db.prepare(`
    SELECT kind FROM env_classifications WHERE sandbox_id = ? AND key_name = ?
  `);
  upsertClassificationStmt = db.prepare(`
    INSERT INTO env_classifications (sandbox_id, key_name, kind)
    VALUES (?, ?, ?)
    ON CONFLICT(sandbox_id, key_name) DO UPDATE SET kind = excluded.kind
  `);
  acknowledgeStmt = db.prepare(`
    UPDATE env_exposures SET acknowledged_at = ? WHERE sandbox_id = ? AND key_name = ?
  `);
}

/**
 * Compute HMAC-SHA256 of a secret value using the current auth signing key.
 */
function hmacValue(value: string): string {
  const { secret } = getCurrentAuthSecret();
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * Record that secrets were exposed to the agent during an env gate operation.
 * Called at injection time (before the child process executes).
 */
export function recordExposure(
  sandboxId: SandboxId,
  secrets: Map<string, string>,
  threadId: string,
): void {
  initStatements();
  const now = Date.now();

  const upsertMany = db.transaction(() => {
    for (const [key, value] of secrets) {
      const hash = hmacValue(value);
      upsertExposureStmt!.run(sandboxId, key, hash, now, threadId);
    }
  });

  upsertMany();
}

/**
 * Get exposure status for all secrets of a sandbox.
 * Compares stored HMAC against current value to determine if rotation is needed.
 * Never returns the hash itself — only whether it matches current.
 */
export function getExposures(sandboxId: SandboxId): Array<{
  key_name: string;
  exposed_at: number;
  thread_id: string;
  hash_matches_current: boolean;
  kind: 'secret' | 'plain';
  acknowledged_at: number | null;
}> {
  initStatements();

  const exposures = getExposuresStmt!.all(sandboxId) as Array<{
    sandbox_id: string;
    key_name: string;
    value_hash: string;
    exposed_at: number;
    thread_id: string;
    acknowledged_at: number | null;
  }>;

  // Read current secret values to compare hashes. Only production scope is
  // checked — the development env file is a distinct rotation target.
  const currentSecrets = readSecrets(sandboxId, 'production');

  return exposures.map((exp) => {
    const currentValue = currentSecrets.get(exp.key_name);
    let hashMatchesCurrent = false;
    if (currentValue !== undefined) {
      const currentHash = hmacValue(currentValue);
      try {
        hashMatchesCurrent = currentHash.length === exp.value_hash.length &&
          crypto.timingSafeEqual(Buffer.from(currentHash, 'hex'), Buffer.from(exp.value_hash, 'hex'));
      } catch {
        hashMatchesCurrent = false;
      }
    }

    const classification = getClassificationStmt!.get(sandboxId, exp.key_name) as { kind: string } | undefined;
    const kind = (classification?.kind === 'plain' ? 'plain' : 'secret') as 'secret' | 'plain';

    return {
      key_name: exp.key_name,
      exposed_at: exp.exposed_at,
      thread_id: exp.thread_id,
      hash_matches_current: hashMatchesCurrent,
      kind,
      acknowledged_at: exp.acknowledged_at,
    };
  });
}

/**
 * Get classifications for all secrets of a sandbox.
 * Returns a map of key_name → kind ('secret' | 'plain').
 * Keys not explicitly classified default to 'secret'.
 */
export function getClassifications(sandboxId: SandboxId): Record<string, 'secret' | 'plain'> {
  initStatements();
  const rows = db.prepare(
    'SELECT key_name, kind FROM env_classifications WHERE sandbox_id = ?'
  ).all(sandboxId) as Array<{ key_name: string; kind: string }>;

  const result: Record<string, 'secret' | 'plain'> = {};
  for (const row of rows) {
    result[row.key_name] = row.kind === 'plain' ? 'plain' : 'secret';
  }
  return result;
}

/**
 * Classify an env var as 'secret' or 'plain'.
 * 'plain' vars don't show rotation indicators.
 */
export function classifySecret(sandboxId: SandboxId, keyName: string, kind: 'secret' | 'plain'): void {
  initStatements();
  upsertClassificationStmt!.run(sandboxId, keyName, kind);
}

/**
 * Acknowledge an exposure warning without rotating.
 * Suppresses the indicator until the value changes again.
 */
export function acknowledgeExposure(sandboxId: SandboxId, keyName: string): boolean {
  initStatements();
  const result = acknowledgeStmt!.run(Date.now(), sandboxId, keyName);
  return result.changes > 0;
}

/**
 * Get a summary of unacknowledged, unrotated exposures for a sandbox.
 * Returns count and key names that need attention.
 *
 * "Needs attention" = secret-classified, hash still matches current value
 * (not rotated), and not acknowledged by the user.
 *
 * Used by agent-bridge to push exposure alerts after env gate operations.
 */
export function getExposureAlertSummary(sandboxId: SandboxId): {
  count: number;
  keys: string[];
} {
  const exposures = getExposures(sandboxId);
  const alertKeys = exposures
    .filter((e) =>
      e.kind === 'secret' &&
      e.hash_matches_current &&
      e.acknowledged_at === null
    )
    .map((e) => e.key_name);

  return { count: alertKeys.length, keys: alertKeys };
}
