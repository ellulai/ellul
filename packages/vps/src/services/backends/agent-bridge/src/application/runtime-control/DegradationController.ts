// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { SystemHealth, SystemHealthSnapshot } from "./SystemHealth";

export interface DegradationDeps {
  health: SystemHealth;
  compactor: { runNow(opts: { keepLastN: number; reason: "yellow_mode" }): Promise<unknown> };
  poolManager: { evictColdScopes(reason: string): Promise<void> };
  previewKeepalive: { setIdleThresholdMs(ms: number): void };
  admission: { setRedMode(on: boolean): void };
  defaults?: { previewIdleMs?: number };
  emit?: (event: { event: string; from?: string; to?: string }) => void;
}

const DEFAULT_PREVIEW_IDLE_MS = 8 * 60 * 1000;
const YELLOW_PREVIEW_IDLE_MS = 4 * 60 * 1000;

export interface DegradationController {
  start(): void;
  stop(): void;
}

export function makeDegradationController(deps: DegradationDeps): DegradationController {
  const previewIdleDefault = deps.defaults?.previewIdleMs ?? DEFAULT_PREVIEW_IDLE_MS;
  const emit = deps.emit ?? (() => {});
  let off: (() => void) | null = null;
  let prev = deps.health.current();

  function onEnter(state: SystemHealthSnapshot["state"]): void {
    if (state === "yellow") {
      deps.previewKeepalive.setIdleThresholdMs(YELLOW_PREVIEW_IDLE_MS);
      deps.compactor.runNow({ keepLastN: 4, reason: "yellow_mode" }).catch(() => {});
      deps.poolManager.evictColdScopes("yellow_mode").catch(() => {});
    } else if (state === "red") {
      deps.admission.setRedMode(true);
    } else if (state === "green") {
      deps.previewKeepalive.setIdleThresholdMs(previewIdleDefault);
      deps.admission.setRedMode(false);
    }
  }

  function onExit(state: SystemHealthSnapshot["state"]): void {
    if (state === "red") {
      deps.admission.setRedMode(false);
    } else if (state === "yellow") {
      deps.previewKeepalive.setIdleThresholdMs(previewIdleDefault);
    }
  }

  return {
    start() {
      off = deps.health.subscribe((snap) => {
        if (snap.state === prev) return;
        emit({ event: "degradation.transition", from: prev, to: snap.state });
        onExit(prev);
        onEnter(snap.state);
        prev = snap.state;
      });
    },
    stop() { if (off) off(); },
  };
}
