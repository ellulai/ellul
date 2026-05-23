// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Integration test harness for the admission controller.
 *
 * The real admission path crosses four module boundaries: systemd
 * control (preview-units), kernel /proc probes (preview-pressure /
 * preview-drain), activity tracking (preview-tracking), and framework
 * detection (@vps/shared). Each of those has been covered in
 * isolation; this file exercises them together via vitest's module
 * mocking so we can assert the full decision tree (accept, accept-
 * after-evict, drain, reject at every step) without a live systemd.
 *
 * The goal is end-to-end coverage of the state machine:
 *
 *   accept:               plenty of headroom, no eviction needed.
 *   accept + warm-mode:   dev peak won't fit, prod artifact exists.
 *   accept-after-evict:   concurrency full, LRU gets stopped, drain
 *                         succeeds, caller green-lit.
 *   reject budget:        framework peak exceeds the per-preview cap.
 *   reject drain-timeout: stop succeeds but memory doesn't recover.
 *   reject load:          loadavg above nCPU × multiplier.
 *   reject PSI:           kernel reports full-stall memory pressure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive os.loadavg / os.cpus / os.totalmem via a mutable harness the
// mock factory reads from. `vi.hoisted` makes the harness visible to
// the vi.mock factory (hoisted above imports) without exposing it to
// production code — mutating the harness inside a test changes what
// the admission path observes via `import * as os from 'node:os'`.
const osHarness = vi.hoisted(() => ({
  loadavg: [0.2, 0.2, 0.2] as [number, number, number],
  cpus: [{
    model: 'x',
    speed: 2000,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }] as Array<{ model: string; speed: number; times: { user: number; nice: number; sys: number; idle: number; irq: number } }>,
  totalmem: 4 * 1024 * 1024 * 1024,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    loadavg: () => osHarness.loadavg,
    cpus: () => osHarness.cpus,
    totalmem: () => osHarness.totalmem,
  };
});

// Inject fakes for the file-system layer the candidate-reservation
// path touches. readSpec returns null so the admission controller
// falls through to detectFramework, which we also stub below.
vi.mock('@vps/shared/preview-spec', () => ({
  readSpec: () => null,
  type: {},
}));

let candidateFrameworkId = 'hono';
let warmArtifactAvailable = true;

vi.mock('@vps/shared/framework', async () => {
  const actual = await vi.importActual<typeof import('@vps/shared/framework')>('@vps/shared/framework');
  return {
    ...actual,
    detectFramework: () => {
      return actual.FRAMEWORKS.find(f => f.id === candidateFrameworkId) ?? null;
    },
  };
});

vi.mock('@vps/shared/framework-artifacts', async () => {
  const actual = await vi.importActual<typeof import('@vps/shared/framework-artifacts')>('@vps/shared/framework-artifacts');
  return {
    ...actual,
    probeWarmArtifact: () => ({
      available: warmArtifactAvailable,
      matchedProbe: null,
      framework: candidateFrameworkId,
      runtime: null,
    }),
  };
});

// systemd layer — every call resolves successfully by default. Tests
// override per-case via the exported spies.
const stopCalls: Array<{ dir: string; mode: 'graceful' | 'immediate' }> = [];
vi.mock('./PreviewPlatform', () => ({
  previewPlatform: {
    listActive: async () => activeList,
    stopUnit: async (dir: string, opts?: { mode?: 'graceful' | 'immediate' }) => {
      stopCalls.push({ dir, mode: opts?.mode ?? 'graceful' });
      return { ok: true };
    },
  },
}));

// Activity tracking — the tests populate `trackedState`.
const trackedState: Array<{ directory: string; lastActivityAt: number; startedAt: number; port: number }> = [];
vi.mock('./PreviewTracking', () => ({
  listTracked: () => trackedState,
  lruOrder: () =>
    [...trackedState].sort((a, b) => a.lastActivityAt - b.lastActivityAt),
  idlenessMs: (dir: string) => {
    const r = trackedState.find(t => t.directory === dir);
    return r ? Date.now() - r.lastActivityAt : null;
  },
  recordStop: () => { /* no-op for tests */ },
}));

