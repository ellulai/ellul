// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, it, expect, afterEach } from 'vitest';

import {
  FRAMEWORK_MEMORY,
  PER_PREVIEW_CEILING_MB,
  PER_PREVIEW_FLOOR_MB,
  PREVIEW_SLICE_PERCENT,
  computeFrameworkCgroupCaps,
  computeMemoryBudget,
  computeNodeHeapCaps,
  computePostgresMemory,
  estimatePreviewPeakMB,
  estimatePreviewSteadyMB,
  frameworkMemoryProfile,
  hotPreviewsCap,
} from '../memory-budget';
import { resolvePreviewMaxConcurrent } from '../constants';

describe('memory-budget: framework profile', () => {
  it('returns exact profile for a known framework id', () => {
    const p = frameworkMemoryProfile('next', 'node');
    expect(p).toBe(FRAMEWORK_MEMORY.next);
    expect(p.devPeakMB).toBeGreaterThan(p.devSteadyMB);
  });

  it('falls back to runtime default when framework id is unknown', () => {
    const p = frameworkMemoryProfile('unknown-fw', 'python');
    expect(p.devSteadyMB).toBeGreaterThan(0);
    expect(p.devPeakMB).toBeGreaterThan(p.devSteadyMB);
  });

  it('falls back to node runtime when both arguments are null', () => {
    const p = frameworkMemoryProfile(null, null);
    expect(p.devSteadyMB).toBeGreaterThan(0);
  });

  it('peak >= steady for every registered framework', () => {
    for (const [id, profile] of Object.entries(FRAMEWORK_MEMORY)) {
      expect(profile.devPeakMB, `${id} peak`).toBeGreaterThanOrEqual(profile.devSteadyMB);
      if (profile.prodSteadyMB !== null) {
        expect(profile.prodSteadyMB, `${id} prod`).toBeGreaterThan(0);
      }
    }
  });

  it('estimate helpers return positive values for every runtime fallback', () => {
    const runtimes = ['node', 'python', 'ruby', 'go', 'rust', 'java', 'bun', 'static'] as const;
    for (const r of runtimes) {
      expect(estimatePreviewPeakMB(null, r)).toBeGreaterThan(0);
      expect(estimatePreviewSteadyMB(null, r)).toBeGreaterThan(0);
    }
  });
});

