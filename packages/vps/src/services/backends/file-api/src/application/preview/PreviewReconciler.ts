// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Preview reconciler — the push-based safety net.
// technically still below the idle threshold. "Never get near

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PREVIEW_LIMITS,
  resolvePreviewIdleEvictMs,
} from '@vps/shared/constants';
import { isOomImminent } from './PreviewPressure';

// Which app is currently selected in the UI? Reading the PREVIEW_FILE
function readActivePreviewDirectory(): string | null {
  try {
    const home = process.env.HOME || '/home/dev';
    const raw = fs.readFileSync(path.join(home, '.ellul', 'preview-app'), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

const OOM_RETRY_CIRCUIT_BREAKER = 3;

function isInstallOomBlocked(directory: string): boolean {
  try {
    const home = process.env.HOME || '/home/dev';
    const stateKey = directory.replace(/\//g, '__');
    const statePath = path.join(home, '.ellul', 'apps', `${stateKey}.install.state.json`);
    const raw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw) as { errorClass?: string; retryCount?: number };
    return state.errorClass === 'oom' && (state.retryCount ?? 0) >= OOM_RETRY_CIRCUIT_BREAKER;
  } catch {
    return false;
  }
}

import { previewPlatform } from './PreviewPlatform';
import {
  listTracked,
  lruOrder,
  observeActivity,
  recordStop,
  recordStart,
  idlenessMs,
} from './PreviewTracking';
import { reconcilerMetrics, trackingMetrics } from './PreviewMetrics';
import { transition as lifecycleTransition } from './PreviewLifecycle';
import { checkAndHealThrash } from './PreviewThrashWatchdog';

export type ReconcilerLog = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  ctx?: Record<string, unknown>,
) => void;

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticks = 0;
// Counts consecutive reconciler ticks where MemAvailable is below the
let consecutivePressureTicks = 0;
const backpressureStrikes = new Map<string, number>();
const BACKPRESSURE_CIRCUIT_BREAKER = 3;

// Start the reconciler loop. Idempotent.
export function startReconciler(log: ReconcilerLog): void {
  if (timer) return;
  const interval = PREVIEW_LIMITS.RECONCILE_INTERVAL_MS;
  log('info', 'preview-reconciler starting', { intervalMs: interval });
  // First tick slightly delayed to let file-api finish booting.
  timer = setTimeout(function run() {
    if (running) {
      timer = setTimeout(run, interval);
      return;
    }
    running = true;
    reconcileOnce(log)
      .catch(err => log('error', 'reconciler tick failed', { error: (err as Error).message }))
      .finally(() => {
        running = false;
        timer = setTimeout(run, interval);
      });
  }, 2000);
}

// Stop the reconciler (tests, shutdown).
export function stopReconciler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// One reconciliation pass. Public so it can be driven from tests or
export async function reconcileOnce(log: ReconcilerLog): Promise<ReconcileReport> {
  ticks++;
  reconcilerMetrics.tickStart();
  const t0 = Date.now();
  const report: ReconcileReport = {
    tick: ticks,
    failedResetCount: 0,
    activeCount: 0,
    evictedIdle: [],
    evictedPressure: [],
    observationErrors: 0,
    elapsedMs: 0,
  };

  // ── 1. Failed-unit GC ───────────────────────────────────────
  try {
    const failed = listFailedPreviewUnits();
    for (const unit of failed) {
      try {
        await previewPlatform.resetFailed(unit.instance);
        report.failedResetCount++;
        reconcilerMetrics.failedUnitsReset(1);
        log('info', 'reconciler: reset failed preview unit', {
          instance: unit.instance,
          result: unit.result,
        });
      } catch (err) {
        log('warn', 'reconciler: reset-failed errored (continuing)', {
          instance: unit.instance,
          error: (err as Error).message,
        });
      }
    }
  } catch (err) {
    log('warn', 'reconciler: listFailedPreviewUnits failed', { error: (err as Error).message });
  }

  // ── 2. Observe activity on every active preview ────────────
  let active: string[] = [];
  try {
    active = await previewPlatform.listActive();
    report.activeCount = active.length;
  } catch (err) {
    log('warn', 'reconciler: listActive failed — skipping observation', {
      error: (err as Error).message,
    });
    report.elapsedMs = Date.now() - t0;
    reconcilerMetrics.tickEnd(report.elapsedMs, report.activeCount);
    trackingMetrics.setTrackedCount(listTracked().length);
    return report;
  }

  const trackedDirs = new Set(listTracked().map(r => r.directory));
  for (const dir of active) {
    backpressureStrikes.delete(dir);
    if (!trackedDirs.has(dir)) {
      const port = portFor(dir);
      if (port !== null) recordStart(dir, port);
    }
  }

  // Observe each active preview.
  for (const dir of active) {
    try {
      observeActivity(dir);
    } catch (err) {
      report.observationErrors++;
      reconcilerMetrics.observationError();
      log('warn', 'reconciler: observeActivity failed', {
        directory: dir,
        error: (err as Error).message,
      });
    }
  }

  // Drop tracking for previews that are no longer active (stopped via
  for (const r of listTracked()) {
    if (!active.includes(r.directory)) recordStop(r.directory);
  }

  // ── 3. Idle eviction ───────────────────────────────────────
  const idleAfter = resolvePreviewIdleEvictMs();
  for (const r of lruOrder()) {
    const idle = idlenessMs(r.directory);
    if (idle !== null && idle >= idleAfter) {
      try {
        lifecycleTransition({ directory: r.directory, next: 'stopping', force: true });
      } catch {}
      try {
        await previewPlatform.stopUnit(r.directory);
        recordStop(r.directory);
        try {
          lifecycleTransition({ directory: r.directory, next: 'cold', force: true });
        } catch {}
        report.evictedIdle.push(r.directory);
        reconcilerMetrics.idleEviction();
        log('info', 'reconciler: evicted idle preview', {
          directory: r.directory,
          idleMs: idle,
        });
      } catch (err) {
        log('warn', 'reconciler: idle eviction failed', {
          directory: r.directory,
          error: (err as Error).message,
        });
      }
    }
  }

  // ── 4. Pressure-driven eviction ────────────────────────────
  // Two-tick confirmation + startup-grace period to avoid evicting
  // Post-mortem 2026-04-19: a Next.js first-compile hit ~85% RAM
  const pressure = readMemoryPressure();
  // Pressure eviction is *expensive*: killing a warm preview forfeits
  if (isOomImminent(pressure, {
    ramTightPercent: PREVIEW_LIMITS.PRESSURE_EVICT_THRESHOLD_PERCENT,
    swapTightMB: PREVIEW_LIMITS.PRESSURE_CRITICAL_FLOOR_MB,
  })) {
    consecutivePressureTicks++;
  } else {
    consecutivePressureTicks = 0;
  }
  const PRESSURE_CONFIRM_TICKS = 2;
  const PRESSURE_STARTUP_GRACE_MS = 120_000;
  if (consecutivePressureTicks >= PRESSURE_CONFIRM_TICKS) {
    const now = Date.now();
    // Never evict the preview the user is currently viewing. It's the
    // time they navigate to it we just re-start it. 2026-04-20 report.
    const activeDirectory = readActivePreviewDirectory();
    const candidates = lruOrder()
      .filter(r => now - r.startedAt >= PRESSURE_STARTUP_GRACE_MS)
      .filter(r => r.directory !== activeDirectory);
    const victim = candidates[0];
    if (victim) {
      try {
        // the victim's charge is reclaimed without a SIGTERM grace
        // gracefully terminated.
        try {
          lifecycleTransition({ directory: victim.directory, next: 'stopping', force: true });
        } catch {}
        await previewPlatform.stopUnit(victim.directory, { mode: 'immediate' });
        recordStop(victim.directory);
        try {
          lifecycleTransition({ directory: victim.directory, next: 'cold', force: true });
        } catch {}
        report.evictedPressure.push(victim.directory);
        reconcilerMetrics.pressureEviction();
        log('warn', 'reconciler: evicted preview under sustained memory pressure', {
          directory: victim.directory,
          memAvailablePercent: pressure.memAvailablePercent,
          swapFreeMB: pressure.swapFreeMB,
          consecutiveTicks: consecutivePressureTicks,
          ageMs: now - victim.startedAt,
        });
      } catch (err) {
        log('error', 'reconciler: pressure eviction failed', {
          directory: victim.directory,
          error: (err as Error).message,
        });
      }
    } else if (lruOrder().length > 0) {
      // Pressure is real but we decided to spare every tracked preview.
      const tracked = lruOrder();
      const allInGrace = tracked.every(r => now - r.startedAt < PRESSURE_STARTUP_GRACE_MS);
      log('info',
        allInGrace
          ? 'reconciler: deferring pressure eviction — all previews inside startup grace'
          : 'reconciler: deferring pressure eviction — only the active preview is evictable (never killed, user is watching it)',
        {
          memAvailablePercent: pressure.memAvailablePercent,
          swapFreeMB: pressure.swapFreeMB,
          trackedCount: tracked.length,
          activeDirectory,
        },
      );
    }
  }

  // ── 5. Active-preview convergence ───────────────────────────
  // races, swallowed internal errors, the caller never polled
  // - Skip during the startup grace window for a fresh start that
  // - Skip if install state shows repeated OOM failures (circuit breaker)
  // - Clear stale markers that point to directories that no longer exist
  try {
    const activeDir = readActivePreviewDirectory();
    if (activeDir && !active.includes(activeDir)) {
      const appPath = path.join(process.env['HOME'] || '/home/dev', 'projects', activeDir);
      if (!fs.existsSync(appPath)) {
        log('warn', 'reconciler: clearing stale preview-app marker — directory no longer exists', {
          directory: activeDir,
          resolvedPath: appPath,
        });
        try {
          const home = process.env.HOME || '/home/dev';
          fs.writeFileSync(path.join(home, '.ellul', 'preview-app'), '');
        } catch {}
      } else {
        const tracked = listTracked().find(r => r.directory === activeDir);
        const inGrace = tracked && (Date.now() - tracked.startedAt) < PRESSURE_STARTUP_GRACE_MS;
        if (!inGrace) {
          // Circuit breaker: if the last install attempt OOM-killed multiple times, don't retry
          const installStateBlocked = isInstallOomBlocked(activeDir);
          if (installStateBlocked) {
            log('warn', 'reconciler: skipping auto-start — install OOM circuit breaker tripped', {
              directory: activeDir,
            });
          } else {
            const strikes = backpressureStrikes.get(activeDir) ?? 0;
            if (strikes >= BACKPRESSURE_CIRCUIT_BREAKER) {
              log('warn', 'reconciler: skipping auto-start — backpressure circuit breaker tripped', {
                directory: activeDir,
                strikes,
              });
            } else {
              log('info', 'reconciler: active-preview marker points to non-running unit — auto-starting', {
                directory: activeDir,
              });
              const result = await startPreviewRef.current?.(activeDir);
              if (result && !result.success) {
                if (result.failReason === 'backpressure' || result.failReason === 'concurrency_limit') {
                  backpressureStrikes.set(activeDir, strikes + 1);
                }
                log('warn', 'reconciler: auto-start failed', {
                  directory: activeDir,
                  error: result.error,
                  failReason: result.failReason,
                  backpressureStrikes: backpressureStrikes.get(activeDir),
                });
              } else if (result?.success) {
                backpressureStrikes.delete(activeDir);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    log('error', 'reconciler: auto-start step threw', {
      error: (err as Error).message,
    });
  }

  // ── 6. Cgroup-thrash auto-restart ───────────────────────────
  // For every active preview, sample memory.events / PSI / accept-queue
  // and restart the unit if any of the three signals trips.  Restarts are
  // rate-limited per-app (5 min cooldown, 3/hr cap) so this never becomes
  // a thrash loop of its own. Each iteration is independent: a slow read
  // on one preview does not block the others.
  for (const dir of active) {
    const port = portFor(dir);
    if (port === null) continue;
    try {
      const restarted = await checkAndHealThrash(dir, port, log);
      if (restarted) {
        // Don't keep iterating after a restart — the unit map may have
        // shifted; the next reconciler tick re-observes from a clean
        // baseline (memory.events resets when the cgroup is recreated).
        report.thrashRestarted = (report.thrashRestarted ?? []).concat(dir);
        break;
      }
    } catch (err) {
      log('warn', 'reconciler: thrash watchdog threw (continuing)', {
        directory: dir,
        error: (err as Error).message,
      });
    }
  }

  report.elapsedMs = Date.now() - t0;
  reconcilerMetrics.tickEnd(report.elapsedMs, report.activeCount);
  trackingMetrics.setTrackedCount(listTracked().length);
  return report;
}

// Injected at module load by preview.service to break the cycle:
export const startPreviewRef: {
  current: ((directory: string) => Promise<{ success: boolean; error?: string; failReason?: string | null }>) | null;
} = { current: null };

export interface ReconcileReport {
  tick: number;
  failedResetCount: number;
  activeCount: number;
  evictedIdle: string[];
  evictedPressure: string[];
  thrashRestarted?: string[];
  observationErrors: number;
  elapsedMs: number;
}

// ── Helpers ────────────────────────────────────────────────────

interface FailedUnitSnapshot {
  instance: string;
  result: string;
}

function listFailedPreviewUnits(): FailedUnitSnapshot[] {
  return previewPlatform.listFailedUnits();
}

function portFor(appDirectory: string): number | null {
  // Derive port from the preview spec on disk. We don't import
  // preview-spec here to avoid a cycle; the cheap path is ok because
  const specPath = `${process.env['HOME']}/projects/${appDirectory}/.ellul/preview.json`;
  try {
    const data = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const p = typeof data.port === 'number' ? data.port : null;
    return p && p > 0 ? p : null;
  } catch {
    return null;
  }
}

function readMemoryPressure(): {
  memAvailablePercent: number;
  swapFreeMB: number;
  swapTotalMB: number;
} {
  try {
    const data = fs.readFileSync('/proc/meminfo', 'utf8');
    const pickKB = (k: string) => {
      const m = data.match(new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm'));
      return m ? parseInt(m[1]!, 10) : 0;
    };
    const avail = pickKB('MemAvailable');
    const total = pickKB('MemTotal') || Math.round(os.totalmem() / 1024);
    const swapFree = pickKB('SwapFree');
    const swapTotal = pickKB('SwapTotal');
    if (total <= 0) return { memAvailablePercent: 100, swapFreeMB: 0, swapTotalMB: 0 };
    return {
      memAvailablePercent: (avail / total) * 100,
      swapFreeMB: Math.round(swapFree / 1024),
      swapTotalMB: Math.round(swapTotal / 1024),
    };
  } catch {
    return { memAvailablePercent: 100, swapFreeMB: 0, swapTotalMB: 0 };
  }
}


// Test helper.
export function _resetReconcilerForTests(): void {
  stopReconciler();
  ticks = 0;
  running = false;
  consecutivePressureTicks = 0;
  backpressureStrikes.clear();
}

