// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Detect cgroup memory-reclaim spirals + accept-queue overflow on a preview
// unit and auto-restart before the user-visible symptom escalates from "slow
// page" to "iframe stuck on warming page". Three independent signals trip
// the watchdog:
//
//   1. memory.events `high` count delta — kernel-level throttle counter;
//      a sudden jump means the cgroup blew past MemoryHigh and the kernel
//      is actively reclaiming pages. Sustained reclaim on Node.js puts the
//      process into D-state on every page fault.
//
//   2. memory.pressure full avg10 — PSI metric for "every process in the
//      cgroup is stalled on memory". > 30 % means the process can't make
//      forward progress and is largely waiting on the kernel.
//
//   3. accept-queue Recv-Q on the listen socket — the dev server didn't
//      accept() fast enough; new connections are queued or dropped. This
//      is the user-visible symptom: requests that should be served
//      instantly time out at the kernel.
//
// All three correlate. Restart clears the working-set drift that drives
// the spiral; the new process starts with a clean RSS and the new
// MemoryHigh from `frameworkMemoryProfile()` is large enough that the
// route compile fits without overshoot. Cooldowns prevent oscillation.

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

import type { ReconcilerLog } from './PreviewReconciler';
import { previewPlatform } from './PreviewPlatform';

interface ThrashWatchState {
  lastHighCount: number;
  recentRestarts: number[]; // unix ms timestamps
}

const watchState = new Map<string, ThrashWatchState>();

// Thresholds. memory.events `high` is monotonic; we look at the per-tick
// delta (tick interval is PREVIEW_LIMITS.RECONCILE_INTERVAL_MS, currently
// 10 s). A healthy unit sees 0 throttle events; a unit in a real reclaim
// spiral hits 50+ in a single 10 s window. 50 is low enough to catch the
// failure mode early (one bad burst is enough) but high enough that a
// brief overshoot during compile (5–15 events / 10 s) doesn't trigger
// the restart cascade. Empirically: dd4cb7db's first thrash at delta=1614
// — well past any reasonable noise threshold; 46cda094 thrashed for hours
// at a ~50–100 event/10 s steady rate that 50 catches but 100 missed.
const HIGH_EVENT_DELTA_THRESHOLD = 50;
const PSI_FULL_AVG10_THRESHOLD = 30;
const ACCEPT_QUEUE_THRESHOLD = 256;

// Restart guards. A wedged unit shouldn't be restarted more than three
// times per hour (something else is wrong; reboot loop wastes resources).
// 5 min between restarts ensures a freshly-restarted unit gets a full
// route-compile cycle before we declare it wedged again.
const RESTART_COOLDOWN_MS = 5 * 60 * 1000;
const RESTARTS_PER_HOUR_CAP = 3;

interface ThrashSignals {
  pid: number | null;
  highCountDelta: number;
  psiFullAvg10: number;
  acceptQueueRecvQ: number;
  cgroupPath: string | null;
}

