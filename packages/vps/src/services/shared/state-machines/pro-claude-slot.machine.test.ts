// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { randomWalk } from "./lib";
import { makeProClaudeSlotMachine, PRO_CLAUDE_SLOT_STATES, type ProClaudeSlotEvent } from "./pro-claude-slot.machine";

const ALL_EVENTS: ProClaudeSlotEvent[] = [
  { type: "bind", threadId: "t-1", resumeToken: "rt-1" },
  { type: "hydrate_done", processPid: 12345 },
  { type: "send_start" },
  { type: "send_complete" },
  { type: "evict_start", nextThreadId: "t-2" },
  { type: "evict_start", nextThreadId: null },
  { type: "evict_done" },
  { type: "reset" },
  { type: "process_died", error: "ERR_PROCESS_DIED" },
];

describe("pro claude slot state machine", () => {
  it("happy path: empty → warming → warm → active → warm → evicting → evicted → empty", () => {
    const m = makeProClaudeSlotMachine();
    expect(m.current()).toBe("empty");
    expect(m.send({ type: "bind", threadId: "t-1", resumeToken: "rt-1" }).ok).toBe(true);
    expect(m.current()).toBe("warming");
    expect(m.send({ type: "hydrate_done", processPid: 12345 }).ok).toBe(true);
    expect(m.current()).toBe("warm");
    expect(m.context().processPid).toBe(12345);

    expect(m.send({ type: "send_start" }).ok).toBe(true);
    expect(m.current()).toBe("active");

    expect(m.send({ type: "send_complete" }).ok).toBe(true);
    expect(m.current()).toBe("warm");
    expect(m.context().lastUseAt).toBeGreaterThan(0);

    expect(m.send({ type: "evict_start", nextThreadId: "t-2" }).ok).toBe(true);
    expect(m.current()).toBe("evicting");
    expect(m.context().nextThreadId).toBe("t-2");

    expect(m.send({ type: "evict_done" }).ok).toBe(true);
    expect(m.current()).toBe("evicted");
    expect(m.context().processPid).toBeNull();

    expect(m.send({ type: "reset" }).ok).toBe(true);
    expect(m.current()).toBe("empty");
    expect(m.context().threadId).toBeNull();
  });

  it("process_died from any live state goes to evicted with typed error", () => {
    const m = makeProClaudeSlotMachine();
    m.sendAll([
      { type: "bind", threadId: "t-1", resumeToken: "rt-1" },
      { type: "hydrate_done", processPid: 12345 },
    ]);
    expect(m.send({ type: "process_died", error: "ERR_PROCESS_OOMKILL" }).ok).toBe(true);
    expect(m.current()).toBe("evicted");
    expect(m.context().lastError).toBe("ERR_PROCESS_OOMKILL");
    expect(m.context().processPid).toBeNull();
  });

  it("property: 1000 events × seeds preserve all invariants", () => {
    for (const seed of [1, 7, 13, 42, 99, 257, 1023, 4096, 65537, 99999]) {
      const m = makeProClaudeSlotMachine();
      expect(() => randomWalk(m, ALL_EVENTS, 1000, seed)).not.toThrow();
      const state = m.current();
      const ctx = m.context();
      if (state === "warm" || state === "active") {
        expect(ctx.threadId).not.toBeNull();
        expect(ctx.processPid).not.toBeNull();
      }
      if (state === "empty") {
        expect(ctx.threadId).toBeNull();
        expect(ctx.processPid).toBeNull();
      }
    }
  });

  it("directed reachability: every documented state via explicit transitions", () => {
    const reached = new Set<string>();
    const cover = (events: ProClaudeSlotEvent[]) => {
      const m = makeProClaudeSlotMachine();
      for (const e of events) {
        const r = m.send(e);
        expect(r.ok, `event ${e.type} from ${m.current()} expected to fire`).toBe(true);
      }
      for (const t of m.trace()) reached.add(t.state);
    };
    // empty (initial), warming, warm, active, evicting, evicted, then reset → empty
    cover([
      { type: "bind", threadId: "t-1", resumeToken: "rt-1" },
      { type: "hydrate_done", processPid: 12345 },
      { type: "send_start" },
      { type: "send_complete" },
      { type: "evict_start", nextThreadId: "t-2" },
      { type: "evict_done" },
      { type: "reset" },
    ]);
    for (const s of PRO_CLAUDE_SLOT_STATES) expect(reached.has(s), `expected ${s} reachable`).toBe(true);
  });
});
