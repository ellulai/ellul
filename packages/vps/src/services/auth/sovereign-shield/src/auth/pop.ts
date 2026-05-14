// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Proof of Possession (PoP) Authentication — Post-Quantum
 *
 * Authenticates web sessions using HMAC-SHA256 over a session-bound shared
 * secret. The shared secret is established via ML-KEM-1024 key encapsulation
 * during the bind phase (session.routes.ts /_auth/pop/bind/init + /complete).
 *
 * Each request is authenticated by HMAC-SHA256(K_pop, payload) where K_pop
 * is derived from the ML-KEM shared secret. No ECDSA, no public-key signatures.
 */

import crypto from 'crypto';
import type { Context } from 'hono';

import { db } from '../database';
import { POP_TIMESTAMP_TOLERANCE_MS, SERVER_STARTUP_TIME } from '../config';
import { logAuditEvent } from '../application/audit/Audit';
import { dbg } from '../application/audit/DebugLog';
import { getDeterministicBodyHash } from './body-hash';

// Client-side JS bundles — compiled from TypeScript at build time.
// Source: src/auth/client/*.ts → prebuild → static/*.js
// Manifest: pop-client-manifest.ts (SRI hashes, ETags, sizes)
import SESSION_POP_SW_JS from '../static/pop-sw.js';
import SESSION_POP_JS from '../static/session-pop.js';
import TERMINAL_INIT_JS from '../static/terminal-init.js';
import TERMINAL_WRAPPER_HTML from '../static/terminal-wrapper.html';
import SESSION_POP_SW_MAP from '../static/pop-sw.js.map';
import SESSION_POP_MAP from '../static/session-pop.js.map';
import TERMINAL_INIT_MAP from '../static/terminal-init.js.map';

export {
  SESSION_POP_SW_JS,
  SESSION_POP_JS,
  TERMINAL_INIT_JS,
  TERMINAL_WRAPPER_HTML,
  SESSION_POP_SW_MAP,
  SESSION_POP_MAP,
  TERMINAL_INIT_MAP,
};

export interface PopVerificationResult {
  valid: boolean;
  reason?: string;
}

export interface Session {
  id: string;
  pop_hmac_key?: string | null;
  pop_sw_active?: number | null;
  pop_prf_bound?: number | null;
}

// Prepared statements for nonce operations
let checkNonceStmt: ReturnType<typeof db.prepare> | null = null;
let insertNonceStmt: ReturnType<typeof db.prepare> | null = null;
let cleanupNoncesStmt: ReturnType<typeof db.prepare> | null = null;

function initStatements() {
  if (!checkNonceStmt) {
    checkNonceStmt = db.prepare('SELECT 1 FROM pop_nonces WHERE nonce_key = ?');
    insertNonceStmt = db.prepare('INSERT OR IGNORE INTO pop_nonces (nonce_key, expires_at) VALUES (?, ?)');
    cleanupNoncesStmt = db.prepare('DELETE FROM pop_nonces WHERE expires_at < ?');
  }
}

/**
 * Verify PoP HMAC signature.
 *
 * Uses HMAC-SHA256 with the session's K_pop derived from ML-KEM key exchange.
 * Constant-time comparison via crypto.timingSafeEqual.
 */
export async function verifyPopSignature(
  hmacKeyBase64: string,
  payload: string,
  signatureBase64: string
): Promise<boolean> {
  try {
    const hmacKey = Buffer.from(hmacKeyBase64, 'base64');
    const expectedMac = crypto.createHmac('sha256', hmacKey)
      .update(payload)
      .digest();
    const clientMac = Buffer.from(signatureBase64, 'base64');

    if (expectedMac.length !== clientMac.length) return false;
    return crypto.timingSafeEqual(expectedMac, clientMac);
  } catch (e) {
    console.error('[shield] PoP HMAC verification error:', (e as Error).message);
    return false;
  }
}

/**
 * Verify PoP headers on a request
 * Returns valid: true if no PoP required or PoP verification passes
 */
