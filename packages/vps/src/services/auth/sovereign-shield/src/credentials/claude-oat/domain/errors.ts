// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Domain errors for the Claude OAT credential subsystem.
 *
 * These errors describe *business rule violations* — they are raised by
 * the domain layer and translated to HTTP status codes by the interface
 * layer. They never carry I/O details (those are infrastructure errors,
 * defined alongside their adapters).
 */

export type ClaudeOatErrorCode =
  | "invalid-token"
  | "issuance-token-not-found"
  | "issuance-token-expired"
  | "issuance-token-already-redeemed"
  | "credential-not-active"
  | "tamper-detected"
  | "uninitialized";

export class ClaudeOatError extends Error {
  constructor(
    public readonly code: ClaudeOatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClaudeOatError";
  }
}
