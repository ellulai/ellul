// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import {
  ISSUANCE_TOKEN_TTL_MS,
  type ClaudeOatState,
} from "@vps/shared/claude-oat";
import type { ClaudeOatPorts } from "./ports";

export interface IssueOatInput {
  readonly threadId: string;
  readonly project: string | null;
}

export interface IssueOatResult {
  readonly issuanceToken: string;
  readonly expiresAt: string;
  readonly state: ClaudeOatState;
}

/**
 * Command: mint a single-use issuance token.
 *
 * Bridge calls this immediately before spawning ellul-claude-launch. The
 * launcher exchanges the token for the actual OAT via /redeem.
 *
 * The audit entry is recorded BEFORE the issuance store insert so that
 * even a process crash mid-issue leaves a trail.
 */
export function issueOat(
  ports: ClaudeOatPorts,
  input: IssueOatInput,
): IssueOatResult {
  const store = ports.store.load();
  const issuanceToken = ports.random.hex(16); // 128-bit UUID
  const issuedAt = ports.clock.now();
  const expiresAt = issuedAt + ISSUANCE_TOKEN_TTL_MS;

  ports.issuance.put({
    token: issuanceToken,
    threadId: input.threadId,
    project: input.project,
    issuedAt,
    expiresAt,
  });

  ports.audit.append({
    type: "issue",
    actor: "bridge",
    details: {
      issuanceTokenPrefix: issuanceToken.slice(0, 8),
      threadId: input.threadId,
      project: input.project,
      ttlMs: ISSUANCE_TOKEN_TTL_MS,
      state: store.state,
    },
  });

  return {
    issuanceToken,
    expiresAt: new Date(expiresAt).toISOString(),
    state: store.state,
  };
}
