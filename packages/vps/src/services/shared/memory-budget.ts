// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Memory budget: pure arithmetic splitting physical RAM into admission reservations.
// Outputs MemoryBudget (reserved/previewBudget/perPreview caps) + FRAMEWORK_MEMORY
// (90th-percentile calibrated RSS). reservedMB is a floor; unknown ids fall to runtime default.

import type { Runtime } from './framework';

// ── Framework memory profile ────────────────────────────────────────

export interface FrameworkMemoryProfile {
  /** Steady-state RSS of the dev server, MB. */
  devSteadyMB: number;
  /** Peak RSS during first compile / cold start, MB. */
  devPeakMB: number;
  /** Steady-state RSS running in production mode; null if not applicable. */
  prodSteadyMB: number | null;
}

// Calibrated 90th-percentile RSS. Admission reserves devPeakMB; devSteadyMB is accounting weight.
export const FRAMEWORK_MEMORY: Record<string, FrameworkMemoryProfile> = {
  // ── Node.js ──
  'next':        { devSteadyMB: 520, devPeakMB: 820, prodSteadyMB: 180 },
  'nuxt':        { devSteadyMB: 480, devPeakMB: 760, prodSteadyMB: 160 },
  'remix':       { devSteadyMB: 340, devPeakMB: 560, prodSteadyMB: 140 },
  'svelte':      { devSteadyMB: 260, devPeakMB: 440, prodSteadyMB: 110 },
  'astro':       { devSteadyMB: 280, devPeakMB: 460, prodSteadyMB: 120 },
  'gatsby':      { devSteadyMB: 420, devPeakMB: 680, prodSteadyMB: 160 },
  'vite':        { devSteadyMB: 220, devPeakMB: 380, prodSteadyMB: 90 },
  'cra':         { devSteadyMB: 380, devPeakMB: 620, prodSteadyMB: 120 },
  'vue-cli':     { devSteadyMB: 360, devPeakMB: 580, prodSteadyMB: 120 },
  'turbo':       { devSteadyMB: 560, devPeakMB: 900, prodSteadyMB: 200 },
  'hono':        { devSteadyMB: 140, devPeakMB: 220, prodSteadyMB: 110 },
  'express':     { devSteadyMB: 140, devPeakMB: 220, prodSteadyMB: 110 },
  'fastify':     { devSteadyMB: 140, devPeakMB: 220, prodSteadyMB: 110 },
  'nestjs':      { devSteadyMB: 280, devPeakMB: 460, prodSteadyMB: 160 },
  'node-dev':    { devSteadyMB: 200, devPeakMB: 360, prodSteadyMB: 140 },
  'node-start':  { devSteadyMB: 180, devPeakMB: 300, prodSteadyMB: 140 },

  // ── Bun ──
  'bun':         { devSteadyMB: 120, devPeakMB: 220, prodSteadyMB: 90 },

  // ── Python ──
  'django':      { devSteadyMB: 180, devPeakMB: 320, prodSteadyMB: 160 },
  'fastapi':     { devSteadyMB: 140, devPeakMB: 240, prodSteadyMB: 120 },
  'flask':       { devSteadyMB: 120, devPeakMB: 200, prodSteadyMB: 100 },
  'streamlit':   { devSteadyMB: 260, devPeakMB: 420, prodSteadyMB: 240 },
  'gradio':      { devSteadyMB: 280, devPeakMB: 440, prodSteadyMB: 260 },
  'python':      { devSteadyMB: 120, devPeakMB: 220, prodSteadyMB: 100 },
  'python-pyproject': { devSteadyMB: 120, devPeakMB: 220, prodSteadyMB: 100 },

  // ── Ruby ──
  'rails':       { devSteadyMB: 340, devPeakMB: 520, prodSteadyMB: 260 },
  'sinatra':     { devSteadyMB: 140, devPeakMB: 220, prodSteadyMB: 120 },
  'ruby':        { devSteadyMB: 160, devPeakMB: 260, prodSteadyMB: 140 },

  // ── Go / Rust ──
  'golang':      { devSteadyMB: 90,  devPeakMB: 220, prodSteadyMB: 60 },
  'rust':        { devSteadyMB: 140, devPeakMB: 900, prodSteadyMB: 80 },

  // ── BEAM ──
  'phoenix':     { devSteadyMB: 260, devPeakMB: 400, prodSteadyMB: 220 },
  'elixir':      { devSteadyMB: 200, devPeakMB: 320, prodSteadyMB: 180 },

  // ── JVM ──
  'spring-boot':        { devSteadyMB: 620, devPeakMB: 1100, prodSteadyMB: 540 },
  'spring-boot-gradle': { devSteadyMB: 640, devPeakMB: 1200, prodSteadyMB: 540 },
  'java-maven':         { devSteadyMB: 480, devPeakMB: 900,  prodSteadyMB: 420 },
  'java-gradle':        { devSteadyMB: 500, devPeakMB: 960,  prodSteadyMB: 420 },

  // ── CLR ──
  'dotnet':      { devSteadyMB: 380, devPeakMB: 620, prodSteadyMB: 280 },

  // ── PHP ──
  'laravel':     { devSteadyMB: 180, devPeakMB: 280, prodSteadyMB: 160 },
  'php':         { devSteadyMB: 120, devPeakMB: 200, prodSteadyMB: 100 },

  // ── Dart ──
  'flutter':     { devSteadyMB: 420, devPeakMB: 700, prodSteadyMB: 200 },
  'dart':        { devSteadyMB: 220, devPeakMB: 360, prodSteadyMB: 140 },

  // ── Static ──
  'static':      { devSteadyMB: 40,  devPeakMB: 80,  prodSteadyMB: 40 },
  'procfile':    { devSteadyMB: 200, devPeakMB: 360, prodSteadyMB: 140 },
  'custom':      { devSteadyMB: 260, devPeakMB: 460, prodSteadyMB: 180 },
};

