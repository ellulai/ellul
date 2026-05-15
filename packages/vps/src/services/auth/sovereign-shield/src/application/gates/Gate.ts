// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Gate Service
 *
 * Manages Sovereign Gates — user-controlled permission grants
 * for AI agent access to secrets, logs, and databases.
 *
 * Gates:
 *   - logs:       Toggle log redaction (5 min default TTL)
 *   - env:        Execute a single command with secrets injected (30s default TTL)
 *   - db_read:    SELECT/EXPLAIN via query proxy (10 min default TTL)
 *   - db_write:   INSERT/UPDATE/DELETE via query proxy (10 min default TTL)
 *   - db_migrate: CREATE/ALTER/DROP + temp owner role (5 min default TTL)
 *   - git:        Git push/pull authorization (5 min default TTL)
 *   - deploy:     App deployment authorization (5 min default TTL)
 *   - exec:       Sovereign sandbox execution (4 hour default TTL)
 *
 * Persistence:
 *   App-level grants are persisted to disk (atomic write) so they survive
 *   process restarts. On startup, persisted grants are restored with fresh
 *   timers for remaining TTL. Expired grants are discarded.
 *
 *   Thread-level grants are ephemeral (in-memory only) — threads don't
 *   survive restarts, so their grants shouldn't either.
 *
 *   db_migrate grants are NEVER persisted — temporary PostgreSQL roles
 *   don't survive restarts, so restoring the gate without the role would
 *   create a dangling permission.
 *
 * Gate state supports three key formats:
 *   - Thread-level: `${threadId}:${gate}` — per-thread, ephemeral
 *   - App-level: `app:${sandboxId}:${gate}` — per-app, persisted to disk
 *   - Org-level: `org:${orgScope}:${gate}` — per-org scope (org mode), persisted to disk
 *
 * All coexist in the same activeGrants Map. Lookup checks thread-level first,
 * then falls back to app-level, then org-level (org mode only).
 */

import fs from 'fs';
import { execFileSync } from 'child_process';
import { VALID_GATE_TYPES, validateGateType } from './GatePermissions';
import { destroyTempMigrateRole, getActiveTempRole } from '../database/Database';
import { GATE_STATE_FILE, getServiceUser } from '../../config';

// ── Local-First LUKS Enforcement ──
// Gates that require volume encryption to be active before allowing access.
// These are blocked when the volume WAS encrypted but LUKS is not currently mounted.
// Enforcement is LOCAL — does not trust API flags. The VPS knows its own LUKS state.
const LUKS_GATED_TYPES: ReadonlySet<GateType> = new Set([
  'db_write', 'db_migrate', 'wallet_spend', 'deploy',
]);

// Marker file written by file-api after successful luks-init.
// Dual-write: vault-backed (primary, for runtime) + boot volume (fallback, pre-vault).
const VOLUME_WAS_ENCRYPTED_MARKER = '/etc/ellul/volume-was-encrypted';
const VOLUME_WAS_ENCRYPTED_BOOT = '/etc/ellul-bootstrap/volume-was-encrypted';

/**
 * LOCAL-FIRST check: Is volume encryption expected but not active?
 * Returns true if high-risk gates should be blocked.
 *
 * Does NOT trust API state — checks actual LUKS mount state via findmnt.
 * Same sovereignty principle as ptrace_scope and iptables.
 *
 * Self-hosted (localhost) and container deployments have no LUKS volume —
 * the vault is a plain directory, always mounted. Skip the check entirely.
 */
