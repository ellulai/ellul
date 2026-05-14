// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Device Routes — CLI Device Trust
 *
 * Trusted CLI devices registered during passkey ceremony can re-authenticate
 * via PoP challenge-response without opening a browser.
 *
 * Endpoints:
 * - POST /_auth/device/challenge     - Request a challenge (AUTH_FLOW)
 * - POST /_auth/device/authenticate  - Complete challenge-response (AUTH_FLOW)
 * - POST /_auth/device/register      - Register PoP key as trusted device (SESSION)
 * - GET  /_auth/device/list          - List registered devices (SESSION)
 * - DELETE /_auth/device/:deviceId   - Revoke a device (SESSION, step-up)
 */

import crypto from 'crypto';
import type { Hono } from 'hono';
import { db } from '../database';
import {
  SVC_USER,
  DEVICE_TRUST_TTL_MS,
  DEVICE_CHALLENGE_TTL_MS,
  DEVICE_MAX_PER_CREDENTIAL,
  DEVICE_AUTH_TIMESTAMP_TOLERANCE_MS,
} from '../config';
import { getCurrentTier } from '../application/gates/Tier';
import { getClientIp } from '../auth/fingerprint';
import { verifyPopSignature } from '../auth/pop';
import { createSession } from '../auth/session';
import { checkRateLimit, recordAuthAttempt } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';

// ── In-Memory Challenge Store ──
// Same pattern as exchange codes in session.ts.
// Single-process per VPS — Map is correct and fast.
// If HA/multi-process needed: migrate to cli_challenges SQLite table.

interface DeviceChallengeData {
  deviceId: string;
  popHmacKey: string;
  credentialId: string;
  ip: string;
  expiresAt: number;
}

const deviceChallenges = new Map<string, DeviceChallengeData>();

// Cleanup expired challenges every 30s
setInterval(() => {
  const now = Date.now();
  for (const [challenge, data] of deviceChallenges) {
    if (data.expiresAt < now) deviceChallenges.delete(challenge);
  }
}, 30_000);

// ── DB Helpers ──

interface CliDevice {
  id: string;
  credential_id: string;
  pop_hmac_key: string;
  device_name: string;
  registered_at: number;
  last_used_at: number;
  expires_at: number;
  revoked_at: number | null;
  ip_registered: string;
  ip_last_used: string | null;
}

/**
 * Register device routes on Hono app
 */
