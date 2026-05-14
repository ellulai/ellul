// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { applyReportUnauth } from "../domain/state-transitions";
import type { ClaudeOatPorts } from "./ports";

export interface ReportUnauthInput {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly anthropicRequestId: string | null;
  readonly model: string | null;
}

export interface ReportUnauthResult {
  readonly probeScheduled: boolean;
}

/**
 * Command: bridge reports an upstream 401 it observed.
 *
 * **AUDIT-ONLY** — does NOT mutate credential state. The only side-effect
 * outside the audit log is incrementing a counter and signalling the
 * probe loop to run an out-of-cycle check (so user-visible login UI
 * surfaces faster on a real revocation than the 10s probe interval would
 * give).
 *
 * The state machine never accepts text-based or assistant-output input.
 * That property is structurally enforced here: this function does not
 * call applyProbeOutcome or applyRevoke.
 */
export function reportUnauth(
  ports: ClaudeOatPorts,
  input: ReportUnauthInput,
  signalImmediateProbe: () => void,
): ReportUnauthResult {
  const current = ports.store.load();
  const next = applyReportUnauth(current);
  ports.store.save(next);
  ports.audit.append({
    type: "report-401",
    actor: "bridge",
    details: { ...input, state: current.state },
  });
  signalImmediateProbe();
  return {
    probeScheduled:
      current.state === "active" || current.state === "suspect",
  };
}
