// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tier Service
 *
 * Security tier management and platform notifications.
 *
 * SECURITY: Tier is derived from ground truth (passkeys, markers) not just a file.
 * Uses tamper-proof caching for performance with periodic revalidation.
 */

import crypto from 'crypto';
import fs from 'fs';
import { exec, execFileSync } from 'child_process';
import type Database from 'better-sqlite3';
import {
  TIER_FILE,
  TERMINAL_DISABLED_FILE,
  SERVER_ID_FILE,
  AI_PROXY_TOKEN_FILE,
  API_URL_FILE,
  SVC_HOME,
  SVC_USER,
  SSH_AUTH_KEYS_PATH,
  DOMAIN_FILE,
  ORIGIN_TAG_FILE,
  PENDING_TIER_NOTIFICATION_FILE,
  PLATFORM_ZONE,
} from '../../config';
import type { SecurityTier } from '../../config';
// markCredentialSynced is loaded dynamically below to break the
// tier.service ↔ credential-reconciliation.service cycle.
import { reloadCaddy } from '@vps/shared/caddy';
import { normalizeDeploymentModel } from '@vps/shared/constants';
import { generateCaddyfileContent } from '@vps/services/gateway/caddy-gen/caddyfile';
import { dbg } from '../audit/DebugLog';

// SECURITY: Marker file that indicates web_locked was intentionally activated
// This file can ONLY be removed via explicit downgrade (SSH or authenticated request)
// Prevents accidental downgrade if DB is corrupted/cleared
const WEB_LOCKED_MARKER = '/etc/ellul/shield-data/.web_locked_activated';

// Transition lock file — prevents concurrent tier switches and aids crash recovery
const TIER_TRANSITION_LOCK = '/etc/ellul/shield-data/.tier-transition';

// Database will be injected to avoid circular dependencies
let db: Database;

/**
 * Invalidate tier state - call this when tier state changes
 * (Kept for API compatibility, but tier is now computed on-demand)
 */
export function invalidateTierCache(): void {
  // No-op: tier is computed from ground truth on every call
  // Marker file check is instant, so no caching needed
}

export function setDatabase(database: Database): void {
  db = database;
}

export interface ServerCredentials {
  serverId: string;
  apiUrl: string;
  token: string | null;
}

/**
 * Get current security tier
 *
 * SECURITY: Always derive tier from ground truth, never trust the tier file alone.
 * No caching - marker file check is instant and provides fail-secure guarantee.
 *
 * Priority order (highest security wins):
 * 1. Private Locked: web_locked marker + LUKS volume → private_locked
 * 2. Web Locked marker exists → web_locked (instant, fail-secure)
 * 3. Web Locked: Passkey exists in database
 * 4. Standard: No passkeys, no markers
 */
export function getCurrentTier(): SecurityTier {
  return computeTierFromGroundTruth();
}

/**
 * Compute tier from ground truth state
 * This is the source of truth for security tier determination.
 *
 * SECURITY PRINCIPLE: Fail secure, not fail open.
 * - If web_locked marker exists, we ALWAYS return at least web_locked
 * - The marker can ONLY be removed via explicit authenticated downgrade
 *
 * TIER DETERMINATION:
 * - private_locked requires EXPLICIT opt-in via the tier file.
 *   All volumes are now LUKS-encrypted by default, so /dev/mapper/luks-home
 *   always exists and CANNOT be used to distinguish managed encryption from
 *   user-initiated Privacy Lock. The tier file is written by the API when
 *   the user explicitly enables Privacy Lock.
 *
 * PERFORMANCE: Marker check is first (fs.existsSync is ~0.1ms)
 */