export function registerDeviceRoutes(app: Hono): void {

  // ────────────────────────────────────────────────────────────────────────
  // A. POST /_auth/device/challenge — Request challenge for device auth
  //    Auth: AUTH_FLOW (no session required — this IS the auth mechanism)
  // ────────────────────────────────────────────────────────────────────────

  app.post('/_auth/device/challenge', async (c) => {
    const ip = getClientIp(c);

    // Strict auth rate limiter (5 failures/15 min, 60 min lockout)
    const rateLimit = checkRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    const body = await c.req.json() as { popHmacKeyId?: string };
    if (!body.popHmacKeyId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    // Look up active, non-expired device by HMAC key identifier
    const now = Date.now();
    const device = db.prepare(
      'SELECT * FROM cli_devices WHERE pop_hmac_key = ? AND revoked_at IS NULL AND expires_at > ?'
    ).get(body.popHmacKeyId, now) as CliDevice | undefined;

    // Opaque 401 — no enumeration (same error for missing/revoked/expired).
    // Record as failed auth attempt so probing hits the rate limiter.
    if (!device) {
      recordAuthAttempt(ip, false);
      return c.json({ error: 'Authentication required' }, 401);
    }

    // Generate challenge
    const challenge = crypto.randomBytes(32).toString('hex');
    deviceChallenges.set(challenge, {
      deviceId: device.id,
      popHmacKey: device.pop_hmac_key,
      credentialId: device.credential_id,
      ip,
      expiresAt: now + DEVICE_CHALLENGE_TTL_MS,
    });

    logAuditEvent({
      type: 'device_challenge_issued',
      ip,
      details: { deviceId: device.id, deviceName: device.device_name },
    });

    return c.json({ challenge, expiresIn: Math.floor(DEVICE_CHALLENGE_TTL_MS / 1000) });
  });

  // ────────────────────────────────────────────────────────────────────────
  // B. POST /_auth/device/authenticate — Complete device auth
  //    Auth: AUTH_FLOW (no session required)
  // ────────────────────────────────────────────────────────────────────────

  app.post('/_auth/device/authenticate', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    const body = await c.req.json() as {
      challenge?: string;
      popHmacKeyId?: string;
      popTimestamp?: string;
      popSignature?: string;
    };

    if (!body.challenge || !body.popHmacKeyId || !body.popTimestamp || !body.popSignature) {
      recordAuthAttempt(ip, false);
      return c.json({ error: 'Authentication failed' }, 401);
    }

    // Atomically consume challenge (delete BEFORE validation — like exchange codes)
    const challengeData = deviceChallenges.get(body.challenge);
    if (challengeData) {
      deviceChallenges.delete(body.challenge);
    }

    const now = Date.now();

    if (!challengeData || challengeData.expiresAt < now) {
      recordAuthAttempt(ip, false);
      return c.json({ error: 'Authentication failed' }, 401);
    }

    // Verify HMAC key ID matches challenge's stored key
    if (body.popHmacKeyId !== challengeData.popHmacKey) {
      recordAuthAttempt(ip, false);
      logAuditEvent({
        type: 'device_auth_failed',
        ip,
        details: { reason: 'pop_key_mismatch', deviceId: challengeData.deviceId },
      });
      return c.json({ error: 'Authentication failed' }, 401);
    }

    // Verify timestamp freshness (60s tolerance — see config clock skew note)
    const reqTime = parseInt(body.popTimestamp, 10);
    if (isNaN(reqTime) || Math.abs(now - reqTime) > DEVICE_AUTH_TIMESTAMP_TOLERANCE_MS) {
      recordAuthAttempt(ip, false);
      logAuditEvent({
        type: 'device_auth_failed',
        ip,
        details: { reason: 'timestamp_expired', deviceId: challengeData.deviceId },
      });
      return c.json({ error: 'Authentication failed' }, 401);
    }

    // Verify HMAC signature — 'device-auth|' prefix prevents cross-protocol replay
    const payload = 'device-auth|' + body.challenge + '|' + body.popTimestamp;
    const valid = await verifyPopSignature(challengeData.popHmacKey, payload, body.popSignature);

    if (!valid) {
      recordAuthAttempt(ip, false);
      logAuditEvent({
        type: 'device_auth_failed',
        ip,
        details: { reason: 'signature_invalid', deviceId: challengeData.deviceId },
      });
      return c.json({ error: 'Authentication failed' }, 401);
    }

    // Success — record attempt
    recordAuthAttempt(ip, true);

    // Create session (same as browser flow — identical security properties)
    const session = createSession(challengeData.credentialId, ip, null);

    // Bind PoP HMAC key to session atomically + generate operator bind nonce
    const operatorBindNonce = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE sessions SET pop_hmac_key = ?, pop_prf_bound = 1, pop_bound_at = ?, operator_bind_nonce = ? WHERE id = ?')
      .run(challengeData.popHmacKey, now, operatorBindNonce, session.id);

    // Update device: sliding TTL renewal + last-used tracking
    const newExpiresAt = now + DEVICE_TRUST_TTL_MS;
    db.prepare('UPDATE cli_devices SET last_used_at = ?, ip_last_used = ?, expires_at = ? WHERE id = ?')
      .run(now, ip, newExpiresAt, challengeData.deviceId);

    const tier = getCurrentTier();

    logAuditEvent({
      type: 'device_auth_success',
      ip,
      sessionId: session.id,
      credentialId: challengeData.credentialId,
      details: { deviceId: challengeData.deviceId },
    });

    return c.json({
      sessionId: session.id,
      tier,
      svcUser: SVC_USER,
      expiresAt: session.expires_at,
      deviceTrustExpiresAt: newExpiresAt,
      operatorBindNonce,
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // C. POST /_auth/device/register — Register PoP key as trusted device
  //    Auth: SESSION (requires active passkey session + PoP)
  // ────────────────────────────────────────────────────────────────────────

  app.post('/_auth/device/register', async (c) => {
    const ip = getClientIp(c);
    const tierGateAuth = c.get('tierGateAuth');

    if (!tierGateAuth?.sessionId || !tierGateAuth?.credentialId) {
      return c.json({ error: 'Session required' }, 401);
    }

    const body = await c.req.json() as { deviceName?: string };
    // Sanitize: strip control chars, limit length, trim
    const deviceName = (body.deviceName || 'CLI Device')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .substring(0, 64)
      .trim() || 'CLI Device';

    // Get PoP HMAC key from the active session — this IS the device key
    const session = db.prepare('SELECT pop_hmac_key FROM sessions WHERE id = ?')
      .get(tierGateAuth.sessionId) as { pop_hmac_key: string | null } | undefined;

    if (!session?.pop_hmac_key) {
      return c.json({ error: 'PoP HMAC key not bound to session — complete ML-KEM bind first' }, 400);
    }

    const popHmacKey = session.pop_hmac_key;
    const now = Date.now();

    // Check if already registered (idempotent)
    const existing = db.prepare('SELECT * FROM cli_devices WHERE pop_hmac_key = ?')
      .get(popHmacKey) as CliDevice | undefined;

    if (existing) {
      if (existing.revoked_at) {
        // Opaque error — don't confirm device existence to potential attacker
        return c.json({ error: 'Device registration failed' }, 400);
      }
      // Update name and refresh TTL
      const newExpiresAt = now + DEVICE_TRUST_TTL_MS;
      db.prepare('UPDATE cli_devices SET device_name = ?, last_used_at = ?, expires_at = ? WHERE id = ?')
        .run(deviceName, now, newExpiresAt, existing.id);

      return c.json({
        deviceId: existing.id,
        deviceName,
        expiresAt: newExpiresAt,
      });
    }

    // LRU eviction: if at max devices, evict the oldest (ghost device protection)
    const deviceCount = db.prepare(
      'SELECT COUNT(*) as count FROM cli_devices WHERE credential_id = ? AND revoked_at IS NULL'
    ).get(tierGateAuth.credentialId) as { count: number };

    if (deviceCount.count >= DEVICE_MAX_PER_CREDENTIAL) {
      const oldest = db.prepare(
        'SELECT id, device_name FROM cli_devices WHERE credential_id = ? AND revoked_at IS NULL ORDER BY last_used_at ASC LIMIT 1'
      ).get(tierGateAuth.credentialId) as { id: string; device_name: string } | undefined;

      if (oldest) {
        // Hard-delete (not soft-delete) — ghost devices from wiped machines
        db.prepare('DELETE FROM cli_devices WHERE id = ?').run(oldest.id);

        logAuditEvent({
          type: 'device_evicted_lru',
          ip,
          credentialId: tierGateAuth.credentialId,
          details: { evictedDeviceId: oldest.id, evictedDeviceName: oldest.device_name, reason: 'max_devices_reached' },
        });
      }
    }

    // Insert new device
    const deviceId = crypto.randomUUID();
    const expiresAt = now + DEVICE_TRUST_TTL_MS;

    db.prepare(
      `INSERT INTO cli_devices (id, credential_id, pop_hmac_key, device_name, registered_at, last_used_at, expires_at, ip_registered, ip_last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(deviceId, tierGateAuth.credentialId, popHmacKey, deviceName, now, now, expiresAt, ip, ip);

    logAuditEvent({
      type: 'device_registered',
      ip,
      sessionId: tierGateAuth.sessionId,
      credentialId: tierGateAuth.credentialId,
      details: { deviceId, deviceName, hmacKeyPrefix: popHmacKey.substring(0, 12) + '...' },
    });

    return c.json({ deviceId, deviceName, expiresAt });
  });

  // ────────────────────────────────────────────────────────────────────────
  // D. GET /_auth/device/list — List registered devices
  //    Auth: SESSION
  // ────────────────────────────────────────────────────────────────────────

  app.get('/_auth/device/list', async (c) => {
    const tierGateAuth = c.get('tierGateAuth');
    if (!tierGateAuth?.credentialId) {
      return c.json({ error: 'Session required' }, 401);
    }

    // Scope to credential — never leak other users' devices
    const devices = db.prepare(
      'SELECT * FROM cli_devices WHERE credential_id = ? ORDER BY last_used_at DESC'
    ).all(tierGateAuth.credentialId) as CliDevice[];

    return c.json({
      devices: devices.map(d => ({
        id: d.id,
        deviceName: d.device_name,
        registeredAt: d.registered_at,
        lastUsedAt: d.last_used_at,
        expiresAt: d.expires_at,
        revokedAt: d.revoked_at,
        ipRegistered: d.ip_registered,
        ipLastUsed: d.ip_last_used,
        hmacKeyPrefix: d.pop_hmac_key.substring(0, 12) + '...',
      })),
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // E. DELETE /_auth/device/:deviceId — Revoke a device
  //    Auth: SESSION (step-up enforced via SENSITIVE_ACTIONS in config)
  // ────────────────────────────────────────────────────────────────────────

  app.delete('/_auth/device/:deviceId', async (c) => {
    const ip = getClientIp(c);
    const tierGateAuth = c.get('tierGateAuth');
    const deviceId = c.req.param('deviceId');

    if (!deviceId) {
      return c.json({ error: 'Missing device ID' }, 400);
    }

    if (!tierGateAuth?.credentialId) {
      return c.json({ error: 'Session required' }, 401);
    }

    // Ownership check: only allow revoking own devices (opaque 404 for others)
    const device = db.prepare('SELECT * FROM cli_devices WHERE id = ? AND credential_id = ?')
      .get(deviceId, tierGateAuth.credentialId) as CliDevice | undefined;

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (device.revoked_at) {
      return c.json({ error: 'Device already revoked' }, 400);
    }

    // Soft-delete (preserve for audit trail)
    const now = Date.now();
    db.prepare('UPDATE cli_devices SET revoked_at = ? WHERE id = ?').run(now, deviceId);

    // Kill all active sessions with this device's HMAC key (single atomic query)
    const killResult = db.prepare('DELETE FROM sessions WHERE pop_hmac_key = ?')
      .run(device.pop_hmac_key);

    logAuditEvent({
      type: 'device_revoked',
      ip,
      sessionId: tierGateAuth?.sessionId,
      details: {
        deviceId,
        deviceName: device.device_name,
        sessionsKilled: killResult.changes,
      },
    });

    return c.json({ revoked: true });
  });
}
