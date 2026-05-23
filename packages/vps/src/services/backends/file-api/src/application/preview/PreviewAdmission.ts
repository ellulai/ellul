// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// immediate-kill path — SIGTERM grace would leave the
// Design invariant: this module never starts a preview. It only grants

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PREVIEW_LIMITS,
  resolvePreviewMaxConcurrent,
} from '@vps/shared/constants';
import {
  computeMemoryBudget,
  estimatePreviewPeakMB,
  estimatePreviewSteadyMB,
  frameworkMemoryProfile,
  type MemoryBudget,
} from '@vps/shared/memory-budget';
import { detectFramework, type FrameworkDef } from '@vps/shared/framework';
import { readSpec, type PreviewMode } from '@vps/shared/preview-spec';
import { probeWarmArtifact } from '@vps/shared/framework-artifacts';

import { getAppPath } from '../../config';
import { previewPlatform } from './PreviewPlatform';
import { listTracked, idlenessMs, lruOrder, recordStop } from './PreviewTracking';
import { readPressure, classifyMemoryPressure, isOomImminent } from './PreviewPressure';
import { drainForAdmission } from './PreviewDrain';
import { admissionMetrics, budgetMetrics } from './PreviewMetrics';
import { admitPreview } from '../admission/AdmissionBridge';

export type AdmissionOutcome =
  | {
      decision: 'accept';
      admittedMode: PreviewMode;
      /** What the cgroup will allow: min(framework devPeak, host perPreviewCap). Bounds the unit's MemoryMax. */
      effectiveCapMB: number;
      budget: MemoryBudget;
      frameworkId: string | null;
    }
  | {
      decision: 'accept-after-evict';
      admittedMode: PreviewMode;
      evictedDirectory: string;
      evictionMode: 'graceful' | 'immediate';
      drainElapsedMs: number;
      effectiveCapMB: number;
      budget: MemoryBudget;
      frameworkId: string | null;
    }
  | {
      decision: 'reject';
      reason: AdmissionRejectReason;
      message: string;
      signals: AdmissionSignals;
      budget: MemoryBudget | null;
      candidateReservation: CandidateReservation | null;
    };

export type AdmissionRejectReason =
  | 'memory-critical'
  | 'load-critical'
  | 'concurrency-full-no-idle-candidate'
  | 'drain-timeout'
  | 'budget-unavailable';

export interface AdmissionSignals {
  activeCount: number;
  memAvailableMB: number;
  swapFreeMB: number;
  // SwapTotal in MB. 0 means no swap is configured — the isOomImminent
  swapTotalMB: number;
  physicalMB: number;
  loadAvg1: number;
  nCPU: number;
}

// Snapshot system state relevant to admission. Pure read — no
export function readAdmissionSignals(): AdmissionSignals {
  if (!previewPlatform.hasCgroups) {
    return {
      activeCount: 0,
      memAvailableMB: 8192,
      swapFreeMB: 0,
      swapTotalMB: 0,
      physicalMB: 8192,
      loadAvg1: 0,
      nCPU: Math.max(1, os.cpus().length),
    };
  }
  let memAvailableMB = 0;
  let swapFreeMB = 0;
  let swapTotalMB = 0;
  let physicalMB = Math.max(1, Math.round(os.totalmem() / 1024 / 1024));
  try {
    const data = fs.readFileSync('/proc/meminfo', 'utf8');
    const pickKB = (key: string): number => {
      const m = data.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
      return m ? parseInt(m[1]!, 10) : 0;
    };
    memAvailableMB = pickKB('MemAvailable') / 1024;
    swapFreeMB = pickKB('SwapFree') / 1024;
    swapTotalMB = pickKB('SwapTotal') / 1024;
    const memTotalKB = pickKB('MemTotal');
    if (memTotalKB > 0) physicalMB = memTotalKB / 1024;
  } catch {
    // Fallback to os.freemem — it under-counts but we only need order of magnitude.
    memAvailableMB = Math.round(os.freemem() / 1024 / 1024);
  }
  return {
    activeCount: 0, // filled by evaluate()
    memAvailableMB,
    swapFreeMB,
    swapTotalMB,
    physicalMB,
    loadAvg1: os.loadavg()[0] ?? 0,
    nCPU: Math.max(1, os.cpus().length),
  };
}

