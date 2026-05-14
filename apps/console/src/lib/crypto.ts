// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Web Crypto API utilities for zero-knowledge E2E encryption.

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import type { HybridKemPublicKey, HybridKemEnvelope } from "@ellul.ai/pqc-types";
import { HYBRID_KEM_HKDF_INFO } from "@ellul.ai/pqc-types";

// Convert Uint8Array to base64 string.
function arrayBufferToBase64(buffer: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]!);
  }
  return btoa(binary);
}

// Concatenate two Uint8Arrays.
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

// Encrypt a secret using hybrid X25519+ML-KEM-1024 + AES-256-GCM.
export { encryptSecretMlKem as encryptSecret };
export async function encryptSecretMlKem(
  publicKeyJson: string,
  plaintext: string
): Promise<HybridKemEnvelope> {
  // Parse and validate public key — hard fail on any mismatch
  let pub_: HybridKemPublicKey;
  try {
    pub_ = JSON.parse(publicKeyJson);
  } catch {
    throw new Error("PQC: Failed to parse public key JSON — fail closed");
  }

  if (pub_.version !== 3 || pub_.algorithm !== "X25519+ML-KEM-1024") {
    throw new Error(
      `PQC: Unsupported key version/algorithm: ${pub_.version}/${pub_.algorithm} — expected 3/X25519+ML-KEM-1024`
    );
  }

  if (!pub_.x25519_pk || !pub_.mlkem_ek) {
    throw new Error("PQC: Missing x25519_pk or mlkem_ek in public key — fail closed");
  }

  // Decode public keys from base64 to raw bytes
  const x25519_pk = Uint8Array.from(atob(pub_.x25519_pk), (c) => c.charCodeAt(0));
  const mlkem_ek = Uint8Array.from(atob(pub_.mlkem_ek), (c) => c.charCodeAt(0));

  // Validate key sizes
  if (x25519_pk.length !== 32) {
    throw new Error(`PQC: Invalid X25519 public key size: expected 32, got ${x25519_pk.length}`);
  }
  if (mlkem_ek.length !== 1568) {
    throw new Error(`PQC: Invalid ML-KEM encapsulation key size: expected 1568, got ${mlkem_ek.length}`);
  }

  // 1. X25519 ephemeral DH
  const eph_sk = x25519.utils.randomSecretKey();
  const eph_pk = x25519.getPublicKey(eph_sk);
  const x25519_ss = x25519.getSharedSecret(eph_sk, x25519_pk);

  // 2. ML-KEM-1024 encapsulate
  const { cipherText: mlkem_ct, sharedSecret: mlkem_ss } =
    ml_kem1024.encapsulate(mlkem_ek);

  // 3. HKDF-SHA256 — ALL raw bytes, no encoded strings
  const ikm = concat(x25519_ss, mlkem_ss);
  const saltInput = concat(new Uint8Array(eph_pk), new Uint8Array(mlkem_ct));
  const salt = sha256(saltInput);
  const info = new TextEncoder().encode(HYBRID_KEM_HKDF_INFO);
  const derivedKey = hkdf(sha256, ikm, salt, info, 32);

  // 4. AES-256-GCM encrypt (Web Crypto)
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derivedKey.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      new TextEncoder().encode(plaintext)
    )
  );

  // 5. Zeroize sensitive material
  eph_sk.fill(0);
  x25519_ss.fill(0);
  mlkem_ss.fill(0);
  ikm.fill(0);
  derivedKey.fill(0);

  return {
    _e2ee: true,
    _pqc: 3,
    x25519_eph_pub: arrayBufferToBase64(new Uint8Array(eph_pk)),
    mlkem_ct: arrayBufferToBase64(new Uint8Array(mlkem_ct)),
    iv: arrayBufferToBase64(iv),
    encryptedData: arrayBufferToBase64(ciphertext),
  };
}

// Create a masked display value for a secret.
export function maskSecretValue(value: string): string {
  if (value.length <= 12) {
    if (value.length <= 4) {
      return "••••";
    }
    return value.slice(0, 2) + "••••" + value.slice(-2);
  }

  const prefix = value.slice(0, 6);
  const suffix = value.slice(-4);
  return `${prefix}•••••${suffix}`;
}

// Note: This only works with the MASKED values, not actual secrets.
// Users must have their actual secrets stored elsewhere.
export function generateEnvFileContent(
  secrets: Array<{ name: string; maskedValue: string }>
): string {
  const header = `# ellul Environment Variables Backup
# Generated: ${new Date().toISOString()}
# WARNING: These are MASKED values, not actual secrets.
# You must have your actual secrets stored elsewhere.
#
# To restore, replace the masked values with your actual secrets.

`;

  const lines = secrets
    .map(({ name, maskedValue }) => `${name}=${maskedValue}`)
    .join("\n");

  return header + lines + "\n";
}

// Download a file in the browser.
export function downloadFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
