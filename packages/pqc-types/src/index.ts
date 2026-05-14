// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Post-Quantum Cryptography Type Definitions
 *
 * Single source of truth for all PQC types across API, Console, VPS, and auth-proxy.
 * All asymmetric cryptography is post-quantum from day one — no RSA, ECDSA,
 * Ed25519, or X25519 types exist in this package.
 *
 * Standards: NIST FIPS 203 (ML-KEM), FIPS 204 (ML-DSA), FIPS 205 (SLH-DSA)
 */

// ─── ML-KEM-1024 (FIPS 203) — Key Encapsulation ───

export interface MlKemPublicKey {
  readonly version: 2;
  readonly algorithm: "ML-KEM-1024";
  /** Base64-encoded ML-KEM-1024 encapsulation key (1,568 bytes) */
  readonly mlkem_ek: string;
  readonly created_at: string;
}

export interface MlKemPrivateKey {
  readonly version: 2;
  readonly algorithm: "ML-KEM-1024";
  /** Base64-encoded ML-KEM-1024 decapsulation key (3,168 bytes) */
  readonly mlkem_dk: string;
  readonly created_at: string;
}

/**
 * ML-KEM-1024 encrypted envelope for E2EE command channel.
 * Replaces the legacy RSA-OAEP + AES-256-GCM envelope.
 */
export interface MlKemEnvelope {
  readonly _e2ee: true;
  readonly _pqc: 2;
  /** Base64-encoded ML-KEM-1024 ciphertext (1,568 bytes) */
  readonly mlkem_ct: string;
  /** Base64-encoded AES-256-GCM IV (12 bytes) */
  readonly iv: string;
  /** Base64-encoded AES-256-GCM ciphertext + 16-byte auth tag */
  readonly encryptedData: string;
}

// ─── Hybrid KEM: X25519 + ML-KEM-1024 (SNDL Defense-in-Depth) ───
// Mandatory combiner for command channel and secrets encryption.
// No classical-only operational mode — ML-KEM is required, X25519 is belt-on-suspenders.

export interface HybridKemPublicKey {
  readonly version: 3;
  readonly algorithm: "X25519+ML-KEM-1024";
  /** Base64-encoded X25519 public key (32 bytes) */
  readonly x25519_pk: string;
  /** Base64-encoded ML-KEM-1024 encapsulation key (1,568 bytes) */
  readonly mlkem_ek: string;
  readonly created_at: string;
}

export interface HybridKemPrivateKey {
  readonly version: 3;
  readonly algorithm: "X25519+ML-KEM-1024";
  /** Base64-encoded X25519 private key (32 bytes) */
  readonly x25519_sk: string;
  /** Base64-encoded ML-KEM-1024 decapsulation key (3,168 bytes) */
  readonly mlkem_dk: string;
  readonly created_at: string;
}

/**
 * Hybrid KEM encrypted envelope for E2EE command channel.
 * SharedSecret = HKDF-SHA256(X25519_SS || ML-KEM_SS, SHA-256(eph_pub || ct), info, 32)
 */
export interface HybridKemEnvelope {
  readonly _e2ee: true;
  readonly _pqc: 3;
  /** Base64-encoded ephemeral X25519 public key (32 bytes) */
  readonly x25519_eph_pub: string;
  /** Base64-encoded ML-KEM-1024 ciphertext (1,568 bytes) */
  readonly mlkem_ct: string;
  /** Base64-encoded AES-256-GCM IV (12 bytes) */
  readonly iv: string;
  /** Base64-encoded AES-256-GCM ciphertext + 16-byte auth tag */
  readonly encryptedData: string;
}

/** HKDF info string for hybrid KEM key derivation */
export const HYBRID_KEM_HKDF_INFO = "ellul-hybrid-kem-v1" as const;

/** Current hybrid KEM algorithm identifier */
export const HYBRID_KEM_ALGORITHM = "X25519+ML-KEM-1024" as const;

/** Current hybrid KEM key version */
export const HYBRID_KEM_VERSION = 3 as const;

/** Validate that a parsed key JSON is a valid hybrid KEM public key */
export function isValidHybridKemPublicKey(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const key = parsed as Record<string, unknown>;
  return key.algorithm === HYBRID_KEM_ALGORITHM && typeof key.mlkem_ek === "string" && typeof key.x25519_pk === "string";
}

/** X25519 key sizes in bytes */
export const X25519 = {
  PUBLIC_KEY_SIZE: 32,
  PRIVATE_KEY_SIZE: 32,
  SHARED_SECRET_SIZE: 32,
} as const;

// ─── ML-DSA-65 (FIPS 204) — Digital Signatures (Manifests) ───