const RUNTIME_FALLBACK: Record<Runtime, FrameworkMemoryProfile> = {
  node:    { devSteadyMB: 300, devPeakMB: 520, prodSteadyMB: 140 },
  python:  { devSteadyMB: 140, devPeakMB: 240, prodSteadyMB: 120 },
  ruby:    { devSteadyMB: 180, devPeakMB: 300, prodSteadyMB: 140 },
  go:      { devSteadyMB: 100, devPeakMB: 240, prodSteadyMB: 60 },
  rust:    { devSteadyMB: 160, devPeakMB: 900, prodSteadyMB: 80 },
  elixir:  { devSteadyMB: 220, devPeakMB: 360, prodSteadyMB: 180 },
  dart:    { devSteadyMB: 260, devPeakMB: 420, prodSteadyMB: 160 },
  flutter: { devSteadyMB: 320, devPeakMB: 560, prodSteadyMB: 80 },
  php:     { devSteadyMB: 140, devPeakMB: 220, prodSteadyMB: 120 },
  dotnet:  { devSteadyMB: 380, devPeakMB: 620, prodSteadyMB: 280 },
  java:    { devSteadyMB: 520, devPeakMB: 1000, prodSteadyMB: 440 },
  bun:     { devSteadyMB: 120, devPeakMB: 220, prodSteadyMB: 90 },
  static:  { devSteadyMB: 40,  devPeakMB: 80,  prodSteadyMB: 40 },
  custom:  { devSteadyMB: 260, devPeakMB: 460, prodSteadyMB: 180 },
};

export function frameworkMemoryProfile(
  frameworkId: string | null | undefined,
  runtime: Runtime | null | undefined,
): FrameworkMemoryProfile {
  if (frameworkId && FRAMEWORK_MEMORY[frameworkId]) {
    return FRAMEWORK_MEMORY[frameworkId]!;
  }
  if (runtime && RUNTIME_FALLBACK[runtime]) {
    return RUNTIME_FALLBACK[runtime]!;
  }
  return RUNTIME_FALLBACK.node;
}

/** Dev-mode peak RSS (MB) used for admission reservation. */
export function estimatePreviewPeakMB(
  frameworkId: string | null | undefined,
  runtime: Runtime | null | undefined,
): number {
  return frameworkMemoryProfile(frameworkId, runtime).devPeakMB;
}