// Resolved framework + sizing inputs for a candidate. Pure read; no side effects.
export interface CandidateReservation {
  frameworkId: string | null;
  framework: FrameworkDef | null;
  /** Framework devPeakMB — UNCLAMPED. Used for accounting; admission clamps to perPreviewCap separately. */
  devPeakMB: number;
  /** Framework devSteadyMB — admission's hot-fit gate. */
  steadyMB: number;
  /** Framework prodSteadyMB — null if n/a. Drives warm-mode reservation. */
  prodSteadyMB: number | null;
  warmArtifactAvailable: boolean;
}

export function resolveCandidateReservation(candidateDirectory: string): CandidateReservation {
  const appPath = getAppPath(candidateDirectory);
  const framework = resolveFramework(appPath);
  const runtime = framework?.runtime ?? null;
  const devPeakMB = estimatePreviewPeakMB(framework?.id ?? null, runtime);
  const steadyMB = estimatePreviewSteadyMB(framework?.id ?? null, runtime);
  const profile = frameworkMemoryProfile(framework?.id ?? null, runtime);
  const warm = probeWarmArtifact(appPath, framework);
  return {
    frameworkId: framework?.id ?? null,
    framework,
    devPeakMB,
    steadyMB,
    prodSteadyMB: profile.prodSteadyMB,
    warmArtifactAvailable: warm.available,
  };
}

function resolveFramework(appPath: string): FrameworkDef | null {
  const spec = readSpec(appPath);
  if (spec) {
    const detected = detectFramework(appPath);
    if (detected) return detected;
    return {
      id: `runtime:${spec.runtime}`,
      runtime: spec.runtime as FrameworkDef['runtime'],
      stackLabel: spec.runtime,
      marker: '',
      devCommand: spec.start,
      prodCommand: spec.start,
      install: null,
      prodInstall: null,
      env: {},
    };
  }
  return detectFramework(appPath);
}

// circuit — rejecting early avoids spinning every eviction before
function sumReservedPeakMB(exclude: string | null): number {
  let sum = 0;
  for (const record of listTracked()) {
    if (exclude && record.directory === exclude) continue;
    const reservation = resolveCandidateReservation(record.directory);
    sum += reservation.steadyMB;
  }
  return sum;
}

