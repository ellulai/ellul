// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Guardrail Strike Counter — 3-Strike Token Burn Protection
 *
 * Maintains a stateful counter per project:command pair tracking consecutive
 * guardrail failures. Mathematically caps token burn by forcing the agent to
 * stop after 3 failed attempts and loop the human back into the decision.
 *
 * Strike lifecycle:
 *   - recordStrike(): called when guardrail scan blocks execution
 *   - clearStrikes(): called when scan passes (agent fixed the code)
 *   - isHardStopped(): returns true after 3+ consecutive failures
 *   - TTL: 30 min — stale strikes auto-expire to prevent permanent lockout
 */

export const MAX_STRIKES = 3;
const STRIKE_TTL_MS = 30 * 60 * 1000; // 30 min

interface StrikeState {
  count: number;
  lastFailedAt: number;
}

// In-memory map: "project:cmd" → strike state.
// Resets on: successful scan (agent fixed the code), or TTL expiry.
const strikes = new Map<string, StrikeState>();

/**
 * Record a guardrail failure. Returns the current strike count (1-indexed).
 */
export function recordStrike(project: string, cmd: string): number {
  const key = `${project}:${cmd}`;
  const now = Date.now();

  // Expired? Reset.
  const existing = strikes.get(key);
  if (existing && now - existing.lastFailedAt > STRIKE_TTL_MS) {
    strikes.delete(key);
  }

  const state = strikes.get(key) || { count: 0, lastFailedAt: 0 };
  state.count++;
  state.lastFailedAt = now;
  strikes.set(key, state);
  return state.count;
}

/**
 * Clear all strikes for a project:command pair.
 * Called when the agent successfully fixes the code and the scan passes.
 */
export function clearStrikes(project: string, cmd: string): void {
  strikes.delete(`${project}:${cmd}`);
}

/**
 * Check if the agent has been hard-stopped (3+ consecutive failures).
 */
export function isHardStopped(project: string, cmd: string): boolean {
  const key = `${project}:${cmd}`;
  const state = strikes.get(key);
  if (!state) return false;
  if (Date.now() - state.lastFailedAt > STRIKE_TTL_MS) {
    strikes.delete(key);
    return false;
  }
  return state.count >= MAX_STRIKES;
}
