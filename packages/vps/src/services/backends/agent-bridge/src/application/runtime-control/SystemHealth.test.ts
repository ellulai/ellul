// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { makeSystemHealth, type MetricsSource, type MetricsTick, type SystemHealthSnapshot } from "./SystemHealth";

function makeSource(): MetricsSource & { fire: (t: MetricsTick) => void } {
  const listeners: Array<(t: MetricsTick) => void> = [];
  return {
    fire(t) { for (const l of listeners) l(t); },
    subscribe(l) { listeners.push(l); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; },
  };
}

describe("SystemHealth", () => {
  it("starts green; transitions to yellow only after sustained pressure", () => {
    let t = 0;
    const src = makeSource();
    const h = makeSystemHealth({ metrics: src, now: () => t });

    src.fire({ sliceUtilizationPct: 75, psiMemAvg10: 0 });
    expect(h.current()).toBe("green");

    t = 31_000;
    src.fire({ sliceUtilizationPct: 75, psiMemAvg10: 0 });
    expect(h.current()).toBe("yellow");
  });

  it("yellow → red on sustained higher pressure", () => {
    let t = 0;
    const src = makeSource();
    const h = makeSystemHealth({ metrics: src, now: () => t });

    src.fire({ sliceUtilizationPct: 80, psiMemAvg10: 0 });
    t = 31_000;
    src.fire({ sliceUtilizationPct: 80, psiMemAvg10: 0 });
    expect(h.current()).toBe("yellow");

    t = 31_001;
    src.fire({ sliceUtilizationPct: 92, psiMemAvg10: 0 });
    t = 47_000;
    src.fire({ sliceUtilizationPct: 92, psiMemAvg10: 0 });
    expect(h.current()).toBe("red");
  });

  it("subscribers fire only on state changes, not every tick", () => {
    let t = 0;
    const src = makeSource();
    const h = makeSystemHealth({ metrics: src, now: () => t });

    let calls = 0;
    h.subscribe(() => { calls++; });

    for (let i = 0; i < 10; i++) {
      t = i * 100;
      src.fire({ sliceUtilizationPct: 10, psiMemAvg10: 0 });
    }
    expect(calls).toBe(0);

    src.fire({ sliceUtilizationPct: 75, psiMemAvg10: 0 });
    t = 31_000;
    src.fire({ sliceUtilizationPct: 75, psiMemAvg10: 0 });
    expect(calls).toBe(1);
  });

  it("snapshot reports last metrics + state-entry timestamp", () => {
    let t = 1000;
    const src = makeSource();
    const h = makeSystemHealth({ metrics: src, now: () => t });

    src.fire({ sliceUtilizationPct: 80, psiMemAvg10: 12 });
    const s = h.snapshot();
    expect(s.sliceUtilizationPct).toBe(80);
    expect(s.psiMemAvg10).toBe(12);
    expect(s.state).toBe("green");
  });
});
