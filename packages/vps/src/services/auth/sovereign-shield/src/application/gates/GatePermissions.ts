// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Gate Permissions Service
 *
 * Persistent per-sandbox gate permissions. Controls whether agent gate
 * requests are auto-granted or require user approval via popup.
 *
 * Scope: sandbox-level, always. Per-app gate permissions would be security
 * theater — two apps inside the same sandbox share a Linux namespace, a UID,
 * and a filesystem, so an agent running in app-A can trivially exercise any
 * gate as if it were app-B. The gate decision point is the sandbox boundary.
 *
 * Org-level permissions (optional fallback): when an org scope is active, an
 * org-level `allow_always` / `never` can fall through when no sandbox-level
 * entry exists. See org-mode docs for details.
 *
 * Permission levels:
 *   - 'ask'           — Default. Agent requests trigger a popup.
 *   - 'allow_session' — Auto-grant for current process lifetime. In-memory only.
 *   - 'allow_always'  — Persistent on disk. Auto-grants without browser round-trip.
 *   - 'never'         — Persistent on disk. Auto-denies without popup. Agent told to skip & continue.
 *
 * Storage: /etc/ellul/shield-data/gate-permissions.json
 * Follows the atomic write pattern from settings.service.ts (write tmp → fsync → rename).
 *
 * Security:
 *   - File is in shield-data directory (agent cannot access)
 *   - Only sovereign-shield reads/writes
 *   - Every permission change is audit-logged
 *   - 'allow_session' is in-memory only (fail-secure on restart)
 */

import fs from 'fs';
import { parseSandboxId, type SandboxId } from '@ellul.ai/types';
import { logAuditEvent } from '../audit/Audit';
import { isWalletEnabled } from '../wallets/WalletFeature';

// ── Types ──

export type GateType = 'logs' | 'env' | 'db_read' | 'db_write' | 'db_migrate' | 'git' | 'deploy' | 'exec' | 'wallet_spend' | 'vault_read';
export type GatePermission = 'ask' | 'allow_session' | 'allow_always' | 'never';

/** Canonical set of valid gate types — used for validation at all boundaries. */
export const VALID_GATE_TYPES: ReadonlySet<GateType> = new Set([
  'logs', 'env', 'db_read', 'db_write', 'db_migrate', 'git', 'deploy', 'exec', 'vault_read',
]);

/**
 * Active gate types — base set + feature-flagged gates.
 * wallet_spend is only valid when the wallet feature is enabled.
 * Cached: the extended set is rebuilt only when the feature flag cache expires.
 */
const EXTENDED_GATE_TYPES: ReadonlySet<GateType> = new Set([
  ...VALID_GATE_TYPES,
  'wallet_spend',
]);

export function getActiveGateTypes(): ReadonlySet<GateType> {
  return isWalletEnabled() ? EXTENDED_GATE_TYPES : VALID_GATE_TYPES;
}

/** Gate types that cannot use `allow_always` — must be re-approved every session. */
export const DENY_ALLOW_ALWAYS: ReadonlySet<GateType> = new Set(['exec', 'wallet_spend']);

interface PermissionEntry {
  permission: 'allow_always' | 'never';
  grantedAt: string;
  grantedBy: string; // 'dashboard' | 'popup' | 'auto'
}

interface GatePermissionsFile {
  version: 1;
  updatedAt: string;
  /** Sandbox-keyed permissions. Keys MUST match `/^sbx-[a-z0-9]{7}$/`. */
  sandboxes: Record<string, Partial<Record<GateType, PermissionEntry>>>;
  /** Org-level permissions — keyed by orgScope (e.g., team slug from org config) */
  orgScopes?: Record<string, Partial<Record<GateType, PermissionEntry>>>;
}

// ── Constants ──

const PERMISSIONS_FILE = '/etc/ellul/shield-data/gate-permissions.json';
const PERMISSIONS_TMP = '/etc/ellul/shield-data/gate-permissions.json.tmp';

