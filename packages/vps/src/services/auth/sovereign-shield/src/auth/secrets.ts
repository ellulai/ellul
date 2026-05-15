// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Versioned Auth Secret Management
 *
 * Supports secret rotation with grace period for existing tokens.
 */

import crypto from 'crypto';
import fs from 'fs';
import { AUTH_SECRETS_FILE, AUTH_SECRET_FILE } from '../config';

// Vault-key encryption for Android proot (no UID separation).
// Key is delivered via stdin from the engine, backed by Android Keystore.
let vaultKey: Buffer | null = null;

export function setVaultKey(key: string): void {
  vaultKey = Buffer.from(key, 'hex');
}

function encryptSecretsData(plaintext: string): string {
  if (!vaultKey) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    _enc: 1,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ct: ct.toString('hex'),
  });
}

function decryptSecretsData(raw: string): string {
  if (!vaultKey) return raw;
  try {
    const envelope = JSON.parse(raw);
    if (!envelope._enc) return raw;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', vaultKey, Buffer.from(envelope.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return raw;
  }
}

export interface SecretInfo {
  value: string;
  createdAt: number;
  retiredAt: number | null;
  expiresAt: number | null;
}

export interface AuthSecrets {
  current: number;
  secrets: Record<number, SecretInfo>;
}

export interface SignatureResult {
  signature: string;
  keyVersion: number;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  keyVersion?: number;
}

// In-memory cache to ensure consistent secret within process lifetime
let cachedSecrets: AuthSecrets | null = null;

/**
 * Load versioned secrets or fall back to legacy single secret
 */
export function loadAuthSecrets(): AuthSecrets {
  if (cachedSecrets) return cachedSecrets;
  try {
    if (fs.existsSync(AUTH_SECRETS_FILE)) {
      const raw = fs.readFileSync(AUTH_SECRETS_FILE, 'utf8');
      cachedSecrets = JSON.parse(decryptSecretsData(raw));
      return cachedSecrets!;
    }
  } catch (e) {
    console.error('[shield] Error loading versioned secrets:', (e as Error).message);
  }

  // Fall back to legacy single secret file
  try {
    const secret = fs.readFileSync(AUTH_SECRET_FILE, 'utf8').trim();
    cachedSecrets = {
      current: 1,
      secrets: {
        1: {
          value: secret,
          createdAt: Date.now(),
          retiredAt: null,
          expiresAt: null
        }
      }
    };
    return cachedSecrets;
  } catch {
    // Generate new secret and persist it
    const newSecret = crypto.randomBytes(32).toString('hex');
    cachedSecrets = {
      current: 1,
      secrets: {
        1: {
          value: newSecret,
          createdAt: Date.now(),
          retiredAt: null,
          expiresAt: null
        }
      }
    };
    try {
      fs.writeFileSync(AUTH_SECRETS_FILE, encryptSecretsData(JSON.stringify(cachedSecrets)), { mode: 0o600 });
      console.log('[shield] Generated and persisted new auth secret');
    } catch (writeErr) {
      console.error('[shield] Failed to persist auth secret:', (writeErr as Error).message);
    }
    return cachedSecrets;
  }
}

/**
 * Get the current signing secret
 */
export function getCurrentAuthSecret(): { secret: string; version: number } {
  const secrets = loadAuthSecrets();
  const currentVersion = secrets.current;
  const currentSecret = secrets.secrets[currentVersion];
  if (!currentSecret) {
    throw new Error('Current secret version not found');
  }
  return {
    secret: currentSecret.value,
    version: currentVersion
  };
}

/**
 * Verify a signature using any valid (non-expired) secret version
 */
export function verifyAuthSignature(
  payload: string | object,
  signature: string,
  keyVersion?: number
): VerificationResult {
  const secrets = loadAuthSecrets();

  // If version specified, use that version
  if (keyVersion !== undefined) {
    const secretInfo = secrets.secrets[keyVersion];
    if (!secretInfo) {
      return { valid: false, reason: 'unknown_key_version' };
    }

    // Check if secret is expired
    if (secretInfo.expiresAt && Date.now() > secretInfo.expiresAt) {
      return { valid: false, reason: 'key_expired' };
    }

    const expectedSig = crypto.createHmac('sha256', secretInfo.value)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');

    try {
      if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
        return { valid: false, reason: 'invalid_signature' };
      }
    } catch {
      return { valid: false, reason: 'invalid_signature' };
    }

    return { valid: true, keyVersion };
  }

  // No version specified - try all non-expired secrets (for backwards compatibility)
  for (const [version, secretInfo] of Object.entries(secrets.secrets)) {
    if (secretInfo.expiresAt && Date.now() > secretInfo.expiresAt) {
      continue; // Skip expired secrets
    }

    const expectedSig = crypto.createHmac('sha256', secretInfo.value)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');

    try {
      if (crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
        return { valid: true, keyVersion: parseInt(version) };
      }
    } catch {
      continue;
    }
  }

  return { valid: false, reason: 'invalid_signature' };
}

/**
 * Sign a payload with the current secret (includes version in output)
 */
export function signPayload(payload: string | object): SignatureResult {
  const { secret, version } = getCurrentAuthSecret();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret)
    .update(payloadStr)
    .digest('hex');

  return {
    signature,
    keyVersion: version
  };
}

