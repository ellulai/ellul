// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { OAT_TOKEN_PATTERN } from "@vps/shared/claude-oat";
import { ClaudeOatError } from "../domain/errors";
import { applySave } from "../domain/state-transitions";
import type { ClaudeOatPorts } from "./ports";

export interface SaveTokenInput {
  readonly token: string;
  readonly sessionId: string;
}

export interface SaveTokenResult {
  readonly state: "active";
  readonly tokenFingerprint: string;
}

/**
 * Command: persist a user-pasted OAT.
 *
 * Idempotent on identical token (no-op + returns same fingerprint). Audit
 * trail records both the save and the resulting state transition.
 */
export function saveToken(
  ports: ClaudeOatPorts,
  input: SaveTokenInput,
): SaveTokenResult {
  if (!OAT_TOKEN_PATTERN.test(input.token)) {
    throw new ClaudeOatError(
      "invalid-token",
      "Token must be a sk-ant-oat01-… OAuth token (60–200 chars).",
    );
  }

  const current = ports.store.load();
  const wrapped = ports.cipher.wrap(input.token, ports.clock.iso());

  // Idempotent same-token save: no audit churn, no transition.
  if (
    current.state === "active" &&
    current.active &&
    current.active.tokenFingerprint === wrapped.tokenFingerprint
  ) {
    return { state: "active", tokenFingerprint: wrapped.tokenFingerprint };
  }

  const next = applySave(current, wrapped);
  ports.store.save(next);
  ports.audit.append({
    type: "save",
    actor: "user",
    details: {
      sessionId: input.sessionId,
      tokenFingerprint: wrapped.tokenFingerprint,
      hadPrevious: current.state === "active" && !!current.active,
    },
  });
  ports.audit.append({
    type: "transition",
    actor: "shield-internal",
    details: { from: current.state, to: "active", reason: "save" },
  });
  return { state: "active", tokenFingerprint: wrapped.tokenFingerprint };
}
