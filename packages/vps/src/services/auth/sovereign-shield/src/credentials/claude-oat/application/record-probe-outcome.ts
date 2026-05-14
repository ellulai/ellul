// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { ProbeRecord } from "@vps/shared/claude-oat";
import { applyProbeOutcome } from "../domain/state-transitions";
import type { ClaudeOatPorts } from "./ports";

/**
 * Command: shield's probe loop reports the outcome of an Anthropic API
 * verification call.
 *
 * This is the SOLE path through which credential state can move to
 * suspect or revoked from auth-failure quorum. Not bridge's report-401,
 * not assistant text, not stream-exit cause text. The whole bug class
 * the original system suffered from is structurally absent because the
 * domain layer's applyProbeOutcome is the only function that can produce
 * those transitions, and only this command calls it.
 */
export function recordProbeOutcome(
  ports: ClaudeOatPorts,
  record: ProbeRecord,
): void {
  const current = ports.store.load();
  const result = applyProbeOutcome(current, record, ports.clock.now());
  ports.store.save(result.next);

  ports.audit.append({
    type: "probe",
    actor: "shield-probe",
    details: {
      outcome: record.outcome,
      latencyMs: record.latencyMs,
      httpStatus: record.httpStatus,
      anthropicRequestId: record.anthropicRequestId,
      quorumReached:
        record.outcome === "auth-failed" &&
        result.next.state === "revoked" &&
        result.transitioned,
      failureCount: result.next.suspectFailures.length,
      recovered: result.recovered,
    },
  });

  if (result.transitioned) {
    ports.audit.append({
      type: "transition",
      actor: "shield-internal",
      details: {
        from: current.state,
        to: result.next.state,
        reason:
          record.outcome === "ok"
            ? "probe-success"
            : record.outcome === "auth-failed"
              ? result.next.state === "revoked"
                ? "probe-quorum-failure"
                : "probe-401"
              : record.outcome,
      },
    });
  }
}