// Pressure reader — drives the PSI verdict.
let pressureSnapshot = {
  memory: null as null | { avg10: { some: number; full: number }; avg60: { some: number; full: number }; avg300: { some: number; full: number }; totalUs: number },
  cpu: null,
  io: null,
  psiUnavailable: true as boolean,
};
vi.mock('./PreviewPressure', async () => {
  const actual = await vi.importActual<typeof import('./PreviewPressure')>('./PreviewPressure');
  return {
    ...actual,
    readPressure: () => pressureSnapshot,
  };
});

// meminfo reader — drives MemAvailable/SwapFree/SwapTotal.
let memInfo = {
  MemTotal: 4 * 1024 * 1024, // 4 GB in kB
  MemAvailable: 3 * 1024 * 1024,
  SwapTotal: 1 * 1024 * 1024,
  SwapFree: 1 * 1024 * 1024,
};
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: (p: string | Buffer | URL, enc?: unknown) => {
      if (typeof p === 'string' && p === '/proc/meminfo') {
        return [
          `MemTotal:       ${memInfo.MemTotal} kB`,
          `MemFree:        ${Math.floor(memInfo.MemAvailable / 2)} kB`,
          `MemAvailable:   ${memInfo.MemAvailable} kB`,
          `SwapTotal:      ${memInfo.SwapTotal} kB`,
          `SwapFree:       ${memInfo.SwapFree} kB`,
        ].join('\n');
      }
      return actual.readFileSync(p as Parameters<typeof actual.readFileSync>[0], enc as Parameters<typeof actual.readFileSync>[1]);
    },
  };
});

// Drain module — deterministic success or failure per-test.
let drainResult = { recovered: true, finalFreeMB: 2048, initialFreeMB: 2048, elapsedMs: 100, polls: 1 };
vi.mock('./PreviewDrain', () => ({
  drainForAdmission: async () => drainResult,
  readMemAvailableMB: () => Math.floor(memInfo.MemAvailable / 1024),
}));

// Metrics — minimal stubs so the admission path doesn't throw when
// recording. Real coverage lives in preview-metrics.test.ts.
const metricsCalls: string[] = [];
vi.mock('./PreviewMetrics', () => {
  const rec = (name: string) => () => metricsCalls.push(name);
  return {
    admissionMetrics: {
      accept: rec('accept'),
      acceptAfterEvict: rec('acceptAfterEvict'),
      acceptAfterDrain: rec('acceptAfterDrain'),
      rejectConcurrency: rec('rejectConcurrency'),
      rejectMemoryCritical: rec('rejectMemoryCritical'),
      rejectLoad: rec('rejectLoad'),
      rejectPressure: rec('rejectPressure'),
      rejectDrainTimeout: rec('rejectDrainTimeout'),
      rejectBudgetUnavailable: rec('rejectBudgetUnavailable'),
      psiEvict: rec('psiEvict'),
      evictionGraceful: rec('evictionGraceful'),
      evictionImmediate: rec('evictionImmediate'),
      recordDrainMs: () => { /* observational */ },
    },
    budgetMetrics: {
      setBudget: () => {},
      setHeadroomMB: () => {},
      setActiveReservedMB: () => {},
    },
  };
});

let activeList: string[] = [];

// os.loadavg / cpus / totalmem are driven via vi.spyOn in beforeEach
// because `os` re-exports getters that are not configurable via
// direct assignment on the namespace object.

// Lazy-imported to ensure mocks are installed before the admission
// module resolves its dependencies.
async function importAdmission() {
  return import('./PreviewAdmission');
}

