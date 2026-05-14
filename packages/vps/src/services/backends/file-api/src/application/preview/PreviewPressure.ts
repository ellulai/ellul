// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Fargate's task placement all consume PSI because it measures the
// ARE being stalled right now — don't admit new work.

import * as fs from 'node:fs';

export interface PressureWindow {
  // % of time at least ONE task stalled on this resource.
  some: number;
  // % of time ALL tasks stalled (total stall). Always <= some.
  full: number;
}

export interface PressureSample {
  avg10: PressureWindow;
  avg60: PressureWindow;
  avg300: PressureWindow;
  // Total stall time (microseconds) since boot. Monotonic counter.
  totalUs: number;
}

export interface PressureSnapshot {
  memory: PressureSample | null;
  cpu: PressureSample | null;
  io: PressureSample | null;
  // True when PSI is not available on this host (cgroup v1, old kernel, container).
  psiUnavailable: boolean;
}

// Read current pressure for memory / cpu / io. Never throws —
export function readPressure(): PressureSnapshot {
  const memory = readOne('/proc/pressure/memory');
  const cpu = readOne('/proc/pressure/cpu');
  const io = readOne('/proc/pressure/io');
  return {
    memory,
    cpu,
    io,
    psiUnavailable: memory === null && cpu === null && io === null,
  };
}

// Admission-level decision: are we under enough memory pressure that
export type PressureVerdict = 'ok' | 'evict-lru' | 'reject';

export function classifyMemoryPressure(snapshot: PressureSnapshot): PressureVerdict {
  if (snapshot.psiUnavailable || !snapshot.memory) return 'ok';
  const { avg10, avg60 } = snapshot.memory;
  if (avg60.full > 10) return 'reject';
  if (avg10.some > 40) return 'reject';
  if (avg10.some > 15) return 'evict-lru';
  return 'ok';
}

// in which case RAM alone must carry the signal
export interface LegacyPressureSignals {
  memAvailablePercent: number;
  swapFreeMB: number;
  swapTotalMB: number;
}

export function isOomImminent(
  s: LegacyPressureSignals,
  thresholds: { ramTightPercent: number; swapTightMB: number },
): boolean {
  const ramTight = s.memAvailablePercent < thresholds.ramTightPercent;
  // No swap configured → fall back to RAM-only. With swap configured,
  const swapTight = s.swapTotalMB === 0 || s.swapFreeMB < thresholds.swapTightMB;
  return ramTight && swapTight;
}

// ── Internals ────────────────────────────────────────────────────

function readOne(path: string): PressureSample | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const some = parsePressureLine(raw, 'some');
    const full = parsePressureLine(raw, 'full');
    const totalUs = parseTotal(raw);
    if (!some || !full) return null;
    return { avg10: some.window, avg60: full.window, avg300: some.windowB, totalUs };
  } catch {
    return null;
  }
}

// Parse one line like:
function parsePressureLine(
  raw: string,
  bucket: 'some' | 'full',
): { window: PressureWindow; windowB: PressureWindow } | null {
  const line = raw.split('\n').find(l => l.startsWith(bucket));
  if (!line) return null;
  const pick = (key: string): number => {
    const m = line.match(new RegExp(`${key}=([0-9.]+)`));
    return m ? parseFloat(m[1]!) : 0;
  };
  return {
    window: { some: pick('avg10'), full: pick('avg10') },
    windowB: { some: pick('avg300'), full: pick('avg300') },
  };
}

function parseTotal(raw: string): number {
  // We sum the `some` total (the wider measure). Kernel reports one
  const line = raw.split('\n').find(l => l.startsWith('some'));
  if (!line) return 0;
  const m = line.match(/total=(\d+)/);
  return m ? parseInt(m[1]!, 10) : 0;
}