function computeTierFromGroundTruth(): SecurityTier {
  // ==========================================================================
  // FAST PATH: Check tier file FIRST for explicit private_locked
  // ==========================================================================
  let tierFileValue: string | null = null;
  let tierFileReadError: string | null = null;
  try {
    tierFileValue = fs.readFileSync(TIER_FILE, 'utf8').trim();
    if (tierFileValue === 'private_locked') {
      // Ensure web_locked marker also exists (private_locked implies web_locked)
      const markerExists = fs.existsSync(WEB_LOCKED_MARKER);
      if (!markerExists) {
        try {
          fs.writeFileSync(WEB_LOCKED_MARKER, Date.now().toString());
          dbg('tier', 'restored_marker_under_private_locked', {});
        } catch (e) {
          dbg('tier', 'restore_marker_failed', { error: (e as Error).message });
        }
      }
      dbg('tier', 'resolved_private_locked_from_file', { markerExisted: markerExists });
      return 'private_locked';
    }
  } catch (e) {
    tierFileReadError = (e as Error).message;
    // Tier file missing — continue to marker check
  }

  // ==========================================================================
  // Check web_locked marker (instant, fail-secure)
  // ==========================================================================
  const webLockedMarkerExists = fs.existsSync(WEB_LOCKED_MARKER);
  dbg('tier', 'marker_check', {
    markerPath: WEB_LOCKED_MARKER,
    markerExists: webLockedMarkerExists,
    tierFileValue,
    tierFileReadError,
  });

  if (webLockedMarkerExists) {
    dbg('tier', 'resolved_web_locked_from_marker', {});
    return 'web_locked';
  }

  // ==========================================================================
  // CROSS-CHECK: Read tier file as a safety net.
  // If the tier file says "web_locked" but marker is missing (crash recovery,
  // filesystem inconsistency), trust the tier file and restore the marker.
  // Note: private_locked is handled in the fast path above.
  // ==========================================================================
  if (tierFileValue === 'web_locked') {
    // Tier file says web_locked — restore missing marker (crash recovery)
    try {
      fs.writeFileSync(WEB_LOCKED_MARKER, Date.now().toString());
      console.log('[shield] SECURITY: Tier file says web_locked, restored missing marker (crash recovery)');
      dbg('tier', 'resolved_web_locked_from_file_marker_restored', {});
    } catch (e) {
      console.error('[shield] SECURITY: Could not restore marker, but tier file is authoritative:', (e as Error).message);
      dbg('tier', 'resolved_web_locked_from_file_marker_restore_failed', { error: (e as Error).message });
    }
    return 'web_locked';
  }

  // ==========================================================================
  // SLOW PATH: No marker, tier file doesn't say web_locked, check actual state
  // ==========================================================================

  // Check for passkeys (only if no marker - new setup or never upgraded)
  let hasPasskey = false;
  let credentialCount = 0;
  let dbQueryError: string | null = null;
  try {
    if (db) {
      credentialCount = (db.prepare('SELECT COUNT(*) as c FROM credential').get() as { c: number }).c;
      hasPasskey = credentialCount > 0;
    } else {
      dbQueryError = 'db_not_initialized';
    }
  } catch (e) {
    // DB error with no marker and tier file not web_locked = standard
    dbQueryError = (e as Error).message;
    console.error('[shield] DB query failed, no web_locked marker or tier file - defaulting to standard');
  }
  dbg('tier', 'credential_count_check', { credentialCount, hasPasskey, dbQueryError });

  if (hasPasskey) {
    // Passkey exists but no marker — create marker now (first-time setup).
    // This is web_locked, not private_locked. Private requires explicit opt-in
    // via the Privacy Lock flow which writes "private_locked" to the tier file.
    let markerWriteError: string | null = null;
    try {
      fs.writeFileSync(WEB_LOCKED_MARKER, Date.now().toString());
      console.log('[shield] SECURITY: Passkey found, created web_locked marker');
    } catch (e) {
      markerWriteError = (e as Error).message;
    }
    dbg('tier', 'resolved_web_locked_from_db', { credentialCount, markerWriteError });
    return 'web_locked';
  }

  // No marker, tier file not locked, no passkeys = standard
  dbg('tier', 'resolved_standard_no_passkey', { credentialCount, tierFileValue });
  return 'standard';
}