function isVolumeEncryptionRequired(): boolean {
  try {
    const model = fs.readFileSync('/etc/ellul/deployment-model', 'utf8').trim();
    if (model === 'localhost') return false;
  } catch {}

  if (fs.existsSync('/.dockerenv')) return false;

  // Volume was never encrypted — no gate needed
  if (!fs.existsSync(VOLUME_WAS_ENCRYPTED_MARKER) && !fs.existsSync(VOLUME_WAS_ENCRYPTED_BOOT)) return false;

  // Check if LUKS is currently active (dm-crypt mapper device mounted at home)
  const svcUser = getServiceUser();
  try {
    const source = execFileSync('findmnt', ['-n', '-o', 'SOURCE', `/home/${svcUser}`], { timeout: 5_000 }).toString().trim();
    if (source.startsWith('/dev/mapper/luks-')) return false; // LUKS mounted — all clear
  } catch {
    // findmnt failed or no mount — LUKS not active
  }

  return true; // LUKS expected but not mounted — block high-risk gates
}

// ── Types ──

export type GateType = 'logs' | 'env' | 'db_read' | 'db_write' | 'db_migrate' | 'git' | 'deploy' | 'exec' | 'wallet_spend' | 'vault_read';
export type GrantScope = 'once' | 'session' | 'timed';

export interface GateGrant {
  gate: GateType;
  scope: GrantScope;
  expiresAt: number;
  threadId: string;
  sandboxId?: string;
  orgScope?: string;
  autoGranted?: boolean;
  revokeTimer: NodeJS.Timeout;
  /** Gate-specific metadata (e.g., wallet_spend: maxAmountLamports, authorizedRecipients). */
  metadata?: Record<string, unknown>;
}

// ── State ──

const activeGrants = new Map<string, GateGrant>();

// ── Default TTLs ──

const DEFAULT_TTLS: Record<GateType, number> = {
  logs: 5 * 60 * 1000,         // 5 minutes
  env: 30 * 1000,               // 30 seconds — intentionally tight; agent
                                 // should read the secret immediately on
                                 // grant. Longer windows = wider abuse
                                 // surface. `grant_session` (60 min) and
                                 // `grant_always` (persisted app permission)
                                 // are the correct knobs for batched work.
  db_read: 10 * 60 * 1000,      // 10 minutes
  db_write: 10 * 60 * 1000,     // 10 minutes
  db_migrate: 5 * 60 * 1000,    // 5 minutes (shorter — DDL is risky)
  git: 5 * 60 * 1000,           // 5 minutes
  deploy: 5 * 60 * 1000,        // 5 minutes
  exec: 4 * 60 * 60 * 1000,     // 4 hours (dev sessions are long-lived)
  wallet_spend: 5 * 60 * 1000,  // 5 minutes (financial ops — short window)
  vault_read: 4 * 60 * 60 * 1000, // 4 hours (knowledge context needed for work session)
};

/** Gates that must NOT be persisted to disk. */
const NON_PERSISTABLE_GATES: ReadonlySet<GateType> = new Set(['db_migrate', 'wallet_spend']);

// ── Persistence ──

interface SerializedGrant {
  gate: GateType;
  scope: GrantScope;
  expiresAt: number;
  sandboxId: string;
  orgScope?: string;
  autoGranted: boolean;
}

interface GateStateFile {
  version: 1;
  updatedAt: string;
  grants: SerializedGrant[];
}

const STATE_TMP = GATE_STATE_FILE + '.tmp';

/**
 * Persist all app-level grants to disk (atomic write).
 * Called on every grant/revoke of app-level gates.
 */
function persistState(): void {
  const grants: SerializedGrant[] = [];
  const now = Date.now();

  for (const [key, grant] of activeGrants) {
    // Only persist app-level and org-level grants (not thread-level)
    if (!key.startsWith('app:') && !key.startsWith('org:')) continue;
    // Skip expired
    if (now > grant.expiresAt) continue;
    // Skip non-persistable gates (db_migrate)
    if (NON_PERSISTABLE_GATES.has(grant.gate)) continue;
    // App-level needs sandboxId, org-level needs orgScope
    if (!grant.sandboxId && !grant.orgScope) continue;

    grants.push({
      gate: grant.gate,
      scope: grant.scope,
      expiresAt: grant.expiresAt,
      sandboxId: grant.sandboxId || grant.orgScope || '',
      orgScope: grant.orgScope,
      autoGranted: grant.autoGranted ?? false,
    });
  }

  const data: GateStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    grants,
  };

  try {
    const json = JSON.stringify(data, null, 2) + '\n';
    const fd = fs.openSync(STATE_TMP, 'w', 0o600);
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(STATE_TMP, GATE_STATE_FILE);
  } catch (err) {
    console.error('[gates] Failed to persist gate state:', (err as Error).message);
  }
}

