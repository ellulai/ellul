// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Type declarations for the ML-KEM browser bundle.
 * Served at runtime by /_auth/static/pqc-mlkem.js — not resolvable at build time.
 */
export interface MlKem1024 {
  encapsulate(ek: Uint8Array): { sharedSecret: Uint8Array; cipherText: Uint8Array };
  decapsulate(ct: Uint8Array, dk: Uint8Array): Uint8Array;
}

export interface PqcMlKemModule {
  ml_kem1024: MlKem1024;
}