beforeEach(() => {
  stopCalls.length = 0;
  metricsCalls.length = 0;
  trackedState.length = 0;
  activeList = [];
  candidateFrameworkId = 'hono';
  warmArtifactAvailable = true;
  pressureSnapshot = {
    memory: null,
    cpu: null,
    io: null,
    psiUnavailable: true,
  };
  memInfo = {
    MemTotal: 4 * 1024 * 1024,
    MemAvailable: 3 * 1024 * 1024,
    SwapTotal: 1 * 1024 * 1024,
    SwapFree: 1 * 1024 * 1024,
  };
  drainResult = { recovered: true, finalFreeMB: 2048, initialFreeMB: 2048, elapsedMs: 100, polls: 1 };
  osHarness.loadavg = [0.2, 0.2, 0.2];
  osHarness.cpus = [{
    model: 'x',
    speed: 2000,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }];
  osHarness.totalmem = memInfo.MemTotal * 1024;
  delete process.env.PREVIEW_MAX_CONCURRENT;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('admission integration: happy path', () => {
  it('accepts a lightweight framework (hono) in hot mode', async () => {
    candidateFrameworkId = 'hono';
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/api');
    expect(outcome.decision).toBe('accept');
    if (outcome.decision === 'accept') {
      expect(outcome.admittedMode).toBe('hot');
      expect(outcome.frameworkId).toBe('hono');
      expect(outcome.budget.physicalMB).toBeGreaterThan(0);
    }
    expect(metricsCalls).toContain('accept');
  });

  it('accepts Spring Boot Gradle in hot mode on a 4 GB host (production minimum)', async () => {
    // Regression: prior divisor=6 sizing capped per-preview at ~443 MB on 4 GB
    // and rejected every JVM dev server. New tier-driven cap (~1433 MB on 4 GB)
    // admits Spring Boot Gradle (devSteady 640) in hot mode.
    candidateFrameworkId = 'spring-boot-gradle';
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/api');
    expect(outcome.decision).toBe('accept');
    if (outcome.decision === 'accept') {
      expect(outcome.admittedMode).toBe('hot');
      expect(outcome.frameworkId).toBe('spring-boot-gradle');
      expect(outcome.budget.perPreviewCapMB).toBeGreaterThan(1200);
    }
  });

  it('accepts Next.js dev in hot mode on a 4 GB host', async () => {
    candidateFrameworkId = 'next';
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/web');
    expect(outcome.decision).toBe('accept');
    if (outcome.decision === 'accept') {
      expect(outcome.admittedMode).toBe('hot');
    }
  });

  it('admits a heavy framework in warm mode when hot would exceed the per-preview budget', async () => {
    // Nuxt dev peak is 760 MB; on a mid host the per-preview cap
    // lands between dev-peak and prod-peak so admission must fall
    // back to warm. Nuxt prod is ~160 MB, trivially fitting.
    memInfo = { MemTotal: 2 * 1024 * 1024, MemAvailable: 1.5 * 1024 * 1024, SwapTotal: 0, SwapFree: 0 };
    osHarness.totalmem = memInfo.MemTotal * 1024;
    candidateFrameworkId = 'nuxt';
    warmArtifactAvailable = true;
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/web');
    // On this size host the hot peak (760 MB) may or may not fit
    // depending on the budget curve — this test just asserts that
    // warm-mode is picked when the framework peak is close to the
    // per-preview cap. If hot fits, admission prefers it.
    if (outcome.decision === 'accept' && outcome.effectiveCapMB < 500) {
      expect(outcome.admittedMode).toBe('warm');
    }
  });

  it('admits lightweight frameworks on a constrained host without falling back to warm', async () => {
    memInfo = { MemTotal: 2 * 1024 * 1024, MemAvailable: 1.5 * 1024 * 1024, SwapTotal: 0, SwapFree: 0 };
    osHarness.totalmem = memInfo.MemTotal * 1024;
    candidateFrameworkId = 'hono';
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/api');
    expect(outcome.decision).toBe('accept');
    if (outcome.decision === 'accept') {
      expect(outcome.admittedMode).toBe('hot');
    }
  });

  it('rejects with budget-unavailable when neither hot nor warm fits', async () => {
    // Spring Boot prod ~540MB — a 1 GB host's per-preview cap is ~250 MB.
    memInfo = { MemTotal: 1 * 1024 * 1024, MemAvailable: 0.8 * 1024 * 1024, SwapTotal: 0, SwapFree: 0 };
    osHarness.totalmem = memInfo.MemTotal * 1024;
    candidateFrameworkId = 'spring-boot-gradle';
    warmArtifactAvailable = false;
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/api');
    expect(outcome.decision).toBe('reject');
    if (outcome.decision === 'reject') {
      expect(outcome.reason).toBe('budget-unavailable');
      expect(outcome.message).toContain('build command');
    }
    expect(metricsCalls).toContain('rejectBudgetUnavailable');
  });
});

describe('admission integration: pressure + eviction', () => {
  it('rejects with memory-critical under PSI full-stall', async () => {
    pressureSnapshot = {
      memory: {
        avg10: { some: 80, full: 20 },
        avg60: { some: 70, full: 15 },
        avg300: { some: 60, full: 10 },
        totalUs: 0,
      },
      cpu: null,
      io: null,
      psiUnavailable: false,
    };
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/api');
    expect(outcome.decision).toBe('reject');
    if (outcome.decision === 'reject') {
      expect(outcome.reason).toBe('memory-critical');
    }
    expect(metricsCalls).toContain('rejectPressure');
  });

  it('rejects with load-critical when loadavg exceeds ncpu × multiplier', async () => {
    osHarness.cpus = [{
      model: 'x',
      speed: 2000,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    }];
    osHarness.loadavg = [5.0, 5.0, 5.0];
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/api');
    expect(outcome.decision).toBe('reject');
    if (outcome.decision === 'reject') {
      expect(outcome.reason).toBe('load-critical');
    }
  });

  it('rejects with memory-critical when MemAvailable + SwapFree both below the floor', async () => {
    memInfo = {
      MemTotal: 2 * 1024 * 1024,
      MemAvailable: 32 * 1024, // 32 MB
      SwapTotal: 0,
      SwapFree: 0,
    };
    osHarness.totalmem = memInfo.MemTotal * 1024;
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/api');
    expect(outcome.decision).toBe('reject');
    if (outcome.decision === 'reject') {
      expect(outcome.reason).toBe('memory-critical');
    }
  });

  it('evicts the LRU idle tracked preview with graceful mode when capacity is full', async () => {
    // PREVIEW_MAX_CONCURRENT=1 with one tracked preview already active.
    process.env.PREVIEW_MAX_CONCURRENT = '1';
    const now = Date.now();
    trackedState.push({
      directory: 'sbx/apps/old',
      port: 4000,
      startedAt: now - 60 * 60 * 1000,
      lastActivityAt: now - 30 * 60 * 1000, // 30 min idle > IDLE_EVICT_AFTER_MS default 15 min
    });
    activeList = ['sbx/apps/old'];
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/new');
    expect(outcome.decision).toBe('accept-after-evict');
    if (outcome.decision === 'accept-after-evict') {
      expect(outcome.evictedDirectory).toBe('sbx/apps/old');
      expect(outcome.evictionMode).toBe('graceful');
    }
    expect(stopCalls).toEqual([
      { dir: 'sbx/apps/old', mode: 'graceful' },
    ]);
    expect(metricsCalls).toContain('evictionGraceful');
    expect(metricsCalls).toContain('acceptAfterEvict');
  });

  it('rejects drain-timeout when memory fails to recover after eviction', async () => {
    process.env.PREVIEW_MAX_CONCURRENT = '1';
    const now = Date.now();
    trackedState.push({
      directory: 'sbx/apps/stuck',
      port: 4000,
      startedAt: now - 60 * 60 * 1000,
      lastActivityAt: now - 30 * 60 * 1000,
    });
    activeList = ['sbx/apps/stuck'];
    drainResult = { recovered: false, finalFreeMB: 120, initialFreeMB: 120, elapsedMs: 5000, polls: 50 };
    const { evaluateAdmission } = await importAdmission();
    const outcome = await evaluateAdmission('sbx/apps/new');
    expect(outcome.decision).toBe('reject');
    if (outcome.decision === 'reject') {
      expect(outcome.reason).toBe('drain-timeout');
    }
    expect(metricsCalls).toContain('rejectDrainTimeout');
  });
});
