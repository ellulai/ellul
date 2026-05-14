// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Promotion Types — Data shapes for local → VPS state promotion
 *
 * PromotionPayload exists ONLY inside daemon process memory.
 * It is NEVER serialized over IPC, never returned to the CLI, never logged.
 * The daemon encrypts it internally and sends only the opaque encrypted blob to VPS.
 */

// ── Size Limits (validated on BOTH sides) ──

export const PROMOTION_LIMITS = {
  maxSecrets: 100,
  maxSecretValueBytes: 64 * 1024,        // 64KB per secret value
  maxTotalSecretBytes: 1024 * 1024,      // 1MB total secret payload
  maxRules: 50,
  maxRuleTextBytes: 16 * 1024,           // 16KB per .scm query
  maxEncryptedPayloadBytes: 5 * 1024 * 1024, // 5MB total encrypted payload
  keyExchangeTtlMs: 60_000,              // 60s ML-KEM key exchange window
} as const;

// ── Promotion Payload (daemon-internal only, never over IPC) ──

export interface PromotionSecret {
  name: string;
  /** Plaintext value — exists ONLY in daemon heap, zeroized after encryption. */
  value: string;
}

export interface PromotionRule {
  id: string;
  scope: 'global' | 'workspace';
  language: string;
  name: string;
  description: string;
  query_scm: string;
  severity: 'error' | 'warning';
  message: string;
  enabled: boolean;
  locked: boolean;
}

export interface PromotionPayload {
  version: 1;
  promotionId: string;
  timestamp: string;
  project: {
    slug: string;
    name: string;
    fingerprint: string;
    // directory OMITTED — local path is useless on VPS and potentially sensitive
  };
  secrets: PromotionSecret[];
  rules: PromotionRule[];
  gatePermissions: Record<string, 'ask' | 'allow_always' | 'deny_always'>;
  execMode: 'capability' | 'unrestricted';
}

// ── Encrypted Promotion Payload (opaque blob, transmitted to VPS) ──

export interface EncryptedPromotionPayload {
  _promotion: true;
  _version: 1;
  promotionId: string;
  /** Unencrypted — non-secret routing metadata for VPS. */
  projectSlug: string;
  /** Base64 ML-KEM-1024 ciphertext. */
  mlkem_ct: string;
  /** Base64 HMAC-SHA256 bind proof. */
  bindProof: string;
  /** Base64 12-byte AES-GCM nonce. */
  iv: string;
  /** Base64 AES-256-GCM ciphertext of PromotionPayload. */
  ciphertext: string;
  /** Base64 16-byte AES-GCM auth tag. */
  authTag: string;
}

// ── Import Receipt (signed by VPS, returned to CLI) ──

export interface ImportReceipt {
  promotionId: string;
  projectSlug: string;
  /** VPS-assigned project ID. */
  projectId: string;
  secretsImported: number;
  rulesImported: number;
  gatePoliciesImported: number;
  timestamp: string;
  /** VPS endpoint for the promoted project. */
  vpsEndpoint: string;
  /** ML-DSA-44 signature over all receipt fields except signature itself. */
  signature: string;
}

// ── Scoped Promotion Token (JWT claims) ──

export interface PromotionTokenClaims {
  /** Token type discriminator. */
  typ: 'promotion';
  /** Scoped usage: only /promotion/init and /promotion/complete. */
  scope: 'promotion';
  /** Bound to specific project slug. */
  projectSlug: string;
  /** Bound to specific promotion ID. */
  promotionId: string;
  /** Bound to authenticated session ID. */
  sessionId: string;
  /** Expiration (unix seconds). */
  exp: number;
  /** Issued at (unix seconds). */
  iat: number;
  /** Unique token ID for single-use tracking. */
  jti: string;
}

// ── Key Exchange Init Response ──

export interface PromotionInitResponse {
  /** Base64 ML-KEM-1024 encapsulation key. */
  mlkem_ek: string;
  /** Challenge for bind proof (hex). */
  challenge: string;
  /** Seconds until key exchange expires. */
  expiresIn: number;
  /** VPS public key for receipt verification (Base64 ML-DSA-44). */
  receiptVerificationKey: string;
}

// ── Promotion Inventory (safe to return to CLI — no secrets) ──

export interface PromotionInventory {
  slug: string;
  name: string;
  secretCount: number;
  ruleCount: number;
  customRuleCount: number;
  lockedRuleCount: number;
  gatePolicies: Record<string, string>;
  execMode: string;
}

// ── Validation ──

export class PromotionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionValidationError';
  }
}

export function validatePayloadLimits(payload: PromotionPayload): void {
  if (payload.secrets.length > PROMOTION_LIMITS.maxSecrets) {
    throw new PromotionValidationError(
      `Too many secrets: ${payload.secrets.length} (max ${PROMOTION_LIMITS.maxSecrets})`,
    );
  }

  let totalSecretBytes = 0;
  for (const secret of payload.secrets) {
    const valueBytes = Buffer.byteLength(secret.value, 'utf8');
    if (valueBytes > PROMOTION_LIMITS.maxSecretValueBytes) {
      throw new PromotionValidationError(
        `Secret "${secret.name}" too large: ${valueBytes} bytes (max ${PROMOTION_LIMITS.maxSecretValueBytes})`,
      );
    }
    totalSecretBytes += valueBytes;
  }
  if (totalSecretBytes > PROMOTION_LIMITS.maxTotalSecretBytes) {
    throw new PromotionValidationError(
      `Total secret payload too large: ${totalSecretBytes} bytes (max ${PROMOTION_LIMITS.maxTotalSecretBytes})`,
    );
  }

  if (payload.rules.length > PROMOTION_LIMITS.maxRules) {
    throw new PromotionValidationError(
      `Too many rules: ${payload.rules.length} (max ${PROMOTION_LIMITS.maxRules})`,
    );
  }

  for (const rule of payload.rules) {
    const ruleBytes = Buffer.byteLength(rule.query_scm, 'utf8');
    if (ruleBytes > PROMOTION_LIMITS.maxRuleTextBytes) {
      throw new PromotionValidationError(
        `Rule "${rule.name}" query too large: ${ruleBytes} bytes (max ${PROMOTION_LIMITS.maxRuleTextBytes})`,
      );
    }
  }
}
