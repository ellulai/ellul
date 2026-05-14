// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { makeDegradationController } from "./DegradationController";
import type { SystemHealth, SystemHealthSnapshot } from "./SystemHealth";

function fakeHealth(initial: SystemHealthSnapshot["state"] = "green"): SystemHealth & { setState: (s: SystemHealthSnapshot["state"]) => void } {
  let state: SystemHealthSnapshot["state"] = initial;
  const subs: Array<(s: SystemHealthSnapshot) => void> = [];
  return {
    current: () => state,
    snapshot: () => ({ state, sliceUtilizationPct: 0, psiMemAvg10: 0, enteredAt: 0, sustainedMs: 0 }),
    subscribe: (l) => { subs.push(l); return () => { const i = subs.indexOf(l); if (i >= 0) subs.splice(i, 1); }; },
    stop: () => {},
    setState(s) {
      state = s;
      for (const l of subs) l({ state, sliceUtilizationPct: 0, psiMemAvg10: 0, enteredAt: 0, sustainedMs: 0 });
    },
  };
}

function fakeDeps() {
  const compactCalls: Array<{ keepLastN: number; reason: string }> = [];
  const poolEvicts: string[] = [];
  const idleSetCalls: number[] = [];
  const redModeCalls: boolean[] = [];
  const events: Array<{ from: string; to: string }> = [];
  return {
    compactCalls,
    poolEvicts,
    idleSetCalls,
    redModeCalls,
    events,
    deps: {
      compactor: { async runNow(opts: { keepLastN: number; reason: "yellow_mode" }) { compactCalls.push(opts); } },
      poolManager: { async evictColdScopes(reason: string) { poolEvicts.push(reason); } },
      previewKeepalive: { setIdleThresholdMs: (ms: number) => idleSetCalls.push(ms) },
      admission: { setRedMode: (on: boolean) => redModeCalls.push(on) },
      emit: (e: { event: string; from?: string; to?: string }) => { events.push({ from: e.from!, to: e.to! }); },
    },
  };
}

describe("DegradationController", () => {
  it("green → yellow fires compactor + evict + tighten preview idle", () => {
    const health = fakeHealth("green");
    const { deps, compactCalls, poolEvicts, idleSetCalls, events } = fakeDeps();
    makeDegradationController({ health, ...deps }).start();
    health.setState("yellow");
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]!.keepLastN).toBe(4);
    expect(poolEvicts).toEqual(["yellow_mode"]);
    expect(idleSetCalls).toEqual([4 * 60 * 1000]);
    expect(events).toEqual([{ from: "green", to: "yellow" }]);
  });

  it("yellow → red enables admission red mode", () => {
    const health = fakeHealth("yellow");
    const { deps, redModeCalls } = fakeDeps();
    makeDegradationController({ health, ...deps }).start();
    health.setState("red");
    expect(redModeCalls).toEqual([true]);
  });

  it("red → yellow disables admission red mode", () => {
    const health = fakeHealth("red");
    const { deps, redModeCalls } = fakeDeps();
    makeDegradationController({ health, ...deps }).start();
    health.setState("yellow");
    expect(redModeCalls).toEqual([false]);
  });

  it("yellow → green resets preview idle to default", () => {
    const health = fakeHealth("yellow");
    const { deps, idleSetCalls } = fakeDeps();
    makeDegradationController({ health, ...deps, defaults: { previewIdleMs: 8 * 60 * 1000 } }).start();
    health.setState("green");
    expect(idleSetCalls).toContain(8 * 60 * 1000);
  });

  it("no actions on same-state events", () => {
    const health = fakeHealth("green");
    const { deps, compactCalls, poolEvicts, idleSetCalls, redModeCalls } = fakeDeps();
    makeDegradationController({ health, ...deps }).start();
    health.setState("green");
    expect(compactCalls).toHaveLength(0);
    expect(poolEvicts).toHaveLength(0);
    expect(idleSetCalls).toHaveLength(0);
    expect(redModeCalls).toHaveLength(0);
  });
});