export interface MlDsaPublicKey {
  readonly version: 2;
  readonly algorithm: "ML-DSA-65";
  /** Base64-encoded ML-DSA-65 public key (1,952 bytes) */
  readonly mldsa_pk: string;
  readonly created_at: string;
}

export interface MlDsaPrivateKey {
  readonly version: 2;
  readonly algorithm: "ML-DSA-65";
  /** Base64-encoded ML-DSA-65 private key (4,032 bytes) */
  readonly mldsa_sk: string;
  readonly created_at: string;
}

// ─── ML-DSA-44 (FIPS 204) — Digital Signatures (Intent Layer) ───

export interface MlDsa44PublicKey {
  readonly version: 2;
  readonly algorithm: "ML-DSA-44";
  /** Base64-encoded ML-DSA-44 public key (1,312 bytes) */
  readonly mldsa44_pk: string;
}

export interface MlDsa44PrivateKey {
  readonly version: 2;
  readonly algorithm: "ML-DSA-44";
  /** Base64-encoded ML-DSA-44 private key (2,560 bytes) */
  readonly mldsa44_sk: string;
}

// ─── SLH-DSA-SHA2-128s (FIPS 205) — Digital Signatures (Operator/Gate) ───

export interface SlhDsaPublicKey {
  readonly version: 2;
  readonly algorithm: "SLH-DSA-SHA2-128s";
  /** Base64-encoded SLH-DSA-SHA2-128s public key (32 bytes) */
  readonly slhdsa_pk: string;
}

export interface SlhDsaPrivateKey {
  readonly version: 2;
  readonly algorithm: "SLH-DSA-SHA2-128s";
  /** Base64-encoded SLH-DSA-SHA2-128s private key (64 bytes) */
  readonly slhdsa_sk: string;
}

// ─── Session Integrity Layer (ML-KEM + HMAC-SHA256) ───

/** Headers attached by the Service Worker to every same-origin request */
export interface SessionMacHeaders {
  /** Unix milliseconds timestamp */
  readonly "X-PoP-Timestamp": string;
  /** UUIDv4 single-use nonce */
  readonly "X-PoP-Nonce": string;
  /** Base64-encoded HMAC-SHA256 tag (32 bytes → 44 base64 chars) */
  readonly "X-PoP-MAC": string;
}

/**
 * Compact session-binding identifier derived from K_pop.
 * Used to prevent cross-session replay of intent signatures.
 * This is NOT an authentication secret or trust anchor.
 *
 * Derivation: HMAC-SHA256(K_pop, "intent-binding") truncated to first 16 bytes (hex).
 */
export type SessionKeyId = string;

// ─── User Intent Layer (ML-DSA-44 / SLH-DSA-SHA2-128s) ───

/** Headers attached by the main thread/extension for high-value actions */
export interface IntentSignatureHeaders {
  /** Base64-encoded ML-DSA-44 (2,420 B) or SLH-DSA-SHA2-128s (7,856 B) signature */
  readonly "X-Intent-Signature": string;
  /** Algorithm identifier for server-side dispatch */
  readonly "X-Intent-Type": "mldsa44" | "slhdsa128s";
  /** Server-issued, challenge-scoped, single-use nonce */
  readonly "X-Intent-Nonce": string;
  /** Unix milliseconds timestamp (30s TTL, 5s future clock skew tolerance) */
  readonly "X-Intent-Timestamp": string;
}

/**
 * Intent signature payload format.
 * Pipe-delimited, signed by the session holder's ML-DSA-44 or SLH-DSA private key.
 */
export interface IntentPayload {
  readonly action: string;
  readonly resource: string;
  readonly parametersHash: string;
  readonly sessionId: string;
  readonly sessionKeyId: SessionKeyId;
  readonly origin: string;
  readonly nonce: string;
  readonly timestamp: string;
}

/** Serializes an IntentPayload to the canonical pipe-delimited string for signing */
export function serializeIntentPayload(p: IntentPayload): string {
  return [
    p.action,
    p.resource,
    p.parametersHash,
    p.sessionId,
    p.sessionKeyId,
    p.origin,
    p.nonce,
    p.timestamp,
  ].join("|");
}

// ─── Action Classification ───

/** Actions requiring post-quantum intent signatures */
export const REQUIRES_INTENT_SIGNATURE = {
  wallet_spend: "slhdsa128s",
  deploy: "slhdsa128s",
  db_migrate: "slhdsa128s",
  db_write: "mldsa44",
  git_push_external: "mldsa44",
  exec: "mldsa44",
} as const satisfies Record<string, "mldsa44" | "slhdsa128s">;

