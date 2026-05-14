// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Confirm Routes
 *
 * Operation confirmation with tier-driven enforcement.
 * The VPS is the sole authority — even if the platform is compromised,
 * the VPS refuses to issue confirmation tokens unless the tier's full
 * security requirements are met.
 *
 * Tier enforcement:
 * - Standard:   Session sufficient
 * - Web Locked: Session + PoP required (same as token routes)
 *
 * Endpoints:
 * - POST /_auth/confirm-operation   - Confirm a destructive operation (tier-enforced)
 * - POST /_auth/verify-confirmation - Verify a confirmation token (called by platform)
 */

import type { Hono } from 'hono';
import crypto from 'crypto';
import fs from 'fs';
import { SERVER_ID_FILE } from '../config';
import { getDeviceFingerprint, getClientIp } from '../auth/fingerprint';
import { VALID_OPERATIONS, isPasskeyOperation } from '../../../../../auth/valid-operations';
import type { Session } from '../auth/session';
import { logAuditEvent } from '../application/audit/Audit';
import { signPayload, verifyAuthSignature } from '../auth/secrets';
import { parseCookies } from '../utils/cookie';
import { db } from '../database';
import { getCurrentTier } from '../application/gates/Tier';


// SECURITY: Confirmation nonce graveyard — ensures every confirmation token is strictly single-use.
// Nonces are persisted in SQLite so they survive service restarts.
// TTL matches token expiry (60 seconds).
let checkConfirmNonceStmt: ReturnType<typeof db.prepare> | null = null;
let insertConfirmNonceStmt: ReturnType<typeof db.prepare> | null = null;
let cleanupConfirmNoncesStmt: ReturnType<typeof db.prepare> | null = null;

function initConfirmNonceStatements() {
  if (!checkConfirmNonceStmt) {
    checkConfirmNonceStmt = db.prepare('SELECT 1 FROM confirmation_nonces WHERE nonce = ?');
    insertConfirmNonceStmt = db.prepare('INSERT OR IGNORE INTO confirmation_nonces (nonce, expires_at) VALUES (?, ?)');
    cleanupConfirmNoncesStmt = db.prepare('DELETE FROM confirmation_nonces WHERE expires_at < ?');
  }
}

// Cleanup expired nonces every 60 seconds
setInterval(() => {
  try {
    initConfirmNonceStatements();
    cleanupConfirmNoncesStmt!.run(Date.now());
  } catch (e) {
    console.error('[shield] Confirmation nonce cleanup error:', (e as Error).message);
  }
}, 60000);

/**
 * Register confirm routes on Hono app
 */
