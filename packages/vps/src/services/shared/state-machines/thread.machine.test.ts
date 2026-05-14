// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { randomWalk } from "./lib";
import { makeThreadMachine, THREAD_STATES, type ThreadEvent } from "./thread.machine";

const ALL_EVENTS: ThreadEvent[] = [
  { type: "open" },
  { type: "warm_done", poolScopeRef: "scope-1" },
  { type: "send_request", turnId: "t-1", queueAccepts: true, queuePosition: -1 },
  { type: "send_request", turnId: "t-1", queueAccepts: false, queuePosition: 2 },
  { type: "queue_dequeue", turnId: "t-1" },
  { type: "send_complete" },
  { type: "send_fail_recoverable", error: "ERR_RATE_LIMIT" },
  { type: "send_fail_terminal", error: "ERR_AUTH_TERMINAL" },
  { type: "recover" },
  { type: "pool_scope_lost" },
  { type: "archive" },
  { type: "unarchive" },
];

describe("thread state machine", () => {
  it("happy path: cold → warming → warm → sending → warm", () => {
    const m = makeThreadMachine();
    expect(m.current()).toBe("cold");

    expect(m.send({ type: "open" }).ok).toBe(true);
    expect(m.current()).toBe("warming");

    expect(m.send({ type: "warm_done", poolScopeRef: "scope-1" }).ok).toBe(true);
    expect(m.current()).toBe("warm");
    expect(m.context().poolScopeRef).toBe("scope-1");

    expect(m.send({ type: "send_request", turnId: "t-1", queueAccepts: true, queuePosition: -1 }).ok).toBe(true);
    expect(m.current()).toBe("sending");
    expect(m.context().activeTurnId).toBe("t-1");

    expect(m.send({ type: "send_complete" }).ok).toBe(true);
    expect(m.current()).toBe("warm");
    expect(m.context().activeTurnId).toBeNull();
  });

  it("queued path: warm → queued → sending", () => {
    const m = makeThreadMachine();
    m.sendAll([
      { type: "open" },
      { type: "warm_done", poolScopeRef: "scope-1" },
    ]);

    expect(m.send({ type: "send_request", turnId: "t-1", queueAccepts: false, queuePosition: 2 }).ok).toBe(true);
    expect(m.current()).toBe("queued");
    expect(m.context().queuePosition).toBe(2);

    expect(m.send({ type: "queue_dequeue", turnId: "t-1" }).ok).toBe(true);
    expect(m.current()).toBe("sending");
    expect(m.context().queuePosition).toBe(-1);
  });

  it("queue_dequeue rejected if turn id mismatches", () => {
    const m = makeThreadMachine();
    m.sendAll([
      { type: "open" },
      { type: "warm_done", poolScopeRef: "scope-1" },
      { type: "send_request", turnId: "t-1", queueAccepts: false, queuePosition: 2 },
    ]);
    const r = m.send({ type: "queue_dequeue", turnId: "t-WRONG" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("guard_rejected");
    expect(m.current()).toBe("queued");
  });

  it("error_recoverable preserves typed error code", () => {
    const m = makeThreadMachine();
    m.sendAll([
      { type: "open" },
      { type: "warm_done", poolScopeRef: "s" },
      { type: "send_request", turnId: "t", queueAccepts: true, queuePosition: -1 },
      { type: "send_fail_recoverable", error: "ERR_RATE_LIMIT" },
    ]);
    expect(m.current()).toBe("error_recoverable");
    expect(m.context().lastError).toBe("ERR_RATE_LIMIT");
    expect(m.send({ type: "recover" }).ok).toBe(true);
    expect(m.current()).toBe("warm");
    expect(m.context().lastError).toBeNull();
  });

  it("pool_scope_lost from any active state goes to warming with scope cleared", () => {
    for (const startEvents of [
      [{ type: "open" }, { type: "warm_done", poolScopeRef: "s" }] as const,
      [
        { type: "open" } as const,
        { type: "warm_done", poolScopeRef: "s" } as const,
        { type: "send_request", turnId: "t", queueAccepts: true, queuePosition: -1 } as const,
      ],
    ]) {
      const m = makeThreadMachine();
      m.sendAll([...startEvents]);
      const r = m.send({ type: "pool_scope_lost" });
      expect(r.ok).toBe(true);
      expect(m.current()).toBe("warming");
      expect(m.context().poolScopeRef).toBeNull();
      expect(m.context().activeTurnId).toBeNull();
    }
  });

  it("archive from any non-archived state succeeds and zeros bindings", () => {
    for (const seed of [1, 2, 3]) {
      const m = makeThreadMachine();
      randomWalk(m, ALL_EVENTS, 50, seed);
      const stateBefore = m.current();
      const r = m.send({ type: "archive" });
      if (stateBefore === "archived") {
        expect(r.ok).toBe(true); // archive→archive transition is fine via *
      } else {
        expect(r.ok).toBe(true);
        expect(m.current()).toBe("archived");
      }
      expect(m.context().poolScopeRef).toBeNull();
      expect(m.context().activeTurnId).toBeNull();
      expect(m.context().archivedAt).toBeGreaterThan(0);
    }
  });

  // ── Property: every reachable trace satisfies every invariant ──
  it("property: 1000 random events × 20 seeds preserve all invariants", () => {
    for (const seed of [1, 7, 13, 42, 99, 257, 1023, 4096, 65537, 99999, 11, 17, 19, 23, 29, 31, 37, 41, 43, 47]) {
      const m = makeThreadMachine();
      expect(() => randomWalk(m, ALL_EVENTS, 1000, seed)).not.toThrow();
      // The brief's load-bearing invariant: sending → poolScopeRef !== null
      if (m.current() === "sending") {
        expect(m.context().poolScopeRef).not.toBeNull();
        expect(m.context().activeTurnId).not.toBeNull();
      }
    }
  });

  it("directed reachability: every documented state via explicit transitions", () => {
    const reached = new Set<string>();
    // Helper: drive a fresh machine through a sequence and union its trace.
    const cover = (events: ThreadEvent[]) => {
      const m = makeThreadMachine();
      for (const e of events) {
        const r = m.send(e);
        // Reachability is a positive claim — every event in the path must succeed.
        expect(r.ok, `event ${e.type} from ${m.current()} expected to fire`).toBe(true);
      }
      for (const t of m.trace()) reached.add(t.state);
    };
    // cold (initial), warming, warm, sending
    cover([
      { type: "open" },
      { type: "warm_done", poolScopeRef: "s" },
      { type: "send_request", turnId: "t", queueAccepts: true, queuePosition: -1 },
    ]);
    // queued
    cover([
      { type: "open" },
      { type: "warm_done", poolScopeRef: "s" },
      { type: "send_request", turnId: "t", queueAccepts: false, queuePosition: 1 },
    ]);
    // error_recoverable
    cover([
      { type: "open" },
      { type: "warm_done", poolScopeRef: "s" },
      { type: "send_request", turnId: "t", queueAccepts: true, queuePosition: -1 },
      { type: "send_fail_recoverable", error: "ERR_RATE_LIMIT" },
    ]);
    // error_terminal
    cover([
      { type: "open" },
      { type: "warm_done", poolScopeRef: "s" },
      { type: "send_request", turnId: "t", queueAccepts: true, queuePosition: -1 },
      { type: "send_fail_terminal", error: "ERR_AUTH_TERMINAL" },
    ]);
    // archived
    cover([{ type: "archive" }]);
    for (const s of THREAD_STATES) expect(reached.has(s), `expected ${s} reachable`).toBe(true);
  });

  it("property: a thread in `sending` always has a live scope (the brief's hard invariant)", () => {
    for (const seed of [11, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]) {
      const m = makeThreadMachine();
      const events: ThreadEvent[] = [...ALL_EVENTS];
      // Walk and at every step verify the invariant on the live machine.
      let s = seed >>> 0;
      for (let i = 0; i < 500; i++) {
        s = (s * 1103515245 + 12345) >>> 0;
        const e = events[s % events.length]!;
        m.send(e); // throws on invariant violation
        if (m.current() === "sending") {
          expect(m.context().poolScopeRef).not.toBeNull();
          expect(m.context().activeTurnId).not.toBeNull();
        }
      }
    }
  });
});
