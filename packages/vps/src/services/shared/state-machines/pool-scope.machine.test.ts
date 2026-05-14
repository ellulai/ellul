// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { randomWalk } from "./lib";
import { makePoolScopeMachine, POOL_SCOPE_STATES, type PoolScopeEvent } from "./pool-scope.machine";

const ALL_EVENTS: PoolScopeEvent[] = [
  { type: "acquire" },
  { type: "spawn_done", processPid: 9999 },
  { type: "release" },
  { type: "session_send_start" },
  { type: "session_send_complete" },
  { type: "idle_reap_due" },
  { type: "reap_done" },
  { type: "process_died", error: "ERR_DAEMON_DIED" },
];

describe("pool scope state machine", () => {
  it("acquire: cold → spawning → warm; refCount tracked", () => {
    const m = makePoolScopeMachine();
    expect(m.send({ type: "acquire" }).ok).toBe(true);
    expect(m.current()).toBe("spawning");
    expect(m.context().refCount).toBe(1);
    expect(m.send({ type: "spawn_done", processPid: 9999 }).ok).toBe(true);
    expect(m.current()).toBe("warm");
    expect(m.context().processPid).toBe(9999);

    // Second acquire while warm increments refCount.
    expect(m.send({ type: "acquire" }).ok).toBe(true);
    expect(m.current()).toBe("warm");
    expect(m.context().refCount).toBe(2);
  });

  it("inferring counts inflight, returns to warm when last completes", () => {
    const m = makePoolScopeMachine();
    m.sendAll([{ type: "acquire" }, { type: "spawn_done", processPid: 9999 }]);
    m.send({ type: "session_send_start" });
    expect(m.current()).toBe("inferring");
    expect(m.context().inflight).toBe(1);
    m.send({ type: "session_send_start" });
    expect(m.context().inflight).toBe(2);
    m.send({ type: "session_send_complete" });
    expect(m.current()).toBe("inferring");
    expect(m.context().inflight).toBe(1);
    m.send({ type: "session_send_complete" });
    expect(m.current()).toBe("warm");
    expect(m.context().inflight).toBe(0);
  });

  it("idle_reap_due rejected if refCount > 0 or inflight > 0", () => {
    const m = makePoolScopeMachine();
    m.sendAll([{ type: "acquire" }, { type: "spawn_done", processPid: 9999 }]);
    expect(m.context().refCount).toBe(1);
    const r = m.send({ type: "idle_reap_due" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("guard_rejected");

    m.send({ type: "release" });
    expect(m.context().refCount).toBe(0);
    expect(m.send({ type: "idle_reap_due" }).ok).toBe(true);
    expect(m.current()).toBe("reaping");
    expect(m.send({ type: "reap_done" }).ok).toBe(true);
    expect(m.current()).toBe("cold");
    expect(m.context().processPid).toBeNull();
  });

  it("process_died collapses to cold and zeros refCount/inflight", () => {
    const m = makePoolScopeMachine();
    m.sendAll([
      { type: "acquire" },
      { type: "spawn_done", processPid: 9999 },
      { type: "session_send_start" },
    ]);
    expect(m.send({ type: "process_died", error: "ERR_DAEMON_DIED" }).ok).toBe(true);
    expect(m.current()).toBe("cold");
    expect(m.context().refCount).toBe(0);
    expect(m.context().inflight).toBe(0);
    expect(m.context().lastError).toBe("ERR_DAEMON_DIED");
  });

  it("property: 1000 events × seeds preserve all invariants", () => {
    for (const seed of [1, 7, 13, 42, 99, 257, 1023, 4096, 65537, 99999]) {
      const m = makePoolScopeMachine();
      expect(() => randomWalk(m, ALL_EVENTS, 1000, seed)).not.toThrow();
      const ctx = m.context();
      expect(ctx.refCount).toBeGreaterThanOrEqual(0);
      expect(ctx.inflight).toBeGreaterThanOrEqual(0);
      if (m.current() === "warm") {
        expect(ctx.processPid).not.toBeNull();
        expect(ctx.inflight).toBe(0);
      }
      if (m.current() === "cold") expect(ctx.processPid).toBeNull();
      if (m.current() === "reaping") {
        expect(ctx.refCount).toBe(0);
        expect(ctx.inflight).toBe(0);
      }
    }
  });

  it("directed reachability: every documented state via explicit transitions", () => {
    const reached = new Set<string>();
    const cover = (events: PoolScopeEvent[]) => {
      const m = makePoolScopeMachine();
      for (const e of events) {
        const r = m.send(e);
        expect(r.ok, `event ${e.type} from ${m.current()} expected to fire`).toBe(true);
      }
      for (const t of m.trace()) reached.add(t.state);
    };
    // cold (initial), spawning, warm, inferring, reaping, cold (post-reap)
    cover([
      { type: "acquire" },
      { type: "spawn_done", processPid: 9999 },
      { type: "session_send_start" },
      { type: "session_send_complete" },
      { type: "release" },
      { type: "idle_reap_due" },
      { type: "reap_done" },
    ]);
    for (const s of POOL_SCOPE_STATES) expect(reached.has(s), `expected ${s} reachable`).toBe(true);
  });
});
