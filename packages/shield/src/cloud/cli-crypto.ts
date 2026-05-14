// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * CLI-side encryption for secrets — Node.js hybrid X25519+ML-KEM-1024+AES-256-GCM.
 *
 * KNOWN DRIFT — same algorithm, same wire format, three implementations:
 *   - apps/api/src/security/crypto/vps-encrypt.ts  (noble v1, sync)
 *   - packages/shield/src/cloud/cli-crypto.ts      (this file, noble v2 — randomSecretKey)
 *   - apps/vscode-extension/src/utils/crypto.ts    (noble v1, async wrapper)
 * The VPS decrypts identically regardless of source. If you change anything
 * in this file's KEM body, mirror it in the other two.
 *
 * No RSA, no ECDSA, no classical-only operational mode.
 */

import * as crypto from 'crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import type { HybridKemPublicKey, HybridKemEnvelope } from '@ellul.ai/pqc-types';
import { HYBRID_KEM_HKDF_INFO } from '@ellul.ai/pqc-types';

/**
 * Encrypt a secret value using hybrid X25519+ML-KEM-1024+AES-256-GCM.
 *
 * @param publicKeyJson - Hybrid public key JSON string (version 3)
 * @param plaintext     - Secret value to encrypt
 * @throws If key is wrong version, wrong algorithm, or malformed
 */
export function encryptSecret(publicKeyJson: string, plaintext: string): HybridKemEnvelope {
  let pub_: HybridKemPublicKey;
  try {
    pub_ = JSON.parse(publicKeyJson);
  } catch {
    throw new Error('PQC: Failed to parse public key JSON — fail closed');
  }

  if (pub_.version !== 3 || pub_.algorithm !== 'X25519+ML-KEM-1024') {
    throw new Error(
      `PQC: Unsupported key version/algorithm: ${pub_.version}/${pub_.algorithm} — expected 3/X25519+ML-KEM-1024`
    );
  }

  if (!pub_.x25519_pk || !pub_.mlkem_ek) {
    throw new Error('PQC: Missing x25519_pk or mlkem_ek in public key — fail closed');
  }

  const x25519_pk = Buffer.from(pub_.x25519_pk, 'base64');
  const mlkem_ek = new Uint8Array(Buffer.from(pub_.mlkem_ek, 'base64'));

  if (x25519_pk.length !== 32) {
    throw new Error(`PQC: Invalid X25519 public key size: expected 32, got ${x25519_pk.length}`);
  }
  if (mlkem_ek.length !== 1568) {
    throw new Error(`PQC: Invalid ML-KEM encapsulation key size: expected 1568, got ${mlkem_ek.length}`);
  }

  // 1. X25519 ephemeral DH
  // @noble/curves v2 renamed randomPrivateKey → randomSecretKey
  const eph_sk = x25519.utils.randomSecretKey();
  const eph_pk = x25519.getPublicKey(eph_sk);
  const x25519_ss = x25519.getSharedSecret(eph_sk, x25519_pk);

  // 2. ML-KEM-1024 encapsulate
  const { cipherText: mlkem_ct, sharedSecret: mlkem_ss } = ml_kem1024.encapsulate(mlkem_ek);

  // 3. HKDF-SHA256 — all raw bytes, no encoded strings
  const ikm = Buffer.concat([Buffer.from(x25519_ss), Buffer.from(mlkem_ss)]);
  const salt = crypto.createHash('sha256')
    .update(Buffer.from(eph_pk))
    .update(Buffer.from(mlkem_ct))
    .digest();
  const derivedKey = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, HYBRID_KEM_HKDF_INFO, 32)
  );

  // 4. AES-256-GCM encrypt
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  // 5. Zeroize
  eph_sk.fill(0);
  x25519_ss.fill(0);
  mlkem_ss.fill(0);
  ikm.fill(0);
  derivedKey.fill(0);

  return {
    _e2ee: true,
    _pqc: 3,
    x25519_eph_pub: Buffer.from(eph_pk).toString('base64'),
    mlkem_ct: Buffer.from(mlkem_ct).toString('base64'),
    iv: iv.toString('base64'),
    encryptedData: ciphertext.toString('base64'),
  };
}

/**
 * Fetch the VPS hybrid public key via the local auth proxy.
 *
 * @param proxyPort - Local auth proxy port
 * @returns Hybrid public key JSON string (version 3)
 * @throws If server returns PEM, wrong version, or wrong algorithm
 */
export async function fetchPublicKey(proxyPort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/_auth/secrets/public-key`);
  if (!res.ok) {
    throw new Error(`Failed to fetch public key: ${res.status}`);
  }
  const data = await res.json() as { publicKey?: unknown; keyVersion?: number };

  // Hard-fail on PEM string (old RSA format)
  if (typeof data.publicKey === 'string') {
    throw new Error('PQC: Server returned PEM string — expected hybrid KEM JSON (v3). VPS may need PQC key rotation.');
  }

  if (!data.publicKey || typeof data.publicKey !== 'object') {
    throw new Error('PQC: Server returned empty or invalid public key');
  }

  const pub_ = data.publicKey as HybridKemPublicKey;
  if (pub_.version !== 3) {
    throw new Error(`PQC: Unsupported key version: ${pub_.version} — expected 3`);
  }
  if (pub_.algorithm !== 'X25519+ML-KEM-1024') {
    throw new Error(`PQC: Unsupported algorithm: ${pub_.algorithm} — expected X25519+ML-KEM-1024`);
  }

  return JSON.stringify(data.publicKey);
}

/**
 * Encrypt and upload secrets in bulk via the local auth proxy.
 *
 * Uses the `/_auth/secrets/bulk` endpoint for atomic writes.
 *
 * @param proxyPort  - Local auth proxy port
 * @param publicKey  - Hybrid public key JSON string (version 3)
 * @param entries    - Key-value pairs to encrypt and upload
 * @param appName    - Target app (default: "_global")
 * @param env        - Target environment
 * @returns Number of secrets set
 */
export async function encryptAndUploadBulk(
  proxyPort: number,
  publicKey: string,
  entries: Array<{ key: string; value: string }>,
  appName: string = '_global',
  env: 'production' | 'development' = 'production',
): Promise<number> {
  const secrets = entries.map(({ key, value }) => {
    const envelope = encryptSecret(publicKey, value);
    return {
      name: key,
      ...envelope,
    };
  });

  const res = await fetch(`http://127.0.0.1:${proxyPort}/_auth/secrets/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secrets, appName, env }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Bulk upload failed: ${res.status}`);
  }

  const result = await res.json() as { count?: number };
  return result.count ?? entries.length;
}