/** Dev-mode steady-state RSS (MB) used for concurrency accounting. */
export function estimatePreviewSteadyMB(
  frameworkId: string | null | undefined,
  runtime: Runtime | null | undefined,
): number {
  return frameworkMemoryProfile(frameworkId, runtime).devSteadyMB;
}

// ── Memory budget ───────────────────────────────────────────────────

/** Tier cap on concurrent hot previews. Drives per-preview cap sizing. */
export function hotPreviewsCap(physicalMB: number): number {
  const phys = Math.max(1, Math.floor(physicalMB));
  if (phys <= 4400) return 2;
  if (phys <= 8400) return 3;
  if (phys <= 16384) return 4;
  return 6;
}

export interface MemoryBudget {
  physicalMB: number;
  /** Reservation for kernel + control plane. Never available to previews. */
  reservedMB: number;
  /** Aggregate pool available across all concurrent previews. */
  previewBudgetMB: number;
  /** Hard cap per preview (cgroup MemoryMax). Sized to fit Spring Boot Gradle peak. */
  perPreviewCapMB: number;
  /** Soft cap per preview (cgroup MemoryHigh). Kernel reclaim trips here. */
  perPreviewHighMB: number;
  /** Concurrent hot previews allowed at the per-preview cap. */
  maxConcurrent: number;
  slicePercent: number;
}

export interface BudgetOptions {
  reservedMB?: number;
  slicePercent?: number;
}

/** Floor for per-preview cap: Spring Boot Gradle dev peak (1200 MB) + ~7% headroom. */
export const PER_PREVIEW_FLOOR_MB = 1280;
/** Ceiling: no single preview gets more than 4 GB; bigger hosts buy concurrency, not per-slot bloat. */
export const PER_PREVIEW_CEILING_MB = 4096;

/** Slice cap as percent-of-physical. Pinned to the previews.slice systemd cap so admission and kernel agree. */
export const PREVIEW_SLICE_PERCENT = 70;

export function computeMemoryBudget(
  physicalMB: number,
  opts: BudgetOptions = {},
): MemoryBudget {
  const phys = Math.max(1, Math.floor(physicalMB));

  const defaultReserveFraction =
    phys <= 1024 ? 0.45 :
    phys <= 2048 ? 0.38 :
    phys <= 4400 ? 0.28 :
    phys <= 8400 ? 0.24 :
    phys <= 16384 ? 0.20 :
    0.18;

  // Sub-2 GB tiers cannot host enterprise frameworks even at the cap floor.
  // Their slice percent is intentionally smaller to leave kernel/control-plane room.
  const defaultSlicePercent =
    phys <= 1024 ? 50 :
    phys <= 2048 ? 60 :
    PREVIEW_SLICE_PERCENT;

  const reservedMB = Math.max(
    256,
    opts.reservedMB ?? Math.round(phys * defaultReserveFraction),
  );
  const slicePercent = opts.slicePercent ?? defaultSlicePercent;
  const previewBudgetMB = Math.max(64, Math.floor(phys * (slicePercent / 100)));

  const tierConcurrency = Math.max(1, hotPreviewsCap(phys));
  const idealCap = Math.floor(previewBudgetMB / tierConcurrency);
  const perPreviewCapMB = Math.min(
    previewBudgetMB,
    PER_PREVIEW_CEILING_MB,
    Math.max(PER_PREVIEW_FLOOR_MB, idealCap),
  );

  const maxConcurrent = Math.max(
    1,
    Math.min(tierConcurrency, Math.floor(previewBudgetMB / perPreviewCapMB)),
  );

  const perPreviewHighMB = Math.floor(perPreviewCapMB * 0.78);

  return {
    physicalMB: phys,
    reservedMB,
    previewBudgetMB,
    perPreviewCapMB,
    perPreviewHighMB,
    maxConcurrent,
    slicePercent,
  };
}

export interface FrameworkCgroupCaps {
  memoryMaxMB: number;
  memoryHighMB: number;
  tasksMax: number;
  cpuQuotaPercent: number;
}

