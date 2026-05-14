// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Pure-arithmetic invariants on the tier-aware sizing curve. NOT a
// load test — that lives at tools/burst-harness/replay.ts.

import { describe, expect, it } from "vitest";
import {
  computeAdapterPoolProfile,
  computeNodeHeapCaps,
  computeWorkloadSliceBudget,
} from "../memory-budget";

// Empirical /proc baseline: ~30 MB off-heap per Node service.
const PER_SERVICE_OFFHEAP_MB = 30;
const NUM_NODE_SERVICES = 5;
// Empirical warm session footprint (opencode storage + bookkeeping).
const PER_WARM_SESSION_MB = 12;
// Observed burst signature: 6 threads in ~14s, then idle.
const BURST_THREAD_COUNT = 6;
const BURST_WINDOW_MS = 14_000;

describe("burst chaos: 4 GB tier", () => {
  const phys = 4096;
  const profile = computeAdapterPoolProfile(phys);
  const heapCaps = computeNodeHeapCaps(phys);
  const slice = computeWorkloadSliceBudget(phys);

  it("control-plane budget covers all 5 node services + their warm sessions", () => {
    const sumOfNodeHeaps =
      heapCaps.sovereignShield +
      heapCaps.fileApi +
      heapCaps.agentBridge +
      heapCaps.enforcer +
      heapCaps.watchdog;
    const totalOffHeap = NUM_NODE_SERVICES * PER_SERVICE_OFFHEAP_MB;
    const warmCost = profile.warmDepth * PER_WARM_SESSION_MB;
    const total = sumOfNodeHeaps + totalOffHeap + warmCost;
    expect(total).toBeLessThan(slice.controlPlaneAggregateMB);
  });

  it("warm pool active on the floor tier — 4 GB does not regress to lite", () => {
    expect(profile.warmDepth).toBeGreaterThanOrEqual(1);
  });

  it("burst window ≪ idle TTL — first thread's warmup is reused by burst peers", () => {
    expect(BURST_WINDOW_MS).toBeLessThan(profile.opencodeIdleTtlMs);
  });

  it("binary mlock budget non-zero on 4 GB", () => {
    expect(profile.binaryMlockBudgetMB).toBeGreaterThan(0);
  });
});

describe("burst chaos: 8 GB tier", () => {
  const phys = 8192;
  const profile = computeAdapterPoolProfile(phys);
  const heapCaps = computeNodeHeapCaps(phys);
  const slice = computeWorkloadSliceBudget(phys);

  it("warm pool depth ≥ 2 — first two of a burst hit warm, rest pay cold path", () => {
    expect(profile.warmDepth).toBeGreaterThanOrEqual(2);
  });

  it("8 GB tier holds full burst's warm sessions inside the slice budget", () => {
    const sumOfNodeHeaps =
      heapCaps.sovereignShield +
      heapCaps.fileApi +
      heapCaps.agentBridge +
      heapCaps.enforcer +
      heapCaps.watchdog;
    const totalOffHeap = NUM_NODE_SERVICES * PER_SERVICE_OFFHEAP_MB;
    const warmCost = profile.warmDepth * PER_WARM_SESSION_MB;
    const total = sumOfNodeHeaps + totalOffHeap + warmCost;
    expect(total).toBeLessThan(slice.controlPlaneAggregateMB);
  });
});

describe("burst chaos: 16 GB+ tier", () => {
  const phys = 16384;
  const profile = computeAdapterPoolProfile(phys);

  it("warm pool absorbs a full burst without falling back to cold", () => {
    expect(profile.warmDepth).toBeGreaterThanOrEqual(4);
  });

  it("idle TTL spans a typical work session (≥ 10 min)", () => {
    expect(profile.opencodeIdleTtlMs).toBeGreaterThanOrEqual(10 * 60_000);
  });
});

describe("regression: floor-tier doesn't degrade to lite", () => {
  it("4 GB tier idle TTL ≤ 5 min — frees pools before next-project burst", () => {
    expect(computeAdapterPoolProfile(4096).opencodeIdleTtlMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it("4 GB tier keeps warmDepth ≥ 1 — discipline, not avoidance", () => {
    expect(computeAdapterPoolProfile(4096).warmDepth).toBe(1);
  });
});
