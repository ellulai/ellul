// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { ClaudeOatRevokeReason } from "@vps/shared/claude-oat";
import { applyRevoke } from "../domain/state-transitions";
import type { ClaudeOatPorts } from "./ports";

export interface RevokeOatInput {
  readonly sessionId: string;
  readonly reason: Extract<
    ClaudeOatRevokeReason,
    "user-logout" | "user-rotation"
  >;
}

export interface RevokeOatResult {
  readonly state: "revoked";
}

/**
 * Command: user clicked logout (or initiated rotation).
 *
 * Idempotent — repeated calls on already-revoked state return without
 * audit churn. The transition entry is only emitted on a real change.
 */
export function revokeOat(
  ports: ClaudeOatPorts,
  input: RevokeOatInput,
): RevokeOatResult {
  const current = ports.store.load();
  const next = applyRevoke(current, input.reason, ports.clock.iso());
  if (next === current) {
    return { state: "revoked" };
  }
  ports.store.save(next);
  ports.audit.append({
    type: "revoke",
    actor: "user",
    details: {
      sessionId: input.sessionId,
      reason: input.reason,
      previousState: current.state,
    },
  });
  ports.audit.append({
    type: "transition",
    actor: "shield-internal",
    details: { from: current.state, to: "revoked", reason: input.reason },
  });
  return { state: "revoked" };
}