export type IntentRequiredAction = keyof typeof REQUIRES_INTENT_SIGNATURE;
export type IntentSignatureType = (typeof REQUIRES_INTENT_SIGNATURE)[IntentRequiredAction];

/** Check if an action requires an intent signature */
export function requiresIntentSignature(action: string): action is IntentRequiredAction {
  return action in REQUIRES_INTENT_SIGNATURE;
}

/** Get the required signature type for an action, or null if not required */
export function getRequiredSignatureType(action: string): IntentSignatureType | null {
  if (requiresIntentSignature(action)) {
    return REQUIRES_INTENT_SIGNATURE[action];
  }
  return null;
}

// ─── ML-KEM Bind Protocol ───

/** Phase 1: Server → Client (init) */
export interface MlKemBindInit {
  /** Base64-encoded ML-KEM-1024 encapsulation key (1,568 bytes) */
  readonly mlkem_ek: string;
  /** 32-byte hex nonce for bind proof */
  readonly bind_challenge: string;
  /** Unix milliseconds — bind expires after this */
  readonly expires_at: number;
}

/** Phase 2: Client → Server (complete) */
export interface MlKemBindComplete {
  /** Base64-encoded ML-KEM-1024 ciphertext (1,568 bytes) */
  readonly mlkem_ct: string;
  /** Base64-encoded HMAC-SHA256(K_raw, "pop-bind|" + bind_challenge) where K_raw is the ML-KEM shared secret */
  readonly bind_proof: string;
  /** Base64-encoded ML-DSA-44 public key for intent signatures (1,312 bytes) */
  readonly intent_public_key?: string;
  /** Base64-encoded SLH-DSA-SHA2-128s public key for financial/irreversible intent signatures (32 bytes) */
  readonly intent_slhdsa_public_key?: string;
  /** Optional: Base64-encoded AES-256-GCM(K_pop_mlkem, prf_output) */
  readonly prf_envelope?: string;
  /** Optional: Base64-encoded 12-byte IV for prf_envelope decryption */
  readonly prf_iv?: string;
}

/** Phase 2: Server → Client (response) */
export interface MlKemBindResponse {
  readonly bound: true;
  readonly pop_version: 2;
  readonly intent_nonce_endpoint: string;
}

// ─── Wallet Types (Quantum-Blind Transaction Enforcement) ───

export interface HdWalletState {
  readonly version: 2;
  readonly nextDerivationIndex: number;
  readonly currentReceiveAddress: string;
  readonly currentReceiveIndex: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UsedSigningAddress {
  readonly address: string;
  readonly derivationIndex: number;
  readonly firstSignedAt: number;
  readonly txId: string;
  readonly sweptTo: string | null;
  readonly drainVerified: boolean;
}

// ─── Constants ───

/** ML-KEM-1024 key sizes in bytes */
export const ML_KEM_1024 = {
  ENCAPSULATION_KEY_SIZE: 1_568,
  DECAPSULATION_KEY_SIZE: 3_168,
  CIPHERTEXT_SIZE: 1_568,
  SHARED_SECRET_SIZE: 32,
} as const;

/** ML-DSA-65 key/signature sizes in bytes */
export const ML_DSA_65 = {
  PUBLIC_KEY_SIZE: 1_952,
  PRIVATE_KEY_SIZE: 4_032,
  SIGNATURE_SIZE: 3_309,
} as const;

/** ML-DSA-44 key/signature sizes in bytes */
export const ML_DSA_44 = {
  PUBLIC_KEY_SIZE: 1_312,
  PRIVATE_KEY_SIZE: 2_560,
  SIGNATURE_SIZE: 2_420,
} as const;

/** SLH-DSA-SHA2-128s key/signature sizes in bytes */
export const SLH_DSA_SHA2_128S = {
  PUBLIC_KEY_SIZE: 32,
  PRIVATE_KEY_SIZE: 64,
  SIGNATURE_SIZE: 7_856,
} as const;

/** Intent signature timing constants */
export const INTENT_TIMING = {
  /** Maximum age of intent signature (milliseconds) */
  SIGNATURE_TTL_MS: 30_000,
  /** Maximum clock skew into the future (milliseconds) */
  MAX_FUTURE_SKEW_MS: 5_000,
  /** Nonce expiry (milliseconds) */
  NONCE_TTL_MS: 30_000,
} as const;

/** Solana wallet constants for Quantum-Blind Transaction Enforcement */
export const WALLET_QBTE = {
  BIP44_PATH_PREFIX: "m/44'/501'",
  RENT_EXEMPT_MINIMUM_LAMPORTS: 890_880,
  MAX_DERIVATION_INDEX: 2_147_483_647,
  ESTIMATED_FEE_PER_INSTRUCTION: 5_000,
} as const;
