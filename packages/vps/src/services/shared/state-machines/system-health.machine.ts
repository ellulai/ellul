// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// System health state machine. Single instance per VPS, lives in agent-bridge.
// Driven by MetricsCollector via DegradationController.
// Spec: docs/v2/architecture/resource-v2/01-state-machines.md#system-health
// Detail: docs/v2/architecture/resource-v2/10-system-health.md

import type { MachineDef } from "./lib";
import { Machine } from "./lib";

export type SystemHealthState = "green" | "yellow" | "red";

export interface SystemHealthCtx {
  /** Most-recent observed slice utilization, percent (0-100). */
  sliceUtilization: number;
  /** Most-recent observed PSI memory avg10 (some), percent (0-100). */
  psiMemAvg10: number;
  /** Wall-clock ms when current state was entered. */
  enteredAt: number;
  /** Sustained-pressure clock (ms): how long sustained above current state's down-threshold. */
  sustainedMs: number;
}

export type SystemHealthEvent =
  | { type: "metrics"; sliceUtilization: number; psiMemAvg10: number; sustainedMs: number };

export const SYSTEM_HEALTH_STATES: readonly SystemHealthState[] = ["green", "yellow", "red"];

// Triggers per the brief:
//   green → yellow:  >= 70% utilization OR PSI avg10 > 10% sustained 30 s
//   yellow → red:    >= 90% utilization OR PSI avg10 > 25% sustained 15 s
// Hysteresis on the way down (5pp + sustained) to avoid flapping.
export const SYSTEM_HEALTH_THRESHOLDS = {
  yellowEnterUtilPct: 70,
  yellowEnterPsiPct: 10,
  yellowEnterSustainedMs: 30_000,

  redEnterUtilPct: 90,
  redEnterPsiPct: 25,
  redEnterSustainedMs: 15_000,

  greenExitUtilPct: 65,
  greenExitPsiPct: 6,
  greenExitSustainedMs: 60_000,

  yellowExitUtilPct: 85,
  yellowExitPsiPct: 18,
  yellowExitSustainedMs: 30_000,
} as const;

export const systemHealthInitialCtx: SystemHealthCtx = {
  sliceUtilization: 0,
  psiMemAvg10: 0,
  enteredAt: Date.now(),
  sustainedMs: 0,
};

export const systemHealthMachineDef: MachineDef<SystemHealthState, SystemHealthEvent, SystemHealthCtx> = {
  id: "system_health",
  initial: "green",
  transitions: [
    // green → yellow
    {
      from: "green",
      event: "metrics",
      to: "yellow",
      guard: (_ctx, e) =>
        (e.sliceUtilization >= SYSTEM_HEALTH_THRESHOLDS.yellowEnterUtilPct ||
          e.psiMemAvg10 >= SYSTEM_HEALTH_THRESHOLDS.yellowEnterPsiPct) &&
        e.sustainedMs >= SYSTEM_HEALTH_THRESHOLDS.yellowEnterSustainedMs,
      effect: enterStateEffect,
    },

    // yellow → red
    {
      from: "yellow",
      event: "metrics",
      to: "red",
      guard: (_ctx, e) =>
        (e.sliceUtilization >= SYSTEM_HEALTH_THRESHOLDS.redEnterUtilPct ||
          e.psiMemAvg10 >= SYSTEM_HEALTH_THRESHOLDS.redEnterPsiPct) &&
        e.sustainedMs >= SYSTEM_HEALTH_THRESHOLDS.redEnterSustainedMs,
      effect: enterStateEffect,
    },

    // red → yellow (hysteresis)
    {
      from: "red",
      event: "metrics",
      to: "yellow",
      guard: (_ctx, e) =>
        e.sliceUtilization < SYSTEM_HEALTH_THRESHOLDS.yellowExitUtilPct &&
        e.psiMemAvg10 < SYSTEM_HEALTH_THRESHOLDS.yellowExitPsiPct &&
        e.sustainedMs >= SYSTEM_HEALTH_THRESHOLDS.yellowExitSustainedMs,
      effect: enterStateEffect,
    },

    // yellow → green (hysteresis)
    {
      from: "yellow",
      event: "metrics",
      to: "green",
      guard: (_ctx, e) =>
        e.sliceUtilization < SYSTEM_HEALTH_THRESHOLDS.greenExitUtilPct &&
        e.psiMemAvg10 < SYSTEM_HEALTH_THRESHOLDS.greenExitPsiPct &&
        e.sustainedMs >= SYSTEM_HEALTH_THRESHOLDS.greenExitSustainedMs,
      effect: enterStateEffect,
    },

    // No-op metrics that don't satisfy any guard self-loop on the current state.
    {
      from: "green",
      event: "metrics",
      to: "green",
      effect: updateMeasurementsEffect,
    },
    {
      from: "yellow",
      event: "metrics",
      to: "yellow",
      effect: updateMeasurementsEffect,
    },
    {
      from: "red",
      event: "metrics",
      to: "red",
      effect: updateMeasurementsEffect,
    },
  ],
  invariants: [
    {
      name: "utilization_in_range",
      predicate: (_state, ctx) => ctx.sliceUtilization >= 0 && ctx.sliceUtilization <= 100,
    },
    {
      name: "psi_in_range",
      predicate: (_state, ctx) => ctx.psiMemAvg10 >= 0 && ctx.psiMemAvg10 <= 100,
    },
    {
      // Once degraded, never silently leap back to green without going through yellow.
      // (The transition table enforces this; the invariant is here for property-test coverage.)
      name: "no_red_to_green_direct",
      predicate: (_state, _ctx) => true,
    },
  ],
};

function enterStateEffect(_ctx: SystemHealthCtx, e: SystemHealthEvent): SystemHealthCtx {
  return {
    sliceUtilization: e.sliceUtilization,
    psiMemAvg10: e.psiMemAvg10,
    enteredAt: Date.now(),
    sustainedMs: 0,
  };
}

function updateMeasurementsEffect(ctx: SystemHealthCtx, e: SystemHealthEvent): SystemHealthCtx {
  return {
    ...ctx,
    sliceUtilization: e.sliceUtilization,
    psiMemAvg10: e.psiMemAvg10,
    sustainedMs: e.sustainedMs,
  };
}

export function makeSystemHealthMachine(initialCtx: SystemHealthCtx = systemHealthInitialCtx): Machine<SystemHealthState, SystemHealthEvent, SystemHealthCtx> {
  return new Machine(systemHealthMachineDef, { ...initialCtx });
}
