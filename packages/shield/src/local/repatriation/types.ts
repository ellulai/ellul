// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Repatriation Types — Data shapes for VPS → local downgrade
 *
 * DowngradePayload exists ONLY inside VPS process memory (before encryption)
 * and local daemon process memory (after decryption). Never serialized over
 * IPC, never returned to the CLI, never logged.
 *
 * Key exchange direction is REVERSED from promotion:
 *   Promotion: VPS generates keypair, local encapsulates TO VPS
 *   Downgrade: LOCAL generates keypair, VPS encapsulates TO LOCAL
 */

// ── Size Limits ──

export const DOWNGRADE_LIMITS = {
  maxSecrets: 100,
  maxSecretValueBytes: 64 * 1024,
  maxTotalSecretBytes: 1024 * 1024,
  maxRules: 50,
  maxRuleTextBytes: 16 * 1024,
  maxEncryptedPayloadBytes: 5 * 1024 * 1024,
  keyExchangeTtlMs: 60_000,
} as const;

// ── Downgrade Payload (VPS memory → encrypted → local daemon memory) ──

export interface DowngradePayload {
  version: 1;
  downgradeId: string;
  timestamp: string;
  project: {
    slug: string;
    name: string;
    fingerprint: string;
    /** Preserved for re-promotion. */
    vpsProjectId: string;
    /** For reference after downgrade. */
    previousVpsEndpoint: string;
  };
  secrets: Array<{ name: string; value: string }>;
  rules: Array<{
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
  }>;
  gatePermissions: Record<string, 'ask' | 'allow_always' | 'deny_always'>;
  execMode: string;
  /** State that CANNOT be repatriated — included for transparency. */
  remoteOnlyNotice: {
    hasDatabase: boolean;
    hasDeployments: boolean;
    hasTeamMembers: boolean;
    auditEntryCount: number;
  };
}

// ── Encrypted Downgrade Payload ──

export interface EncryptedDowngradePayload {
  _downgrade: true;
  _version: 1;
  downgradeId: string;
  /** Unencrypted routing metadata (non-secret). */
  projectSlug: string;
  /** Base64 ML-KEM-1024 ciphertext (VPS encapsulated to LOCAL's ek). */
  mlkem_ct: string;
  /** Base64 HMAC-SHA256 bind proof. */
  bindProof: string;
  /** Base64 12-byte AES-GCM nonce. */
  iv: string;
  /** Base64 AES-256-GCM ciphertext of DowngradePayload. */
  ciphertext: string;
  /** Base64 16-byte AES-GCM auth tag. */
  authTag: string;
}

// ── Downgrade Receipt (signed by VPS) ──

export interface DowngradeReceipt {
  downgradeId: string;
  projectSlug: string;
  vpsProjectId: string;
  secretsExported: number;
  rulesExported: number;
  gatePoliciesExported: number;
  remoteOnlyNotice: {
    hasDatabase: boolean;
    hasDeployments: boolean;
    hasTeamMembers: boolean;
    auditEntryCount: number;
  };
  timestamp: string;
  /** ML-DSA-44 signature over all receipt fields except signature itself. */
  signature: string;
}

// ── Downgrade Init Response (VPS → local daemon) ──

export interface DowngradeInitResponse {
  /** Challenge for bind proof (hex). */
  challenge: string;
  /** Seconds until key exchange expires. */
  expiresIn: number;
  /** VPS public key for receipt verification (Base64 ML-DSA-44). */
  receiptVerificationKey: string;
}

// ── Downgrade Export Response (VPS → local daemon) ──

export interface DowngradeExportResponse {
  encryptedPayload: EncryptedDowngradePayload;
  receipt: DowngradeReceipt;
}

// ── Scoped Downgrade Token (JWT claims) ──

export interface DowngradeTokenClaims {
  typ: 'downgrade';
  scope: 'downgrade';
  projectSlug: string;
  downgradeId: string;
  sessionId: string;
  exp: number;
  iat: number;
  jti: string;
}

// ── Downgrade Inventory (safe for CLI — no secrets) ──

export interface DowngradeInventory {
  slug: string;
  name: string;
  mode: string;
  vpsEndpoint: string;
  secretCount: number;
  ruleCount: number;
  customRuleCount: number;
  lockedRuleCount: number;
  gatePolicies: Record<string, string>;
  remoteOnlyNotice: {
    hasDatabase: boolean;
    hasDeployments: boolean;
    hasTeamMembers: boolean;
    auditEntryCount: number;
  };
}

// ── Validation ──

export class DowngradeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DowngradeValidationError';
  }
}

export function validateDowngradePayloadLimits(payload: DowngradePayload): void {
  if (payload.secrets.length > DOWNGRADE_LIMITS.maxSecrets) {
    throw new DowngradeValidationError(
      `Too many secrets: ${payload.secrets.length} (max ${DOWNGRADE_LIMITS.maxSecrets})`,
    );
  }

  let totalSecretBytes = 0;
  for (const secret of payload.secrets) {
    const valueBytes = Buffer.byteLength(secret.value, 'utf8');
    if (valueBytes > DOWNGRADE_LIMITS.maxSecretValueBytes) {
      throw new DowngradeValidationError(
        `Secret "${secret.name}" too large: ${valueBytes} bytes (max ${DOWNGRADE_LIMITS.maxSecretValueBytes})`,
      );
    }
    totalSecretBytes += valueBytes;
  }
  if (totalSecretBytes > DOWNGRADE_LIMITS.maxTotalSecretBytes) {
    throw new DowngradeValidationError(
      `Total secret payload too large: ${totalSecretBytes} bytes (max ${DOWNGRADE_LIMITS.maxTotalSecretBytes})`,
    );
  }

  if (payload.rules.length > DOWNGRADE_LIMITS.maxRules) {
    throw new DowngradeValidationError(
      `Too many rules: ${payload.rules.length} (max ${DOWNGRADE_LIMITS.maxRules})`,
    );
  }

  for (const rule of payload.rules) {
    const ruleBytes = Buffer.byteLength(rule.query_scm, 'utf8');
    if (ruleBytes > DOWNGRADE_LIMITS.maxRuleTextBytes) {
      throw new DowngradeValidationError(
        `Rule "${rule.name}" query too large: ${ruleBytes} bytes (max ${DOWNGRADE_LIMITS.maxRuleTextBytes})`,
      );
    }
  }
}
