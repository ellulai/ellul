// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { applyTamperRevoke } from "../domain/state-transitions";
import type { ClaudeOatPorts } from "./ports";

export type RedeemOatResult =
  | { ok: true; token: string }
  | {
      ok: false;
      code:
        | "issuance-token-not-found"
        | "issuance-token-expired"
        | "issuance-token-already-redeemed"
        | "credential-not-active";
      error: string;
    };

/**
 * Command: launcher exchanges an issuance token for the actual OAT.
 *
 * Single-use semantics enforced via IssuanceStore.consume (atomic delete).
 * If the unwrap fails (cipher integrity / fingerprint mismatch), state
 * is forced to revoked with reason="tamper-detected".
 */
export function redeemOat(
  ports: ClaudeOatPorts,
  input: { issuanceToken: string },
): RedeemOatResult {
  const consumed = ports.issuance.consume(input.issuanceToken);
  if (!consumed) {
    // Could be: never issued, already consumed, or expired-and-swept.
    // We can't distinguish without a separate persistence layer, so we
    // return "not-found" as the cheapest accurate signal.
    ports.audit.append({
      type: "redeem",
      actor: "launcher",
      details: {
        issuanceTokenPrefix: input.issuanceToken.slice(0, 8),
        result: "rejected-not-found-or-consumed",
      },
    });
    return {
      ok: false,
      code: "issuance-token-not-found",
      error: "Issuance token not found or already redeemed.",
    };
  }

  if (ports.clock.now() > consumed.expiresAt) {
    ports.audit.append({
      type: "redeem",
      actor: "launcher",
      details: {
        issuanceTokenPrefix: input.issuanceToken.slice(0, 8),
        result: "rejected-expired",
      },
    });
    return {
      ok: false,
      code: "issuance-token-expired",
      error: "Issuance token expired.",
    };
  }

  const store = ports.store.load();
  if (store.state !== "active" && store.state !== "suspect") {
    ports.audit.append({
      type: "redeem",
      actor: "launcher",
      details: {
        issuanceTokenPrefix: input.issuanceToken.slice(0, 8),
        result: "rejected-state",
        state: store.state,
      },
    });
    return {
      ok: false,
      code: "credential-not-active",
      error: `Credential state is ${store.state}; cannot redeem.`,
    };
  }
  if (!store.active) {
    ports.audit.append({
      type: "redeem",
      actor: "launcher",
      details: {
        issuanceTokenPrefix: input.issuanceToken.slice(0, 8),
        result: "rejected-no-active",
      },
    });
    return {
      ok: false,
      code: "credential-not-active",
      error: "No active credential.",
    };
  }

  let plaintext: string;
  try {
    plaintext = ports.cipher.unwrap(store.active);
  } catch (err) {
    const next = applyTamperRevoke(store, ports.clock.iso());
    ports.store.save(next);
    ports.audit.append({
      type: "tamper-detected",
      actor: "shield-internal",
      details: { reason: `unwrap-failed: ${(err as Error).message}` },
    });
    ports.audit.append({
      type: "transition",
      actor: "shield-internal",
      details: { from: store.state, to: "revoked", reason: "tamper-detected" },
    });
    return {
      ok: false,
      code: "credential-not-active",
      error: "Stored credential failed integrity check.",
    };
  }

  ports.audit.append({
    type: "redeem",
    actor: "launcher",
    details: {
      issuanceTokenPrefix: input.issuanceToken.slice(0, 8),
      threadId: consumed.threadId,
      project: consumed.project,
      result: "ok",
      tokenFingerprint: store.active.tokenFingerprint,
      latencyMs: ports.clock.now() - consumed.issuedAt,
    },
  });
  return { ok: true, token: plaintext };
}
