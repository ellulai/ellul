// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Preview state machine. Per appDirectory. Lives in file-api.
// Spec: docs/v2/architecture/resource-v2/01-state-machines.md#preview

import type { MachineDef } from "./lib";
import { Machine } from "./lib";

export type PreviewState =
  | "disabled"
  | "cold"
  | "starting"
  | "hot"
  | "warm"
  | "demoting"
  | "promoting"
  | "stopping"
  | "failed";

export interface PreviewCtx {
  /** Detected framework id (e.g. "next", "django"). null if not detected. */
  frameworkId: string | null;
  /** Reserved peak RSS the AdmissionService committed at start, MB. 0 if not started. */
  effectiveCapMB: number;
  /** Last admission decision id (uuid). For audit. */
  lastAdmissionId: string | null;
  /** Last error code (typed; matches a runbook). */
  lastError: string | null;
  /** Wall-clock ms of last keepalive heartbeat OR HTTP hit (whichever later). 0 if never. */
  lastActivityAt: number;
  /** Whether a unit-level systemd service is currently running. Matches kernel reality. */
  unitRunning: boolean;
}

export type PreviewEvent =
  | { type: "framework_detected"; frameworkId: string }
  | { type: "framework_lost" }
  | { type: "start_admitted"; effectiveCapMB: number; admissionId: string }
  | { type: "ready_hot" }
  | { type: "ready_warm" }
  | { type: "demote" }
  | { type: "demote_done" }
  | { type: "promote" }
  | { type: "promote_done" }
  | { type: "stop" }
  | { type: "stop_done" }
  | { type: "failure"; error: string }
  | { type: "recover" }
  | { type: "activity_observed"; at: number };

export const PREVIEW_STATES: readonly PreviewState[] = [
  "disabled",
  "cold",
  "starting",
  "hot",
  "warm",
  "demoting",
  "promoting",
  "stopping",
  "failed",
];

export const previewInitialCtx: PreviewCtx = {
  frameworkId: null,
  effectiveCapMB: 0,
  lastAdmissionId: null,
  lastError: null,
  lastActivityAt: 0,
  unitRunning: false,
};

export const previewMachineDef: MachineDef<PreviewState, PreviewEvent, PreviewCtx> = {
  id: "preview",
  initial: "disabled",
  transitions: [
    {
      from: "disabled",
      event: "framework_detected",
      to: "cold",
      effect: (ctx, e) => ({ ...ctx, frameworkId: e.frameworkId }),
    },
    { from: "*", event: "framework_lost", to: "disabled", effect: () => ({ ...previewInitialCtx }) },

    {
      from: "cold",
      event: "start_admitted",
      to: "starting",
      effect: (ctx, e) => ({ ...ctx, effectiveCapMB: e.effectiveCapMB, lastAdmissionId: e.admissionId, unitRunning: true }),
    },

    { from: "starting", event: "ready_hot", to: "hot", effect: markActivity },
    { from: "starting", event: "ready_warm", to: "warm", effect: markActivity },

    { from: "hot", event: "demote", to: "demoting" },
    { from: "demoting", event: "demote_done", to: "warm" },

    { from: "warm", event: "promote", to: "promoting" },
    { from: "promoting", event: "promote_done", to: "hot" },

    { from: "starting", event: "stop", to: "stopping" },
    { from: "hot", event: "stop", to: "stopping" },
    { from: "warm", event: "stop", to: "stopping" },
    { from: "promoting", event: "stop", to: "stopping" },
    { from: "demoting", event: "stop", to: "stopping" },
    { from: "stopping", event: "stop_done", to: "cold", effect: clearReservation },

    { from: "starting", event: "failure", to: "failed", effect: failureEffect },
    { from: "hot", event: "failure", to: "failed", effect: failureEffect },
    { from: "warm", event: "failure", to: "failed", effect: failureEffect },
    { from: "promoting", event: "failure", to: "failed", effect: failureEffect },
    { from: "demoting", event: "failure", to: "failed", effect: failureEffect },
    { from: "stopping", event: "failure", to: "failed", effect: failureEffect },

    { from: "failed", event: "recover", to: "cold", effect: clearReservation },

    // Activity observations don't change state but update freshness for the keepalive reaper.
    { from: "hot", event: "activity_observed", to: "hot", effect: markActivity },
    { from: "warm", event: "activity_observed", to: "warm", effect: markActivity },
    { from: "starting", event: "activity_observed", to: "starting", effect: markActivity },
  ],
  invariants: [
    {
      name: "active_states_have_reservation",
      predicate: (state, ctx) =>
        ![ "starting", "hot", "warm", "demoting", "promoting", "stopping" ].includes(state) || ctx.effectiveCapMB > 0,
    },
    {
      name: "cold_has_no_reservation",
      predicate: (state, ctx) => state !== "cold" || ctx.effectiveCapMB === 0,
    },
    {
      name: "disabled_has_no_framework",
      predicate: (state, ctx) => state !== "disabled" || ctx.frameworkId === null,
    },
    {
      name: "framework_required_for_active",
      predicate: (state, ctx) =>
        ![ "starting", "hot", "warm", "demoting", "promoting" ].includes(state) || ctx.frameworkId !== null,
    },
    {
      name: "unit_running_matches_active",
      predicate: (state, ctx) => {
        const isActive = [ "starting", "hot", "warm", "demoting", "promoting", "stopping" ].includes(state);
        return ctx.unitRunning === isActive;
      },
    },
    {
      name: "failed_has_typed_error",
      predicate: (state, ctx) => state !== "failed" || (ctx.lastError !== null && ctx.lastError.length > 0),
    },
  ],
};

function markActivity(ctx: PreviewCtx, e: PreviewEvent): PreviewCtx {
  if (e.type === "activity_observed") return { ...ctx, lastActivityAt: e.at };
  return { ...ctx, lastActivityAt: Date.now() };
}

function clearReservation(ctx: PreviewCtx): PreviewCtx {
  return { ...ctx, effectiveCapMB: 0, lastAdmissionId: null, unitRunning: false };
}

function failureEffect(ctx: PreviewCtx, e: PreviewEvent): PreviewCtx {
  return {
    ...ctx,
    effectiveCapMB: 0,
    unitRunning: false,
    lastError: e.type === "failure" ? e.error : ctx.lastError,
  };
}

export function makePreviewMachine(initialCtx: PreviewCtx = previewInitialCtx): Machine<PreviewState, PreviewEvent, PreviewCtx> {
  return new Machine(previewMachineDef, { ...initialCtx });
}
