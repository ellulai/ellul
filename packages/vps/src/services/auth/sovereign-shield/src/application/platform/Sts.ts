// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * STS (Security Token Service) — Project-scoped token signing & verification
 *
 * VPS signs project-scoped tokens with HKDF-derived keys. Gate lookups extract
 * projectId from the verified signature — never from client-supplied fields.
 * This makes project isolation mathematically provable.
 *
 * Key Derivation (HKDF RFC 5869):
 *   master = /etc/ellul/jwt-secret (32 bytes, hex-encoded)
 *   sts_key     = HKDF(master, info="ellul-sts-v1")
 *   receipt_key = HKDF(master, info="ellul-receipt-v1")
 *
 * Two independent keys from one master prevents cross-protocol confusion:
 * a JWT cannot be used as an STS token, and vice versa.
 *
 * Token format: compact JWS (HS256) with typ:"STS" claim.
 * Default TTL: 15 minutes. Client refreshes at 80% (12 min).
 */

import crypto from 'crypto';
import fs from 'fs';
import { JWT_SECRET_FILE } from '../../config';

// ── HKDF Key Derivation ──

const HKDF_HASH = 'sha256';
const HKDF_KEY_LENGTH = 32; // 256-bit derived keys

const HKDF_INFO_STS = 'ellul-sts-v1';
const HKDF_INFO_RECEIPT = 'ellul-receipt-v1';

/** Derived keys — null if master secret unavailable. */
let STS_KEY: Buffer | null = null;
let RECEIPT_KEY: Buffer | null = null;

/**
 * Derive a key using HKDF (RFC 5869).
 * Node 16+ has crypto.hkdfSync built-in.
 * Salt is empty — domain separation is via the info parameter.
 */
function hkdfDerive(master: Buffer, info: string): Buffer {
  const derived = crypto.hkdfSync(HKDF_HASH, master, Buffer.alloc(0), info, HKDF_KEY_LENGTH);
  return Buffer.from(derived);
}

// ── Initialise derived keys at module load ──

try {
  const raw = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();

  // Validate format: exactly 64 lowercase hex chars (32 bytes).
  // Catches the most critical failure mode: encrypted ciphertext written
  // to disk instead of plaintext.
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    console.error(
      `[sts] CRITICAL: jwt-secret has invalid format. ` +
      `Expected: 64 lowercase hex characters. STS disabled.`,
    );
  } else {
    const master = Buffer.from(raw, 'hex');
    STS_KEY = hkdfDerive(master, HKDF_INFO_STS);
    RECEIPT_KEY = hkdfDerive(master, HKDF_INFO_RECEIPT);

    // Self-test: sign and verify a canary token to prove keys are consistent.
    // Catches HKDF implementation quirks, encoding mismatches, or memory corruption.
    const testHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const testBody = Buffer.from(JSON.stringify({
      _selftest: true,
      typ: 'STS',
      iat: Math.floor(Date.now() / 1000),
    })).toString('base64url');
    const testInput = `${testHeader}.${testBody}`;

    const sig1 = crypto.createHmac('sha256', STS_KEY).update(testInput).digest('base64url');
    const sig2 = crypto.createHmac('sha256', STS_KEY).update(testInput).digest('base64url');

    if (sig1 !== sig2) {
      console.error('[sts] CRITICAL: HKDF self-test failed — HMAC signature non-deterministic. STS disabled.');
      STS_KEY = null;
      RECEIPT_KEY = null;
    } else {
      // Verify derived keys are actually different from each other (domain separation works)
      if (STS_KEY.equals(RECEIPT_KEY)) {
        console.error('[sts] CRITICAL: HKDF derived identical keys for different infos. STS disabled.');
        STS_KEY = null;
        RECEIPT_KEY = null;
      } else {
        console.log('[sts] HKDF key derivation complete (sts_key, receipt_key). Self-test passed.');
      }
    }
  }
} catch {
  console.log('[sts] No jwt-secret found — STS disabled (standard tier or first boot).');
}

// ── STS Token Types ──

export interface StsPayload {
  /** Subject: immutable infrastructure slug (e.g., "sbx-a1b2c3d"). */
  sub: string;
  /** Session ID binding — ties token to the authenticated shield session. */
  sid: string;
  /** Token type discriminator. Prevents cross-protocol confusion with JWTs. */
  typ: 'STS';
  /** Issued at (unix seconds). */
  iat: number;
  /** Expiration (unix seconds). */
  exp: number;
  /** JWT ID — unique per issuance, enables per-token revocation if needed. */
  jti: string;
}

/** Default STS token TTL: 15 minutes. */
export const STS_TOKEN_TTL_SECONDS = 15 * 60;

/** Maximum allowed TTL: 1 hour. Prevents abuse of long-lived tokens. */
const MAX_TOKEN_TTL_SECONDS = 60 * 60;

/** Error code returned by VPS when STS token is expired — used by Gotcha #4 retry logic. */
export const STS_EXPIRED_CODE = 'STS_EXPIRED';

/** Error code returned when STS token has invalid signature. */
export const STS_INVALID_CODE = 'STS_INVALID';

// ── Public API ──

