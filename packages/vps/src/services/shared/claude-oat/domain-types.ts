// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Domain vocabulary for the Claude OAT credential subsystem.
 *
 * These types are shared across the bounded context boundary between
 * sovereign-shield (the credential owner) and agent-bridge / launcher
 * (the consumers). They describe state — not transitions; the transition
 * rules live in shield's domain layer.
 */

/** State of the credential held by sovereign-shield. */
export type ClaudeOatState = "empty" | "active" | "suspect" | "revoked";

/** Reasons recorded in audit log when state transitions to "revoked". */
export type ClaudeOatRevokeReason =
  | "user-logout"
  | "user-rotation"
  | "probe-quorum-failure"
  | "tamper-detected";

/** Reason a probe failed — used to decide whether to count toward quorum. */
export type ClaudeOatProbeOutcome =
  | "ok" // 200 — token works
  | "auth-failed" // 401 — counts toward suspect quorum
  | "rate-limited" // 429 — does NOT count, triggers backoff
  | "anthropic-error" // 5xx — does NOT count, triggers backoff
  | "network-error" // timeout / connection refused — does NOT count
  | "no-token"; // no token to probe (state=empty/revoked) — skipped
