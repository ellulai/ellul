// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it, vi } from "vitest";
import { makeDrainHandler } from "./DrainHandler";

function fakes() {
  const broadcasts: Array<unknown> = [];
  const wsAccepts = { closed: false };
  const slotsEvicts: string[] = [];
  const poolsFlushes: string[] = [];
  const cpFlushes: number[] = [];
  return {
    broadcasts, wsAccepts, slotsEvicts, poolsFlushes, cpFlushes,
    deps: {
      broadcast: {
        broadcastShutdown: (p: unknown) => broadcasts.push(p),
        closeWsAccepts: () => { wsAccepts.closed = true; },
      },
      slots: { async evictAll(reason: string) { slotsEvicts.push(reason); } },
      pools: { async flushIdle(reason: string) { poolsFlushes.push(reason); } },
      checkpoints: { async flushPending() { cpFlushes.push(Date.now()); } },
      now: () => 1_700_000_000_000,
    },
  };
}

describe("DrainHandler", () => {
  it("broadcasts bridge_shutting_down with drain window", async () => {
    const f = fakes();
    const h = makeDrainHandler(f.deps);
    await h.drain("release_drain");
    expect(f.broadcasts).toHaveLength(1);
    const b = f.broadcasts[0] as { event: string; drainStart: number; drainEnd: number };
    expect(b.event).toBe("bridge_shutting_down");
    expect(b.drainEnd - b.drainStart).toBe(5000);
  });

  it("closes WS accepts and runs all drain steps", async () => {
    const f = fakes();
    const h = makeDrainHandler(f.deps);
    await h.drain("release_drain");
    expect(f.wsAccepts.closed).toBe(true);
    expect(f.slotsEvicts).toEqual(["release_drain"]);
    expect(f.poolsFlushes).toEqual(["release_drain"]);
    expect(f.cpFlushes).toHaveLength(1);
  });

  it("returns durationMs", async () => {
    let t = 0;
    const f = fakes();
    const h = makeDrainHandler({ ...f.deps, now: () => (t += 1) });
    const r = await h.drain("x");
    expect(r.durationMs).toBeGreaterThanOrEqual(1);
  });

  it("idempotent: second drain is a no-op while first is in flight", async () => {
    const slow = {
      slots: { async evictAll() { await new Promise((r) => setTimeout(r, 30)); } },
    };
    const f = fakes();
    const h = makeDrainHandler({ ...f.deps, ...slow });
    const p1 = h.drain("first");
    const r2 = await h.drain("second");
    await p1;
    expect(r2.durationMs).toBe(0);
  });

  it("partial failures don't block the drain", async () => {
    const f = fakes();
    const broken = { ...f.deps, slots: { async evictAll() { throw new Error("slot evict failed"); } } };
    const h = makeDrainHandler(broken);
    const r = await h.drain("x");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});
