// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Proof of Possession (PoP) Signer — ML-KEM + HMAC-SHA256
 *
 * Performs ML-KEM-1024 key exchange with the server to establish a shared
 * HMAC key, then signs all requests with HMAC-SHA256.
 *
 * This is the canonical CLI implementation. The VS Code extension
 * re-exports from this package.
 */

import * as crypto from 'crypto';

/** HMAC key material for session PoP */
export interface PopHmacKey {
  /** Base64-encoded HMAC-SHA256 key derived from ML-KEM shared secret */
  hmacKeyBase64: string;
}

export interface PopHeaders {
  'X-PoP-Timestamp': string;
  'X-PoP-Nonce': string;
  'X-PoP-Signature': string;
}

/** SLH-DSA-SHA2-128s operator keypair (volatile RAM only) */
export interface OperatorKeyPair {
  /** Base64-encoded SLH-DSA-SHA2-128s public key (32 bytes) */
  publicKeyBase64: string;
  /** Raw secret key bytes for signing (64 bytes) — zeroize on shutdown */
  secretKey: Uint8Array;
}

/**
 * Perform ML-KEM-1024 bind handshake with the server.
 *
 * 1. POST /_auth/pop/bind/init → get mlkem_ek + bind_challenge
 * 2. Encapsulate against ek → shared secret K
 * 3. Compute bind_proof = HMAC-SHA256(K, "pop-bind|" + challenge)
 * 4. POST /_auth/pop/bind/complete → server verifies and stores K_pop
 * 5. Derive K_pop = HMAC-SHA256(K, "pop-session-mac") locally
 *
 * Returns the HMAC key for signing subsequent requests.
 */
export async function performMlKemBind(
  baseUrl: string,
  sessionCookie: string,
): Promise<PopHmacKey> {
  const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');

  // Phase 1: Init
  const initRes = await fetch(`${baseUrl}/_auth/pop/bind/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
    },
    body: '{}',
  });
  if (!initRes.ok) {
    const body = await initRes.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || 'ML-KEM bind init failed');
  }
  const { mlkem_ek, bind_challenge } = await initRes.json() as {
    mlkem_ek: string;
    bind_challenge: string;
    bound?: boolean;
  };

  if (!mlkem_ek || !bind_challenge) {
    throw new Error('Server returned incomplete bind init response');
  }

  // Phase 2: Encapsulate
  const ekBytes = Buffer.from(mlkem_ek, 'base64');
  const { sharedSecret, cipherText } = ml_kem1024.encapsulate(ekBytes);

  // Compute bind proof with domain separation: HMAC-SHA256(K, "pop-bind|" + challenge)
  const bindProof = crypto.createHmac('sha256', Buffer.from(sharedSecret))
    .update('pop-bind|' + bind_challenge)
    .digest('base64');

  // Derive K_pop locally (same derivation as server)
  const kPop = crypto.createHmac('sha256', Buffer.from(sharedSecret))
    .update('pop-session-mac')
    .digest('base64');

  // Zero shared secret
  (sharedSecret as Uint8Array).fill(0);

  // Phase 3: Complete
  const completeRes = await fetch(`${baseUrl}/_auth/pop/bind/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
    },
    body: JSON.stringify({
      ciphertext: Buffer.from(cipherText).toString('base64'),
      bind_proof: bindProof,
    }),
  });
  if (!completeRes.ok) {
    const body = await completeRes.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || 'ML-KEM bind complete failed');
  }

  return { hmacKeyBase64: kPop };
}

/**
 * Sign a request with HMAC-SHA256 PoP.
 * Payload: `timestamp|method|path|bodyHash|nonce`
 */
export function signRequest(
  hmacKey: PopHmacKey,
  method: string,
  path: string,
  body?: string | Buffer | null,
): PopHeaders {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();

  let bodyHash = '';
  if (body != null && (typeof body === 'string' ? body.length > 0 : body.length > 0)) {
    bodyHash = crypto.createHash('sha256').update(body).digest('base64');
  }

  const payload = `${timestamp}|${method.toUpperCase()}|${path}|${bodyHash}|${nonce}`;

  const signature = crypto.createHmac('sha256', Buffer.from(hmacKey.hmacKeyBase64, 'base64'))
    .update(payload)
    .digest('base64');

  return {
    'X-PoP-Timestamp': timestamp,
    'X-PoP-Nonce': nonce,
    'X-PoP-Signature': signature,
  };
}

/**
 * Generate SLH-DSA-SHA2-128s operator keypair in volatile memory.
 * The private key exists ONLY in the daemon process's RAM — MCP subprocesses
 * (separate OS processes) cannot access it. This makes agent self-approval
 * mathematically impossible.
 */
export async function generateOperatorKeyPair(): Promise<OperatorKeyPair> {
  const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
  const { publicKey, secretKey } = slh_dsa_sha2_128s.keygen();
  return {
    publicKeyBase64: Buffer.from(publicKey).toString('base64'),
    secretKey,
  };
}

/**
 * Sign a gate control operation with SLH-DSA-SHA2-128s.
 * Payload format depends on operation type (caller constructs it).
 * Timestamp is appended automatically: "{payload}|{timestamp}"
 */
export async function signOperatorAction(
  operatorKey: OperatorKeyPair,
  payload: string,
): Promise<{ signature: string; timestamp: string }> {
  const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
  const timestamp = Date.now().toString();
  const fullPayload = `${payload}|${timestamp}`;
  const messageBytes = Buffer.from(fullPayload);
  // noble API: sign(message, secretKey)
  const signature = slh_dsa_sha2_128s.sign(messageBytes, operatorKey.secretKey);
  return {
    signature: Buffer.from(signature).toString('base64'),
    timestamp,
  };
}

/**
 * Sign a device auth challenge with HMAC-SHA256.
 * Payload: `device-auth|{challenge}|{timestamp}`
 */
export function signDeviceChallenge(
  hmacKey: PopHmacKey,
  challenge: string,
): { signature: string; timestamp: string } {
  const timestamp = Date.now().toString();
  const payload = `device-auth|${challenge}|${timestamp}`;

  const signature = crypto.createHmac('sha256', Buffer.from(hmacKey.hmacKeyBase64, 'base64'))
    .update(payload)
    .digest('base64');

  return { signature, timestamp };
}