/**
 * Set security tier
 */
export function setTier(tier: SecurityTier): void {
  fs.writeFileSync(TIER_FILE, tier);
}

/**
 * Check if a tier has the requirements to be active
 */
export function canActivateTier(tier: SecurityTier): boolean {
  if (tier === 'standard') return true;

  if (tier === 'web_locked' || tier === 'private_locked') {
    // Need at least one passkey
    const count = (db.prepare('SELECT COUNT(*) as c FROM credential').get() as { c: number }).c;
    if (count === 0) return false;
    // private_locked requires passkeys (checked above). All volumes are now
    // LUKS-encrypted by default, so /dev/mapper/luks-home is not a distinguishing check.
    // The tier is set by the API via update-identity after the Privacy Lock flow completes.
    return true;
  }

  return false;
}

/**
 * Read server credentials for platform notifications
 */
export function getServerCredentials(): ServerCredentials | null {
  try {
    const serverId = fs.readFileSync(SERVER_ID_FILE, 'utf8').trim();
    const apiUrl = fs.existsSync(API_URL_FILE)
      ? fs.readFileSync(API_URL_FILE, 'utf8').trim()
      : `https://api.${PLATFORM_ZONE}`;
    const token = fs.readFileSync(AI_PROXY_TOKEN_FILE, 'utf8').trim() || null;
    return { serverId, apiUrl, token };
  } catch {
    return null;
  }
}

/**
 * Notify platform about tier change.
 *
 * Write-ahead marker: payload persisted to disk BEFORE the HTTP call so a
 * crash or network failure never silently drops the notification. On success
 * the marker is deleted; on failure it stays for `retryPendingTierNotification`
 * (periodic timer in main.ts) to pick up.
 */
export async function notifyPlatformTierChange(
  fromTier: SecurityTier,
  toTier: SecurityTier,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  const marker = {
    fromTier,
    toTier,
    ipAddress: ipAddress || 'unknown',
    userAgent: userAgent || 'unknown',
    createdAt: Date.now(),
    attempts: 0,
  };

  try {
    fs.writeFileSync(PENDING_TIER_NOTIFICATION_FILE, JSON.stringify(marker));
  } catch (e) {
    console.error('[shield] Cannot write tier notification marker:', (e as Error).message);
  }

  await sendTierNotification(marker);
}

interface TierNotificationMarker {
  fromTier: SecurityTier;
  toTier: SecurityTier;
  ipAddress: string;
  userAgent: string;
  createdAt: number;
  attempts: number;
}