// Evaluate admission for a candidate start. Side-effectful only when
export async function evaluateAdmission(
  candidateDirectory: string,
  opts: {
    log?: (level: 'info' | 'warn' | 'error', msg: string, ctx?: Record<string, unknown>) => void;
  } = {},
): Promise<AdmissionOutcome> {
  const log = opts.log ?? (() => {});
  const signals = readAdmissionSignals();
  const active = await previewPlatform.listActive();
  signals.activeCount = active.length;

  // resource-v2 fast-fail gate: red mode + tier cap + framework-too-big are
  // decided by the v2 AdmissionService against measured cgroup headroom and
  // SystemHealth before falling through to the existing per-preview logic.
  // Spec: docs/v2/architecture/resource-v2/05-admission.md
  const v2Reservation = resolveCandidateReservation(candidateDirectory);
  const v2Decision = await admitPreview({
    kind: "preview",
    frameworkId: v2Reservation.frameworkId,
    runtime: v2Reservation.framework?.runtime ?? null,
  });
  if (!v2Decision.ok && v2Decision.reason !== "ERR_ADMISSION_FRAMEWORK_TOO_BIG" && v2Decision.reason !== "ERR_ADMISSION_NO_HEADROOM") {
    // FRAMEWORK_TOO_BIG and NO_HEADROOM fall through to the rich legacy path
    // below — it produces user-actionable messages that the v2 short-circuit
    // can't (e.g. "run the framework's build command first").
    const reason: AdmissionRejectReason =
      v2Decision.reason === "ERR_ADMISSION_PRESSURE_HIGH" ? 'memory-critical' :
      v2Decision.reason === "ERR_ADMISSION_DEGRADED_RED" ? 'memory-critical' :
      v2Decision.reason === "ERR_ADMISSION_TIER_CAP" ? 'concurrency-full-no-idle-candidate' :
      'memory-critical';
    log('warn', 'admission.v2.reject', { reason: v2Decision.reason });
    return { decision: 'reject', reason, message: `Admission rejected (${v2Decision.reason}).`, signals, budget: null, candidateReservation: v2Reservation };
  }

  const budget = computeMemoryBudget(signals.physicalMB);
  budgetMetrics.setBudget({
    physicalMB: budget.physicalMB,
    reservedMB: budget.reservedMB,
    previewBudgetMB: budget.previewBudgetMB,
    perPreviewCapMB: budget.perPreviewCapMB,
  });

  const reservation = resolveCandidateReservation(candidateDirectory);

  // Hot admits on steady-state RSS; cgroup MemoryHigh reclaims peaks before they reach MemoryMax.
  const hotFits = reservation.steadyMB <= budget.perPreviewCapMB;
  const warmSteady = reservation.prodSteadyMB;
  const warmFits = warmSteady !== null && warmSteady <= budget.perPreviewCapMB;
  const warmAvailable = warmFits && reservation.warmArtifactAvailable;

  let admittedMode: PreviewMode = 'hot';
  // Headroom math gates against what the cgroup will actually allow the unit to grow into.
  let effectiveCapMB = Math.min(reservation.devPeakMB, budget.perPreviewCapMB);
  if (!hotFits && warmAvailable && warmSteady !== null) {
    admittedMode = 'warm';
    effectiveCapMB = Math.min(Math.floor(warmSteady * 1.25), budget.perPreviewCapMB);
  }

  const activeReservedMB = sumReservedPeakMB(null);
  const headroomMB = Math.max(0, signals.memAvailableMB - effectiveCapMB);
  budgetMetrics.setActiveReservedMB(activeReservedMB);
  budgetMetrics.setHeadroomMB(headroomMB);

  const fitsAtAll = admittedMode === 'hot' ? hotFits : warmFits;
  if (!fitsAtAll) {
    admissionMetrics.rejectBudgetUnavailable();
    return {
      decision: 'reject',
      reason: 'budget-unavailable',
      signals, budget, candidateReservation: reservation,
      message:
        `Candidate steady ${reservation.steadyMB}MB (dev) / ` +
        `${warmSteady ?? 'n/a'}MB (warm) exceeds the per-preview budget ` +
        `(${budget.perPreviewCapMB}MB). Framework "${reservation.frameworkId ?? 'unknown'}" is too ` +
        `memory-hungry for this host class. ` +
        (warmSteady !== null && !reservation.warmArtifactAvailable
          ? `A production build would fit; run the framework's build command first.`
          : ``),
    };
  }

  // ── PSI: reject if kernel says we're stalling on memory ─────
  // PSI beats MemAvailable on every dimension: it measures the
  const pressure = readPressure();
  const verdict = classifyMemoryPressure(pressure);
  if (verdict === 'reject') {
    admissionMetrics.rejectPressure();
    return {
      decision: 'reject',
      reason: 'memory-critical',
      signals, budget, candidateReservation: reservation,
      message:
        `Kernel reports memory pressure — avg10.some=${pressure.memory?.avg10.some.toFixed(1)}% ` +
        `avg60.full=${pressure.memory?.avg60.full.toFixed(1)}%. ` +
        `System is actively stalling on memory; wait a moment and retry.`,
    };
  }

  // ── Hard memory floor (legacy fallback) ─────────────────────
  if (
    signals.memAvailableMB < PREVIEW_LIMITS.PRESSURE_CRITICAL_FLOOR_MB &&
    signals.swapFreeMB < PREVIEW_LIMITS.PRESSURE_CRITICAL_FLOOR_MB
  ) {
    admissionMetrics.rejectMemoryCritical();
    return {
      decision: 'reject',
      reason: 'memory-critical',
      signals, budget, candidateReservation: reservation,
      message:
        `System memory exhausted — MemAvailable=${Math.round(signals.memAvailableMB)}MB + ` +
        `SwapFree=${Math.round(signals.swapFreeMB)}MB below ${PREVIEW_LIMITS.PRESSURE_CRITICAL_FLOOR_MB}MB floor.`,
    };
  }

  // ── Hard load ceiling ────────────────────────────────────────
  if (signals.loadAvg1 > signals.nCPU * PREVIEW_LIMITS.LOAD_MULTIPLIER) {
    admissionMetrics.rejectLoad();
    return {
      decision: 'reject',
      reason: 'load-critical',
      signals, budget, candidateReservation: reservation,
      message: `System load too high (${signals.loadAvg1.toFixed(1)} over ${signals.nCPU} cores) — try again shortly.`,
    };
  }

  // ── Concurrency cap (+ soft-pressure / PSI proactive eviction) ─
  const candidateIsActive = active.includes(candidateDirectory);
  const maxConcurrent = resolvePreviewMaxConcurrent(
    PREVIEW_LIMITS.MAX_CONCURRENT,
    signals.physicalMB,
  );
  const memPressurePercent = (signals.memAvailableMB / signals.physicalMB) * 100;
  // don't need is a net loss. The PSI `evict-lru` verdict stays
  const oomImminent = isOomImminent(
    {
      memAvailablePercent: memPressurePercent,
      swapFreeMB: signals.swapFreeMB,
      swapTotalMB: signals.swapTotalMB,
    },
    {
      ramTightPercent: PREVIEW_LIMITS.PRESSURE_EVICT_THRESHOLD_PERCENT,
      swapTightMB: PREVIEW_LIMITS.PRESSURE_CRITICAL_FLOOR_MB,
    },
  );
  const underSoftPressure = oomImminent || verdict === 'evict-lru';

  // ── Headroom-driven proactive eviction ──────────────────────
  // reserved peak exceeds current MemAvailable we must evict to
  const insufficientHeadroom =
    !candidateIsActive &&
    effectiveCapMB > headroomMB + PREVIEW_LIMITS.DRAIN_HEADROOM_MB;

  const mustFreeSlot = !candidateIsActive && signals.activeCount >= maxConcurrent;
  if (mustFreeSlot || underSoftPressure || insufficientHeadroom) {
    const trigger: EvictionTrigger = mustFreeSlot
      ? 'cap'
      : underSoftPressure
      ? 'pressure'
      : 'headroom';
    const victim = pickEvictionVictim(candidateDirectory, active, trigger);
    if (!victim) {
      if (!mustFreeSlot && !insufficientHeadroom) {
        // caps will prevent the new start from piling on the stall.
        admissionMetrics.accept();
        return {
          decision: 'accept',
          admittedMode,
          effectiveCapMB,
          budget,
          frameworkId: reservation.frameworkId,
        };
      }
      admissionMetrics.rejectConcurrency();
      return {
        decision: 'reject',
        reason: 'concurrency-full-no-idle-candidate',
        signals, budget, candidateReservation: reservation,
        message:
          `Cannot start more than ${maxConcurrent} previews at once, and no idle preview was found to evict. ` +
          `Stop one of the running previews and try again.`,
      };
    }
    if (verdict === 'evict-lru') admissionMetrics.psiEvict();

    // SIGTERM grace window and re-trigger the exact slice OOM
    // we're trying to avoid. Capped-concurrency evictions stay
    const evictionMode: 'graceful' | 'immediate' =
      trigger === 'cap' ? 'graceful' : 'immediate';

    log('info', 'admission: evicting LRU preview to free slot', {
      candidate: candidateDirectory,
      victim: victim.directory,
      activeCount: signals.activeCount,
      maxConcurrent,
      memAvailableMB: Math.round(signals.memAvailableMB),
      effectiveCapMB,
      memPressurePercent: Math.round(memPressurePercent),
      trigger,
      evictionMode,
    });

    try {
      await previewPlatform.stopUnit(victim.directory, { mode: evictionMode });
      recordStop(victim.directory);
    } catch (err) {
      log('error', 'admission: eviction stopUnit failed', {
        victim: victim.directory,
        error: (err as Error).message,
      });
      return {
        decision: 'reject',
        reason: 'concurrency-full-no-idle-candidate',
        signals, budget, candidateReservation: reservation,
        message: `Eviction failed for ${victim.directory} while trying to make room for ${candidateDirectory}.`,
      };
    }

    if (evictionMode === 'graceful') admissionMetrics.evictionGraceful();
    else admissionMetrics.evictionImmediate();

    // ── Drain ─────────────────────────────────────────────────
    // peak + headroom, so the incoming preview never starts
    const drainTargetMB =
      Math.round(effectiveCapMB + PREVIEW_LIMITS.DRAIN_HEADROOM_MB);
    const drain = await drainForAdmission({
      targetFreeMB: drainTargetMB,
      timeoutMs: PREVIEW_LIMITS.DRAIN_TIMEOUT_MS,
      pollIntervalMs: PREVIEW_LIMITS.DRAIN_POLL_INTERVAL_MS,
      onProgress: ({ freeMB, elapsedMs, polls }) => {
        if (polls === 1 || polls % 10 === 0) {
          log('info', 'admission: draining', {
            victim: victim.directory,
            freeMB,
            targetMB: drainTargetMB,
            elapsedMs,
          });
        }
      },
    });
    admissionMetrics.recordDrainMs(drain.elapsedMs);

    if (!drain.recovered) {
      // for safety, but if MemAvailable reached the peak itself (no
      if (drain.finalFreeMB >= effectiveCapMB) {
        log('warn', 'admission: drain fell short of headroom target but has enough for peak — admitting', {
          victim: victim.directory,
          targetMB: drainTargetMB,
          effectiveCapMB,
          finalFreeMB: Math.round(drain.finalFreeMB),
          elapsedMs: drain.elapsedMs,
          polls: drain.polls,
        });
      } else {
        admissionMetrics.rejectDrainTimeout();
        log('warn', 'admission: drain timeout after eviction', {
          victim: victim.directory,
          targetMB: drainTargetMB,
          effectiveCapMB,
          finalFreeMB: Math.round(drain.finalFreeMB),
          elapsedMs: drain.elapsedMs,
          polls: drain.polls,
        });
        return {
          decision: 'reject',
          reason: 'drain-timeout',
          signals, budget, candidateReservation: reservation,
          message:
            `Evicted ${path.basename(victim.directory)} to make room, but memory did not recover ` +
            `in ${PREVIEW_LIMITS.DRAIN_TIMEOUT_MS}ms (target=${drainTargetMB}MB, ` +
            `peak=${effectiveCapMB}MB, final=${Math.round(drain.finalFreeMB)}MB). ` +
            `Try again in a moment.`,
        };
      }
    }

    admissionMetrics.acceptAfterEvict();
    admissionMetrics.acceptAfterDrain();
    return {
      decision: 'accept-after-evict',
      admittedMode,
      evictedDirectory: victim.directory,
      evictionMode,
      drainElapsedMs: drain.elapsedMs,
      effectiveCapMB,
      budget,
      frameworkId: reservation.frameworkId,
    };
  }

  admissionMetrics.accept();
  return {
    decision: 'accept',
    admittedMode,
    effectiveCapMB,
    budget,
    frameworkId: reservation.frameworkId,
  };
}

type EvictionTrigger = 'cap' | 'pressure' | 'headroom';

// Never evicts the candidate itself (caller guaranteed by
function pickEvictionVictim(
  candidateDirectory: string,
  active: string[],
  trigger: EvictionTrigger,
): { directory: string } | null {
  const tracked = lruOrder().filter(r => r.directory !== candidateDirectory);

  // Tier 1: strictly idle
  for (const r of tracked) {
    const idle = idlenessMs(r.directory);
    if (idle !== null && idle >= PREVIEW_LIMITS.IDLE_EVICT_AFTER_MS) {
      return { directory: r.directory };
    }
  }

  if (trigger === 'pressure' || trigger === 'headroom') {
    // Tier 2: oldest tracked even if "active" — pressure is the override.
    const oldest = tracked[0];
    if (oldest) return { directory: oldest.directory };
  }

  // Tier 3: untracked active (reconciler hasn't caught up)
  const untracked = active
    .filter(d => d !== candidateDirectory && !listTracked().some(t => t.directory === d))
    .sort();
  if (untracked.length > 0 && trigger === 'cap') return { directory: untracked[0]! };

  return null;
}
