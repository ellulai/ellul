// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Wire protocol — request/response shapes for the HTTP boundary between
 * sovereign-shield (credential owner) and its consumers (agent-bridge,
 * ellul-claude-launch).
 *
 * Pure data types. No behavior, no I/O. Anything that mutates state is
 * the responsibility of shield's domain/application layer.
 */

import type {
  ClaudeOatProbeOutcome,
  ClaudeOatRevokeReason,
  ClaudeOatState,
} from "./domain-types";

// ── /save — user paste -----------------------------------------------------

export interface SaveRequest {
  /** Anthropic OAT — must match OAT_TOKEN_PATTERN. */
  readonly token: string;
  /** Authenticated session id from passkey login (proves user intent). */
  readonly sessionId: string;
}

export interface SaveResponse {
  readonly ok: true;
  readonly state: "active";
  /** Hash prefix of the stored token, for client-side verification. */
  readonly tokenFingerprint: string;
}

// ── /peek — UI status query -----------------------------------------------

export interface SafePeekResponse {
  readonly state: ClaudeOatState;
  readonly hasToken: boolean;
  /** First 20 chars of the stored token (for UX), null if no token. */
  readonly tokenPrefix: string | null;
  readonly lastVerifiedAt: string | null;
  readonly lastFailedAt: string | null;
  /** Number of consecutive failed probes, 0 if state=active. */
  readonly suspectFailureCount: number;
  readonly revokedAt: string | null;
  readonly revokedReason: ClaudeOatRevokeReason | null;
}

// ── /issue — bridge mints a single-use issuance token --------------------

export interface IssueRequest {
  readonly threadId: string;
  readonly project?: string | null;
}

export interface IssueResponse {
  /** 128-bit UUID issuance token. Single-use. Send to launcher in argv. */
  readonly issuanceToken: string;
  /** ISO8601 — when this issuance token expires (60s from issue). */
  readonly expiresAt: string;
  /** Current credential state — bridge can decide to fail-fast. */
  readonly state: ClaudeOatState;
}

// ── /redeem — launcher exchanges issuance for the real OAT ---------------

export interface RedeemRequest {
  readonly issuanceToken: string;
}

export interface RedeemResponse {
  /** The OAT itself. Returned exactly once per issuance token. */
  readonly token: string;
}

export interface RedeemErrorResponse {
  readonly error: string;
  readonly code:
    | "issuance-token-not-found"
    | "issuance-token-expired"
    | "issuance-token-already-redeemed"
    | "credential-not-active";
}

// ── /report-401 — bridge audit signal ------------------------------------

export interface Report401Request {
  readonly threadId: string;
  readonly turnId?: string | null;
  /** Anthropic request_id from the 401 response (if available). */
  readonly anthropicRequestId?: string | null;
  /** Model name — for filtering tier/model-specific revocations. */
  readonly model?: string | null;
}

export interface Report401Response {
  readonly ok: true;
  /** Whether shield kicked off an immediate verification probe. */
  readonly probeScheduled: boolean;
}

// ── /revoke — user logout ------------------------------------------------

export interface RevokeRequest {
  readonly sessionId: string;
  readonly reason: Extract<ClaudeOatRevokeReason, "user-logout" | "user-rotation">;
}

export interface RevokeResponse {
  readonly ok: true;
  readonly state: "revoked";
}

// ── Probe outcome — internal to shield, but typed here so the audit log
// schema is part of the shared contract --------------------------------

export interface ProbeRecord {
  readonly ts: string;
  readonly outcome: ClaudeOatProbeOutcome;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
  readonly anthropicRequestId: string | null;
}

export interface SuspectFailure {
  readonly ts: string;
  readonly anthropicRequestId: string | null;
}
