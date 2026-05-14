// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import {
  computeAdapterPoolProfile,
  computeMemoryBudget,
  computeNodeHeapCaps,
  computeWorkloadSliceBudget,
  hotPreviewsCap,
  proClaudeSlotCap,
  sidebarVisibleThreadsCap,
} from "./memory-budget";

describe("computeWorkloadSliceBudget", () => {
  it("4 GB tier: control 28%, kernel 8%, workload 72%, soft-hint 1.5G", () => {
    const b = computeWorkloadSliceBudget(4096);
    expect(b.physicalMB).toBe(4096);
    expect(b.kernelReservedMB).toBe(327); // floor(4096 × 0.08)
    expect(b.controlPlaneAggregateMB).toBe(1146); // floor(4096 × 0.28)
    expect(b.workloadMaxMB).toBe(2949); // floor(4096 × 0.72)
    expect(b.workloadHighMB).toBe(Math.floor(b.workloadMaxMB * 0.89));
    expect(b.perSandboxSoftHintMB).toBe(1536);
    expect(b.proClaudeSlotSoftHintMB).toBe(320);
    expect(b.workloadMaxPercent).toBe(72);
  });

  it("8 GB tier: workload 72%, soft-hint 2G", () => {
    const b = computeWorkloadSliceBudget(8192);
    expect(b.kernelReservedMB).toBe(655);
    expect(b.controlPlaneAggregateMB).toBe(2293);
    expect(b.workloadMaxMB).toBe(5898);
    expect(b.perSandboxSoftHintMB).toBe(2048);
  });

  it("kernel reserve never below 256 MB", () => {
    for (const phys of [256, 512, 1024]) {
      const b = computeWorkloadSliceBudget(phys);
      expect(b.kernelReservedMB).toBeGreaterThanOrEqual(256);
    }
  });

  it("workload aggregate never below 256 MB (degenerate floor)", () => {
    const b = computeWorkloadSliceBudget(256);
    expect(b.workloadMaxMB).toBeGreaterThanOrEqual(256);
  });

  it("workload + control-plane + kernel-reserve sum sits within drift tolerance of physical", () => {
    // 72 + 28 + 8 = 108% nominal. Slices are root-siblings; memory pressure
    // routes through systemd-oomd, not strict slice arithmetic. Drift guard
    // catches accidental percentage bumps; 2 GB tier hits 256 MB kernel floor
    // pushing the sum slightly higher.
    for (const phys of [2048, 4096, 8192, 16384, 32768]) {
      const b = computeWorkloadSliceBudget(phys);
      const sum = b.workloadMaxMB + b.controlPlaneAggregateMB + b.kernelReservedMB;
      expect(sum, `phys=${phys}`).toBeLessThanOrEqual(Math.floor(phys * 1.13));
    }
  });

  it("workloadHighMB always strictly less than workloadMaxMB", () => {
    for (const phys of [2048, 4096, 8192, 16384, 32768]) {
      const b = computeWorkloadSliceBudget(phys);
      expect(b.workloadHighMB).toBeLessThan(b.workloadMaxMB);
    }
  });

  it("probeSoftHintMB scales by tier (resource-v2 Phase B host-mode probes)", () => {
    expect(computeWorkloadSliceBudget(1024).probeSoftHintMB).toBe(384);
    expect(computeWorkloadSliceBudget(2048).probeSoftHintMB).toBe(384);
    expect(computeWorkloadSliceBudget(4096).probeSoftHintMB).toBe(512);
    expect(computeWorkloadSliceBudget(8192).probeSoftHintMB).toBe(768);
    expect(computeWorkloadSliceBudget(16384).probeSoftHintMB).toBe(1024);
    expect(computeWorkloadSliceBudget(32768).probeSoftHintMB).toBe(1024);
  });

  it("probeSoftHintMB is always less than perSandboxSoftHintMB (probes are not full sandboxes)", () => {
    for (const phys of [2048, 4096, 8192, 16384]) {
      const b = computeWorkloadSliceBudget(phys);
      expect(b.probeSoftHintMB).toBeLessThan(b.perSandboxSoftHintMB);
    }
  });

  it("does not regress existing computeMemoryBudget output", () => {
    const old = computeMemoryBudget(4096);
    expect(old.physicalMB).toBe(4096);
    expect(old.maxConcurrent).toBeGreaterThan(0);
  });
});