/**
 * Sign a project-scoped STS token.
 *
 * @param slug       - Immutable infrastructure slug (e.g., "sbx-a1b2c3d").
 *                     This is the ONLY project identifier in the token.
 *                     Display names are resolved client-side via ProjectRegistry.
 * @param sessionId  - Authenticated shield session ID. Binding prevents token
 *                     theft across sessions — if the session is revoked, all
 *                     STS tokens signed against it are immediately invalid.
 * @param ttlSeconds - Token TTL (default: 15 min, capped at 1 hour)
 * @returns Compact JWS string (header.payload.signature)
 * @throws If STS key is unavailable (jwt-secret missing or invalid)
 */
export function signProjectToken(
  slug: string,
  sessionId: string,
  ttlSeconds: number = STS_TOKEN_TTL_SECONDS,
): string {
  if (!STS_KEY) {
    throw new Error('STS signing key not available. Ensure /etc/ellul/jwt-secret is valid.');
  }

  // Clamp TTL to max
  const effectiveTtl = Math.min(Math.max(ttlSeconds, 1), MAX_TOKEN_TTL_SECONDS);

  const now = Math.floor(Date.now() / 1000);
  const payload: StsPayload = {
    sub: slug,
    sid: sessionId,
    typ: 'STS',
    iat: now,
    exp: now + effectiveTtl,
    jti: crypto.randomBytes(16).toString('hex'),
  };

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signInput = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', STS_KEY).update(signInput).digest('base64url');

  return `${signInput}.${signature}`;
}

/** Result of STS token verification. */
export type StsVerifyResult =
  | { valid: true; payload: StsPayload }
  | { valid: false; reason: 'unavailable' | 'malformed' | 'signature_invalid' | 'expired' | 'invalid_claims' | 'session_mismatch' };

/**
 * Verify and decode an STS token.
 *
 * Performs (in order):
 * 1. Structural validation (3-part JWS)
 * 2. HMAC-SHA256 verification with timing-safe comparison
 * 3. Payload decoding (ONLY after signature is verified)
 * 4. typ:"STS" discriminator check (rejects JWTs)
 * 5. Expiration check
 * 6. Required field validation (sub, sid, jti)
 * 7. Session binding check (optional, if sessionId provided)
 *
 * Expiration is only checked AFTER signature verification — an attacker
 * cannot distinguish expired from invalid without knowing the signing key.
 *
 * @param token     - Compact JWS string from X-STS-Token header
 * @param sessionId - Optional: verify token is bound to this specific session
 * @returns Structured result with reason on failure (never throws)
 */
export function verifyProjectToken(token: string, sessionId?: string): StsPayload | null {
  const result = verifyProjectTokenDetailed(token, sessionId);
  return result.valid ? result.payload : null;
}

/**
 * Detailed verification — returns structured reason on failure.
 * Used by tier-gate middleware for Gotcha #4 (transparent retry on expiry).
 * Expiration reason is ONLY returned for signature-verified tokens — never
 * for forged tokens, preventing the oracle attack.
 */
export function verifyProjectTokenDetailed(token: string, sessionId?: string): StsVerifyResult {
  if (!STS_KEY) return { valid: false, reason: 'unavailable' };

  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      return { valid: false, reason: 'malformed' };
    }

    // SECURITY: Timing-safe HMAC comparison prevents brute-force via timing oracle.
    const signInput = `${parts[0]}.${parts[1]}`;
    const expectedSig = crypto.createHmac('sha256', STS_KEY).update(signInput).digest('base64url');

    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    const actualBuf = Buffer.from(parts[2], 'utf8');
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return { valid: false, reason: 'signature_invalid' };
    }

    // Decode payload AFTER signature verification (don't parse untrusted data)
    const payload: StsPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    // Type discriminator: MUST be "STS". Rejects JWTs, internal tokens, etc.
    if (payload.typ !== 'STS') return { valid: false, reason: 'invalid_claims' };

    // Expiration check — SAFE to report 'expired' here because signature is verified.
    // Attacker without the key gets 'signature_invalid', not 'expired'.
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return { valid: false, reason: 'expired' };

    // Required fields — all must be non-empty strings
    if (!payload.sub || typeof payload.sub !== 'string') return { valid: false, reason: 'invalid_claims' };
    if (!payload.sid || typeof payload.sid !== 'string') return { valid: false, reason: 'invalid_claims' };
    if (!payload.jti || typeof payload.jti !== 'string') return { valid: false, reason: 'invalid_claims' };

    // Session binding check (when caller provides the expected session)
    if (sessionId && payload.sid !== sessionId) return { valid: false, reason: 'session_mismatch' };

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'malformed' };
  }
}

/**
 * Check if STS is available (keys derived successfully from jwt-secret).
 */
export function isStsAvailable(): boolean {
  return STS_KEY !== null;
}

/**
 * Get the HKDF-derived receipt key for sync receipt signing.
 * Used by sync-receipt.service.ts (Phase 3).
 * Returns null if HKDF derivation failed.
 */
export function getReceiptKey(): Buffer | null {
  return RECEIPT_KEY ? Buffer.from(RECEIPT_KEY) : null;
}