export function registerConfirmRoutes(app: Hono): void {

  /**
   * Confirm a destructive operation with passkey
   * Used by dashboard for Web Locked tier to authorize delete/rebuild
   */
  app.post('/_auth/confirm-operation', async (c) => {
    // Session + PoP (web_locked) or JWT (standard) already verified by tier-gate middleware
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);

    // Fetch session for credential_id (needed in token payload)
    const sessionRecord = sessionId
      ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | undefined
      : undefined;

    // Parse the operation from request body
    const body = await c.req.json() as { operation?: string };
    const operation = body.operation;

    // VALID_OPERATIONS imported from the shared source of truth.
    // Any new passkey-gated op MUST be added there — see
    // packages/vps/src/auth/valid-operations.ts.
    if (!operation || !isPasskeyOperation(operation)) {
      return c.json({
        error: 'Invalid operation',
        validOperations: VALID_OPERATIONS,
      }, 400);
    }

    // Get server ID
    let serverId = 'unknown';
    try {
      serverId = fs.readFileSync(SERVER_ID_FILE, 'utf8').trim();
    } catch {}

    const tier = getCurrentTier();

    // HARDWARE NON-REPUDIATION (P2 security enhancement)
    // Capture the raw PoP HMAC headers for the audit log. For destructive actions,
    // this creates a cryptographic proof that only the holder of the session's ML-KEM
    // derived HMAC key could have authorized this specific request. A third-party auditor
    // can verify: HMAC-SHA256(session.pop_hmac_key, payload) === popSignature.
    const popSignatureRaw = c.req.header('x-pop-signature') || null;
    const popTimestampRaw = c.req.header('x-pop-timestamp') || null;
    const popNonceRaw = c.req.header('x-pop-nonce') || null;

    // NOTE: Body hash is omitted because the confirm-operation body ({ operation })
    // differs from the execution body sent to the platform API. The operation name
    // in the signed token is sufficient to prevent bait-and-switch attacks.

    // Generate a signed confirmation token
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = {
      operation,
      serverId,
      timestamp,
      nonce,
      credentialId: sessionRecord?.credential_id,
      ip,
      tier,
    };

    // Sign the payload with versioned auth secret (P1 security enhancement)
    const { signature, keyVersion } = signPayload(payload);

    // Base64 encode the confirmation (includes key version for rotation support)
    const confirmation = Buffer.from(JSON.stringify({
      payload,
      signature,
      keyVersion, // Include version so verify can use correct secret
    })).toString('base64url');

    // Log the confirmation with hardware non-repudiation data
    logAuditEvent({
      type: 'operation_confirmed',
      ip,
      fingerprint: fingerprintData.hash,
      credentialId: sessionRecord?.credential_id,
      sessionId: sessionRecord?.id,
      details: {
        operation,
        serverId,
        timestamp,
        tier,
        nonce,
        // Hardware non-repudiation: raw PoP HMAC proving device possession.
        // A third-party auditor can reconstruct the signed payload from the fields above
        // and verify against the session's pop_hmac_key to prove hardware provenance.
        popSignature: popSignatureRaw,
        popTimestamp: popTimestampRaw,
        popNonce: popNonceRaw,
      },
    });

    return c.json({
      confirmed: true,
      operation,
      confirmation,
      expiresAt: timestamp + 60000, // 60 second expiry
    });
  });

  /**
   * Verify a confirmation token (called by platform)
   * This is for the platform to verify the confirmation came from this VPS
   * SECURITY: Now includes IP binding verification to prevent token interception attacks
   */
  app.post('/_auth/verify-confirmation', async (c) => {
    const body = await c.req.json() as {
      confirmation?: string;
      operation?: string;
      expectedServerId?: string;
      verifierIp?: string;
    };
    const { confirmation, operation, expectedServerId, verifierIp } = body;

    if (!confirmation || !operation) {
      return c.json({ error: 'Missing confirmation or operation' }, 400);
    }

    // SECURITY MODEL: This endpoint is called by the platform API over HTTPS
    // (Platform → edge proxy → Caddy → localhost:3005). All traffic reaches sovereign-shield
    // through Caddy's reverse_proxy, so socket.remoteAddress is always 127.0.0.1 —
    // a localhost check cannot distinguish platform from external callers.
    //
    // Defense-in-depth is provided by the token validation below:
    //   1. HMAC signature — requires VPS auth secret (unforgeable without compromising VPS)
    //   2. Single-use nonce graveyard — SQLite-persisted, survives restarts
    //   3. 60-second TTL — narrow window
    //   4. Operation + serverId matching — prevents cross-operation/cross-server replay
    //   5. IP binding — token records user's IP at confirmation time
    //
    // An attacker without a valid token gets { error: 'Invalid signature' } — no data
    // leak, no side effects. Obtaining a valid token requires breaking TLS.
    const callerIp = getClientIp(c);

    try {
      // Decode the confirmation
      const decoded = JSON.parse(Buffer.from(confirmation, 'base64url').toString()) as {
        payload: {
          operation: string;
          serverId: string;
          timestamp: number;
          nonce?: string;
          ip?: string;
          bodyHash?: string;
        };
        signature: string;
        keyVersion?: number;
      };
      const { payload, signature, keyVersion } = decoded;

      // Verify signature using versioned secrets (P1 security enhancement)
      // This supports secret rotation with grace period
      const verifyResult = verifyAuthSignature(payload, signature, keyVersion);

      if (!verifyResult.valid) {
        logAuditEvent({
          type: 'confirmation_signature_invalid',
          ip: verifierIp || callerIp,
          details: {
            reason: verifyResult.reason,
            keyVersion,
            operation
          }
        });
        return c.json({ error: 'Invalid signature', reason: verifyResult.reason }, 401);
      }

      // Check operation matches
      if (payload.operation !== operation) {
        return c.json({ error: 'Operation mismatch' }, 400);
      }

      // Check server ID if provided
      if (expectedServerId && payload.serverId !== expectedServerId) {
        return c.json({ error: 'Server ID mismatch' }, 400);
      }

      // Check expiry (60 seconds)
      if (Date.now() - payload.timestamp > 60000) {
        return c.json({ error: 'Confirmation expired' }, 410);
      }

      // NONCE GRAVEYARD (P0 security enhancement — SQLite-persisted)
      // Every confirmation token is strictly single-use. The nonce embedded in the
      // signed payload is checked against the graveyard — if it has been seen before,
      // the token is rejected even if it is otherwise valid and unexpired.
      // Persisted in SQLite so nonces survive service restarts within the 5-minute TTL.
      const tokenNonce = (payload as { nonce?: string }).nonce;
      if (tokenNonce) {
        initConfirmNonceStatements();
        const existing = checkConfirmNonceStmt!.get(tokenNonce);
        if (existing) {
          logAuditEvent({
            type: 'confirmation_replay_blocked',
            ip: verifierIp || callerIp,
            details: {
              operation: payload.operation,
              serverId: payload.serverId,
              nonce: tokenNonce,
            }
          });
          return c.json({ error: 'Confirmation already used', reason: 'nonce_reused' }, 409);
        }
        // Bury the nonce — TTL matches the 60-second token window
        try {
          insertConfirmNonceStmt!.run(tokenNonce, payload.timestamp + 60000);
        } catch (e) {
          console.error('[shield] Confirmation nonce insert error:', (e as Error).message);
        }
      }

      // IP BINDING VERIFICATION
      // Skipped in proxied mode — edge IPs rotate between requests.
      // See utils/ip-binding.ts for full rationale.
      const { shouldRejectIpMismatch } = await import('../utils/ip-binding');

      if (shouldRejectIpMismatch(payload.ip, verifierIp, c.req.raw.headers)) {
        logAuditEvent({
          type: 'confirmation_ip_mismatch',
          ip: verifierIp,
          details: {
            expectedIp: payload.ip,
            actualIp: verifierIp,
            operation: payload.operation,
            serverId: payload.serverId
          }
        });
        return c.json({
          error: 'IP address mismatch',
          details: 'Confirmation must be verified from the same IP where it was created'
        }, 403);
      }

      // Log successful verification
      logAuditEvent({
        type: 'confirmation_verified',
        ip: verifierIp || callerIp,
        details: {
          operation: payload.operation,
          serverId: payload.serverId,
          ipVerified: !!verifierIp
        }
      });

      return c.json({
        valid: true,
        verified: true,
        operation: payload.operation,
        serverId: payload.serverId,
        timestamp: payload.timestamp,
        ipVerified: !!verifierIp,
        bodyHash: payload.bodyHash ?? null,
      });
    } catch (e) {
      return c.json({ error: 'Invalid confirmation format', details: (e as Error).message }, 400);
    }
  });
}
