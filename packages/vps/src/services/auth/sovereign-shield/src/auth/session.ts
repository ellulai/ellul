// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Session Management
 *
 * Passkey session creation, validation, and refresh with
 * deferred fingerprint binding and PoP support.
 */

import crypto from 'crypto';
import type { Context } from 'hono';
import { db } from '../database';
import {
  ROTATION_INTERVAL_MS,
  STEP_UP_THRESHOLD_MS,
  SENSITIVE_ACTIONS,
} from '../config';
import { logAuditEvent } from '../application/audit/Audit';
import { dbg } from '../application/audit/DebugLog';
import { getSessionPolicy, getSessionTTL } from '../application/platform/SessionPolicy';
import { compareFingerprints, type FingerprintData } from './fingerprint';

export interface Session {
  id: string;
  credential_id: string;
  ip: string;
  fingerprint: string | null;
  fingerprint_status: 'pending' | 'bound';
  fingerprint_components: string | null;
  fingerprint_bound_at: number | null;
  country_code: string | null;
  created_at: number;
  last_activity: number;
  last_rotation: number;
  expires_at: number;
  absolute_expiry: number;
  pop_hmac_key?: string | null;
  pop_bound_at?: number | null;
  pop_sw_active?: number | null;
}

export interface SessionValidationResult {
  valid: boolean;
  reason?: string;
  hint?: string;
  session?: Session;
}

export interface SessionRefreshResult {
  sessionId: string;
  rotated: boolean;
}

/**
 * Create session with DEFERRED fingerprint binding.
 * Fingerprint is captured on first navigation request, not during auth (fetch/XHR).
 */