// ── Validation ──

/** Validate and cast a gate type string. Throws on invalid. */
export function validateGateType(gate: string): GateType {
  const active = getActiveGateTypes();
  if (!active.has(gate as GateType)) {
    throw new Error(`Invalid gate type: '${gate}'. Must be one of: ${[...active].join(', ')}`);
  }
  return gate as GateType;
}

/**
 * Normalize an org scope identifier: trim, lowercase, reject empty/null.
 * Throws on invalid. Used only for org-level gate permissions (a distinct
 * concept from the sandbox scope). Sandbox slugs go through
 * `parseSandboxId` from `@ellul.ai/types`.
 */
export function normalizeOrgScope(orgScope: string | null | undefined): string {
  if (orgScope == null) throw new Error('orgScope is required');
  const normalized = orgScope.trim().toLowerCase();
  if (normalized.length === 0) throw new Error('orgScope cannot be empty');
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid orgScope: '${normalized}'. Only alphanumeric, hyphens, underscores, and dots allowed.`);
  }
  return normalized;
}


// ── State ──

// In-memory session permissions (cleared on process restart = fail-secure)
const sessionPermissions = new Map<string, true>();

function sessionKey(gate: GateType, scope: string): string {
  return `${scope}:${gate}`;
}

// ── Write Queue (single-writer pattern) ──
// Serializes all writes through a promise chain to prevent concurrent corruption.
let writeQueue: Promise<void> = Promise.resolve();

// ── File I/O (atomic write pattern from settings.service.ts) ──

function readPermissionsFile(): GatePermissionsFile {
  try {
    const raw = fs.readFileSync(PERMISSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || typeof parsed.sandboxes !== 'object') {
      return { version: 1, updatedAt: new Date().toISOString(), sandboxes: {} };
    }
    return parsed as GatePermissionsFile;
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), sandboxes: {} };
  }
}

function writePermissionsFileSync(data: GatePermissionsFile): void {
  data.updatedAt = new Date().toISOString();
  const json = JSON.stringify(data, null, 2) + '\n';
  const fd = fs.openSync(PERMISSIONS_TMP, 'w', 0o600);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(PERMISSIONS_TMP, PERMISSIONS_FILE);
}

/**
 * Enqueue an atomic write. Serializes all writes through a promise chain
 * so concurrent calls don't corrupt the file.
 */
function enqueueWrite(data: GatePermissionsFile): Promise<void> {
  writeQueue = writeQueue.then(() => {
    writePermissionsFileSync(data);
  }).catch((err) => {
    console.error('[shield] Gate permissions write failed:', err);
    throw err;
  });
  return writeQueue;
}

// ── Public API ──

/**
 * Get the effective permission for a gate in a specific sandbox.
 * Checks: never (sandbox or org) → session → allow_always (sandbox or org)
 * → explicit sandbox entry → org fallback → ask.
 *
 * When `orgScope` is provided, org-level permissions are checked as a
 * fallback when the sandbox has NO explicit entry for this gate.
 */
export function getPermission(
  gate: GateType,
  sandboxId: SandboxId,
  orgScope?: string,
): GatePermission {
  validateGateType(gate);

  const data = readPermissionsFile();
  const sandboxPerms = data.sandboxes[sandboxId];

  // 'never' takes highest priority — check sandbox-level then org-level
  if (sandboxPerms?.[gate]?.permission === 'never') {
    return 'never';
  }
  if (orgScope) {
    const orgPerms = data.orgScopes?.[orgScope];
    if (orgPerms?.[gate]?.permission === 'never') {
      return 'never';
    }
  }

  // Sandbox-level session permission
  if (sessionPermissions.has(sessionKey(gate, sandboxId))) {
    return 'allow_session';
  }

  // Sandbox-level persistent allow_always
  if (sandboxPerms?.[gate]?.permission === 'allow_always') {
    return 'allow_always';
  }

  // Sandbox-level explicit entry ('ask' or anything else) wins over org.
  // SECURITY: Previously org-level could silently auto-grant access to
  // sandboxes that hadn't set any explicit permission (defaulting to 'ask').
  // Now org-level only applies as fallback when the sandbox has NO entry.
  if (sandboxPerms?.[gate]) {
    return sandboxPerms[gate]!.permission as GatePermission;
  }

  // No sandbox-level permission set — check org-level as fallback
  if (orgScope) {
    if (sessionPermissions.has(sessionKey(gate, orgScope))) {
      return 'allow_session';
    }
    const orgPerms = data.orgScopes?.[orgScope];
    if (orgPerms?.[gate]?.permission === 'allow_always') {
      return 'allow_always';
    }
  }

  return 'ask';
}

/**
 * Set a persistent permission ('allow_always', 'never', or 'ask') for a
 * sandbox. 'ask' removes the entry (absence = ask).
 */
export async function setPermission(
  gate: GateType,
  sandboxId: SandboxId,
  permission: 'allow_always' | 'never' | 'ask',
  grantedBy: 'dashboard' | 'popup' | 'auto' = 'dashboard',
): Promise<void> {
  validateGateType(gate);

  const data = readPermissionsFile();
  const previous = data.sandboxes[sandboxId]?.[gate]?.permission || 'ask';

  // Block allow_always for gates that require per-session approval
  if (permission === 'allow_always' && DENY_ALLOW_ALWAYS.has(gate)) {
    throw new Error(`Gate type '${gate}' does not support allow_always. Use allow_session instead.`);
  }

  if (permission === 'allow_always' || permission === 'never') {
    if (!data.sandboxes[sandboxId]) data.sandboxes[sandboxId] = {};
    data.sandboxes[sandboxId]![gate] = {
      permission,
      grantedAt: new Date().toISOString(),
      grantedBy,
    };
  } else {
    // 'ask' — remove the entry
    const sandboxPerms = data.sandboxes[sandboxId];
    if (sandboxPerms) {
      delete sandboxPerms[gate];
      if (Object.keys(sandboxPerms).length === 0) {
        delete data.sandboxes[sandboxId];
      }
    }
  }

  await enqueueWrite(data);

  // Also clear any session permission when setting persistent
  sessionPermissions.delete(sessionKey(gate, sandboxId));

  logAuditEvent({
    type: 'gate_permission.set',
    sandboxId,
    details: { gate, permission, previous, grantedBy },
  });
}

/**
 * Set a session-scoped permission (in-memory only, clears on restart).
 */
export function setSessionPermission(gate: GateType, sandboxId: SandboxId): void {
  validateGateType(gate);
  sessionPermissions.set(sessionKey(gate, sandboxId), true);
  logAuditEvent({
    type: 'gate_permission.set',
    sandboxId,
    details: { gate, permission: 'allow_session', scope: 'session' },
  });
}

/**
 * Clear a session-scoped permission.
 */
export function clearSessionPermission(gate: GateType, sandboxId: SandboxId): void {
  validateGateType(gate);
  sessionPermissions.delete(sessionKey(gate, sandboxId));
}

/**
 * Check if a gate request should be auto-granted based on permissions.
 * Returns true for 'allow_always' and 'allow_session'.
 */
export function shouldAutoGrant(gate: GateType, sandboxId: SandboxId): boolean {
  validateGateType(gate);
  const perm = getPermission(gate, sandboxId);
  return perm === 'allow_always' || perm === 'allow_session';
}

/**
 * Check if a gate request should be auto-denied based on permissions.
 * Returns true for 'never'.
 */
export function shouldAutoDeny(gate: GateType, sandboxId: SandboxId): boolean {
  validateGateType(gate);
  return getPermission(gate, sandboxId) === 'never';
}

/**
 * Get all gate permissions for a specific sandbox.
 */
export function getSandboxPermissions(sandboxId: SandboxId): Record<GateType, GatePermission> {
  const result: Record<string, GatePermission> = {};
  for (const gate of VALID_GATE_TYPES) {
    result[gate] = getPermission(gate, sandboxId);
  }
  return result as Record<GateType, GatePermission>;
}

/**
 * Get all permissions for all sandboxes (for UI listing).
 * Returns the raw permissions file data merged with session permissions.
 */
export function getAllPermissions(): GatePermissionsFile & { sessionSandboxes?: Record<string, Partial<Record<GateType, true>>> } {
  const data = readPermissionsFile();

  const sessionSandboxes: Record<string, Partial<Record<GateType, true>>> = {};
  for (const key of sessionPermissions.keys()) {
    const [scope, gate] = key.split(':') as [string, GateType];
    if (!sessionSandboxes[scope]) sessionSandboxes[scope] = {};
    sessionSandboxes[scope][gate] = true;
  }

  return { ...data, sessionSandboxes: Object.keys(sessionSandboxes).length > 0 ? sessionSandboxes : undefined };
}

// ── Org-Level Permissions ──

/**
 * Set a persistent permission at the org scope.
 * Org-level permissions apply as fallback when no app-level permission is set.
 */
export async function setPermissionForOrg(
  gate: GateType,
  orgScope: string,
  permission: 'allow_always' | 'never' | 'ask',
  grantedBy: 'dashboard' | 'popup' | 'auto' = 'dashboard',
): Promise<void> {
  validateGateType(gate);
  orgScope = normalizeOrgScope(orgScope);

  if (permission === 'allow_always' && DENY_ALLOW_ALWAYS.has(gate)) {
    throw new Error(`Gate type '${gate}' does not support allow_always at org scope.`);
  }

  const data = readPermissionsFile();
  if (!data.orgScopes) data.orgScopes = {};

  if (permission === 'allow_always' || permission === 'never') {
    if (!data.orgScopes[orgScope]) data.orgScopes[orgScope] = {};
    data.orgScopes[orgScope]![gate] = {
      permission,
      grantedAt: new Date().toISOString(),
      grantedBy,
    };
  } else {
    const orgPerms = data.orgScopes[orgScope];
    if (orgPerms) {
      delete orgPerms[gate];
      if (Object.keys(orgPerms).length === 0) {
        delete data.orgScopes[orgScope];
      }
    }
  }

  await enqueueWrite(data);

  sessionPermissions.delete(sessionKey(gate, orgScope));

  logAuditEvent({
    type: 'gate_permission_set',
    details: { gate, orgScope, permission, grantedBy, scope: 'org' },
  });
}

/**
 * Get all gate permissions for an org scope. Returns 'ask' when nothing is
 * explicitly set — the org has no gate-level override. The sandbox-scope
 * arg is a placeholder; org-level lookups deliberately don't short-circuit
 * through sandbox-specific entries.
 *
 * Typed with `_` throwaway sandbox since `getPermission` requires it but
 * the org-level branch only inspects org rows.
 */
export function getOrgPermissions(orgScope: string): Record<GateType, GatePermission> {
  orgScope = normalizeOrgScope(orgScope);
  const data = readPermissionsFile();
  const orgPerms = data.orgScopes?.[orgScope];
  const result: Record<string, GatePermission> = {};
  for (const gate of VALID_GATE_TYPES) {
    const perm = orgPerms?.[gate]?.permission;
    if (perm === 'never' || perm === 'allow_always') {
      result[gate] = perm;
    } else if (sessionPermissions.has(sessionKey(gate, orgScope))) {
      result[gate] = 'allow_session';
    } else {
      result[gate] = 'ask';
    }
  }
  return result as Record<GateType, GatePermission>;
}

/**
 * Initialize on startup. Creates the file if it doesn't exist.
 */
export function initGatePermissions(): void {
  if (!fs.existsSync(PERMISSIONS_FILE)) {
    writePermissionsFileSync({ version: 1, updatedAt: new Date().toISOString(), sandboxes: {} });
  }
  console.log('[shield] Gate permissions initialized');
}
