// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Pure state-transition functions. Take a current store and an event,
 * return the new store. No I/O, no clocks (timestamps are inputs), no
 * mutation. Tests can call these directly without any infrastructure.
 *
 * This is the heart of the "provably impossible" property: text-based
 * inputs literally cannot reach these functions because no transition
 * accepts them. Only verified probe outcomes and explicit user actions
 * are inputs.
 */

import {
  QUORUM_FAILURE_THRESHOLD,
  QUORUM_WINDOW_MS,
  type ClaudeOatRevokeReason,
} from "@vps/shared/claude-oat";
import type { ProbeRecord, SuspectFailure } from "@vps/shared/claude-oat";
import type { WrappedCredential } from "./credential";
import { withVerifiedAt } from "./credential";
import { type ClaudeOatStoreV1, trimHistory } from "./store";

const HISTORY_MAX_LEN = 10;

/** User pasted a new OAT. The previous active credential (if any) becomes the rotation fallback. */
export function applySave(
  current: ClaudeOatStoreV1,
  newCredential: WrappedCredential,
): ClaudeOatStoreV1 {
  const previous =
    current.state === "active" && current.active ? current.active : null;
  return {
    version: 1,
    active: newCredential,
    previous,
    state: "active",
    suspectFailures: [],
    verifyHistory: [],
    revokedAt: null,
    revokedReason: null,
    bridgeReportedUnauthCount: 0,
  };
}

/** User clicked logout (or initiated rotation). Idempotent for already-revoked. */
export function applyRevoke(
  current: ClaudeOatStoreV1,
  reason: Extract<ClaudeOatRevokeReason, "user-logout" | "user-rotation">,
  ts: string,
): ClaudeOatStoreV1 {
  if (current.state === "revoked") return current;
  return {
    version: 1,
    active: null,
    previous: null,
    state: "revoked",
    suspectFailures: [],
    verifyHistory: current.verifyHistory,
    revokedAt: ts,
    revokedReason: reason,
    bridgeReportedUnauthCount: current.bridgeReportedUnauthCount,
  };
}

/** Tamper detected — force revoke with explicit reason. */
export function applyTamperRevoke(
  current: ClaudeOatStoreV1,
  ts: string,
): ClaudeOatStoreV1 {
  return {
    version: 1,
    active: null,
    previous: null,
    state: "revoked",
    suspectFailures: [],
    verifyHistory: current.verifyHistory,
    revokedAt: ts,
    revokedReason: "tamper-detected",
    bridgeReportedUnauthCount: current.bridgeReportedUnauthCount,
  };
}

/**
 * Bridge reported a 401 from a Claude API turn. AUDIT-ONLY: the only
 * mutation is incrementing the audit counter. State remains untouched.
 *
 * This is the single most important guarantee in the subsystem. The
 * absence of any state mutation here is what makes "adversarial
 * assistant text wipes the token" structurally impossible.
 */
export function applyReportUnauth(
  current: ClaudeOatStoreV1,
): ClaudeOatStoreV1 {
  return {
    ...current,
    bridgeReportedUnauthCount: current.bridgeReportedUnauthCount + 1,
  };
}

export interface ProbeOutcomeResult {
  readonly next: ClaudeOatStoreV1;
  /**
   * Whether the credential transitioned. Used by the application layer
   * to emit transition audit entries.
   */
  readonly transitioned: boolean;
  readonly recovered: boolean;
}

/**
 * Probe outcome handler. The probe loop calls this with the result of
 * its Anthropic API call. State machine:
 *
 *   - ok: clear suspect, mark active, update lastVerifiedAt.
 *   - auth-failed: increment quorum window. If 3 in 90s → revoked.
 *   - rate-limited / anthropic-error / network-error: record only.
 */
export function applyProbeOutcome(
  current: ClaudeOatStoreV1,
  record: ProbeRecord,
  now: number,
): ProbeOutcomeResult {
  const verifyHistory = trimHistory(current.verifyHistory, record, HISTORY_MAX_LEN);

  if (record.outcome === "ok") {
    const updatedActive = current.active
      ? withVerifiedAt(current.active, record.ts)
      : null;
    const wasSuspect = current.state === "suspect";
    return {
      next: {
        ...current,
        active: updatedActive,
        previous: null, // Two-slot rotation: clear previous after first success.
        state: current.state === "revoked" ? "revoked" : "active",
        suspectFailures: [],
        verifyHistory,
      },
      transitioned: wasSuspect,
      recovered: wasSuspect,
    };
  }

  if (record.outcome === "auth-failed") {
    const failure: SuspectFailure = {
      ts: record.ts,
      anthropicRequestId: record.anthropicRequestId,
    };
    const cutoff = now - QUORUM_WINDOW_MS;
    const fresh = current.suspectFailures.filter(
      (f) => Date.parse(f.ts) >= cutoff,
    );
    const suspectFailures = [...fresh, failure];

    if (suspectFailures.length >= QUORUM_FAILURE_THRESHOLD) {
      return {
        next: {
          version: 1,
          active: null,
          previous: null,
          state: "revoked",
          suspectFailures: [],
          verifyHistory,
          revokedAt: record.ts,
          revokedReason: "probe-quorum-failure",
          bridgeReportedUnauthCount: current.bridgeReportedUnauthCount,
        },
        transitioned: true,
        recovered: false,
      };
    }

    return {
      next: {
        ...current,
        state: "suspect",
        suspectFailures,
        verifyHistory,
      },
      transitioned: current.state !== "suspect",
      recovered: false,
    };
  }

  // rate-limited / anthropic-error / network-error / no-token — record only.
  return {
    next: { ...current, verifyHistory },
    transitioned: false,
    recovered: false,
  };
}