export function createSession(
  credentialId: string,
  ip: string,
  fingerprintData: FingerprintData | null
): Session {
  const now = Date.now();
  const { sessionTtlMs, absoluteMaxMs, maxConcurrentSessions } = getSessionPolicy();

  // Enforce concurrent session limit: evict oldest sessions to make room.
  // maxConcurrentSessions includes the one we're about to create, so we keep (max - 1).
  const existingSessions = db.prepare(
    'SELECT id FROM sessions WHERE credential_id = ? ORDER BY created_at DESC'
  ).all(credentialId) as { id: string }[];

  const keepCount = Math.max(0, maxConcurrentSessions - 1);
  const toEvict = existingSessions.slice(keepCount);

  for (const old of toEvict) {
    logAuditEvent({
      type: 'session_invalidated',
      ip,
      fingerprint: fingerprintData?.hash,
      credentialId,
      sessionId: old.id,
      details: { reason: 'concurrent_limit_exceeded', max: maxConcurrentSessions }
    });
  }
  if (toEvict.length > 0) {
    const ids = toEvict.map(s => s.id);
    db.prepare(
      `DELETE FROM sessions WHERE id IN (${ids.map(() => '?').join(',')})`
    ).run(...ids);
  }
  const session: Session = {
    id: crypto.randomUUID(),
    credential_id: credentialId,
    ip,
    // DEFERRED BINDING: fingerprint starts as NULL, bound on first navigation
    fingerprint: null,
    fingerprint_status: 'pending',
    fingerprint_components: null,
    fingerprint_bound_at: null,
    country_code: null,
    created_at: now,
    last_activity: now,
    last_rotation: now,
    expires_at: now + sessionTtlMs,
    absolute_expiry: now + absoluteMaxMs,
  };

  const operatorBindNonce = crypto.randomBytes(32).toString('hex');

  db.prepare(
    `INSERT INTO sessions (id, credential_id, ip, fingerprint, fingerprint_status, fingerprint_components, fingerprint_bound_at, country_code, created_at, last_activity, last_rotation, expires_at, absolute_expiry, operator_bind_nonce)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id, session.credential_id, session.ip, session.fingerprint,
    session.fingerprint_status, session.fingerprint_components, session.fingerprint_bound_at,
    session.country_code, session.created_at, session.last_activity, session.last_rotation,
    session.expires_at, session.absolute_expiry, operatorBindNonce
  );

  logAuditEvent({
    type: 'session_created',
    ip,
    fingerprint: fingerprintData?.hash,
    credentialId,
    sessionId: session.id,
    details: {
      fingerprint_status: 'pending',
      session_ttl_ms: sessionTtlMs,
      absolute_max_ms: absoluteMaxMs,
      max_concurrent_sessions: maxConcurrentSessions,
    }
  });
  dbg('session', 'created', {
    sidShort: session.id.slice(0, 8),
    credentialIdShort: credentialId.slice(0, 8),
    ip,
    evicted: toEvict.length,
    sessionTtlMs,
    absoluteMaxMs,
  });

  return session;
}

/**
 * Validate session with DEFERRED FINGERPRINT BINDING and HARD REJECT.
 */
export function validateSession(
  sessionId: string,
  ip: string,
  fingerprintData: FingerprintData,
  path: string
): SessionValidationResult {
  const sidShort = sessionId.slice(0, 8);
  dbg('session', 'validate_enter', { sidShort, path, ip, fpShort: fingerprintData?.hash?.slice(0, 8), isNavigation: !!fingerprintData?.isNavigation });

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | undefined;
  if (!session) {
    dbg('session', 'reject_not_found', { sidShort });
    return { valid: false, reason: 'not_found' };
  }

  const now = Date.now();

  // Retroactive policy enforcement: if the owner lowered the TTL since this
  // session was created, enforce the new policy even if expires_at hasn't been
  // clamped yet (defense-in-depth against race with policy update).
  const { sessionTtlMs, absoluteMaxMs, idleTimeoutMs } = getSessionPolicy();
  const policyExpiresAt = session.created_at + sessionTtlMs;
  const policyAbsoluteExpiry = session.created_at + absoluteMaxMs;
  if (now > policyExpiresAt || now > policyAbsoluteExpiry) {
    dbg('session', 'reject_policy_expired', {
      sidShort,
      ageMs: now - session.created_at,
      policyTtlMs: sessionTtlMs,
      policyAbsoluteMs: absoluteMaxMs,
    });
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    logAuditEvent({
      type: 'session_expired',
      ip,
      fingerprint: fingerprintData.hash,
      sessionId,
      details: { reason: 'policy_retroactive', policy_ttl: sessionTtlMs, policy_absolute: absoluteMaxMs }
    });
    return { valid: false, reason: 'policy_expired' };
  }

  // Check absolute expiry (hardcoded at session creation)
  if (now > session.absolute_expiry) {
    dbg('session', 'reject_absolute_expiry', {
      sidShort,
      now,
      absoluteExpiry: session.absolute_expiry,
      overshootMs: now - session.absolute_expiry,
    });
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    logAuditEvent({
      type: 'session_expired',
      ip,
      fingerprint: fingerprintData.hash,
      sessionId,
      details: { reason: 'absolute_expiry' }
    });
    return { valid: false, reason: 'absolute_expiry' };
  }

  // Check session TTL (fixed window from creation)
  if (now > session.expires_at) {
    dbg('session', 'reject_session_timeout', {
      sidShort,
      now,
      expiresAt: session.expires_at,
      overshootMs: now - session.expires_at,
    });
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    logAuditEvent({
      type: 'session_expired',
      ip,
      fingerprint: fingerprintData.hash,
      sessionId,
      details: { reason: 'idle_timeout' }
    });
    return { valid: false, reason: 'session_timeout' };
  }

  // Check idle timeout: no requests for idleTimeoutMs = session dead.
  // This is separate from the fixed session window — a user who authenticates
  // and walks away should be kicked after 15 minutes, not kept alive for hours.
  if (now - session.last_activity > idleTimeoutMs) {
    dbg('session', 'reject_idle_timeout', {
      sidShort,
      idleMs: now - session.last_activity,
      thresholdMs: idleTimeoutMs,
    });
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    logAuditEvent({
      type: 'session_expired',
      ip,
      fingerprint: fingerprintData.hash,
      sessionId,
      details: { reason: 'idle_timeout', idle_ms: now - session.last_activity, threshold_ms: idleTimeoutMs }
    });
    return { valid: false, reason: 'idle_timeout' };
  }

  // === DEFERRED FINGERPRINT BINDING ===
  // SECURITY: Bind fingerprint on the FIRST request regardless of type
  // (navigation or XHR/fetch). Previously only navigation requests triggered
  // binding, which created a race condition: an attacker with a stolen session
  // cookie could send XHR requests (allowed through with pending status) and
  // then navigate to bind their own fingerprint, locking out the legitimate user.
  // Binding on any request type closes this window.
  if (session.fingerprint_status === 'pending') {
    dbg('session', 'binding_fingerprint', {
      sidShort,
      fpShort: fingerprintData?.hash?.slice(0, 8),
      country: fingerprintData?.countryCode,
      trigger: fingerprintData?.isNavigation ? 'navigation' : 'xhr',
      componentCount: Object.keys(fingerprintData?.components ?? {}).length,
    });
    // Bind the fingerprint now on whatever request arrives first
    db.prepare(
      `UPDATE sessions SET fingerprint = ?, fingerprint_status = ?, fingerprint_components = ?,
       fingerprint_bound_at = ?, country_code = ?, last_activity = ? WHERE id = ?`
    ).run(
      fingerprintData.hash, 'bound', JSON.stringify(fingerprintData.components),
      now, fingerprintData.countryCode, now, sessionId
    );

    logAuditEvent({
      type: 'fingerprint_bound',
      ip,
      fingerprint: fingerprintData.hash,
      sessionId,
      details: {
        country_code: fingerprintData.countryCode,
        component_count: Object.keys(fingerprintData.components).length,
        components_preview: Object.keys(fingerprintData.components).join(', '),
        trigger: fingerprintData.isNavigation ? 'navigation' : 'xhr',
      }
    });

    // Update local session object for subsequent checks
    session.fingerprint = fingerprintData.hash;
    session.fingerprint_status = 'bound';
    session.fingerprint_components = JSON.stringify(fingerprintData.components);
    session.country_code = fingerprintData.countryCode;
  }

  // === FINGERPRINT/COUNTRY/UA VALIDATION ===
  const hasPoP = !!session.pop_hmac_key;

  // Fingerprint validation (navigation requests only)
  if (session.fingerprint_status === 'bound' && session.fingerprint && fingerprintData.isNavigation) {
    if (fingerprintData.hash !== session.fingerprint) {
      const storedComponents = JSON.parse(session.fingerprint_components || '{}');
      const comparison = compareFingerprints(storedComponents, fingerprintData.components);

      if (hasPoP) {
        // PoP bound - log anomaly only
        logAuditEvent({
          type: 'fingerprint_anomaly',
          ip,
          fingerprint: fingerprintData.hash,
          sessionId,
          details: {
            stored_hash: session.fingerprint.substring(0, 16),
            current_hash: fingerprintData.hash.substring(0, 16),
            mismatches: comparison.mismatches,
            note: 'PoP bound - anomaly logged, not rejected',
          }
        });
      } else {
        // No PoP - hard reject
        dbg('session', 'reject_fingerprint_mismatch', {
          sidShort,
          storedHashShort: session.fingerprint.substring(0, 16),
          currentHashShort: fingerprintData.hash.substring(0, 16),
          mismatches: comparison.mismatches,
        });
        logAuditEvent({
          type: 'fingerprint_mismatch_rejected',
          ip,
          fingerprint: fingerprintData.hash,
          sessionId,
          details: {
            stored_hash: session.fingerprint.substring(0, 16),
            current_hash: fingerprintData.hash.substring(0, 16),
            mismatches: comparison.mismatches,
          }
        });
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        return { valid: false, reason: 'fingerprint_mismatch' };
      }
    }
  }

  // Country binding validation
  if (session.country_code && fingerprintData.countryCode) {
    if (session.country_code !== fingerprintData.countryCode) {
      if (hasPoP) {
        logAuditEvent({
          type: 'country_anomaly',
          ip,
          fingerprint: fingerprintData.hash,
          sessionId,
          details: {
            stored_country: session.country_code,
            current_country: fingerprintData.countryCode,
            note: 'PoP bound - anomaly logged, not rejected',
          }
        });
      } else {
        dbg('session', 'reject_country_mismatch', {
          sidShort,
          storedCountry: session.country_code,
          currentCountry: fingerprintData.countryCode,
        });
        logAuditEvent({
          type: 'country_mismatch_rejected',
          ip,
          fingerprint: fingerprintData.hash,
          sessionId,
          details: {
            stored_country: session.country_code,
            current_country: fingerprintData.countryCode,
          }
        });
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        return { valid: false, reason: 'country_mismatch' };
      }
    }
  }

  // User-Agent validation (all requests)
  if (session.fingerprint_status === 'bound' && session.fingerprint_components) {
    const storedComponents = JSON.parse(session.fingerprint_components);
    const currentUA = fingerprintData.components['user-agent'] || '';
    const storedUA = storedComponents['user-agent'] || '';

    if (storedUA && currentUA && currentUA !== storedUA) {
      if (hasPoP) {
        logAuditEvent({
          type: 'useragent_anomaly',
          ip,
          fingerprint: fingerprintData.hash,
          sessionId,
          details: {
            stored_ua: storedUA.substring(0, 50),
            current_ua: currentUA.substring(0, 50),
            note: 'PoP bound - anomaly logged, not rejected',
          }
        });
      } else {
        dbg('session', 'reject_useragent_mismatch', {
          sidShort,
          storedUaPrefix: storedUA.substring(0, 50),
          currentUaPrefix: currentUA.substring(0, 50),
        });
        logAuditEvent({
          type: 'useragent_mismatch_rejected',
          ip,
          fingerprint: fingerprintData.hash,
          sessionId,
          details: {
            stored_ua: storedUA.substring(0, 50),
            current_ua: currentUA.substring(0, 50),
          }
        });
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        return { valid: false, reason: 'useragent_mismatch' };
      }
    }
  }

  // IP binding - LOG ONLY (can legitimately change with mobile/VPN)
  if (session.ip !== ip) {
    logAuditEvent({
      type: 'ip_mismatch_logged',
      ip,
      fingerprint: fingerprintData.hash,
      sessionId,
      details: { expected: session.ip, actual: ip }
    });
    // Update stored IP to current (allows legitimate network changes)
    db.prepare('UPDATE sessions SET ip = ? WHERE id = ?').run(ip, sessionId);
  }

  // Step-up authentication for sensitive actions
  if (SENSITIVE_ACTIONS.some(action => path && path.startsWith(action))) {
    const timeSinceAuth = now - session.created_at;
    if (timeSinceAuth > STEP_UP_THRESHOLD_MS) {
      dbg('session', 'reject_step_up_required', {
        sidShort, path, timeSinceAuthMs: timeSinceAuth, thresholdMs: STEP_UP_THRESHOLD_MS,
      });
      return { valid: false, reason: 'step_up_required', session };
    }
  }

  // Update last activity
  db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(now, sessionId);
  dbg('session', 'valid', { sidShort, fpStatus: session.fingerprint_status, popBound: !!session.pop_hmac_key });

  return { valid: true, session };
}

/**
 * Refresh session (update expiry and optionally rotate ID).
 *
 * @param canRotate - Only rotate the session ID when the caller can update the
 *   browser cookie (e.g., via a redirect). Caddy's forward_auth does NOT pass
 *   Set-Cookie on 200 responses, so rotating the ID during normal forward_auth
 *   creates a stale cookie → next request fails with "not_found" → 401.
 *   Rotation only happens when the caller will redirect (sessionFromUrl = true).
 */
export function refreshSession(
  session: Session,
  ip: string,
  fingerprintData: FingerprintData,
  canRotate: boolean = false
): SessionRefreshResult {
  const now = Date.now();
  let newSessionId = session.id;
  let rotated = false;

  if (canRotate && now - session.last_rotation > ROTATION_INTERVAL_MS) {
    newSessionId = crypto.randomUUID();
    rotated = true;
    logAuditEvent({
      type: 'session_rotated',
      ip,
      fingerprint: fingerprintData.hash,
      sessionId: newSessionId,
      details: { old_id: session.id }
    });
  }

  // Update last_activity for audit trail and rotation, but do NOT reset
  // expires_at — the 4-hour idle window is set once at session creation
  // and must not be extended by background requests or forward-auth checks.
  db.prepare('UPDATE sessions SET id = ?, last_activity = ?, last_rotation = ? WHERE id = ?')
    .run(newSessionId, now, rotated ? now : session.last_rotation, session.id);

  // Cascade session ID change to terminal sessions bound to this shield session
  if (rotated) {
    db.prepare('UPDATE term_sessions SET shield_session_id = ? WHERE shield_session_id = ?')
      .run(newSessionId, session.id);
  }

  return { sessionId: newSessionId, rotated };
}

/**
 * Set session cookie on response
 */
export function setSessionCookie(c: Context, sessionId: string, _hostname: string): void {
  // __Host- prefix: browser enforces Secure + Path=/ + no Domain (origin-locked)
  // SameSite=None required: console.ellul.ai loads the bridge iframe from
  // {shortId}-srv.ellul.ai — that's a cross-origin context. SameSite=Lax
  // blocks cookie delivery on cross-origin iframe/fetch, breaking the entire
  // bridge auth flow. SameSite=None + Secure allows it while still requiring HTTPS.
  // __Host- prefix prevents cross-subdomain cookie tossing (no Domain= allowed).
  const { absoluteMaxMs } = getSessionTTL();
  c.header('Set-Cookie', `__Host-shield_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.floor(absoluteMaxMs / 1000)}`);
  dbg('session', 'cookie_set', {
    sidShort: sessionId.slice(0, 8),
    maxAgeS: Math.floor(absoluteMaxMs / 1000),
    hostnameForLog: _hostname,
  });
}

/**
 * Clear session cookie
 */
export function clearSessionCookie(c: Context, _hostname: string): void {
  c.header('Set-Cookie', `__Host-shield_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`);
}

/**
 * Get session by ID
 */
export function getSession(sessionId: string): Session | null {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | null;
}

/**
 * Delete session
 */
export function deleteSession(sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/**
 * Get all sessions for a credential
 */
export function getSessionsByCredential(credentialId: string): Session[] {
  return db.prepare('SELECT * FROM sessions WHERE credential_id = ?').all(credentialId) as Session[];
}

/**
 * Delete all sessions for a credential
 */
export function deleteSessionsByCredential(credentialId: string): void {
  db.prepare('DELETE FROM sessions WHERE credential_id = ?').run(credentialId);
}

/**
 * Clean up expired sessions from the database.
 * Called periodically by main.ts to enforce session expiry
 * even when no validation request triggers lazy deletion.
 */
export function cleanupExpiredSessions(): void {
  const now = Date.now();
  const ACTIVE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  // Count sessions that were actively used before expiring (worth auditing)
  const activeExpired = db.prepare(
    `SELECT COUNT(*) as count FROM sessions
     WHERE (expires_at < ? OR absolute_expiry < ?)
     AND last_activity > ?`
  ).get(now, now, now - ACTIVE_THRESHOLD_MS) as { count: number };

  const result = db.prepare(
    'DELETE FROM sessions WHERE expires_at < ? OR absolute_expiry < ?'
  ).run(now, now);

  if (result.changes > 0) {
    console.log(`[shield] Cleaned up ${result.changes} expired session(s) (${activeExpired.count} were recently active)`);
    // Only audit-log if any expired session was recently active — avoids
    // polluting the tamper-evident hash chain with routine GC of long-dead sessions.
    if (activeExpired.count > 0) {
      logAuditEvent({
        type: 'sessions_cleanup',
        details: { expired_count: result.changes, active_expired: activeExpired.count },
      });
    }
  }
}

// ── Session Exchange Codes ──
// SECURITY: One-time codes that map to auth data, used to avoid exposing
// session IDs or JWTs directly in URL parameters (browser history, referer headers, logs).
// Codes are single-use and expire after 30 seconds.
//
// Supports both tiers:
//   web_locked → code maps to a passkey session ID
//   standard   → code maps to a JWT string

const EXCHANGE_CODE_TTL_MS = 30_000;

interface ExchangeCodeData {
  tier: 'web_locked' | 'private_locked' | 'standard';
  /** Passkey session ID (web_locked) */
  sessionId?: string;
  /** JWT token string (standard) */
  jwt?: string;
  expiresAt: number;
}

const exchangeCodes = new Map<string, ExchangeCodeData>();

// Cleanup expired codes every 30s
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of exchangeCodes) {
    if (data.expiresAt < now) exchangeCodes.delete(code);
  }
}, 30_000);

/**
 * Create a one-time exchange code for a passkey session ID (web_locked tier).
 * The code can be safely placed in URL parameters.
 */
export function createSessionExchangeCode(sessionId: string): string {
  const code = crypto.randomBytes(32).toString('hex');
  exchangeCodes.set(code, {
    tier: 'web_locked',
    sessionId,
    expiresAt: Date.now() + EXCHANGE_CODE_TTL_MS,
  });
  return code;
}

/**
 * Create a one-time exchange code for a JWT (standard tier).
 * Used to pass standard-tier auth into cross-origin iframes where
 * SameSite=Lax cookies are not sent.
 */
export function createJwtExchangeCode(jwt: string): string {
  const code = crypto.randomBytes(32).toString('hex');
  exchangeCodes.set(code, {
    tier: 'standard',
    jwt,
    expiresAt: Date.now() + EXCHANGE_CODE_TTL_MS,
  });
  return code;
}

/**
 * Consume a one-time exchange code, returning the full auth data.
 * Returns null if the code is invalid, expired, or already used.
 */
export function consumeExchangeCode(code: string): ExchangeCodeData | null {
  const data = exchangeCodes.get(code);
  if (!data) return null;

  // Always delete immediately (single-use)
  exchangeCodes.delete(code);

  if (data.expiresAt < Date.now()) return null;
  return data;
}

