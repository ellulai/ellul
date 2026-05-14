// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';

import { classifyMemoryPressure, isOomImminent, readPressure } from './PreviewPressure';

describe('preview-pressure', () => {
  it('returns ok when PSI unavailable', () => {
    expect(
      classifyMemoryPressure({
        memory: null,
        cpu: null,
        io: null,
        psiUnavailable: true,
      }),
    ).toBe('ok');
  });

  it('returns ok when avg10.some <= 15', () => {
    expect(
      classifyMemoryPressure({
        memory: {
          avg10: { some: 10, full: 0 },
          avg60: { some: 5, full: 0 },
          avg300: { some: 3, full: 0 },
          totalUs: 0,
        },
        cpu: null,
        io: null,
        psiUnavailable: false,
      }),
    ).toBe('ok');
  });

  it('returns evict-lru when avg10.some between 15 and 40', () => {
    expect(
      classifyMemoryPressure({
        memory: {
          avg10: { some: 25, full: 0 },
          avg60: { some: 10, full: 0 },
          avg300: { some: 5, full: 0 },
          totalUs: 0,
        },
        cpu: null,
        io: null,
        psiUnavailable: false,
      }),
    ).toBe('evict-lru');
  });

  it('returns reject when avg10.some > 40', () => {
    expect(
      classifyMemoryPressure({
        memory: {
          avg10: { some: 60, full: 20 },
          avg60: { some: 30, full: 10 },
          avg300: { some: 15, full: 5 },
          totalUs: 0,
        },
        cpu: null,
        io: null,
        psiUnavailable: false,
      }),
    ).toBe('reject');
  });

  it('returns reject when avg60.full > 10', () => {
    expect(
      classifyMemoryPressure({
        memory: {
          avg10: { some: 10, full: 0 },
          avg60: { some: 40, full: 15 },
          avg300: { some: 20, full: 10 },
          totalUs: 0,
        },
        cpu: null,
        io: null,
        psiUnavailable: false,
      }),
    ).toBe('reject');
  });

  it('readPressure never throws', () => {
    // On CI/test machines PSI may or may not be present. Either way the
    // function must return a snapshot object, not throw.
    expect(() => readPressure()).not.toThrow();
    const snap = readPressure();
    expect(snap).toHaveProperty('psiUnavailable');
  });
});

// ── isOomImminent — legacy MemAvailable + swap classifier ───────────
//
// Codifies the rule shared by admission and reconciler: only evict when
// RAM is tight AND swap is tight (or no swap configured). Tests pin the
// boundary cases so a future threshold tweak can't silently flip the
// policy in one path without flipping it in the other.
describe('isOomImminent', () => {
  const thresholds = { ramTightPercent: 15, swapTightMB: 128 };

  it('false when both RAM and swap have headroom', () => {
    expect(
      isOomImminent(
        { memAvailablePercent: 30, swapFreeMB: 500, swapTotalMB: 2048 },
        thresholds,
      ),
    ).toBe(false);
  });

  it('false when only RAM is tight but swap has headroom (kernel can reclaim)', () => {
    // This is the post-2026-04-20 case: 9% available RAM, 1GB swap free.
    // Previous threshold fired here and killed the preview. New gate
    // requires swap to ALSO be tight.
    expect(
      isOomImminent(
        { memAvailablePercent: 9, swapFreeMB: 1000, swapTotalMB: 2048 },
        thresholds,
      ),
    ).toBe(false);
  });

  it('false when only swap is tight but RAM has headroom', () => {
    expect(
      isOomImminent(
        { memAvailablePercent: 40, swapFreeMB: 50, swapTotalMB: 2048 },
        thresholds,
      ),
    ).toBe(false);
  });

  it('true when BOTH RAM and swap are tight', () => {
    expect(
      isOomImminent(
        { memAvailablePercent: 9, swapFreeMB: 50, swapTotalMB: 2048 },
        thresholds,
      ),
    ).toBe(true);
  });

  it('RAM-only when no swap is configured (swapTotalMB=0)', () => {
    // Without swap, swapFree is meaningless as a signal — RAM alone
    // carries it. A host with 0 swap at 9% RAM IS about to OOM.
    expect(
      isOomImminent(
        { memAvailablePercent: 9, swapFreeMB: 0, swapTotalMB: 0 },
        thresholds,
      ),
    ).toBe(true);
    // And the inverse: plenty of RAM, no swap → still fine.
    expect(
      isOomImminent(
        { memAvailablePercent: 40, swapFreeMB: 0, swapTotalMB: 0 },
        thresholds,
      ),
    ).toBe(false);
  });

  it('boundary: exactly at the RAM threshold is NOT tight (strict <)', () => {
    expect(
      isOomImminent(
        { memAvailablePercent: 15, swapFreeMB: 50, swapTotalMB: 2048 },
        thresholds,
      ),
    ).toBe(false);
  });

  it('boundary: exactly at the swap threshold is NOT tight (strict <)', () => {
    expect(
      isOomImminent(
        { memAvailablePercent: 9, swapFreeMB: 128, swapTotalMB: 2048 },
        thresholds,
      ),
    ).toBe(false);
  });
});
