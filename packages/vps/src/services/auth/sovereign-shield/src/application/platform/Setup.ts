// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Setup Service
 *
 * Setup token validation and attestation policy management.
 */

import crypto from 'crypto';
import fs from 'fs';
import {
  SETUP_TOKEN_FILE,
  SETUP_EXPIRY_FILE,
  ATTESTATION_POLICY_FILE,
  TRUSTED_AAGUIDS,
} from '../../config';

export interface AttestationPolicy {
  mode: 'strict' | 'permissive' | 'none';
  allowedAAGUIDs: string[];
  warnUnknownAAGUID: boolean;
  logAttestationDetails: boolean;
}

/**
 * Load attestation policy (default: strict mode)
 */
export function loadAttestationPolicy(): AttestationPolicy {
  try {
    if (fs.existsSync(ATTESTATION_POLICY_FILE)) {
      return JSON.parse(fs.readFileSync(ATTESTATION_POLICY_FILE, 'utf8'));
    }
  } catch {}
  // Default strict policy - only allow known hardware authenticators
  // This prevents software-based authenticator attacks where keys can be exported
  return {
    mode: 'strict',
    allowedAAGUIDs: Object.keys(TRUSTED_AAGUIDS),
    warnUnknownAAGUID: true,
    logAttestationDetails: true,
  };
}

/**
 * Validate setup token with timing-safe comparison
 */
export function validateSetupToken(token: string | undefined | null): boolean {
  if (!token) return false;
  try {
    const validToken = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim();

    // Constant-time comparison to prevent timing attacks
    // Handle different lengths by padding shorter string (still rejects but without length leak)
    const tokenBuf = Buffer.from(token);
    const validBuf = Buffer.from(validToken);
    const maxLen = Math.max(tokenBuf.length, validBuf.length);
    const paddedToken = Buffer.alloc(maxLen);
    const paddedValid = Buffer.alloc(maxLen);
    tokenBuf.copy(paddedToken);
    validBuf.copy(paddedValid);

    if (!crypto.timingSafeEqual(paddedToken, paddedValid) || tokenBuf.length !== validBuf.length) {
      return false;
    }

    // SECURITY: expiry is MANDATORY. Previously the token was treated as
    // non-expiring if the expiry file did not exist — on a VPS where
    // provisioning wrote SETUP_TOKEN_FILE but failed before writing
    // SETUP_EXPIRY_FILE, the token lived forever. An attacker who guessed
    // or observed the setup link in the race window before the legitimate
    // user completed registration would own the account. We now refuse
    // tokens without an expiry file and fail-closed on any parse error.
    if (!fs.existsSync(SETUP_EXPIRY_FILE)) {
      // Tear down the orphaned token so we don't keep rejecting forever —
      // the user can re-mint via the provisioner.
      try { fs.unlinkSync(SETUP_TOKEN_FILE); } catch {}
      return false;
    }
    const expiryRaw = fs.readFileSync(SETUP_EXPIRY_FILE, 'utf8').trim();
    const expiry = parseInt(expiryRaw, 10);
    if (!Number.isFinite(expiry) || expiry <= 0) {
      // Malformed expiry — treat as expired.
      try { fs.unlinkSync(SETUP_TOKEN_FILE); } catch {}
      try { fs.unlinkSync(SETUP_EXPIRY_FILE); } catch {}
      return false;
    }
    if (Date.now() / 1000 > expiry) {
      // Token expired - clean up
      try { fs.unlinkSync(SETUP_TOKEN_FILE); } catch {}
      try { fs.unlinkSync(SETUP_EXPIRY_FILE); } catch {}
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up setup token files
 */
export function cleanupSetupToken(): void {
  try { fs.unlinkSync(SETUP_TOKEN_FILE); } catch {}
  try { fs.unlinkSync(SETUP_EXPIRY_FILE); } catch {}
}
