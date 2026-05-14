// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { randomWalk } from "./lib";
import { makeSandboxMachine, SANDBOX_STATES, type SandboxEvent } from "./sandbox.machine";

const ALL_EVENTS: SandboxEvent[] = [
  { type: "create" },
  { type: "provisioning_done" },
  { type: "provisioning_failed", error: "ERR_PROVISIONING" },
  { type: "thread_attached" },
  { type: "thread_detached" },
  { type: "pool_scope_attached" },
  { type: "pool_scope_reaped" },
  { type: "idle_reap_due" },
  { type: "reap_done" },
  { type: "vps_hibernate" },
  { type: "vps_wake" },
  { type: "access" },
];

describe("sandbox state machine", () => {
  it("happy path: create → provisioning → warm", () => {
    const m = makeSandboxMachine();
    expect(m.current()).toBe("not_provisioned");
    expect(m.send({ type: "create" }).ok).toBe(true);
    expect(m.current()).toBe("provisioning");
    expect(m.send({ type: "provisioning_done" }).ok).toBe(true);
    expect(m.current()).toBe("warm");
    expect(m.context().sliceLive).toBe(true);
    expect(m.context().namespaceLive).toBe(true);
  });

  it("idle_reap_due rejected when threads or scopes attached", () => {
    const m = makeSandboxMachine();
    m.sendAll([{ type: "create" }, { type: "provisioning_done" }, { type: "thread_attached" }]);
    const r = m.send({ type: "idle_reap_due" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("guard_rejected");
    expect(m.current()).toBe("warm");
  });

  it("idle_reap_due accepted only when empty", () => {
    const m = makeSandboxMachine();
    m.sendAll([{ type: "create" }, { type: "provisioning_done" }]);
    expect(m.send({ type: "idle_reap_due" }).ok).toBe(true);
    expect(m.current()).toBe("reaping");
    expect(m.send({ type: "reap_done" }).ok).toBe(true);
    expect(m.current()).toBe("cold");
    expect(m.context().sliceLive).toBe(false);
  });

  it("vps_hibernate from any state goes to hibernated and clears resources", () => {
    for (const seed of [1, 7, 17, 23]) {
      const m = makeSandboxMachine();
      randomWalk(m, ALL_EVENTS, 30, seed);
      const r = m.send({ type: "vps_hibernate" });
      expect(r.ok).toBe(true);
      expect(m.current()).toBe("hibernated");
      expect(m.context().sliceLive).toBe(false);
      expect(m.context().namespaceLive).toBe(false);
      expect(m.context().warmThreads).toBe(0);
      expect(m.context().warmPoolScopes).toBe(0);
    }
  });

  it("provisioning_failed clears state and keeps error", () => {
    const m = makeSandboxMachine();
    m.send({ type: "create" });
    expect(m.send({ type: "provisioning_failed", error: "ERR_BOOT" }).ok).toBe(true);
    expect(m.current()).toBe("not_provisioned");
    expect(m.context().lastError).toBe("ERR_BOOT");
  });

  it("property: 1000 events × seeds preserve all invariants", () => {
    for (const seed of [1, 7, 13, 42, 99, 257, 1023, 4096, 65537, 99999]) {
      const m = makeSandboxMachine();
      expect(() => randomWalk(m, ALL_EVENTS, 1000, seed)).not.toThrow();
      // Cross-check the load-bearing invariants the machine enforces.
      const ctx = m.context();
      expect(ctx.warmPoolScopes).toBeGreaterThanOrEqual(0);
      expect(ctx.warmThreads).toBeGreaterThanOrEqual(0);
      if (m.current() === "warm") {
        expect(ctx.sliceLive).toBe(true);
        expect(ctx.namespaceLive).toBe(true);
      }
      if (m.current() === "cold" || m.current() === "not_provisioned" || m.current() === "hibernated") {
        expect(ctx.sliceLive).toBe(false);
        expect(ctx.namespaceLive).toBe(false);
      }
      if (m.current() === "reaping") {
        expect(ctx.warmThreads).toBe(0);
        expect(ctx.warmPoolScopes).toBe(0);
      }
    }
  });

  it("directed reachability: every documented state via explicit transitions", () => {
    const reached = new Set<string>();
    const cover = (events: SandboxEvent[]) => {
      const m = makeSandboxMachine();
      for (const e of events) {
        const r = m.send(e);
        expect(r.ok, `event ${e.type} from ${m.current()} expected to fire`).toBe(true);
      }
      for (const t of m.trace()) reached.add(t.state);
    };
    // not_provisioned (initial), provisioning, warm
    cover([{ type: "create" }, { type: "provisioning_done" }]);
    // reaping, cold (after reap_done)
    cover([
      { type: "create" },
      { type: "provisioning_done" },
      { type: "idle_reap_due" },
      { type: "reap_done" },
    ]);
    // hibernated (from any state via vps_hibernate)
    cover([{ type: "vps_hibernate" }]);
    for (const s of SANDBOX_STATES) expect(reached.has(s), `expected ${s} reachable`).toBe(true);
  });
});
