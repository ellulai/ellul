// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * The WrappedCredential value object.
 *
 * Encapsulates the encrypted-at-rest representation of an OAT plus the
 * metadata needed to rotate, verify integrity, and surface UX-safe
 * fingerprints. All fields are immutable; rotations produce a new value.
 */

export interface WrappedCredential {
  /** AES-256-GCM ciphertext of the OAT, base64. */
  readonly wrappedToken: string;
  /** AES-256-GCM IV, base64 (12 bytes). */
  readonly nonce: string;
  /** AES-256-GCM authentication tag, base64 (16 bytes). */
  readonly authTag: string;
  /** SHA-256 of the plaintext token, hex (first 16 chars only — for audit). */
  readonly tokenFingerprint: string;
  /** ISO8601 of when this credential was saved. */
  readonly createdAt: string;
  /** ISO8601 of last successful probe against this credential, or null. */
  readonly lastVerifiedAt: string | null;
}

/** Update lastVerifiedAt without mutating the original. */
export function withVerifiedAt(
  cred: WrappedCredential,
  ts: string,
): WrappedCredential {
  return { ...cred, lastVerifiedAt: ts };
}