const HEAVY_THREAD_RUNTIMES = new Set<Runtime>(['java', 'dotnet', 'elixir', 'ruby']);
const LIGHT_THREAD_RUNTIMES = new Set<Runtime>(['go', 'rust', 'static']);
const COMPILE_HEAVY_RUNTIMES = new Set<Runtime>(['java', 'rust', 'dotnet']);

/** Reclaim cushion subtracted from MemoryMax to derive MemoryHigh. The kernel
 *  starts proactive reclaim at MemoryHigh; a fixed 256 MB cushion keeps the
 *  throttle window small relative to actual peak overshoot, so a brief spike
 *  during route compilation reclaims ~256 MB and stops, rather than a
 *  multi-hundred-MB reclaim that loops the process into D-state. */
const MEMORY_HIGH_CUSHION_MB = 256;

export function computeFrameworkCgroupCaps(
  frameworkId: string | null | undefined,
  runtime: Runtime | null | undefined,
  budget: MemoryBudget,
): FrameworkCgroupCaps {
  const profile = frameworkMemoryProfile(frameworkId, runtime);

  // The cgroup cap is a host-protection boundary, not an estimate of how much
  // the framework needs.  `budget.perPreviewCapMB` already accounts for host
  // concurrency (`previewBudgetMB / tierConcurrency` floored at
  // `PER_PREVIEW_FLOOR_MB`), so each preview safely gets the full slot.
  // The previous formula clamped to `devPeakMB * 1.5`, which sat tight to
  // documented peaks but had no headroom for real-world working-set drift —
  // route caches, HMR buffers, V8 fragmentation. Real next.js dev at user
  // load on a 4 GB host grew past 974 MB MemoryHigh in ~3 min and pushed the
  // cgroup into a reclaim spiral the watchdog had to break (37k+ throttle
  // events on 46cda094 / 1.6k+ events / 10 s on dd4cb7db before restart).
  // Sizing the cap at the budgeted slot uses the headroom we already paid
  // for at admission time. Floor at devSteadyMB + 64 MB so a misconfigured
  // budget never delivers a cap below the framework's resting RSS.
  const minViableMaxMB = profile.devSteadyMB + 64;
  const memoryMaxMB = Math.max(minViableMaxMB, budget.perPreviewCapMB);
  // Floor MemoryHigh at devSteadyMB so the kernel never reclaims below the
  // dev server's resting RSS; cap the cushion at half of MemoryMax so very
  // small caps still get a usable throttle window.
  const cushion = Math.min(MEMORY_HIGH_CUSHION_MB, Math.floor(memoryMaxMB / 2));
  const memoryHighMB = Math.max(
    Math.min(profile.devSteadyMB, memoryMaxMB - 16),
    memoryMaxMB - cushion,
  );

  const tasksMax =
    runtime && HEAVY_THREAD_RUNTIMES.has(runtime) ? 400 :
    runtime && LIGHT_THREAD_RUNTIMES.has(runtime) ? 128 :
    200;

  const cpuQuotaPercent =
    runtime && COMPILE_HEAVY_RUNTIMES.has(runtime) ? 120 :
    runtime === 'static' ? 25 :
    75;

  return { memoryMaxMB, memoryHighMB, tasksMax, cpuQuotaPercent };
}

// Node heap caps (--max-old-space-size). Off-heap adds ~30-40MB RSS on top.
export interface NodeHeapCaps {
  sovereignShield: number;
  fileApi: number;
  agentBridge: number;
  enforcer: number;
  watchdog: number;
}

export function computeNodeHeapCaps(physicalMB: number): NodeHeapCaps {
  const phys = Math.max(1, Math.floor(physicalMB));
  // 4 GB tier (kernel-visible 3.7–3.9 GB): the bridge previously sat at
  // 158 MB RSS with cap=192 — only 34 MB GC headroom on a service that
  // routinely fields six-thread bursts. Bumping to 256 gives 100 MB
  // headroom which keeps GC out of the hot path during burst load
  // while staying well under the control-plane.slice cap (30% × 4 GB
  // = 1 228 MB; sum of caps below = 880 MB + ~150 MB off-heap = 1 030 MB).
  if (phys <= 1024) {
    return { sovereignShield: 80, fileApi: 96,  agentBridge: 96,  enforcer: 48, watchdog: 48 };
  }
  if (phys <= 2048) {
    return { sovereignShield: 112, fileApi: 144, agentBridge: 144, enforcer: 64, watchdog: 56 };
  }
  if (phys <= 4096) {
    return { sovereignShield: 224, fileApi: 256, agentBridge: 256, enforcer: 96, watchdog: 80 };
  }
  if (phys <= 8192) {
    return { sovereignShield: 320, fileApi: 384, agentBridge: 384, enforcer: 128, watchdog: 96 };
  }
  return { sovereignShield: 512, fileApi: 512, agentBridge: 512, enforcer: 160, watchdog: 128 };
}

