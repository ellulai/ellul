// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// preventing localhost auth bypass attacks.

import * as fs from 'fs';
import * as crypto from 'crypto';
import { PATHS, TIERS, type SecurityTier } from './config';

// using the file-api internal token as key. This prevents localhost auth bypass

const INTERNAL_TOKEN_PATH = `/run/shield/internal-file-api.token`;
const HMAC_MAX_AGE_SECONDS = 30;

let cachedInternalToken: string | null = null;

// Read the file-api internal token from disk. Cached after first read.
function readInternalToken(): string | null {
  if (cachedInternalToken) return cachedInternalToken;
  try {
    cachedInternalToken = fs.readFileSync(INTERNAL_TOKEN_PATH, 'utf8').trim();
    return cachedInternalToken;
  } catch {
    return null;
  }
}

// Invalidate the cached internal token (called on HMAC verification failure
export function refreshInternalToken(): void {
  cachedInternalToken = null;
}

// SECURITY: This is the critical fix for the localhost auth bypass vulnerability.
// to file-api port 3002 and bypass all session validation.
export function verifyForwardAuthHmac(headers: Record<string, string | undefined>): boolean {
  const user = headers['x-auth-user'];
  const tier = headers['x-auth-tier'];
  const session = headers['x-auth-session'];
  const timestamp = headers['x-auth-timestamp'];
  const hmac = headers['x-auth-hmac'];

  // All fields required
  if (!user || !tier || !session || !timestamp || !hmac) return false;

  // Replay protection: reject timestamps older than HMAC_MAX_AGE_SECONDS
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > HMAC_MAX_AGE_SECONDS) return false;

  // Read the internal token (shared secret between shield and file-api)
  const token = readInternalToken();
  if (!token) return false;

  // Compute expected HMAC
  const message = `${user}|${tier}|${session}|${timestamp}`;
  const expected = crypto.createHmac('sha256', token).update(message).digest('hex');

  // Timing-safe comparison
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(hmac);
  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Get the current security tier.
// SECURITY: Fail-secure — check web_locked marker FIRST.
export function getCurrentTier(): SecurityTier {
  // Prevents tier file corruption/deletion from downgrading security.
  try {
    if (fs.existsSync('/etc/ellul/.sovereign-shield-active')) return TIERS.WEB_LOCKED;
  } catch {}
  try {
    const tier = fs.readFileSync(PATHS.TIER, 'utf8').trim();
    if (tier === 'standard' || tier === 'web_locked' || tier === 'private_locked') {
      return tier;
    }
  } catch {}
  return TIERS.STANDARD;
}

// Get server ID from file.
export function getServerId(): string | null {
  try {
    return fs.readFileSync(PATHS.SERVER_ID, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
