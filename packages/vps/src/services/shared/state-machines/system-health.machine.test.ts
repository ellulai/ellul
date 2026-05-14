// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { randomWalk } from "./lib";
import {
  makeSystemHealthMachine,
  SYSTEM_HEALTH_THRESHOLDS,
  SYSTEM_HEALTH_STATES,
  type SystemHealthEvent,
} from "./system-health.machine";

describe("system health state machine", () => {
  it("starts in green", () => {
    const m = makeSystemHealthMachine();
    expect(m.current()).toBe("green");
  });

  it("green → yellow on sustained pressure (utilization)", () => {
    const m = makeSystemHealthMachine();
    const r = m.send({
      type: "metrics",
      sliceUtilization: SYSTEM_HEALTH_THRESHOLDS.yellowEnterUtilPct,
      psiMemAvg10: 0,
      sustainedMs: SYSTEM_HEALTH_THRESHOLDS.yellowEnterSustainedMs,
    });
    expect(r.ok).toBe(true);
    expect(m.current()).toBe("yellow");
  });

  it("green → yellow on sustained PSI", () => {
    const m = makeSystemHealthMachine();
    const r = m.send({
      type: "metrics",
      sliceUtilization: 50,
      psiMemAvg10: SYSTEM_HEALTH_THRESHOLDS.yellowEnterPsiPct + 1,
      sustainedMs: SYSTEM_HEALTH_THRESHOLDS.yellowEnterSustainedMs,
    });
    expect(r.ok).toBe(true);
    expect(m.current()).toBe("yellow");
  });

  it("green stays green when threshold met but not sustained", () => {
    const m = makeSystemHealthMachine();
    m.send({
      type: "metrics",
      sliceUtilization: SYSTEM_HEALTH_THRESHOLDS.yellowEnterUtilPct + 5,
      psiMemAvg10: 0,
      sustainedMs: 0, // not sustained
    });
    expect(m.current()).toBe("green");
  });

  it("yellow → red on sustained higher pressure", () => {
    const m = makeSystemHealthMachine();
    m.send({
      type: "metrics",
      sliceUtilization: SYSTEM_HEALTH_THRESHOLDS.yellowEnterUtilPct + 5,
      psiMemAvg10: 0,
      sustainedMs: SYSTEM_HEALTH_THRESHOLDS.yellowEnterSustainedMs,
    });
    expect(m.current()).toBe("yellow");
    m.send({
      type: "metrics",
      sliceUtilization: SYSTEM_HEALTH_THRESHOLDS.redEnterUtilPct + 2,
      psiMemAvg10: 0,
      sustainedMs: SYSTEM_HEALTH_THRESHOLDS.redEnterSustainedMs,
    });
    expect(m.current()).toBe("red");
  });

  it("hysteresis: red → yellow → green never red → green directly", () => {
    const m = makeSystemHealthMachine();
    // Drive to red
    m.send({
      type: "metrics",
      sliceUtilization: 75,
      psiMemAvg10: 0,
      sustainedMs: SYSTEM_HEALTH_THRESHOLDS.yellowEnterSustainedMs,
    });
    m.send({
      type: "metrics",
      sliceUtilization: 92,
      psiMemAvg10: 0,
      sustainedMs: SYSTEM_HEALTH_THRESHOLDS.redEnterSustainedMs,
    });
    expect(m.current()).toBe("red");
    // Now drop to a low value with high sustainedMs.
    // From red, machine ONLY allows red→yellow (no transition red→green
    // is defined). So even if sustained, it goes red→yellow first.
    m.send({
      type: "metrics",
      sliceUtilization: 10,
      psiMemAvg10: 0,
      sustainedMs: 1_000_000,
    });
    expect(m.current()).toBe("yellow");
    m.send({
      type: "metrics",
      sliceUtilization: 5,
      psiMemAvg10: 0,
      sustainedMs: SYSTEM_HEALTH_THRESHOLDS.greenExitSustainedMs,
    });
    expect(m.current()).toBe("green");
  });

  it("property: random metrics never violate invariants", () => {
    for (const seed of [1, 7, 13, 42, 99, 257, 1023, 4096, 65537, 99999]) {
      const m = makeSystemHealthMachine();
      let s = seed >>> 0;
      let lastState = m.current();
      for (let i = 0; i < 1000; i++) {
        s = (s * 1103515245 + 12345) >>> 0;
        // Use unsigned shifts (>>>) — JS >> is signed; on s > 0x7FFFFFFF it
        // produces negatives that propagate to negative percentages and
        // legitimately violate the in-range invariant.
        const e: SystemHealthEvent = {
          type: "metrics",
          sliceUtilization: s % 101,
          psiMemAvg10: (s >>> 8) % 101,
          sustainedMs: (s >>> 16) % 90_000,
        };
        m.send(e);
        // Hard property: can never observe red → green direct transition.
        const cur = m.current();
        if (lastState === "red") expect(cur === "red" || cur === "yellow").toBe(true);
        if (lastState === "green") expect(cur === "green" || cur === "yellow").toBe(true);
        lastState = cur;
      }
    }
  });

  it("property: every documented state is reachable", () => {
    const reached = new Set<string>();
    for (const seed of Array.from({ length: 60 }, (_, i) => i * 19 + 1)) {
      const m = makeSystemHealthMachine();
      let s = seed >>> 0;
      for (let i = 0; i < 400; i++) {
        s = (s * 1103515245 + 12345) >>> 0;
        m.send({
          type: "metrics",
          sliceUtilization: s % 101,
          psiMemAvg10: (s >>> 8) % 101,
          sustainedMs: (s >>> 16) % 90_000,
        });
      }
      for (const e of m.trace()) reached.add(e.state);
    }
    for (const st of SYSTEM_HEALTH_STATES) expect(reached.has(st), `expected ${st} reachable`).toBe(true);
  });

  it("directed reachability: every documented state via explicit transitions", () => {
    const m = makeSystemHealthMachine();
    expect(m.current()).toBe("green");
    m.send({
      type: "metrics",
      sliceUtilization: 75,
      psiMemAvg10: 0,
      sustainedMs: SYSTEM_HEALTH_THRESHOLDS.yellowEnterSustainedMs,
    });
    expect(m.current()).toBe("yellow");
    m.send({
      type: "metrics",
      sliceUtilization: 95,
      psiMemAvg10: 0,
      sustainedMs: SYSTEM_HEALTH_THRESHOLDS.redEnterSustainedMs,
    });
    expect(m.current()).toBe("red");
  });
});
