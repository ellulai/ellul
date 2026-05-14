// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import {
  makeSystemHealthMachine,
  SYSTEM_HEALTH_THRESHOLDS,
  type SystemHealthState,
} from "@vps/services/shared/state-machines";

export interface SystemHealthSnapshot {
  state: SystemHealthState;
  sliceUtilizationPct: number;
  psiMemAvg10: number;
  enteredAt: number;
  sustainedMs: number;
}

export interface MetricsTick {
  sliceUtilizationPct: number;
  psiMemAvg10: number;
}

export interface MetricsSource {
  subscribe(listener: (tick: MetricsTick) => void): () => void;
}

export interface SystemHealthDeps {
  metrics: MetricsSource;
  now?: () => number;
  emit?: (snap: SystemHealthSnapshot) => void;
}

export interface SystemHealth {
  current(): SystemHealthState;
  snapshot(): SystemHealthSnapshot;
  subscribe(l: (snap: SystemHealthSnapshot) => void): () => void;
  stop(): void;
}

export function makeSystemHealth(deps: SystemHealthDeps): SystemHealth {
  const now = deps.now ?? Date.now;
  const machine = makeSystemHealthMachine();
  const listeners = new Set<(snap: SystemHealthSnapshot) => void>();
  let lastTick: MetricsTick = { sliceUtilizationPct: 0, psiMemAvg10: 0 };
  let stateEnteredAt = now();
  let sustainedSinceMs = now();
  let prevTriggerHit = false;

  function snap(): SystemHealthSnapshot {
    return {
      state: machine.current(),
      sliceUtilizationPct: lastTick.sliceUtilizationPct,
      psiMemAvg10: lastTick.psiMemAvg10,
      enteredAt: stateEnteredAt,
      sustainedMs: now() - sustainedSinceMs,
    };
  }

  function fire(prev: SystemHealthState): void {
    const cur = machine.current();
    if (prev === cur) return;
    stateEnteredAt = now();
    sustainedSinceMs = now();
    prevTriggerHit = false;
    const s = snap();
    if (deps.emit) deps.emit(s);
    for (const l of listeners) {
      try { l(s); } catch { /* listener errors not fatal */ }
    }
  }

  function triggerForCurrent(util: number, psi: number): boolean {
    const t = SYSTEM_HEALTH_THRESHOLDS;
    switch (machine.current()) {
      case "green":
        return util >= t.yellowEnterUtilPct || psi >= t.yellowEnterPsiPct;
      case "yellow":
        return util >= t.redEnterUtilPct || psi >= t.redEnterPsiPct
          || (util < t.greenExitUtilPct && psi < t.greenExitPsiPct);
      case "red":
        return util < t.yellowExitUtilPct && psi < t.yellowExitPsiPct;
    }
  }

  const off = deps.metrics.subscribe((tick) => {
    lastTick = tick;
    const triggerHit = triggerForCurrent(tick.sliceUtilizationPct, tick.psiMemAvg10);
    if (triggerHit && !prevTriggerHit) sustainedSinceMs = now();
    prevTriggerHit = triggerHit;
    const sustainedMs = triggerHit ? now() - sustainedSinceMs : 0;
    const prev = machine.current();
    machine.send({
      type: "metrics",
      sliceUtilization: tick.sliceUtilizationPct,
      psiMemAvg10: tick.psiMemAvg10,
      sustainedMs,
    });
    fire(prev);
  });

  return {
    current() { return machine.current(); },
    snapshot: snap,
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    stop() { off(); listeners.clear(); },
  };
}
