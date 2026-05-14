// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Security Tier Policy
 *
 * Defines the tier hierarchy, transition rules, and enforcement.
 * This is the single source of truth for what tier changes are permitted.
 *
 * Tier Hierarchy (ascending security):
 *   standard (0) → web_lock (1) → privacy_lock (2)
 *
 * Transition Rules:
 *   - Upgrades are always permitted
 *   - Downgrades are permitted unless the source tier is immutable
 *   - privacy_lock is immutable (volume encryption cannot be reversed)
 */

import fs from 'fs';

// ── Tier Definition ────────────────────────────────────────

export type TierLevel = 'standard' | 'web_lock' | 'privacy_lock';

interface TierDefinition {
  rank: number;
  immutable: boolean;
  label: string;
}

const TIERS: Record<TierLevel, TierDefinition> = {
  standard:     { rank: 0, immutable: false, label: 'Standard' },
  web_lock:     { rank: 1, immutable: false, label: 'Web Lock' },
  privacy_lock: { rank: 2, immutable: true,  label: 'Privacy Lock' },
};

// ── Tier Resolution ────────────────────────────────────────

const TIER_FILE = '/etc/ellul/security-tier';

/** Map from backend tier names to policy tier levels. */
const BACKEND_TIER_MAP: Record<string, TierLevel> = {
  standard: 'standard',
  web_locked: 'web_lock',
  private_locked: 'privacy_lock',
};

/**
 * Resolve a backend tier name to a policy tier level.
 * Falls back to 'standard' for unknown values (fail-open on read, fail-closed on write).
 */
export function resolveBackendTier(backendTier: string): TierLevel {
  return BACKEND_TIER_MAP[backendTier] ?? 'standard';
}

/**
 * Get the effective tier level.
 *
 * Tier is set explicitly by user action (Standard → Web Lock → Privacy Lock),
 * NOT inferred from volume encryption state. All volumes are now encrypted
 * by default at provisioning — the volume-was-encrypted marker is no longer
 * a reliable signal for tier promotion.
 *
 * Privacy Lock requires explicit user opt-in via the console encryption flow,
 * which sets securityTier = "private_locked" in the DB and on the VPS.
 */
export function getEffectiveTier(backendTier: string): TierLevel {
  return resolveBackendTier(backendTier);
}

/**
 * Check whether the current effective tier is privacy_lock.
 * Reads the tier file directly — the authoritative VPS-side source of truth.
 */
export function isPrivacyLocked(): boolean {
  try {
    return fs.readFileSync(TIER_FILE, 'utf-8').trim() === 'private_locked';
  } catch {
    return false;
  }
}

// ── Transition Validation ──────────────────────────────────

export interface TransitionResult {
  allowed: boolean;
  from: TierLevel;
  to: TierLevel;
  code?: string;
  reason?: string;
}

/**
 * Validate a tier transition against the policy.
 *
 * Rules:
 *   1. Same tier → allowed (no-op)
 *   2. Higher rank → allowed (upgrade)
 *   3. Lower rank from immutable tier → denied
 *   4. Lower rank from mutable tier → allowed (downgrade)
 */
export function validateTransition(
  currentBackendTier: string,
  targetBackendTier: string,
): TransitionResult {
  const from = getEffectiveTier(currentBackendTier);
  const to = resolveBackendTier(targetBackendTier);
  const fromDef = TIERS[from];
  const toDef = TIERS[to];

  // Same tier
  if (from === to) {
    return { allowed: true, from, to };
  }

  // Upgrade
  if (toDef.rank > fromDef.rank) {
    return { allowed: true, from, to };
  }

  // Downgrade from immutable tier
  if (fromDef.immutable) {
    return {
      allowed: false,
      from,
      to,
      code: 'TIER_IMMUTABLE',
      reason: `${fromDef.label} is permanent and cannot be downgraded.`,
    };
  }

  // Downgrade from mutable tier
  return { allowed: true, from, to };
}