// Conservative pgtune (`web`) — low resident cost (DB is one tenant among many).
export interface PostgresMemoryProfile {
  sharedBuffersMB: number;
  workMemMB: number;
  maintenanceWorkMemMB: number;
  effectiveCacheSizeMB: number;
  maxConnections: number;
  walBuffersMB: number;
}

export function computePostgresMemory(physicalMB: number): PostgresMemoryProfile {
  const phys = Math.max(512, Math.floor(physicalMB));
  // shared_buffers at 12 % scales the pgtune guidance down so PostgreSQL
  // never dominates the host. max_connections is set at the SLA floor,
  // not the theoretical maximum — work_mem is budget per sort/hash op
  // per connection, so raising max_connections multiplies RSS risk.
  const sharedBuffersMB = Math.max(32, Math.floor(phys * 0.12));
  const effectiveCacheSizeMB = Math.max(96, Math.floor(phys * 0.35));
  const maintenanceWorkMemMB = Math.max(16, Math.floor(phys * 0.03));
  const maxConnections =
    phys <= 1024 ? 20 :
    phys <= 2048 ? 30 :
    phys <= 4096 ? 50 :
    phys <= 8192 ? 80 :
    120;
  // work_mem is per connection per operation; keep it tight on small
  // hosts and let larger hosts absorb correlated-subquery sort spills.
  const workMemMB =
    phys <= 1024 ? 2 :
    phys <= 2048 ? 3 :
    phys <= 4096 ? 6 :
    phys <= 8192 ? 10 :
    16;
  const walBuffersMB = Math.min(16, Math.max(4, Math.floor(sharedBuffersMB / 32)));
  return {
    sharedBuffersMB,
    workMemMB,
    maintenanceWorkMemMB,
    effectiveCacheSizeMB,
    maxConnections,
    walBuffersMB,
  };
}

// ── User-workload slice budget (resource-v2) ─────────────────────────
//
// Aggregate cap on ellul-user-workload.slice — parent of:
//   ellul-user-workload-previews.slice, ellul-user-workload-sbx-<id>.slice,
//   ellul-pro-claude-slot<N>.scope. Mirrors the percents in
//   shell/workflow/slice/user-workload-unit.slice and control-plane-unit.slice.

export interface WorkloadSliceBudget {
  physicalMB: number;
  /** 8% kernel + sshd lifeline reserve (min 256 MB). */
  kernelReservedMB: number;
  /** ellul-control-plane.slice aggregate cap (28% of phys, sized to fit heap caps + off-heap + warm pool on 4 GB). */
  controlPlaneAggregateMB: number;
  /** ellul-user-workload.slice MemoryMax (72% of phys). */
  workloadMaxMB: number;
  /** ellul-user-workload.slice MemoryHigh (89% of MemoryMax). */
  workloadHighMB: number;
  /** Per-sandbox slice MemoryHigh soft-hint. Per-sandbox slices have no MemoryMax. */
  perSandboxSoftHintMB: number;
  /** Pro Claude slot MemoryHigh soft-hint (one Pro session, prompt-cache spikes absorbed). */
  proClaudeSlotSoftHintMB: number;
  /** Inventory probe scope soft-hint. Probes run via ellul-spawn-scope under the workload slice. */
  probeSoftHintMB: number;
  workloadMaxPercent: number;
  workloadHighPercent: number;
}