function readPidOnPort(port: number): number | null {
  try {
    const out = execSync(`ss -tlnp 'sport = :${port}'`, {
      encoding: 'utf8',
      timeout: 2000,
    });
    const m = out.match(/pid=(\d+)/);
    return m?.[1] ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function readCgroupPath(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
    // unified hierarchy lines look like "0::/path/to/cgroup"
    const m = raw.match(/^0::(.+)$/m);
    return m?.[1] ? m[1] : null;
  } catch {
    return null;
  }
}

function readMemoryHighCount(cgroupBase: string): number {
  try {
    const events = fs.readFileSync(`${cgroupBase}/memory.events`, 'utf8');
    const m = events.match(/^high\s+(\d+)/m);
    return m?.[1] ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function readPsiFullAvg10(cgroupBase: string): number {
  try {
    const psi = fs.readFileSync(`${cgroupBase}/memory.pressure`, 'utf8');
    const m = psi.match(/full\s+avg10=([\d.]+)/);
    return m?.[1] ? parseFloat(m[1]) : 0;
  } catch {
    return 0;
  }
}

function readAcceptQueueRecvQ(port: number): number {
  try {
    const out = execSync(`ss -tln 'sport = :${port}'`, {
      encoding: 'utf8',
      timeout: 2000,
    });
    // ss output for LISTEN socket has columns: State Recv-Q Send-Q Local Peer
    const m = out.match(/LISTEN\s+(\d+)\s+\d+\s+\S+:(\d+)/);
    return m?.[1] ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function readSignals(appDir: string, port: number): ThrashSignals {
  const pid = readPidOnPort(port);
  if (!pid) {
    return { pid: null, highCountDelta: 0, psiFullAvg10: 0, acceptQueueRecvQ: 0, cgroupPath: null };
  }
  const cgroupPath = readCgroupPath(pid);
  if (!cgroupPath) {
    return { pid, highCountDelta: 0, psiFullAvg10: 0, acceptQueueRecvQ: 0, cgroupPath: null };
  }
  const cgroupBase = `/sys/fs/cgroup${cgroupPath}`;
  const highCount = readMemoryHighCount(cgroupBase);
  const psiFullAvg10 = readPsiFullAvg10(cgroupBase);
  const acceptQueueRecvQ = readAcceptQueueRecvQ(port);

  const state = watchState.get(appDir) ?? { lastHighCount: 0, recentRestarts: [] };
  const highCountDelta = state.lastHighCount > 0 ? highCount - state.lastHighCount : 0;
  state.lastHighCount = highCount;
  watchState.set(appDir, state);

  return { pid, highCountDelta, psiFullAvg10, acceptQueueRecvQ, cgroupPath };
}

function isThrashing(signals: ThrashSignals): { thrashing: boolean; reason: string } {
  if (signals.pid === null) return { thrashing: false, reason: '' };
  if (signals.highCountDelta >= HIGH_EVENT_DELTA_THRESHOLD) {
    return {
      thrashing: true,
      reason: `cgroup memory.high triggered ${signals.highCountDelta} times since last tick`,
    };
  }
  if (signals.psiFullAvg10 >= PSI_FULL_AVG10_THRESHOLD) {
    return {
      thrashing: true,
      reason: `PSI memory full avg10 = ${signals.psiFullAvg10}% (≥${PSI_FULL_AVG10_THRESHOLD}%)`,
    };
  }
  if (signals.acceptQueueRecvQ >= ACCEPT_QUEUE_THRESHOLD) {
    return {
      thrashing: true,
      reason: `accept queue Recv-Q = ${signals.acceptQueueRecvQ} (≥${ACCEPT_QUEUE_THRESHOLD})`,
    };
  }
  return { thrashing: false, reason: '' };
}

function pruneOldRestarts(state: ThrashWatchState, now: number): void {
  state.recentRestarts = state.recentRestarts.filter((t) => now - t < 60 * 60 * 1000);
}

function restartAllowed(state: ThrashWatchState, now: number): { allowed: boolean; reason?: string } {
  pruneOldRestarts(state, now);
  if (state.recentRestarts.length >= RESTARTS_PER_HOUR_CAP) {
    return {
      allowed: false,
      reason: `hourly restart cap (${RESTARTS_PER_HOUR_CAP}) exceeded — operator intervention required`,
    };
  }
  const lastRestart = state.recentRestarts[state.recentRestarts.length - 1];
  if (lastRestart !== undefined && now - lastRestart < RESTART_COOLDOWN_MS) {
    const ageMs = now - lastRestart;
    return {
      allowed: false,
      reason: `cooldown active (${Math.round(ageMs / 1000)}s since last restart, need ${RESTART_COOLDOWN_MS / 1000}s)`,
    };
  }
  return { allowed: true };
}

/** Inspect a preview unit's cgroup + listen socket for thrash signals.
 *  Restarts the unit if any signal trips, with cooldown + per-hour cap.
 *  Returns true when a restart was issued. */
export async function checkAndHealThrash(
  appDir: string,
  port: number,
  log: ReconcilerLog,
): Promise<boolean> {
  if (!previewPlatform.hasCgroups) return false;
  const signals = readSignals(appDir, port);
  const { thrashing, reason } = isThrashing(signals);
  if (!thrashing) return false;

  const state = watchState.get(appDir) ?? { lastHighCount: 0, recentRestarts: [] };
  watchState.set(appDir, state);

  const now = Date.now();
  const guard = restartAllowed(state, now);
  if (!guard.allowed) {
    log('warn', 'thrash-watchdog: thrash detected but restart blocked', {
      directory: appDir,
      port,
      reason,
      blockedReason: guard.reason,
      restartHistory: state.recentRestarts.map((t) => new Date(t).toISOString()),
    });
    return false;
  }

  log('warn', 'thrash-watchdog: restarting wedged preview unit', {
    directory: appDir,
    port,
    pid: signals.pid,
    cgroupPath: signals.cgroupPath,
    trigger: reason,
    highCountDelta: signals.highCountDelta,
    psiFullAvg10: signals.psiFullAvg10,
    acceptQueueRecvQ: signals.acceptQueueRecvQ,
  });

  state.recentRestarts.push(now);
  // The cgroup gets a fresh memory.events table on restart, so reset the
  // baseline rather than carrying a now-stale lastHighCount forward.
  state.lastHighCount = 0;
  watchState.set(appDir, state);

  try {
    const result = await previewPlatform.restartUnit(appDir);
    if (!result.ok) {
      log('error', 'thrash-watchdog: restart failed', {
        directory: appDir,
        error: result.error,
      });
      return false;
    }
    return true;
  } catch (err) {
    log('error', 'thrash-watchdog: restart threw', {
      directory: appDir,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Test helper: reset watchdog state. */
export function __resetThrashWatchdogStateForTests(): void {
  watchState.clear();
}
