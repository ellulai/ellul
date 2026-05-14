// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// controller that returns immediately after stopUnit() to race the
// This module closes that race the same way the Kubernetes eviction

import * as fs from 'node:fs';

export interface DrainOptions {
  // Required free memory (MB) before the drain is considered complete.
  targetFreeMB: number;
  // Maximum wall-clock budget (ms) to spend waiting.
  timeoutMs: number;
  // Poll interval (ms). Defaults to 100ms.
  pollIntervalMs?: number;
  // Optional hook called on each poll. Useful for surfacing drain
  onProgress?: (snapshot: {
    freeMB: number;
    elapsedMs: number;
    polls: number;
  }) => void;
  // Injected clock; defaults to Date.now. Lets tests drive the loop.
  now?: () => number;
  // Injected /proc/meminfo reader; defaults to fs.readFileSync.
  readMemInfo?: () => string;
}

export interface DrainResult {
  // True if targetFreeMB was reached before timeout.
  recovered: boolean;
  // MemAvailable on the last poll.
  finalFreeMB: number;
  // MemAvailable on the first poll (pre-drain snapshot).
  initialFreeMB: number;
  // Wall-clock milliseconds spent in the drain loop.
  elapsedMs: number;
  // Number of polls executed.
  polls: number;
}

// Read MemAvailable from /proc/meminfo in MB. Returns 0 on any read
export function readMemAvailableMB(reader: () => string = defaultReader): number {
  let raw: string;
  try {
    raw = reader();
  } catch {
    return 0;
  }
  const m = raw.match(/^MemAvailable:\s+(\d+)\s*kB/m);
  if (!m) return 0;
  const kB = parseInt(m[1]!, 10);
  if (!Number.isFinite(kB)) return 0;
  return Math.floor(kB / 1024);
}

// timeout expires. Never throws — exhausting the budget returns
export async function drainForAdmission(opts: DrainOptions): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const read = opts.readMemInfo ?? defaultReader;
  const interval = Math.max(10, opts.pollIntervalMs ?? 100);
  const started = now();
  const deadline = started + Math.max(0, opts.timeoutMs);
  let polls = 0;
  const initialFreeMB = readMemAvailableMB(read);
  let currentFreeMB = initialFreeMB;

  while (true) {
    polls++;
    currentFreeMB = readMemAvailableMB(read);
    const elapsedMs = now() - started;
    if (opts.onProgress) {
      try { opts.onProgress({ freeMB: currentFreeMB, elapsedMs, polls }); }
      catch { /* onProgress is observational; never let it break the loop. */ }
    }
    if (currentFreeMB >= opts.targetFreeMB) {
      return {
        recovered: true,
        finalFreeMB: currentFreeMB,
        initialFreeMB,
        elapsedMs,
        polls,
      };
    }
    if (now() >= deadline) {
      return {
        recovered: false,
        finalFreeMB: currentFreeMB,
        initialFreeMB,
        elapsedMs,
        polls,
      };
    }
    const remaining = deadline - now();
    await sleep(Math.min(interval, Math.max(1, remaining)));
  }
}

// pages the kernel would otherwise amortize across normal allocations.
export function requestKernelReclaim(mode: 1 | 2 | 3 = 1): { ok: boolean; error?: string } {
  try {
    fs.writeFileSync('/proc/sys/vm/drop_caches', String(mode));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Internals ───────────────────────────────────────────────────────

function defaultReader(): string {
  return fs.readFileSync('/proc/meminfo', 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