export async function verifyRequestPoP(
  c: Context,
  session: Session
): Promise<PopVerificationResult> {
  const sidShort = session.id.slice(0, 8);
  // Short-circuit if tier-gate middleware already verified PoP for this request.
  if (c.get('popVerified')) {
    return { valid: true, reason: 'already_verified' };
  }

  // Use HMAC key (PQC) — no legacy fallback. Sessions without pop_hmac_key skip PoP.
  const popKey = session.pop_hmac_key;
  if (!popKey) {
    dbg('pop', 'no_pop_required', { sidShort });
    return { valid: true, reason: 'no_pop_required' };
  }

  initStatements();

  const timestamp = c.req.header('x-pop-timestamp');
  const nonce = c.req.header('x-pop-nonce');
  const signature = c.req.header('x-pop-signature');

  if (!timestamp || !nonce || !signature) {
    dbg('pop', 'reject_missing_headers', {
      sidShort,
      hasTimestamp: !!timestamp,
      hasNonce: !!nonce,
      hasSignature: !!signature,
    });
    return { valid: false, reason: 'missing_pop_headers' };
  }

  const now = Date.now();
  const reqTime = parseInt(timestamp, 10);
  if (Math.abs(now - reqTime) > POP_TIMESTAMP_TOLERANCE_MS) {
    dbg('pop', 'reject_timestamp_expired', {
      sidShort, now, reqTime, deltaMs: now - reqTime, toleranceMs: POP_TIMESTAMP_TOLERANCE_MS,
    });
    return { valid: false, reason: 'pop_timestamp_expired' };
  }

  // SECURITY: Startup grace period
  if (reqTime < SERVER_STARTUP_TIME) {
    console.log('[shield] PoP rejected - timestamp predates server startup');
    dbg('pop', 'reject_timestamp_before_startup', { sidShort, reqTime, startup: SERVER_STARTUP_TIME });
    return { valid: false, reason: 'timestamp_before_startup' };
  }

  // SECURITY: Atomically claim nonce BEFORE verification
  const nonceKey = session.id + ':' + nonce;
  try {
    const result = insertNonceStmt!.run(nonceKey, now + (POP_TIMESTAMP_TOLERANCE_MS * 2));
    if (result.changes === 0) {
      console.log('[shield] PoP nonce replay detected for session:', session.id.substring(0, 8));
      dbg('pop', 'reject_nonce_reused', { sidShort, nonceShort: nonce.slice(0, 8) });
      return { valid: false, reason: 'nonce_reused' };
    }
  } catch (e) {
    console.error('[shield] Nonce claim error:', (e as Error).message);
    dbg('pop', 'reject_nonce_check_failed', { sidShort, error: (e as Error).message });
    return { valid: false, reason: 'nonce_check_failed' };
  }

  const method = c.req.method;
  const path = new URL(c.req.url).pathname;

  let rawBody: string | null = null;
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      rawBody = await c.req.text();
    } catch {
      rawBody = null;
    }
  }
  const bodyHash = getDeterministicBodyHash(rawBody);

  const payload = timestamp + '|' + method + '|' + path + '|' + bodyHash + '|' + nonce;

  // Verify using HMAC-SHA256 (PQC session MAC)
  const valid = await verifyPopSignature(popKey, payload, signature);
  if (!valid) {
    dbg('pop', 'reject_signature_invalid', {
      sidShort, method, path, bodyHashShort: bodyHash.slice(0, 12), bodyLen: rawBody?.length ?? 0,
    });
    return { valid: false, reason: 'pop_signature_invalid' };
  }

  dbg('pop', 'verified', { sidShort, method, path });
  return { valid: true };
}

/**
 * Verify PoP in the forward_auth context.
 *
 * Caddy's forward_auth sub-request is always GET /api/auth/session with no
 * body, so `verifyRequestPoP` — which reads `c.req.url`, `c.req.method`, and
 * `c.req.text()` — would recompute the payload over the wrong values. Here
 * we reconstruct the ORIGINAL client payload from forwarded headers:
 *
 *   X-Forwarded-Uri     → original path (we use pathname only)
 *   X-Forwarded-Method  → original HTTP method
 *   X-PoP-BodyHash      → body hash computed client-side by the SW
 *
 * Security: all four payload components (method, path, bodyHash, nonce) are
 * covered by the HMAC signature, so a forged value in any header makes the
 * signature invalid. `X-PoP-BodyHash` cannot be swapped independently — the
 * signature binds it.
 *
 * Replay protection is identical to `verifyRequestPoP`: the (sessionId, nonce)
 * pair is claimed atomically in `pop_nonces` before signature verification.
 *
 * Caveat: shield cannot re-hash the original body here (Caddy's forward_auth
 * doesn't forward it). A downstream service can optionally re-hash the body
 * and compare to X-PoP-BodyHash for end-to-end body-replay protection.
 */