/**
 * Restore app-level grants from disk on startup.
 * Discards expired grants and recreates timers for live ones.
 */
export function restoreGateState(): void {
  let data: GateStateFile;
  try {
    const raw = fs.readFileSync(GATE_STATE_FILE, 'utf8');
    data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.grants)) {
      console.log('[gates] Gate state file has unknown format, starting fresh');
      return;
    }
  } catch {
    // No state file or unreadable — start fresh (fail-secure)
    return;
  }

  const now = Date.now();
  let restored = 0;
  let expired = 0;

  const VALID_SCOPES = new Set(['once', 'session', 'timed']);
  const MAX_GRANT_TTL_MS = 25 * 60 * 60 * 1000; // 25 hours — generous cap

  for (const entry of data.grants) {
    // Validate gate type
    if (!VALID_GATE_TYPES.has(entry.gate as GateType)) continue;
    // Skip non-persistable gates that somehow got saved
    if (NON_PERSISTABLE_GATES.has(entry.gate)) continue;
    // Validate scope enum
    if (!VALID_SCOPES.has(entry.scope)) continue;
    // Validate expiresAt is a finite number within bounds
    if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) continue;
    if (entry.expiresAt > now + MAX_GRANT_TTL_MS) continue; // reject absurdly far-future grants
    // Validate sandboxId is a non-empty string without path separators
    if (typeof entry.sandboxId !== 'string' || !entry.sandboxId || /[/\\]/.test(entry.sandboxId)) continue;
    // Skip expired
    const remaining = entry.expiresAt - now;
    if (remaining <= 0) {
      expired++;
      continue;
    }

    // Recreate the grant with a fresh timer
    const isOrg = !!entry.orgScope;
    const key = isOrg
      ? orgGateKey(entry.gate, entry.orgScope!)
      : appGateKey(entry.gate, entry.sandboxId);
    const label = isOrg ? `org scope ${entry.orgScope}` : entry.sandboxId;

    const revokeTimer = setTimeout(() => {
      activeGrants.delete(key);
      console.log(`[gates] Auto-revoked ${isOrg ? 'org' : 'app'}-level ${entry.gate} gate for ${label}`);
      persistState();
    }, remaining);

    activeGrants.set(key, {
      gate: entry.gate,
      scope: entry.scope,
      expiresAt: entry.expiresAt,
      threadId: isOrg ? `org:${entry.orgScope}` : `app:${entry.sandboxId}`,
      sandboxId: isOrg ? undefined : entry.sandboxId,
      orgScope: entry.orgScope,
      autoGranted: entry.autoGranted,
      revokeTimer,
    });

    restored++;
  }

  if (restored > 0 || expired > 0) {
    console.log(`[gates] Restored ${restored} gate grants from disk (${expired} expired, discarded)`);
  }

  // Clean up the state file to remove expired entries
  if (expired > 0) {
    persistState();
  }
}

// ── Key helpers ──

function gateKey(gate: GateType, threadId: string): string {
  return `${threadId}:${gate}`;
}

function appGateKey(gate: GateType, sandboxId: string): string {
  return `app:${sandboxId}:${gate}`;
}

function orgGateKey(gate: GateType, orgScope: string): string {
  return `org:${orgScope}:${gate}`;
}

// ── Public API ──

/**
 * Grant access through a gate for a specific thread.
 * Thread-level grants are ephemeral (not persisted).
 */