describe("tier caps", () => {
  it("proClaudeSlotCap: 1 on $20 (4G), 3 on $50 (8G)", () => {
    expect(proClaudeSlotCap(4096)).toBe(1);
    expect(proClaudeSlotCap(8192)).toBe(3);
    expect(proClaudeSlotCap(2048)).toBe(1);
  });

  it("sidebarVisibleThreadsCap: 30 on $20, 100 on $50", () => {
    expect(sidebarVisibleThreadsCap(4096)).toBe(30);
    expect(sidebarVisibleThreadsCap(8192)).toBe(100);
  });

  it("hotPreviewsCap: 2 on 4 GB, 3 on 8 GB, 4 on 16 GB, 6 on 32 GB", () => {
    expect(hotPreviewsCap(4096)).toBe(2);
    expect(hotPreviewsCap(8192)).toBe(3);
    expect(hotPreviewsCap(16384)).toBe(4);
    expect(hotPreviewsCap(32768)).toBe(6);
  });
});

describe("computeAdapterPoolProfile", () => {
  it("4 GB tier (kernel-visible 3.7G included): warmDepth 1, 3-min TTL, 80 MB mlock", () => {
    for (const phys of [3700, 3800, 3900, 4096]) {
      const p = computeAdapterPoolProfile(phys);
      expect(p.warmDepth).toBe(1);
      expect(p.opencodeIdleTtlMs).toBe(180_000);
      expect(p.cursorIdleTtlMs).toBe(180_000);
      expect(p.zeroclawIdleTtlMs).toBe(180_000);
      expect(p.binaryMlockBudgetMB).toBe(80);
      expect(p.reconcileIntervalMs).toBe(30_000);
    }
  });

  it("8 GB tier: warmDepth 2, 5-min TTL, 160 MB mlock", () => {
    for (const phys of [4500, 6144, 8000, 8192]) {
      const p = computeAdapterPoolProfile(phys);
      expect(p.warmDepth).toBe(2);
      expect(p.opencodeIdleTtlMs).toBe(300_000);
      expect(p.binaryMlockBudgetMB).toBe(160);
    }
  });

  it("16 GB+ tier: warmDepth 4, 10-min TTL, 320 MB mlock", () => {
    for (const phys of [12288, 16384, 32768]) {
      const p = computeAdapterPoolProfile(phys);
      expect(p.warmDepth).toBe(4);
      expect(p.opencodeIdleTtlMs).toBe(600_000);
      expect(p.binaryMlockBudgetMB).toBe(320);
    }
  });

  it("reconcile cadence is 30s across every tier", () => {
    for (const phys of [1024, 4096, 8192, 16384]) {
      expect(computeAdapterPoolProfile(phys).reconcileIntervalMs).toBe(30_000);
    }
  });

  it("degenerate input still yields a usable profile", () => {
    const p = computeAdapterPoolProfile(0);
    expect(p.warmDepth).toBe(1);
    expect(p.opencodeIdleTtlMs).toBeGreaterThan(0);
  });
});

describe("computeNodeHeapCaps × control-plane slice coherence", () => {
  it("4 GB tier: sum of node heap caps + off-heap stays under control-plane slice cap", () => {
    const phys = 4096;
    const caps = computeNodeHeapCaps(phys);
    const slice = computeWorkloadSliceBudget(phys);
    const sumOfCaps =
      caps.sovereignShield + caps.fileApi + caps.agentBridge + caps.enforcer + caps.watchdog;
    const estOffHeapMB = 150;
    expect(sumOfCaps + estOffHeapMB).toBeLessThanOrEqual(slice.controlPlaneAggregateMB);
  });

  it("8 GB tier: bridge cap raised to 384 (was 320)", () => {
    expect(computeNodeHeapCaps(8192).agentBridge).toBe(384);
  });

  it("4 GB tier: bridge cap raised to 256 (was 192) — gives ≥100 MB GC headroom over observed 158 MB RSS", () => {
    expect(computeNodeHeapCaps(4096).agentBridge).toBe(256);
  });

  it("monotone: bridge heap cap never decreases as RAM increases", () => {
    const tiers = [1024, 2048, 4096, 8192, 16384];
    for (let i = 1; i < tiers.length; i++) {
      expect(computeNodeHeapCaps(tiers[i]!).agentBridge).toBeGreaterThanOrEqual(
        computeNodeHeapCaps(tiers[i - 1]!).agentBridge,
      );
    }
  });
});
