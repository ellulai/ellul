// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { randomWalk } from "./lib";
import { makePreviewMachine, PREVIEW_STATES, type PreviewEvent } from "./preview.machine";

const ALL_EVENTS: PreviewEvent[] = [
  { type: "framework_detected", frameworkId: "next" },
  { type: "framework_lost" },
  { type: "start_admitted", effectiveCapMB: 820, admissionId: "adm-1" },
  { type: "ready_hot" },
  { type: "ready_warm" },
  { type: "demote" },
  { type: "demote_done" },
  { type: "promote" },
  { type: "promote_done" },
  { type: "stop" },
  { type: "stop_done" },
  { type: "failure", error: "ERR_PORT_BIND_TIMEOUT" },
  { type: "recover" },
  { type: "activity_observed", at: 1700000000000 },
];

describe("preview state machine", () => {
  it("happy path: disabled → cold → starting → hot → demoting → warm → stopping → cold", () => {
    const m = makePreviewMachine();
    expect(m.current()).toBe("disabled");
    expect(m.send({ type: "framework_detected", frameworkId: "next" }).ok).toBe(true);
    expect(m.current()).toBe("cold");
    expect(m.send({ type: "start_admitted", effectiveCapMB: 820, admissionId: "adm-1" }).ok).toBe(true);
    expect(m.current()).toBe("starting");
    expect(m.context().effectiveCapMB).toBe(820);
    expect(m.send({ type: "ready_hot" }).ok).toBe(true);
    expect(m.current()).toBe("hot");
    expect(m.send({ type: "demote" }).ok).toBe(true);
    expect(m.send({ type: "demote_done" }).ok).toBe(true);
    expect(m.current()).toBe("warm");
    expect(m.send({ type: "stop" }).ok).toBe(true);
    expect(m.send({ type: "stop_done" }).ok).toBe(true);
    expect(m.current()).toBe("cold");
    expect(m.context().effectiveCapMB).toBe(0);
    expect(m.context().unitRunning).toBe(false);
  });

  it("framework_lost from any state resets to disabled", () => {
    for (const seed of [1, 7, 13]) {
      const m = makePreviewMachine();
      randomWalk(m, ALL_EVENTS, 100, seed);
      const r = m.send({ type: "framework_lost" });
      expect(r.ok).toBe(true);
      expect(m.current()).toBe("disabled");
      expect(m.context().frameworkId).toBeNull();
      expect(m.context().effectiveCapMB).toBe(0);
    }
  });

  it("failure preserves typed error code", () => {
    const m = makePreviewMachine();
    m.sendAll([
      { type: "framework_detected", frameworkId: "next" },
      { type: "start_admitted", effectiveCapMB: 820, admissionId: "adm-1" },
    ]);
    expect(m.send({ type: "failure", error: "ERR_PORT_BIND_TIMEOUT" }).ok).toBe(true);
    expect(m.current()).toBe("failed");
    expect(m.context().lastError).toBe("ERR_PORT_BIND_TIMEOUT");
    expect(m.send({ type: "recover" }).ok).toBe(true);
    expect(m.current()).toBe("cold");
  });

  it("activity_observed updates lastActivityAt without changing state", () => {
    const m = makePreviewMachine();
    m.sendAll([
      { type: "framework_detected", frameworkId: "next" },
      { type: "start_admitted", effectiveCapMB: 820, admissionId: "adm-1" },
      { type: "ready_hot" },
    ]);
    const r = m.send({ type: "activity_observed", at: 1234567890 });
    expect(r.ok).toBe(true);
    expect(m.current()).toBe("hot");
    expect(m.context().lastActivityAt).toBe(1234567890);
  });

  it("property: 1000 events × seeds preserve all invariants", () => {
    for (const seed of [1, 7, 13, 42, 99, 257, 1023, 4096, 65537, 99999]) {
      const m = makePreviewMachine();
      expect(() => randomWalk(m, ALL_EVENTS, 1000, seed)).not.toThrow();
      // Cross-check load-bearing invariants.
      const state = m.current();
      const ctx = m.context();
      const isActive = ["starting", "hot", "warm", "demoting", "promoting", "stopping"].includes(state);
      expect(ctx.unitRunning).toBe(isActive);
      if (state === "cold") expect(ctx.effectiveCapMB).toBe(0);
      if (state === "disabled") expect(ctx.frameworkId).toBeNull();
      if (state === "failed") expect(ctx.lastError).not.toBeNull();
    }
  });

  it("directed reachability: every documented state via explicit transitions", () => {
    const reached = new Set<string>();
    const cover = (events: PreviewEvent[]) => {
      const m = makePreviewMachine();
      for (const e of events) {
        const r = m.send(e);
        expect(r.ok, `event ${e.type} from ${m.current()} expected to fire`).toBe(true);
      }
      for (const t of m.trace()) reached.add(t.state);
    };
    // disabled (initial), cold, starting, hot
    cover([
      { type: "framework_detected", frameworkId: "next" },
      { type: "start_admitted", effectiveCapMB: 820, admissionId: "adm-1" },
      { type: "ready_hot" },
    ]);
    // warm, demoting (warm via demote_done; demoting via demote)
    cover([
      { type: "framework_detected", frameworkId: "next" },
      { type: "start_admitted", effectiveCapMB: 820, admissionId: "adm-1" },
      { type: "ready_hot" },
      { type: "demote" },
      { type: "demote_done" },
    ]);
    // promoting
    cover([
      { type: "framework_detected", frameworkId: "next" },
      { type: "start_admitted", effectiveCapMB: 820, admissionId: "adm-1" },
      { type: "ready_warm" },
      { type: "promote" },
    ]);
    // stopping
    cover([
      { type: "framework_detected", frameworkId: "next" },
      { type: "start_admitted", effectiveCapMB: 820, admissionId: "adm-1" },
      { type: "ready_hot" },
      { type: "stop" },
    ]);
    // failed
    cover([
      { type: "framework_detected", frameworkId: "next" },
      { type: "start_admitted", effectiveCapMB: 820, admissionId: "adm-1" },
      { type: "failure", error: "ERR_PORT_BIND_TIMEOUT" },
    ]);
    for (const s of PREVIEW_STATES) expect(reached.has(s), `expected ${s} reachable`).toBe(true);
  });
});