export function grantGate(
  gate: GateType,
  threadId: string,
  ttlMs?: number,
  opts?: { sandboxId?: string; scope?: GrantScope; metadata?: Record<string, unknown> },
): { expiresAt: number } {
  validateGateType(gate);
  const key = gateKey(gate, threadId);
  const ttl = ttlMs || DEFAULT_TTLS[gate];
  const expiresAt = Date.now() + ttl;

  // Revoke existing grant if any
  const existing = activeGrants.get(key);
  if (existing) {
    clearTimeout(existing.revokeTimer);
  }

  const revokeTimer = setTimeout(() => {
    activeGrants.delete(key);
    console.log(`[gates] Auto-revoked ${gate} gate for thread ${threadId.slice(0, 8)}`);

    // db_migrate gate: destroy temporary migrate role
    if (gate === 'db_migrate' && opts?.sandboxId) {
      try {
        const tempRole = getActiveTempRole(opts.sandboxId);
        if (tempRole) destroyTempMigrateRole(tempRole.roleName);
      } catch (err) {
        console.error(`[gates] SECURITY: Failed to destroy temp migrate role for ${opts.sandboxId}:`, (err as Error).message);
      }
    }
  }, ttl);

  activeGrants.set(key, {
    gate,
    scope: opts?.scope || 'timed',
    expiresAt,
    threadId,
    sandboxId: opts?.sandboxId,
    revokeTimer,
    metadata: opts?.metadata,
  });

  console.log(`[gates] Granted ${gate} gate for thread ${threadId.slice(0, 8)} (TTL: ${ttl / 1000}s)`);
  return { expiresAt };
}

/**
 * Revoke a specific gate for a thread.
 */
export function revokeGate(gate: GateType, threadId: string): void {
  validateGateType(gate);
  const key = gateKey(gate, threadId);
  const grant = activeGrants.get(key);
  if (!grant) return;

  clearTimeout(grant.revokeTimer);
  activeGrants.delete(key);

  // db_migrate gate: destroy temporary migrate role
  if (gate === 'db_migrate' && grant.sandboxId) {
    try {
      const tempRole = getActiveTempRole(grant.sandboxId);
      if (tempRole) destroyTempMigrateRole(tempRole.roleName);
    } catch (err) {
      console.error(`[gates] SECURITY: Failed to destroy temp migrate role for ${grant.sandboxId}:`, (err as Error).message);
    }
  }

  console.log(`[gates] Revoked ${gate} gate for thread ${threadId.slice(0, 8)}`);
}

/**
 * Check if a gate is currently open for a thread.
 * Checks thread-level → app-level → org-level (org mode).
 */
export function isGateOpen(gate: GateType, threadId: string, sandboxId?: string, orgScope?: string): boolean {
  validateGateType(gate);

  // LOCAL-FIRST: Block high-risk gates when volume encryption is expected but not active.
  // This check does NOT trust API flags — it inspects actual LUKS mount state.
  if (LUKS_GATED_TYPES.has(gate) && isVolumeEncryptionRequired()) {
    return false;
  }

  // Thread-level check
  const key = gateKey(gate, threadId);
  const grant = activeGrants.get(key);
  if (grant) {
    if (Date.now() > grant.expiresAt) {
      clearTimeout(grant.revokeTimer);
      activeGrants.delete(key);
    } else {
      return true;
    }
  }

  // App-level fallback
  if (sandboxId && isGateOpenForApp(gate, sandboxId)) {
    return true;
  }

  // Org-level fallback (org mode)
  if (orgScope && isGateOpenForOrg(gate, orgScope)) {
    return true;
  }

  return false;
}

/**
 * Revoke ALL gates for a thread (cleanup on thread end).
 */
export function revokeAllForThread(threadId: string): void {
  for (const [key, grant] of activeGrants) {
    if (grant.threadId === threadId) {
      clearTimeout(grant.revokeTimer);
      activeGrants.delete(key);

      // db_migrate gate: destroy temporary migrate role
      if (grant.gate === 'db_migrate' && grant.sandboxId) {
        try {
          const tempRole = getActiveTempRole(grant.sandboxId);
          if (tempRole) destroyTempMigrateRole(tempRole.roleName);
        } catch (err) {
          console.error(`[gates] SECURITY: Failed to destroy temp migrate role for ${grant.sandboxId}:`, (err as Error).message);
        }
      }
    }
  }
}

