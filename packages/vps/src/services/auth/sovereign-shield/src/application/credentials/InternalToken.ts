// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Internal Service Token Management — Per-Service Scoping
 *
 * Generates a cryptographically random 256-bit master secret on each sovereign-shield
 * startup, then HMAC-derives a unique token per known service. Each is written to
 * /run/shield/internal-<service>.token.
 *
 * Purpose: authenticates internal API calls from authorized services (file-api,
 * agent-bridge, enforcer) to sovereign-shield AND ensures a stolen file-api token
 * cannot impersonate agent-bridge (or vice versa).
 *
 * Token lifecycle:
 * - Master secret generated fresh on every sovereign-shield start (not persisted)
 * - Per-service tokens derived via HMAC-SHA256(master, serviceName)
 * - Rotates every 30 minutes with a 60-second grace window for old tokens
 * - /run/shield/ is on tmpfs — cleared on reboot (defense-in-depth)
 * - Services read their token file once at startup and cache in memory
 * - On shield restart or token rotation: services detect auth failures (401),
 *   re-read token file, retry once
 *
 * Service name is REQUIRED — requests without x-service-name are rejected.
 * No legacy fallback; clean cutover.
 *
 * File: /run/shield/internal-<service>.token
 * Ownership: shield-runner:shield-ipc 640 (SGID directory ensures group inheritance)
 * Who can read: shield-runner (owner), file-api/agent-bridge/enforcer (in shield-ipc group)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { INTERNAL_TOKEN_PATH } from '../../config';

// Known internal services — each gets a derived token file
const KNOWN_SERVICES = ['file-api', 'agent-bridge', 'enforcer'] as const;
export type InternalService = (typeof KNOWN_SERVICES)[number];

// In-memory master secrets for HMAC derivation
let currentMasterSecret: string = '';
let previousMasterSecret: string = '';
let previousTokenExpiresAt: number = 0;

// Rotation interval: 30 minutes
const ROTATION_INTERVAL_MS = 30 * 60 * 1000;
// Grace window: old tokens stay valid for 60 seconds after rotation
const GRACE_WINDOW_MS = 60 * 1000;

let rotationTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Derive a per-service token from the master secret via HMAC-SHA256.
 */
function deriveServiceToken(master: string, service: string): string {
  return crypto.createHmac('sha256', master).update(service).digest('hex');
}

/**
 * Get the token file path for a specific service.
 */
function serviceTokenPath(service: string): string {
  const dir = path.dirname(INTERNAL_TOKEN_PATH);
  return path.join(dir, `internal-${service}.token`);
}

/**
 * Write a token to disk atomically (tmp + rename).
 */
function writeTokenFile(filePath: string, token: string): void {
  const tmpPath = `${filePath}.tmp`;
  const dir = path.dirname(filePath);

  // Ensure directory exists (should be created by tmpfiles.d as 2750 shield-runner:shield-ipc).
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o2750 });
  }

  // Mode 0o640: owner (shield-runner) rw, group (shield-ipc) r, others none
  fs.writeFileSync(tmpPath, token, { mode: 0o640 });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Write all per-service tokens and legacy global token to disk.
 */
function writeAllTokens(master: string): void {
  for (const service of KNOWN_SERVICES) {
    const token = deriveServiceToken(master, service);
    try {
      writeTokenFile(serviceTokenPath(service), token);
    } catch (err: any) {
      console.warn(`[shield] Failed to write token for ${service}: ${err.message}`);
    }
  }

}

/**
 * Rotate the master secret and all derived tokens.
 * The old tokens remain valid for GRACE_WINDOW_MS.
 */
function rotateToken(): void {
  previousMasterSecret = currentMasterSecret;
  previousTokenExpiresAt = Date.now() + GRACE_WINDOW_MS;

  currentMasterSecret = crypto.randomBytes(32).toString('hex');

  try {
    writeAllTokens(currentMasterSecret);
    console.log('[shield] Internal service tokens rotated');
  } catch (err: any) {
    console.warn(`[shield] Failed to write rotated tokens: ${err.message}`);
  }
}

/**
 * Generate and write fresh internal service tokens.
 * Called once during sovereign-shield startup. Starts periodic rotation.
 */
export function initInternalToken(): void {
  currentMasterSecret = crypto.randomBytes(32).toString('hex');

  try {
    writeAllTokens(currentMasterSecret);
    console.log('[shield] Per-service internal tokens generated');
  } catch (err: any) {
    console.warn(`[shield] Failed to write internal tokens: ${err.message}`);
    console.warn('[shield] Internal endpoint auth will be unavailable');
  }

  // Start periodic rotation
  if (rotationTimer) clearInterval(rotationTimer);
  rotationTimer = setInterval(rotateToken, ROTATION_INTERVAL_MS);
  if (rotationTimer.unref) rotationTimer.unref();
}

/**
 * Validate an internal service token and verify the claimed service identity.
 *
 * @param authHeader - Authorization header value ("Bearer <token>")
 * @param claimedService - Service name from x-service-name header
 * @returns true if the token is valid AND matches the claimed service
 */
export function validateInternalToken(
  authHeader: string | undefined,
  claimedService?: string,
): boolean {
  if (!currentMasterSecret) return false;
  if (!authHeader?.startsWith('Bearer ')) return false;

  const provided = authHeader.slice(7);
  const providedBuf = Buffer.from(provided);

  // Service name is required — reject if missing or unknown
  if (!claimedService || !KNOWN_SERVICES.includes(claimedService as InternalService)) {
    return false;
  }

  // Validate against the per-service derived token
  const expectedToken = deriveServiceToken(currentMasterSecret, claimedService);
  if (timingSafeCompare(providedBuf, Buffer.from(expectedToken))) return true;

  // Check previous master during rotation grace window
  if (previousMasterSecret && Date.now() < previousTokenExpiresAt) {
    const prevToken = deriveServiceToken(previousMasterSecret, claimedService);
    if (timingSafeCompare(providedBuf, Buffer.from(prevToken))) return true;
  }

  return false;
}

/**
 * Timing-safe buffer comparison that handles length mismatches.
 */
function timingSafeCompare(a: Buffer, b: Buffer): boolean {
  const maxLen = Math.max(a.length, b.length, 1);
  const aBuf = Buffer.alloc(maxLen);
  const bBuf = Buffer.alloc(maxLen);
  a.copy(aBuf);
  b.copy(bBuf);
  return crypto.timingSafeEqual(aBuf, bBuf) && a.length === b.length;
}

/**
 * Identify which service a token belongs to (for audit trail).
 * Returns the verified service name, or null if no match.
 */
export function getVerifiedService(authHeader: string | undefined): InternalService | null {
  if (!currentMasterSecret) return null;
  if (!authHeader?.startsWith('Bearer ')) return null;

  const provided = authHeader.slice(7);
  const providedBuf = Buffer.from(provided);

  for (const service of KNOWN_SERVICES) {
    const expectedToken = deriveServiceToken(currentMasterSecret, service);
    if (timingSafeCompare(providedBuf, Buffer.from(expectedToken))) return service;

    if (previousMasterSecret && Date.now() < previousTokenExpiresAt) {
      const prevToken = deriveServiceToken(previousMasterSecret, service);
      if (timingSafeCompare(providedBuf, Buffer.from(prevToken))) return service;
    }
  }

  return null;
}

/**
 * Get the derived token for a specific target service.
 * Used by sovereign-shield when making outbound calls to other services
 * (e.g., notifying agent-bridge of session revocation).
 */
export function getTokenForService(service: InternalService): string {
  return deriveServiceToken(currentMasterSecret, service);
}