// Sized so heap caps + ~150 MB off-heap + warm pool fits inside the slice on the
// 4 GB tier (912 + 150 + 12 = 1074 MB → 28% × 4096 = 1147 MB, ~73 MB headroom).
const CONTROL_PLANE_PERCENT = 28;
const KERNEL_RESERVE_PERCENT = 8;
const WORKLOAD_MAX_PERCENT = 72;
const WORKLOAD_HIGH_RATIO = 0.89;

export function computeWorkloadSliceBudget(physicalMB: number): WorkloadSliceBudget {
  const phys = Math.max(1, Math.floor(physicalMB));

  const kernelReservedMB = Math.max(256, Math.floor(phys * (KERNEL_RESERVE_PERCENT / 100)));
  const controlPlaneAggregateMB = Math.floor(phys * (CONTROL_PLANE_PERCENT / 100));
  const workloadMaxMB = Math.max(256, Math.floor(phys * (WORKLOAD_MAX_PERCENT / 100)));
  const workloadHighMB = Math.floor(workloadMaxMB * WORKLOAD_HIGH_RATIO);

  const perSandboxSoftHintMB = phys <= 4096 ? 1536 : 2048;
  const proClaudeSlotSoftHintMB = 320;
  const probeSoftHintMB =
    phys <= 2048 ? 384 :
    phys <= 4096 ? 512 :
    phys <= 8192 ? 768 :
    1024;

  return {
    physicalMB: phys,
    kernelReservedMB,
    controlPlaneAggregateMB,
    workloadMaxMB,
    workloadHighMB,
    perSandboxSoftHintMB,
    proClaudeSlotSoftHintMB,
    probeSoftHintMB,
    workloadMaxPercent: Math.round((workloadMaxMB / phys) * 100),
    workloadHighPercent: Math.round((workloadHighMB / phys) * 100),
  };
}

/** Slot manager enforces — Pro Claude concurrent process cap. */
export function proClaudeSlotCap(physicalMB: number): number {
  return Math.max(1, Math.floor(physicalMB)) <= 4096 ? 1 : 3;
}

/** ThreadArchiveService enforces — visible-thread sidebar cap. */
export function sidebarVisibleThreadsCap(physicalMB: number): number {
  return Math.max(1, Math.floor(physicalMB)) <= 4096 ? 30 : 100;
}

// ── Adapter pool profile ─────────────────────────────────────────────
// Sizing for per-project pools (opencode/cursor/zeroclaw) and the
// namespace reconciler. Tier-shaped: 4 GB is the product floor, so the
// curve uses warm depth + mlock pinning to carry the SLO instead of
// recommending a bigger box.

export interface AdapterPoolProfile {
  opencodeIdleTtlMs: number;
  cursorIdleTtlMs: number;
  zeroclawIdleTtlMs: number;
  /** Pre-created sessions per adapter per project. 0 disables warm pool. */
  warmDepth: number;
  reconcileIntervalMs: number;
  /** mlock budget for adapter binary pinning across the bridge, MB. */
  binaryMlockBudgetMB: number;
}

export function computeAdapterPoolProfile(physicalMB: number): AdapterPoolProfile {
  const phys = Math.max(1, Math.floor(physicalMB));
  // 4 200 cutoff captures the kernel-visible end of "4 GB" Hetzner shapes.
  if (phys <= 4200) {
    return {
      opencodeIdleTtlMs: 3 * 60_000,
      cursorIdleTtlMs: 3 * 60_000,
      zeroclawIdleTtlMs: 3 * 60_000,
      warmDepth: 1,
      reconcileIntervalMs: 30_000,
      binaryMlockBudgetMB: 80,
    };
  }
  if (phys <= 8400) {
    return {
      opencodeIdleTtlMs: 5 * 60_000,
      cursorIdleTtlMs: 5 * 60_000,
      zeroclawIdleTtlMs: 5 * 60_000,
      warmDepth: 2,
      reconcileIntervalMs: 30_000,
      binaryMlockBudgetMB: 160,
    };
  }
  return {
    opencodeIdleTtlMs: 10 * 60_000,
    cursorIdleTtlMs: 10 * 60_000,
    zeroclawIdleTtlMs: 10 * 60_000,
    warmDepth: 4,
    reconcileIntervalMs: 30_000,
    binaryMlockBudgetMB: 320,
  };
}
