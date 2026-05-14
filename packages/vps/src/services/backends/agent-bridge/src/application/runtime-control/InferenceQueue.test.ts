// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { makeInferenceQueue } from "./InferenceQueue";

describe("InferenceQueue", () => {
  it("accepts up to concurrency, then queues", () => {
    const q = makeInferenceQueue({ concurrencyFor: () => 2, hardCapFor: () => 16 });
    const k = { sandbox: "sbx-abc1234", adapter: "opencode" as const };
    expect(q.enqueue(k, "t1").tag).toBe("accepted");
    expect(q.enqueue(k, "t2").tag).toBe("accepted");
    const r = q.enqueue(k, "t3");
    expect(r.tag).toBe("queued");
    if (r.tag === "queued") expect(r.position).toBe(0);
  });

  it("rejects past hardCap", () => {
    const q = makeInferenceQueue({ concurrencyFor: () => 1, hardCapFor: () => 3 });
    const k = { sandbox: "s", adapter: "opencode" as const };
    expect(q.enqueue(k, "t1").tag).toBe("accepted");
    expect(q.enqueue(k, "t2").tag).toBe("queued");
    expect(q.enqueue(k, "t3").tag).toBe("queued");
    const r = q.enqueue(k, "t4");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ERR_QUEUE_FULL");
  });

  it("complete promotes head of queue to in-flight (FIFO)", () => {
    const q = makeInferenceQueue({ concurrencyFor: () => 1, hardCapFor: () => 16 });
    const k = { sandbox: "s", adapter: "cursor" as const };
    q.enqueue(k, "t1");
    q.enqueue(k, "t2");
    q.enqueue(k, "t3");
    q.complete(k, "t1");
    const snap = q.snapshot()[0]!;
    expect(snap.inflight).toBe(1);
    expect(snap.queued.map((x) => x.turnId)).toEqual(["t3"]);
  });

  it("ETA = position × median turn duration; fallback when no samples", () => {
    const q = makeInferenceQueue({ concurrencyFor: () => 1, hardCapFor: () => 16, fallbackTurnMs: 5000, now: () => 1 });
    const k = { sandbox: "s", adapter: "codex" as const };
    q.enqueue(k, "t1");
    const r = q.enqueue(k, "t2");
    if (r.tag !== "queued") throw new Error("expected queued");
    expect(r.etaMs).toBe(0);
    const r3 = q.enqueue(k, "t3");
    if (r3.tag !== "queued") throw new Error("expected queued");
    expect(r3.etaMs).toBe(5000);
  });

  it("ETA uses median of recent turn durations once sampled", () => {
    let t = 0;
    const q = makeInferenceQueue({ concurrencyFor: () => 1, hardCapFor: () => 16, fallbackTurnMs: 9999, now: () => t });
    const k = { sandbox: "s", adapter: "claude" as const };
    for (let i = 0; i < 3; i++) {
      t = i * 1000;
      q.enqueue(k, `done-${i}`);
      t = i * 1000 + 200;
      q.complete(k, `done-${i}`);
    }
    t = 5000;
    q.enqueue(k, "in-flight");
    const r = q.enqueue(k, "queued");
    if (r.tag !== "queued") throw new Error("expected queued");
    expect(r.etaMs).toBe(0);
    const r2 = q.enqueue(k, "next");
    if (r2.tag !== "queued") throw new Error("expected queued");
    expect(r2.etaMs).toBe(200);
  });

  it("independent queues per (sandbox, adapter)", () => {
    const q = makeInferenceQueue({ concurrencyFor: () => 1, hardCapFor: () => 16 });
    expect(q.enqueue({ sandbox: "a", adapter: "opencode" }, "t1").tag).toBe("accepted");
    expect(q.enqueue({ sandbox: "a", adapter: "cursor" }, "t1").tag).toBe("accepted");
    expect(q.enqueue({ sandbox: "b", adapter: "opencode" }, "t1").tag).toBe("accepted");
    const snap = q.snapshot();
    expect(snap).toHaveLength(3);
    for (const s of snap) expect(s.inflight).toBe(1);
  });

  it("subscribers fire on enqueue + complete", () => {
    const q = makeInferenceQueue({ concurrencyFor: () => 1, hardCapFor: () => 16 });
    const k = { sandbox: "s", adapter: "opencode" as const };
    let calls = 0;
    const off = q.subscribe(() => { calls++; });
    q.enqueue(k, "t1");
    q.enqueue(k, "t2");
    q.complete(k, "t1");
    off();
    q.enqueue(k, "t3");
    expect(calls).toBe(3);
  });
});
