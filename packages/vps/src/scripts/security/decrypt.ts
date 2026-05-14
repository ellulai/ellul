// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/security/decrypt.sh';

/**
 * Decrypt script - decrypts secrets using the server's private key.
 * Used for zero-knowledge secrets management.
 *
 * Hybrid encryption: RSA-OAEP (SHA-256) wraps AES-256-GCM key.
 * Browser appends GCM auth tag (16 bytes) to ciphertext.
 * openssl enc doesn't support GCM auth tags, so we use Node.js crypto.
 */
export function getDecryptScript(): string {
  return content;
}
