// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { makeSessionCompactor, type CompactableAdapter, type CompactorEvent } from "./SessionCompactor";

function stub(adapter: CompactableAdapter["adapter"], sessions: Array<{ sessionId: string; turnCount: number; sandbox: string }>, throws = false): CompactableAdapter & { calls: Array<[string, number]> } {
  const calls: Array<[string, number]> = [];
  return {
    adapter,
    calls,
    async listSessions() { if (throws) throw new Error("listSessions failed"); return sessions; },
    async compactSession(sessionId, keepLastN) {
      calls.push([sessionId, keepLastN]);
      return { droppedTurns: 5, freedBytesEst: 1024 * 1024 };
    },
  };
}

describe("SessionCompactor.runNow", () => {
  it("compacts only sessions with turnCount > threshold", async () => {
    const a = stub("opencode", [
      { sessionId: "s1", turnCount: 3, sandbox: "x" },
      { sessionId: "s2", turnCount: 12, sandbox: "x" },
      { sessionId: "s3", turnCount: 8, sandbox: "x" },
    ]);
    const events: CompactorEvent[] = [];
    const c = makeSessionCompactor({ adapters: [a], thresholdTurns: 8, emit: (e) => events.push(e) });
    const ev = await c.runNow();
    expect(ev.byAdapter).toHaveLength(1);
    expect(ev.byAdapter[0]!.compacted).toBe(1);
    expect(ev.byAdapter[0]!.droppedTurnsTotal).toBe(5);
    expect(a.calls).toEqual([["s2", 8]]);
    expect(events).toHaveLength(1);
  });

  it("uses provided keepLastN", async () => {
    const a = stub("cursor", [{ sessionId: "s1", turnCount: 20, sandbox: "x" }]);
    const c = makeSessionCompactor({ adapters: [a], thresholdTurns: 8 });
    await c.runNow({ keepLastN: 4, reason: "yellow_mode" });
    expect(a.calls).toEqual([["s1", 4]]);
  });

  it("isolates per-adapter errors (other adapters still run)", async () => {
    const broken = stub("opencode", [{ sessionId: "x", turnCount: 100, sandbox: "x" }], true);
    const ok = stub("cursor", [{ sessionId: "y", turnCount: 100, sandbox: "x" }]);
    const c = makeSessionCompactor({ adapters: [broken, ok], thresholdTurns: 8 });
    const ev = await c.runNow();
    const oc = ev.byAdapter.find((b) => b.adapter === "opencode")!;
    expect(oc.errors).toBeGreaterThanOrEqual(1);
    const cu = ev.byAdapter.find((b) => b.adapter === "cursor")!;
    expect(cu.compacted).toBe(1);
  });

  it("emits compactor.run with intervalReason", async () => {
    const a = stub("codex", [{ sessionId: "s", turnCount: 100, sandbox: "x" }]);
    const events: CompactorEvent[] = [];
    const c = makeSessionCompactor({ adapters: [a], thresholdTurns: 8, emit: (e) => events.push(e) });
    await c.runNow({ reason: "yellow_mode" });
    expect(events[0]!.intervalReason).toBe("yellow_mode");
  });
});

describe("SessionCompactor.start/stop", () => {
  it("schedules periodic ticks until stop", async () => {
    const a = stub("opencode", [{ sessionId: "s", turnCount: 100, sandbox: "x" }]);
    const events: CompactorEvent[] = [];
    const c = makeSessionCompactor({
      adapters: [a],
      thresholdTurns: 8,
      intervalMs: 30,
      jitterMs: 5,
      emit: (e) => events.push(e),
    });
    c.start();
    await new Promise((r) => setTimeout(r, 200));
    c.stop();
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const ev of events) expect(ev.intervalReason).toBe("tick");
  });
});
