// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * The ClaudeOatStore aggregate — root of the credential subsystem's
 * persistence boundary. All transitions go through pure constructor
 * functions; mutation is forbidden. Persistence concerns live in the
 * infrastructure layer.
 */

import type {
  ClaudeOatRevokeReason,
  ClaudeOatState,
} from "@vps/shared/claude-oat";
import type {
  ProbeRecord,
  SuspectFailure,
} from "@vps/shared/claude-oat";
import type { WrappedCredential } from "./credential";

export interface ClaudeOatStoreV1 {
  readonly version: 1;
  /** Active credential (the one used by spawns). */
  readonly active: WrappedCredential | null;
  /**
   * Previous credential after a rotation, kept briefly for fall-back.
   * Cleared after first successful active probe.
   */
  readonly previous: WrappedCredential | null;
  readonly state: ClaudeOatState;
  /** ISO8601 timestamps of recent failed probes (window for quorum). */
  readonly suspectFailures: readonly SuspectFailure[];
  /** Last ~10 probe outcomes for diagnostics. */
  readonly verifyHistory: readonly ProbeRecord[];
  readonly revokedAt: string | null;
  readonly revokedReason: ClaudeOatRevokeReason | null;
  /** Audit-only counter incremented on every report-401 from bridge. */
  readonly bridgeReportedUnauthCount: number;
}

/** Virgin store — no token, no history. */
export function emptyStore(): ClaudeOatStoreV1 {
  return {
    version: 1,
    active: null,
    previous: null,
    state: "empty",
    suspectFailures: [],
    verifyHistory: [],
    revokedAt: null,
    revokedReason: null,
    bridgeReportedUnauthCount: 0,
  };
}

/** Trim verifyHistory to last N entries. */
export function trimHistory(
  history: readonly ProbeRecord[],
  record: ProbeRecord,
  maxLen: number,
): readonly ProbeRecord[] {
  return [...history, record].slice(-maxLen);
}