/**
 * Get the grant metadata for a specific gate+thread.
 * Used by exec-with-secrets to determine which app's secrets to inject.
 * Checks thread-level first, then falls back to app-level.
 */
export function getGateGrant(gate: GateType, threadId: string, sandboxId?: string): GateGrant | undefined {
  // Thread-level check
  const key = gateKey(gate, threadId);
  const grant = activeGrants.get(key);
  if (grant) {
    if (Date.now() > grant.expiresAt) {
      clearTimeout(grant.revokeTimer);
      activeGrants.delete(key);
    } else {
      return grant;
    }
  }

  // App-level fallback
  if (sandboxId) {
    return getGateGrantForApp(gate, sandboxId);
  }

  return undefined;
}

/**
 * Get gate status for a thread (for API response).
 */
export function getGateStatus(threadId: string): Record<GateType, boolean> {
  const result: Record<string, boolean> = {};
  for (const gate of VALID_GATE_TYPES) {
    result[gate] = isGateOpen(gate, threadId);
  }
  return result as Record<GateType, boolean>;
}

/**
 * Get remaining TTL for a gate (for UI display).
 */
export function getGateRemainingMs(gate: GateType, threadId: string): number {
  const key = gateKey(gate, threadId);
  const grant = activeGrants.get(key);
  if (!grant) return 0;
  const remaining = grant.expiresAt - Date.now();
  return remaining > 0 ? remaining : 0;
}

// ── App-Level Grants ──
// These use a different key format: `app:${sandboxId}:${gate}`
// Used by the auto-grant system when per-app permissions are set.
// App-level grants are persisted to disk for restart resilience.

/**
 * Grant a gate at the app level (works across all threads).
 * Persisted to disk unless the gate is in NON_PERSISTABLE_GATES.
 */
export function grantGateForApp(
  gate: GateType,
  sandboxId: string,
  ttlMs?: number,
  opts?: { autoGranted?: boolean; metadata?: Record<string, unknown> },
): { expiresAt: number } {
  const key = appGateKey(gate, sandboxId);
  const ttl = ttlMs || DEFAULT_TTLS[gate];
  const expiresAt = Date.now() + ttl;

  const existing = activeGrants.get(key);
  if (existing) {
    clearTimeout(existing.revokeTimer);
  }

  const revokeTimer = setTimeout(() => {
    activeGrants.delete(key);
    console.log(`[gates] Auto-revoked app-level ${gate} gate for ${sandboxId}`);

    // db_migrate gate: destroy temporary migrate role
    if (gate === 'db_migrate') {
      try {
        const tempRole = getActiveTempRole(sandboxId);
        if (tempRole) destroyTempMigrateRole(tempRole.roleName);
      } catch (err) {
        console.error(`[gates] SECURITY: Failed to destroy temp migrate role for ${sandboxId}:`, (err as Error).message);
      }
    }

    persistState();
  }, ttl);

  activeGrants.set(key, {
    gate,
    scope: 'timed',
    expiresAt,
    threadId: `app:${sandboxId}`,
    sandboxId,
    autoGranted: opts?.autoGranted ?? false,
    revokeTimer,
    metadata: opts?.metadata,
  });

  console.log(`[gates] Granted app-level ${gate} gate for ${sandboxId} (TTL: ${ttl / 1000}s${opts?.autoGranted ? ', auto' : ''})`);
  persistState();
  return { expiresAt };
}

/**
 * Check if a gate is open at the app level.
 */
export function isGateOpenForApp(gate: GateType, sandboxId: string): boolean {
  const key = appGateKey(gate, sandboxId);
  const grant = activeGrants.get(key);
  if (!grant) return false;
  if (Date.now() > grant.expiresAt) {
    clearTimeout(grant.revokeTimer);
    activeGrants.delete(key);
    persistState();
    return false;
  }
  return true;
}

