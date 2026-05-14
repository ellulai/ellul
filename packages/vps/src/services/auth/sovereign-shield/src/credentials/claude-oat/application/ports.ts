// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Application-layer ports — the contracts the infrastructure layer must
 * satisfy. The application layer depends only on these interfaces; it
 * never imports anything from infrastructure/. Tests substitute fakes.
 *
 * This is the dependency-inversion seam that makes the entire bounded
 * context testable without a filesystem, a clock, or a network.
 */

import type { ClaudeOatStoreV1 } from "../domain/store";
import type {
  AuditEntryDraft,
  ClaudeOatAuditEntry,
} from "../domain/audit";
import type { WrappedCredential } from "../domain/credential";

// ── Persistence: the encrypted store ----------------------------------------

export interface StoreRepository {
  /** Read the current store. Throws if uninitialized. */
  load(): ClaudeOatStoreV1;
  /** Atomically replace the on-disk store. */
  save(store: ClaudeOatStoreV1): void;
}

// ── Persistence: the audit log ---------------------------------------------

export interface AuditLog {
  /** Recover audit-chain head (last seq + last hash) on startup. */
  resume(): { lastSeq: number; lastHash: string };
  /** Append an entry. Returns the persisted entry with hash + seq filled in. */
  append(draft: AuditEntryDraft): ClaudeOatAuditEntry;
}

// ── Cryptography: AES-GCM wrap/unwrap with HKDF-derived per-VPS key ----------

export interface CredentialCipher {
  wrap(plaintext: string, createdAt: string): WrappedCredential;
  /** Throws if integrity check (auth tag or fingerprint) fails. */
  unwrap(cred: WrappedCredential): string;
}

// ── Issuance: ephemeral single-use tokens ----------------------------------

export interface IssuanceRecord {
  readonly token: string;
  readonly threadId: string;
  readonly project: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface IssuanceStore {
  /** Mint a new issuance token. Caller passes a freshly-randomized token. */
  put(record: IssuanceRecord): void;
  /** Find an issuance token. Does NOT consume — caller must call consume(). */
  get(token: string): IssuanceRecord | null;
  /** Atomically consume (delete) a token. Returns the record if it existed. */
  consume(token: string): IssuanceRecord | null;
  /** Delete all expired tokens (now > expiresAt). */
  sweepExpired(now: number): void;
}

// ── Time: an injectable clock --------------------------------------------

export interface Clock {
  now(): number;
  iso(): string;
}

// ── Random: an injectable RNG --------------------------------------------

export interface RandomBytes {
  /** Returns a hex string of the given byte count, doubled length. */
  hex(byteCount: number): string;
}

// ── Composition: the full set of application-layer dependencies -----------

export interface ClaudeOatPorts {
  readonly store: StoreRepository;
  readonly audit: AuditLog;
  readonly cipher: CredentialCipher;
  readonly issuance: IssuanceStore;
  readonly clock: Clock;
  readonly random: RandomBytes;
}
