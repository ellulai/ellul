// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { SafePeekResponse } from "@vps/shared/claude-oat";
import type { ClaudeOatPorts } from "./ports";

/**
 * Query: UI-safe view of credential state. Never returns the token.
 *
 * Note that we DO unwrap to derive the 20-char prefix for UX. This is
 * functionally equivalent to exposing a hash-prefix of the same length
 * in terms of secrecy (not enough entropy to guess the rest), and it
 * gives users something recognizable in the workbench.
 */
export function peek(ports: ClaudeOatPorts): SafePeekResponse {
  const store = ports.store.load();
  const active = store.active;

  let tokenPrefix: string | null = null;
  if (active && (store.state === "active" || store.state === "suspect")) {
    try {
      tokenPrefix = ports.cipher.unwrap(active).slice(0, 20) + "…";
    } catch {
      // Tamper detected — caller (recordTamper) handles transition; here
      // we just surface no prefix.
      tokenPrefix = null;
    }
  }

  return {
    state: store.state,
    hasToken:
      !!active && (store.state === "active" || store.state === "suspect"),
    tokenPrefix,
    lastVerifiedAt: active?.lastVerifiedAt ?? null,
    lastFailedAt:
      store.suspectFailures.length > 0
        ? store.suspectFailures[store.suspectFailures.length - 1]!.ts
        : null,
    suspectFailureCount: store.suspectFailures.length,
    revokedAt: store.revokedAt,
    revokedReason: store.revokedReason,
  };
}