export async function verifyForwardAuthPoP(
  c: Context,
  session: Session,
): Promise<PopVerificationResult> {
  const sidShort = session.id.slice(0, 8);
  const popKey = session.pop_hmac_key;
  if (!popKey) {
    dbg('pop_fa', 'no_pop_required', { sidShort });
    return { valid: true, reason: 'no_pop_required' };
  }

  initStatements();

  const timestamp = c.req.header('x-pop-timestamp');
  const nonce = c.req.header('x-pop-nonce');
  const signature = c.req.header('x-pop-signature');
  const bodyHash = c.req.header('x-pop-bodyhash');
  const forwardedMethod = c.req.header('x-forwarded-method');
  const forwardedUri = c.req.header('x-forwarded-uri');

  if (!timestamp || !nonce || !signature || !bodyHash) {
    dbg('pop_fa', 'reject_missing_headers', {
      sidShort,
      hasTimestamp: !!timestamp, hasNonce: !!nonce, hasSignature: !!signature, hasBodyHash: !!bodyHash,
    });
    return { valid: false, reason: 'missing_pop_headers' };
  }
  if (!forwardedMethod || !forwardedUri) {
    dbg('pop_fa', 'reject_missing_forward_headers', {
      sidShort, hasMethod: !!forwardedMethod, hasUri: !!forwardedUri,
    });
    return { valid: false, reason: 'missing_forward_headers' };
  }

  const now = Date.now();
  const reqTime = parseInt(timestamp, 10);
  if (Math.abs(now - reqTime) > POP_TIMESTAMP_TOLERANCE_MS) {
    dbg('pop_fa', 'reject_timestamp_expired', {
      sidShort, deltaMs: now - reqTime, toleranceMs: POP_TIMESTAMP_TOLERANCE_MS,
    });
    return { valid: false, reason: 'pop_timestamp_expired' };
  }
  if (reqTime < SERVER_STARTUP_TIME) {
    dbg('pop_fa', 'reject_timestamp_before_startup', { sidShort });
    return { valid: false, reason: 'timestamp_before_startup' };
  }

  const nonceKey = session.id + ':' + nonce;
  try {
    const result = insertNonceStmt!.run(nonceKey, now + POP_TIMESTAMP_TOLERANCE_MS * 2);
    if (result.changes === 0) {
      dbg('pop_fa', 'reject_nonce_reused', { sidShort, nonceShort: nonce.slice(0, 8) });
      return { valid: false, reason: 'nonce_reused' };
    }
  } catch (e) {
    console.error('[shield] forward_auth nonce claim error:', (e as Error).message);
    dbg('pop_fa', 'reject_nonce_check_failed', { sidShort, error: (e as Error).message });
    return { valid: false, reason: 'nonce_check_failed' };
  }

  // Pathname only — query string is stripped from the signed payload by
  // pop-sw.ts (`url.pathname`). Keep the two sides identical.
  const path = forwardedUri.split('?')[0] || '/';
  const method = forwardedMethod.toUpperCase();
  const payload = timestamp + '|' + method + '|' + path + '|' + bodyHash + '|' + nonce;

  const valid = await verifyPopSignature(popKey, payload, signature);
  if (!valid) {
    dbg('pop_fa', 'reject_signature_invalid', {
      sidShort, method, path, bodyHashShort: bodyHash.slice(0, 12),
    });
    return { valid: false, reason: 'pop_signature_invalid' };
  }
  dbg('pop_fa', 'verified', { sidShort, method, path });
  return { valid: true };
}

/**
 * Bind PoP HMAC key to a session
 */
export function bindPopKey(sessionId: string, hmacKey: string, ip: string): void {
  const now = Date.now();
  db.prepare('UPDATE sessions SET pop_hmac_key = ?, pop_prf_bound = 1, pop_bound_at = ? WHERE id = ?')
    .run(hmacKey, now, sessionId);

  logAuditEvent({
    type: 'pop_key_bound',
    ip,
    sessionId,
    details: { message: 'ML-KEM derived HMAC key bound' }
  });
}

/**
 * Cleanup expired nonces periodically
 */
export function cleanupExpiredNonces(): void {
  initStatements();
  try {
    cleanupNoncesStmt!.run(Date.now());
  } catch (e) {
    console.error('[shield] Nonce cleanup error:', (e as Error).message);
  }
}