describe('memory-budget: tier caps', () => {
  it('hotPreviewsCap: 2 on $20 (4 GB), 3 on $50 (8 GB), 4 on 16 GB, 6 on 32 GB', () => {
    expect(hotPreviewsCap(4096)).toBe(2);
    expect(hotPreviewsCap(8192)).toBe(3);
    expect(hotPreviewsCap(16384)).toBe(4);
    expect(hotPreviewsCap(32768)).toBe(6);
  });

  it('hotPreviewsCap: monotone non-decreasing across tiers', () => {
    let prev = hotPreviewsCap(1024);
    for (const phys of [2048, 4096, 8192, 16384, 32768]) {
      const cur = hotPreviewsCap(phys);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('memory-budget: computeMemoryBudget — production-tier sizing', () => {
  it('PREVIEW_SLICE_PERCENT is 70 (matches previews.slice MemoryMax)', () => {
    expect(PREVIEW_SLICE_PERCENT).toBe(70);
  });

  it('per-preview floor of 1280 MB clears Spring Boot Gradle dev peak (1200) with headroom', () => {
    expect(PER_PREVIEW_FLOOR_MB).toBeGreaterThanOrEqual(FRAMEWORK_MEMORY['spring-boot-gradle']!.devPeakMB);
    for (const [, profile] of Object.entries(FRAMEWORK_MEMORY)) {
      // Floor must accommodate every framework's devPeakMB at minimum.
      // (Frameworks above the floor scale up with host class.)
      if (profile.devPeakMB > PER_PREVIEW_FLOOR_MB) {
        // Only Spring Boot Gradle peaks above (and we tolerate 7% headroom there).
        expect(profile.devPeakMB).toBeLessThanOrEqual(Math.round(PER_PREVIEW_FLOOR_MB * 1.1));
      }
    }
  });

  it('4 GB tier: 2 concurrent previews, ~1433 MB cap, fits Spring Boot Gradle', () => {
    const b = computeMemoryBudget(4096);
    expect(b.physicalMB).toBe(4096);
    expect(b.slicePercent).toBe(70);
    expect(b.previewBudgetMB).toBe(2867); // floor(4096 × 0.70)
    expect(b.maxConcurrent).toBe(2);
    expect(b.perPreviewCapMB).toBe(1433); // floor(2867 / 2)
    expect(b.perPreviewCapMB).toBeGreaterThanOrEqual(PER_PREVIEW_FLOOR_MB);
    // Fits Spring Boot Gradle dev peak (1200) and Next.js dev peak (820).
    expect(b.perPreviewCapMB).toBeGreaterThan(FRAMEWORK_MEMORY['spring-boot-gradle']!.devPeakMB);
  });

  it('8 GB tier: 3 concurrent previews, ~1911 MB cap', () => {
    const b = computeMemoryBudget(8192);
    expect(b.slicePercent).toBe(70);
    expect(b.previewBudgetMB).toBe(5734);
    expect(b.maxConcurrent).toBe(3);
    expect(b.perPreviewCapMB).toBe(1911); // floor(5734 / 3)
  });

  it('16 GB tier: 4 concurrent previews, ~2867 MB cap', () => {
    const b = computeMemoryBudget(16384);
    expect(b.slicePercent).toBe(70);
    expect(b.maxConcurrent).toBe(4);
    expect(b.perPreviewCapMB).toBe(Math.floor(b.previewBudgetMB / 4));
    expect(b.perPreviewCapMB).toBeGreaterThanOrEqual(PER_PREVIEW_FLOOR_MB);
  });

  it('32 GB tier: per-preview cap clamped at 4 GB ceiling, 6 concurrent', () => {
    const b = computeMemoryBudget(32768);
    expect(b.maxConcurrent).toBe(6);
    expect(b.perPreviewCapMB).toBeLessThanOrEqual(PER_PREVIEW_CEILING_MB);
    expect(b.perPreviewCapMB).toBeGreaterThanOrEqual(PER_PREVIEW_FLOOR_MB);
  });

  it('reservedMB scales DOWN as RAM grows (control plane is mostly fixed cost)', () => {
    const small = computeMemoryBudget(1024);
    const medium = computeMemoryBudget(4096);
    const large = computeMemoryBudget(16384);
    expect(small.reservedMB / small.physicalMB).toBeGreaterThan(
      medium.reservedMB / medium.physicalMB,
    );
    expect(medium.reservedMB / medium.physicalMB).toBeGreaterThan(
      large.reservedMB / large.physicalMB,
    );
  });

  it('reservedMB never below 256 MB even on tiny hosts', () => {
    expect(computeMemoryBudget(128).reservedMB).toBeGreaterThanOrEqual(256);
  });

  it('per-preview hard cap fits inside the preview pool, soft cap below hard', () => {
    for (const phys of [512, 1024, 2048, 4096, 8192, 16384, 32768]) {
      const b = computeMemoryBudget(phys);
      expect(b.perPreviewCapMB, `phys=${phys}`).toBeLessThanOrEqual(b.previewBudgetMB);
      expect(b.perPreviewHighMB).toBeLessThan(b.perPreviewCapMB);
    }
  });

  it('per-preview cap never above the 4 GB ceiling regardless of host size', () => {
    for (const phys of [16384, 32768, 65536, 131072]) {
      expect(computeMemoryBudget(phys).perPreviewCapMB).toBeLessThanOrEqual(PER_PREVIEW_CEILING_MB);
    }
  });

  it('maxConcurrent never exceeds tier cap', () => {
    for (const phys of [1024, 2048, 4096, 8192, 16384, 32768, 65536]) {
      const b = computeMemoryBudget(phys);
      expect(b.maxConcurrent).toBeLessThanOrEqual(hotPreviewsCap(phys));
    }
  });

  it('honors slicePercent override', () => {
    const b = computeMemoryBudget(4096, { slicePercent: 80, reservedMB: 1024 });
    expect(b.slicePercent).toBe(80);
    expect(b.reservedMB).toBe(1024);
    expect(b.previewBudgetMB).toBe(Math.floor(4096 * 0.80));
  });

  it('treats invalid physicalMB as the minimum floor', () => {
    const b = computeMemoryBudget(0);
    expect(b.physicalMB).toBe(1);
    expect(b.previewBudgetMB).toBeGreaterThanOrEqual(64);
  });
});

describe('memory-budget: enterprise framework fit on the 4 GB minimum', () => {
  // Production floor: every framework with devPeakMB ≤ 1200 must admit at hot mode
  // on a 4 GB host. Anything with larger peak gracefully degrades to warm mode.
  const ENTERPRISE_FRAMEWORKS = [
    'next', 'nuxt', 'remix', 'svelte', 'astro', 'gatsby', 'vite', 'cra', 'turbo',
    'nestjs', 'spring-boot', 'spring-boot-gradle', 'java-maven', 'java-gradle',
    'rust', 'flutter', 'dotnet', 'rails',
  ];

  it('per-preview cap on 4 GB fits every enterprise framework devPeakMB', () => {
    const cap = computeMemoryBudget(4096).perPreviewCapMB;
    for (const id of ENTERPRISE_FRAMEWORKS) {
      const profile = FRAMEWORK_MEMORY[id]!;
      expect(profile.devPeakMB, `${id} devPeakMB ${profile.devPeakMB} > cap ${cap}`)
        .toBeLessThanOrEqual(cap);
    }
  });

  it('per-preview cap on 4 GB fits every framework devSteadyMB (admission gate)', () => {
    const cap = computeMemoryBudget(4096).perPreviewCapMB;
    for (const [id, profile] of Object.entries(FRAMEWORK_MEMORY)) {
      expect(profile.devSteadyMB, `${id} steady ${profile.devSteadyMB} > cap ${cap}`)
        .toBeLessThanOrEqual(cap);
    }
  });
});

describe('memory-budget: resolvePreviewMaxConcurrent ↔ computeMemoryBudget coherence', () => {
  afterEach(() => {
    delete process.env.PREVIEW_MAX_CONCURRENT;
  });

  it('matches computeMemoryBudget.maxConcurrent when no env override', () => {
    for (const phys of [1024, 2048, 4096, 8192, 16384, 32768]) {
      const budget = computeMemoryBudget(phys);
      const resolved = resolvePreviewMaxConcurrent(undefined, phys);
      expect(resolved, `phys=${phys}`).toBe(budget.maxConcurrent);
    }
  });

  it('env override wins over physical-derived value', () => {
    process.env.PREVIEW_MAX_CONCURRENT = '7';
    expect(resolvePreviewMaxConcurrent(undefined, 16384)).toBe(7);
  });
});

describe('memory-budget: computeNodeHeapCaps', () => {
  it('scales monotonically with physical RAM', () => {
    const steps = [1024, 2048, 4096, 8192, 16384];
    let prev = computeNodeHeapCaps(steps[0]!);
    for (let i = 1; i < steps.length; i++) {
      const next = computeNodeHeapCaps(steps[i]!);
      expect(next.sovereignShield).toBeGreaterThanOrEqual(prev.sovereignShield);
      expect(next.fileApi).toBeGreaterThanOrEqual(prev.fileApi);
      expect(next.agentBridge).toBeGreaterThanOrEqual(prev.agentBridge);
      expect(next.enforcer).toBeGreaterThanOrEqual(prev.enforcer);
      expect(next.watchdog).toBeGreaterThanOrEqual(prev.watchdog);
      prev = next;
    }
  });

  it('total heap reservation fits inside the budget reservedMB on every tier', () => {
    for (const phys of [1024, 2048, 4096, 8192, 16384]) {
      const caps = computeNodeHeapCaps(phys);
      const total = caps.sovereignShield + caps.fileApi + caps.agentBridge + caps.enforcer + caps.watchdog;
      const budget = computeMemoryBudget(phys);
      expect(total, `phys=${phys} total=${total} reserved=${budget.reservedMB}`)
        .toBeLessThanOrEqual(budget.reservedMB);
    }
  });
});

describe('memory-budget: computeFrameworkCgroupCaps', () => {
  it('scales MemoryMax up to the framework peak when the budget permits', () => {
    const budget = computeMemoryBudget(16384);
    const caps = computeFrameworkCgroupCaps('next', 'node', budget);
    // Next dev peak 820 × 1.15 ≈ 943 MB. A 16 GB host has more than that.
    expect(caps.memoryMaxMB).toBeGreaterThan(800);
  });

  it('clamps MemoryMax to the budget per-preview cap on small hosts', () => {
    const budget = computeMemoryBudget(1024);
    const caps = computeFrameworkCgroupCaps('spring-boot', 'java', budget);
    expect(caps.memoryMaxMB).toBeLessThanOrEqual(budget.perPreviewCapMB);
  });

  it('MemoryHigh is strictly below MemoryMax', () => {
    for (const [id] of Object.entries(FRAMEWORK_MEMORY)) {
      const budget = computeMemoryBudget(8192);
      const caps = computeFrameworkCgroupCaps(id, null, budget);
      expect(caps.memoryHighMB, id).toBeLessThan(caps.memoryMaxMB);
    }
  });

  it('raises TasksMax for heavy-thread runtimes', () => {
    const budget = computeMemoryBudget(4096);
    const java = computeFrameworkCgroupCaps('spring-boot', 'java', budget);
    const go = computeFrameworkCgroupCaps('golang', 'go', budget);
    const hono = computeFrameworkCgroupCaps('hono', 'node', budget);
    expect(java.tasksMax).toBeGreaterThan(hono.tasksMax);
    expect(hono.tasksMax).toBeGreaterThan(go.tasksMax);
  });

  it('raises CPUQuota for compile-heavy runtimes', () => {
    const budget = computeMemoryBudget(8192);
    const java = computeFrameworkCgroupCaps('spring-boot', 'java', budget);
    const rust = computeFrameworkCgroupCaps('rust', 'rust', budget);
    const python = computeFrameworkCgroupCaps('flask', 'python', budget);
    expect(java.cpuQuotaPercent).toBeGreaterThan(python.cpuQuotaPercent);
    expect(rust.cpuQuotaPercent).toBeGreaterThan(python.cpuQuotaPercent);
  });

  it('produces valid caps for every framework id', () => {
    const budget = computeMemoryBudget(4096);
    for (const id of Object.keys(FRAMEWORK_MEMORY)) {
      const caps = computeFrameworkCgroupCaps(id, null, budget);
      expect(caps.memoryMaxMB).toBeGreaterThan(0);
      expect(caps.memoryHighMB).toBeGreaterThan(0);
      expect(caps.tasksMax).toBeGreaterThan(0);
      expect(caps.cpuQuotaPercent).toBeGreaterThan(0);
    }
  });
});

describe('memory-budget: computePostgresMemory', () => {
  it('sizes max_connections in known tiers', () => {
    expect(computePostgresMemory(512).maxConnections).toBeLessThanOrEqual(20);
    expect(computePostgresMemory(1024).maxConnections).toBeLessThanOrEqual(20);
    expect(computePostgresMemory(2048).maxConnections).toBeLessThanOrEqual(30);
    expect(computePostgresMemory(8192).maxConnections).toBeLessThanOrEqual(80);
    expect(computePostgresMemory(32768).maxConnections).toBeGreaterThanOrEqual(120);
  });

  it('keeps shared_buffers under ~15% of physical', () => {
    for (const phys of [512, 1024, 2048, 4096, 8192, 16384]) {
      const pg = computePostgresMemory(phys);
      expect(pg.sharedBuffersMB / phys).toBeLessThan(0.15);
    }
  });

  it('caps wal_buffers to the documented PostgreSQL 16MB ceiling', () => {
    for (const phys of [512, 1024, 4096, 32768]) {
      const pg = computePostgresMemory(phys);
      expect(pg.walBuffersMB).toBeGreaterThanOrEqual(4);
      expect(pg.walBuffersMB).toBeLessThanOrEqual(16);
    }
  });
});