async function sendTierNotification(marker: TierNotificationMarker): Promise<boolean> {
  const creds = getServerCredentials();
  if (!creds || !creds.token) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${creds.apiUrl}/api/servers/${creds.serverId}/vps-event`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event: 'tier_changed',
        data: {
          fromTier: marker.fromTier,
          tier: marker.toTier,
          ipAddress: marker.ipAddress,
          userAgent: marker.userAgent,
        },
        timestamp: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex'),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok || res.status === 409) {
      // 409 = already processed (idempotent) — treat as success
      try { fs.unlinkSync(PENDING_TIER_NOTIFICATION_FILE); } catch {}
      console.log(`[shield] Platform notified of tier change: ${marker.fromTier} → ${marker.toTier}`);
      return true;
    }
    console.warn(`[shield] Tier notification returned ${res.status} — will retry`);
    return false;
  } catch (e: any) {
    clearTimeout(timeout);
    console.warn('[shield] Tier notification failed:', e.name === 'AbortError' ? 'timeout' : (e as Error).message);
    return false;
  }
}

const MAX_NOTIFICATION_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_NOTIFICATION_ATTEMPTS = 60;

export async function retryPendingTierNotification(): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync(PENDING_TIER_NOTIFICATION_FILE, 'utf8');
  } catch {
    return; // No pending notification
  }

  let marker: TierNotificationMarker;
  try {
    marker = JSON.parse(raw);
  } catch {
    // Corrupt marker — delete and bail
    try { fs.unlinkSync(PENDING_TIER_NOTIFICATION_FILE); } catch {}
    return;
  }

  if (Date.now() - marker.createdAt > MAX_NOTIFICATION_AGE_MS || marker.attempts >= MAX_NOTIFICATION_ATTEMPTS) {
    console.error(`[shield] Tier notification expired (${marker.attempts} attempts over ${Math.round((Date.now() - marker.createdAt) / 60000)}min) — discarding`);
    try { fs.unlinkSync(PENDING_TIER_NOTIFICATION_FILE); } catch {}
    return;
  }

  marker.attempts++;
  try {
    fs.writeFileSync(PENDING_TIER_NOTIFICATION_FILE, JSON.stringify(marker));
  } catch {}

  await sendTierNotification(marker);
}

/**
 * Notify platform about settings change (terminal/SSH toggle)
 * Fire-and-forget — heartbeat reconciles within 30s on failure.
 */
export async function notifyPlatformSettingsChange(
  settings: { terminalEnabled: boolean; sshEnabled: boolean },
  ipAddress: string,
  userAgent: string
): Promise<void> {
  const creds = getServerCredentials();
  if (!creds || !creds.token) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${creds.apiUrl}/api/servers/${creds.serverId}/vps-event`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event: 'settings_changed',
        data: {
          terminalEnabled: settings.terminalEnabled,
          sshEnabled: settings.sshEnabled,
          ipAddress,
          userAgent,
        },
        timestamp: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex'),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn('[shield] Settings webhook returned', res.status);
    }
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name !== 'AbortError') throw err;
    console.warn('[shield] Settings webhook timed out');
  }
}

/**
 * Notify platform about SSH key changes
 */
export async function notifyPlatformSshKeyChange(
  action: 'added' | 'removed',
  fingerprint: string,
  name: string,
  publicKey?: string
): Promise<void> {
  const creds = getServerCredentials();
  if (!creds || !creds.token) return;

  const event = action === 'added' ? 'ssh_key_added' : 'ssh_key_removed';

  try {
    await fetch(`${creds.apiUrl}/api/servers/${creds.serverId}/vps-event`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event,
        data: { fingerprint, name, publicKey },
        timestamp: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex'),
      }),
    });
  } catch (e) {
    console.error('[shield] Failed to notify platform of SSH key change:', (e as Error).message);
  }
}

/**
 * Notify platform about passkey registration.
 * Sends full credential data so the API can populate both server_passkeys
 * (for dashboard display) and user_encryption_credentials (for PRF volume encryption).
 * One registration, one credential, both tables.
 *
 * Synchronous with one retry — the VPS→API call is authenticated (bearer + nonce).
 * Returns true if the API confirmed the sync, false if both attempts failed.
 * Registration still succeeds either way (sovereignty), but the return value tells
 * the frontend whether it needs to fall back to direct sync.
 *
 * Also invalidates tier cache since passkey existence affects tier.
 */