/**
 * Get grant metadata for an app-level gate.
 */
export function getGateGrantForApp(gate: GateType, sandboxId: string): GateGrant | undefined {
  const key = appGateKey(gate, sandboxId);
  const grant = activeGrants.get(key);
  if (!grant) return undefined;
  if (Date.now() > grant.expiresAt) {
    clearTimeout(grant.revokeTimer);
    activeGrants.delete(key);
    persistState();
    return undefined;
  }
  return grant;
}

/**
 * Revoke an app-level gate.
 */
export function revokeGateForApp(gate: GateType, sandboxId: string): void {
  const key = appGateKey(gate, sandboxId);
  const grant = activeGrants.get(key);
  if (!grant) return;

  clearTimeout(grant.revokeTimer);
  activeGrants.delete(key);

  // db_migrate gate: destroy temporary migrate role
  if (gate === 'db_migrate') {
    try {
      const tempRole = getActiveTempRole(sandboxId);
      if (tempRole) destroyTempMigrateRole(tempRole.roleName);
    } catch (err) {
      console.error(`[gates] SECURITY: Failed to destroy temp migrate role for ${sandboxId}:`, (err as Error).message);
    }
  }

  console.log(`[gates] Revoked app-level ${gate} gate for ${sandboxId}`);
  persistState();
}

// ── Org-Level Grants (Org Mode) ──
// These use key format: `org:${orgScope}:${gate}`
// Used when org mode is active and gates are scoped per-org (e.g., per namespace/team).
// The orgScope string is the scope identifier (typically a team slug from the org config).
// Persisted to disk alongside app-level grants.

/**
 * Grant a gate at the team level (works for all threads in that team's namespace).
 * Persisted to disk unless the gate is in NON_PERSISTABLE_GATES.
 */
export function grantGateForOrg(
  gate: GateType,
  orgScope: string,
  ttlMs?: number,
  opts?: { autoGranted?: boolean; metadata?: Record<string, unknown> },
): { expiresAt: number } {
  const key = orgGateKey(gate, orgScope);
  const ttl = ttlMs || DEFAULT_TTLS[gate];
  const expiresAt = Date.now() + ttl;

  const existing = activeGrants.get(key);
  if (existing) {
    clearTimeout(existing.revokeTimer);
  }

  const revokeTimer = setTimeout(() => {
    activeGrants.delete(key);
    console.log(`[gates] Auto-revoked org-level ${gate} gate for org scope ${orgScope}`);
    persistState();
  }, ttl);

  activeGrants.set(key, {
    gate,
    scope: 'timed',
    expiresAt,
    threadId: `org:${orgScope}`,
    orgScope,
    autoGranted: opts?.autoGranted ?? false,
    revokeTimer,
    metadata: opts?.metadata,
  });

  console.log(`[gates] Granted org-level ${gate} gate for org scope ${orgScope} (TTL: ${ttl / 1000}s${opts?.autoGranted ? ', auto' : ''})`);
  persistState();
  return { expiresAt };
}

/**
 * Check if a gate is open at the team level.
 */
export function isGateOpenForOrg(gate: GateType, orgScope: string): boolean {
  const key = orgGateKey(gate, orgScope);
  const grant = activeGrants.get(key);
  if (!grant) return false;
  if (Date.now() > grant.expiresAt) {
    clearTimeout(grant.revokeTimer);
    activeGrants.delete(key);
    persistState();
    return false;
  }
  return true;
}

/**
 * Revoke a org-level gate.
 */
export function revokeGateForOrg(gate: GateType, orgScope: string): void {
  const key = orgGateKey(gate, orgScope);
  const grant = activeGrants.get(key);
  if (!grant) return;

  clearTimeout(grant.revokeTimer);
  activeGrants.delete(key);

  console.log(`[gates] Revoked org-level ${gate} gate for org scope ${orgScope}`);
  persistState();
}
