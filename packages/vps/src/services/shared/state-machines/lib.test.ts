// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { InvariantViolationError, Machine, randomWalk, type MachineDef } from "./lib";

type S = "a" | "b" | "c";
type E = { type: "go" } | { type: "back" } | { type: "noop" };
interface Ctx {
  count: number;
}

const def: MachineDef<S, E, Ctx> = {
  id: "test",
  initial: "a",
  transitions: [
    // Guards prevent counter-runaway so the invariants hold over arbitrary walks.
    { from: "a", event: "go", to: "b", guard: (c) => c.count < 2, effect: (c) => ({ ...c, count: c.count + 1 }) },
    { from: "b", event: "go", to: "c", guard: (c) => c.count < 2, effect: (c) => ({ ...c, count: c.count + 1 }) },
    { from: "b", event: "back", to: "a", guard: (c) => c.count > 0, effect: (c) => ({ ...c, count: c.count - 1 }) },
    { from: "c", event: "back", to: "b" },
  ],
  invariants: [
    { name: "count_non_negative", predicate: (_s, c) => c.count >= 0 },
    { name: "count_le_two", predicate: (_s, c) => c.count <= 2 },
  ],
};

describe("Machine", () => {
  it("starts in initial state with initial context", () => {
    const m = new Machine(def, { count: 0 });
    expect(m.current()).toBe("a");
    expect(m.context().count).toBe(0);
  });

  it("transitions on send and applies effect", () => {
    const m = new Machine(def, { count: 0 });
    const r = m.send({ type: "go" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.from).toBe("a");
      expect(r.to).toBe("b");
    }
    expect(m.current()).toBe("b");
    expect(m.context().count).toBe(1);
  });

  it("returns no_transition when event has no matching from", () => {
    const m = new Machine(def, { count: 0 });
    const r = m.send({ type: "back" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no_transition");
      expect(r.current).toBe("a");
    }
    expect(m.current()).toBe("a");
  });

  it("throws InvariantViolationError when an invariant is violated", () => {
    const m = new Machine(def, { count: 0 });
    expect(m.send({ type: "go" }).ok).toBe(true);
    expect(m.send({ type: "go" }).ok).toBe(true);
    // Now count = 2 — at the cap. One more "go" would fail count_le_two,
    // but there's no transition from "c" with event "go". Force an invariant
    // violation by injecting a transition that breaks count_le_two.
    const breakingDef: MachineDef<S, E, Ctx> = {
      ...def,
      transitions: [
        ...def.transitions,
        { from: "c", event: "go", to: "a", effect: (c) => ({ ...c, count: c.count + 1 }) },
      ],
    };
    const m2 = new Machine(breakingDef, { count: 0 });
    expect(m2.send({ type: "go" }).ok).toBe(true);
    expect(m2.send({ type: "go" }).ok).toBe(true);
    expect(() => m2.send({ type: "go" })).toThrow(InvariantViolationError);
  });

  it("trace records every transition with timestamps", () => {
    const m = new Machine(def, { count: 0 });
    m.send({ type: "go" });
    m.send({ type: "back" });
    const t = m.trace();
    expect(t.length).toBe(3);
    expect(t.map((x) => x.state)).toEqual(["a", "b", "a"]);
    expect(t.map((x) => x.event)).toEqual(["@@init", "go", "back"]);
    for (const e of t) expect(typeof e.at).toBe("number");
  });

  it("randomWalk preserves invariants over 1000 steps with arbitrary seeds", () => {
    const events: E[] = [{ type: "go" }, { type: "back" }, { type: "noop" as "noop" }];
    for (const seed of [1, 2, 3, 4, 7, 13, 42, 99, 1023, 65537]) {
      const m = new Machine(def, { count: 0 });
      // Should never throw — invariants hold across all reachable states.
      expect(() => randomWalk(m, events, 1000, seed)).not.toThrow();
      // Final state is reachable.
      expect(["a", "b", "c"].includes(m.current())).toBe(true);
      // Context never dropped below 0 nor above 2.
      expect(m.context().count).toBeGreaterThanOrEqual(0);
      expect(m.context().count).toBeLessThanOrEqual(2);
    }
  });
});