export async function notifyPlatformPasskeyRegistered(
  credentialId: string,
  name: string,
  credentialData?: {
    publicKey: string;       // base64url-encoded
    counter: number;
    transports: string[];
    aaguid: string;
    prfSupported: boolean;
  },
): Promise<boolean> {
  // Passkey added = tier may change to web_locked
  invalidateTierCache();

  const creds = getServerCredentials();
  if (!creds || !creds.token) return false;

  const payload = JSON.stringify({
    event: 'passkey_registered',
    data: {
      credentialId,
      name,
      ...(credentialData && {
        publicKey: credentialData.publicKey,
        counter: credentialData.counter,
        transports: credentialData.transports,
        aaguid: credentialData.aaguid,
        prfSupported: credentialData.prfSupported,
      }),
    },
    timestamp: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex'),
  });

  const url = `${creds.apiUrl}/api/servers/${creds.serverId}/vps-event`;
  const headers = {
    'Authorization': `Bearer ${creds.token}`,
    'Content-Type': 'application/json',
  };

  // Attempt with one retry
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const { markCredentialSynced } = await import('../credentials/CredentialReconciliation');
        markCredentialSynced(credentialId);
        return true;
      }
      console.warn(`[shield] Platform notification attempt ${attempt + 1} failed: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`[shield] Platform notification attempt ${attempt + 1} failed:`, (e as Error).message);
    }
  }

  console.error('[shield] Platform notification failed after 2 attempts — frontend will fall back to direct sync');
  return false;
}

/**
 * Notify platform about passkey removal
 * Also invalidates tier cache since passkey existence affects tier
 */
export async function notifyPlatformPasskeyRemoved(credentialId: string, name: string): Promise<void> {
  // Passkey removed = tier may change from web_locked
  invalidateTierCache();

  const creds = getServerCredentials();
  if (!creds || !creds.token) return;

  try {
    await fetch(`${creds.apiUrl}/api/servers/${creds.serverId}/vps-event`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event: 'passkey_removed',
        data: { credentialId, name },
        timestamp: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex'),
      }),
    });
  } catch (e) {
    console.error('[shield] Failed to notify platform of passkey removal:', (e as Error).message);
  }
}

/**
 * Notify platform to clear stored heartbeat public key.
 * Called after keypair regeneration so next heartbeat re-registers via TOFU.
 */
export async function notifyPlatformHeartbeatKeyReset(): Promise<void> {
  const creds = getServerCredentials();
  if (!creds || !creds.token) return;

  try {
    await fetch(`${creds.apiUrl}/api/servers/${creds.serverId}/vps-event`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event: 'heartbeat_key_reset',
        data: {},
        timestamp: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex'),
      }),
    });
  } catch (e) {
    console.error('[shield] Failed to notify platform of heartbeat key reset:', (e as Error).message);
  }
}

/**
 * Execute a tier switch with pre-flight checks and rollback on failure
 *
 * This is the single source of truth for all tier changes.
 * It includes:
 * - Pre-flight safety checks (verify new access works before closing old)
 * - Tier file updates with verification
 * - Rollback on failure
 * - Platform notification
 */
export async function executeTierSwitch(
  targetTier: SecurityTier,
  ipAddress: string,
  userAgent: string
): Promise<void> {
  const { execSync, spawnSync } = await import('child_process');
  const currentTier = getCurrentTier();

  // Prevent concurrent tier transitions
  if (fs.existsSync(TIER_TRANSITION_LOCK)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(TIER_TRANSITION_LOCK, 'utf8'));
      const lockAge = Date.now() - (lockData.startedAt || 0);
      // Stale lock (>60s) — previous transition crashed, allow override
      if (lockAge < 60_000) {
        throw new Error('Tier transition already in progress');
      }
      console.log('[shield] Clearing stale transition lock (age:', lockAge, 'ms)');
    } catch (e) {
      if ((e as Error).message === 'Tier transition already in progress') throw e;
      // Corrupt lock file — clear it
    }
  }

  // Write transition lock
  fs.writeFileSync(TIER_TRANSITION_LOCK, JSON.stringify({
    from: currentTier,
    to: targetTier,
    startedAt: Date.now(),
  }));

  // Suppress perf-monitor's OOM-loop breaker for the duration. Tier
  // transitions briefly spike PSI on small hosts; without this lock the
  // breaker can fire on a healthy toggle. perf-monitor caps the lock at
  // 120s so a wedged transition can't permanently disable the breaker.
  // /run/shield is shield-runner's RuntimeDirectory (tmpfs — no
  // stale-lock survival across reboots).
  const PERF_MONITOR_TIER_LOCK = '/run/shield/tier-change-in-progress';
  try {
    fs.writeFileSync(PERF_MONITOR_TIER_LOCK, `${Date.now()}\n${currentTier}->${targetTier}\n`);
  } catch (e) {
    // Best-effort. Underlying fix (PSI threshold + window) is the safety net.
    console.warn('[shield] could not acquire perf-monitor tier lock:', (e as Error).message);
  }

  try {

  // Helper to verify a service is running
  const isServiceRunning = (service: string): boolean => {
    try {
      const result = spawnSync('systemctl', ['is-active', '--quiet', service]);
      return result.status === 0;
    } catch { return false; }
  };

  // Helper to write tier file (service runs as $SVC_USER, no chattr available)
  const writeTierFile = (tier: string): void => {
    fs.writeFileSync(TIER_FILE, tier);
    if (fs.readFileSync(TIER_FILE, 'utf8').trim() !== tier) {
      throw new Error(`Failed to update tier file to ${tier}`);
    }
    console.log(`[shield] Tier file updated to ${tier} (verified)`);
  };

  // Helper to write marker file
  const writeMarker = (path: string, content: string): void => {
    fs.writeFileSync(path, content);
  };

  // Helper to remove marker file
  const removeMarker = (path: string): void => {
    try { fs.unlinkSync(path); } catch {}
  };

  switch (targetTier) {
    case 'standard':
      // =================================================================
      // DOWNGRADE TO STANDARD - Must verify web terminal works BEFORE closing SSH
      // =================================================================

      // STEP 1: Start terminal services FIRST (before any destructive changes)
      // Non-blocking to avoid starving forward_auth requests during tier switch.
      await new Promise<void>((resolve) => {
        exec('/usr/local/bin/ellul-unlock 2>&1 || true', { timeout: 10_000 }, () => {
          exec('systemctl start ellul-agent-bridge ellul-term-proxy 2>/dev/null || true', { timeout: 10_000 }, () => resolve());
        });
      });

      // STEP 2: Wait and verify terminal services are running BEFORE closing SSH
      await new Promise(r => setTimeout(r, 2000));
      if (!isServiceRunning('ellul-agent-bridge') || !isServiceRunning('ellul-term-proxy')) {
        console.error('[shield] FATAL: Terminal services failed to start! Aborting downgrade.');
        throw new Error('Terminal services failed to start - downgrade aborted, SSH still available');
      }
      console.log('[shield] Terminal services (agent-bridge, term-proxy) verified running');

      // STEP 3: Remove web_locked marker and clear passkey credentials
      // Both must succeed: if marker is gone but passkeys remain,
      // computeTierFromGroundTruth() recreates the marker and tier snaps back.
      // SAFETY: Only clear credentials AFTER confirming marker is gone.
      // If marker removal fails, keep credentials so user can still authenticate.
      removeMarker(WEB_LOCKED_MARKER);
      if (fs.existsSync(WEB_LOCKED_MARKER)) {
        console.error('[shield] CRITICAL: web_locked marker could not be removed — aborting downgrade');
        throw new Error('Failed to remove web_locked marker — downgrade aborted, passkeys preserved');
      }
      console.log('[shield] SECURITY: web_locked marker removed (explicit downgrade)');
      // Marker confirmed gone — clear credentials in a transaction.
      // If the DB operation fails, restore the marker so the user can still
      // authenticate with their existing passkeys (fail-secure).
      try {
        db.exec('BEGIN');
        db.prepare('DELETE FROM sessions').run();
        db.prepare('DELETE FROM credential').run();
        db.exec('COMMIT');
        console.log('[shield] Passkey credentials and sessions cleared (standard downgrade)');
      } catch (e) {
        db.exec('ROLLBACK');
        // Restore marker — credentials still exist, user can still auth
        writeMarker(WEB_LOCKED_MARKER, Date.now().toString());
        console.error('[shield] Failed to clear credentials, restored web_locked marker:', (e as Error).message);
        throw new Error('Failed to clear credentials — web_locked state restored');
      }

      // STEP 4: Update tier file (after security state is consistent)
      writeTierFile('standard');

      // STEP 5: Remove SSH keys and close SSH port
      // SSH keys are a web_locked feature — standard tier does not support SSH.
      // Non-fatal: shield-runner lacks CAP_CHOWN; enforcer (root) self-heals on next cycle.
      try {
        if (fs.existsSync(SSH_AUTH_KEYS_PATH)) {
          fs.writeFileSync(SSH_AUTH_KEYS_PATH, '');
          execFileSync('chown', ['root:root', SSH_AUTH_KEYS_PATH], { stdio: 'pipe' });
          execFileSync('chmod', ['600', SSH_AUTH_KEYS_PATH], { stdio: 'pipe' });
          console.log('[shield] SSH keys removed (standard tier does not support SSH)');
        }
        const sshDir = `${SVC_HOME}/.ssh`;
        if (fs.existsSync(sshDir)) {
          execFileSync('chown', [`${SVC_USER}:${SVC_USER}`, sshDir], { stdio: 'pipe' });
          execFileSync('chmod', ['700', sshDir], { stdio: 'pipe' });
        }
      } catch (sshErr) {
        console.warn('[shield] SSH cleanup deferred to enforcer:', (sshErr as Error).message);
      }

      // STEP 6: FINAL - Close SSH port and stop sshd
      execSync('ufw deny 22/tcp 2>/dev/null || true', { stdio: 'pipe' });
      exec('systemctl disable --now sshd 2>/dev/null || true', { timeout: 10_000 }, () => {});
      console.log('[shield] SSH port closed and sshd disabled (standard tier)');
      break;

    case 'web_locked':
      // =================================================================
      // UPGRADE TO WEB LOCKED - Passkey gate should already be active
      // =================================================================

      // STEP 0: Ensure SSH stays closed (no SSH fallback)
      execSync('ufw deny 22/tcp 2>/dev/null || true', { stdio: 'pipe' });
      console.log('[shield] SSH port closed (web_locked from standard - passkey + recovery codes only)');

      // STEP 1: Verify we're running (sovereign-shield must be active for web_locked)
      console.log('[shield] Sovereign Shield is active (self-verified)');

      // STEP 2: Create web_locked activation marker (SECURITY: prevents accidental downgrade)
      writeMarker(WEB_LOCKED_MARKER, Date.now().toString());
      console.log('[shield] SECURITY: web_locked marker created');

      // Export passkey public keys to bootstrap partition (root FS) for
      // sovereign mode stateless unlock (Patent Embodiment 6, Pre-Sleep Checkpoint)
      try {
        const { exportBootstrapCredentials } = require('../platform/BootstrapExport');
        exportBootstrapCredentials();
      } catch (e) { console.warn('[shield] Bootstrap export failed:', e); }

      // STEP 3: Update tier file
      writeTierFile('web_locked');

      // STEP 4: Remove terminal disabled marker if present
      try { fs.unlinkSync(TERMINAL_DISABLED_FILE); } catch {}

      // STEP 5: Lock down SSH — agent must not modify authorized_keys directly.
      // Only sovereign-shield (running as root) can manage SSH keys via /_auth/keys.
      // Lock both .ssh dir (prevents creating authorized_keys2/symlinks) and authorized_keys file.
      {
        const sshDir = `${SVC_HOME}/.ssh`;
        if (fs.existsSync(sshDir)) {
          execFileSync('chown', ['root:root', sshDir], { stdio: 'pipe' });
          execFileSync('chmod', ['700', sshDir], { stdio: 'pipe' });
        }
        if (fs.existsSync(SSH_AUTH_KEYS_PATH)) {
          execFileSync('chown', ['root:root', SSH_AUTH_KEYS_PATH], { stdio: 'pipe' });
          execFileSync('chmod', ['600', SSH_AUTH_KEYS_PATH], { stdio: 'pipe' });
        }
        console.log('[shield] SSH .ssh/ and authorized_keys locked to root (agent zero access)');
      }
      break;
  }

  // Invalidate tier cache immediately after state change
  invalidateTierCache();

  // Recompute settings with new tier overrides
  const { onTierChanged } = await import('../platform/Settings');
  onTierChanged();

  // ── Regenerate Caddyfile + reload Caddy ──
  // The Caddyfile is tier-agnostic (forward_auth goes to sovereign-shield regardless;
  // the runtime middleware handles the auth difference). Regenerating ensures the
  // config stays consistent with current domains/model after any state change.
  try {
    const domain = (() => { try { return fs.readFileSync(DOMAIN_FILE, 'utf8').trim(); } catch { return ''; } })();
    const serverId = (() => { try { return fs.readFileSync(SERVER_ID_FILE, 'utf8').trim(); } catch { return ''; } })();
    const model = normalizeDeploymentModel((() => {
      try {
        const meta = JSON.parse(fs.readFileSync('/opt/ellul/metadata.json', 'utf8'));
        return meta.deployment_model || 'proxied';
      } catch { return 'proxied'; }
    })());
    const originTag = (() => { try { return fs.readFileSync(ORIGIN_TAG_FILE, 'utf8').trim() || undefined; } catch { return undefined; } })();

    if (domain && serverId) {
      const { PLATFORM_ZONE, APP_ZONE, CONSOLE_ORIGIN } = await import('../../config');
      const shortId = serverId.slice(0, 8);
      const codeDomain = model === 'direct'
        ? `${shortId}-dcode.${PLATFORM_ZONE}`
        : `${shortId}-code.${PLATFORM_ZONE}`;
      const devDomain = model === 'direct'
        ? `${shortId}-ddev.${APP_ZONE}`
        : `${shortId}-dev.${APP_ZONE}`;

      let customDomain: string | undefined;
      try {
        const cd = fs.readFileSync('/etc/ellul/custom-domain', 'utf8').trim();
        if (cd) customDomain = cd;
      } catch {}

      const caddyfileContent = generateCaddyfileContent({
        deploymentModel: model,
        mainDomain: domain,
        codeDomain,
        devDomain,
        platformZone: PLATFORM_ZONE,
        appZone: APP_ZONE,
        consoleOrigin: CONSOLE_ORIGIN,
        customDomain,
        originTag,
      });

      const caddyfile = '/etc/caddy/Caddyfile';
      fs.writeFileSync(`${caddyfile}.tmp`, caddyfileContent);

      // Validate before applying — async to avoid blocking the event loop
      // (blocking would starve forward_auth requests → 502)
      const valid = await new Promise<boolean>((resolve) => {
        exec(`caddy validate --config ${caddyfile}.tmp --adapter caddyfile`, { timeout: 10_000 }, (err) => resolve(!err));
      });
      if (valid) {
        fs.renameSync(`${caddyfile}.tmp`, caddyfile);
        fs.chmodSync(caddyfile, 0o644);
        await reloadCaddy();
        console.log(`[shield] Caddyfile regenerated + Caddy reloaded for tier ${targetTier}`);
      } else {
        try { fs.unlinkSync(`${caddyfile}.tmp`); } catch {}
        console.warn(`[shield] Caddyfile validation failed during tier switch (Caddy keeps old config)`);
      }
    }
  } catch (caddyErr) {
    // Non-fatal — enforcer will self-heal on next cycle
    console.warn(`[shield] Caddy regen failed during tier switch: ${(caddyErr as Error).message}`);
  }

  // Notify platform — marker file written before HTTP call, periodic retry on failure.
  notifyPlatformTierChange(currentTier, targetTier, ipAddress, userAgent).catch(() => {});
  } finally {
    // perf-monitor lock first — breaker polls it every 60s.
    try { fs.unlinkSync(PERF_MONITOR_TIER_LOCK); } catch {}
    try { fs.unlinkSync(TIER_TRANSITION_LOCK); } catch {}
  }
}
