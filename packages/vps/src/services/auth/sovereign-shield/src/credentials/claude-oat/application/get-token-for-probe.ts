// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { applyTamperRevoke } from "../domain/state-transitions";
import type { ClaudeOatPorts } from "./ports";

/**
 * Internal query: get the active token plaintext for the probe loop.
 *
 * Exposed only to the probe interface. Returns null when there's no
 * credential to verify or the unwrap fails (latter forces tamper revoke).
 *
 * NEVER expose this to the HTTP layer. The /redeem endpoint is the
 * sanctioned path for handing the OAT to anyone outside the probe loop.
 */
export function getTokenForProbe(ports: ClaudeOatPorts): string | null {
  const store = ports.store.load();
  if (store.state !== "active" && store.state !== "suspect") return null;
  if (!store.active) return null;
  try {
    return ports.cipher.unwrap(store.active);
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
    return null;
  }
}
