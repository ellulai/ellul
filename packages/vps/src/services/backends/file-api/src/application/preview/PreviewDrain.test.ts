// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';

import { drainForAdmission, readMemAvailableMB } from './PreviewDrain';

function fakeMemInfo(availKB: number): () => string {
  return () =>
    [
      `MemTotal:       ${availKB * 2} kB`,
      `MemFree:        ${Math.floor(availKB / 2)} kB`,
      `MemAvailable:   ${availKB} kB`,
      `Buffers:        0 kB`,
      `Cached:         0 kB`,
      `SwapTotal:      0 kB`,
      `SwapFree:       0 kB`,
    ].join('\n');
}

describe('preview-drain: readMemAvailableMB', () => {
  it('parses the MemAvailable line correctly', () => {
    const r = readMemAvailableMB(fakeMemInfo(2048 * 1024));
    expect(r).toBe(2048);
  });

  it('returns 0 when /proc/meminfo is unreadable', () => {
    const r = readMemAvailableMB(() => {
      throw new Error('permission denied');
    });
    expect(r).toBe(0);
  });

  it('returns 0 when MemAvailable is absent', () => {
    const r = readMemAvailableMB(() => 'MemTotal: 1024 kB\n');
    expect(r).toBe(0);
  });
});

describe('preview-drain: drainForAdmission', () => {
  it('returns recovered=true when the first read already meets the target', async () => {
    const r = await drainForAdmission({
      targetFreeMB: 500,
      timeoutMs: 1000,
      pollIntervalMs: 10,
      readMemInfo: fakeMemInfo(600 * 1024),
    });
    expect(r.recovered).toBe(true);
    expect(r.polls).toBeGreaterThanOrEqual(1);
    expect(r.finalFreeMB).toBe(600);
  });

  it('returns recovered=true once memory recovers above the target mid-drain', async () => {
    let sample = 100 * 1024;
    const readMemInfo = () => {
      const before = sample;
      if (sample < 800 * 1024) sample += 200 * 1024;
      const kb = before;
      return [
        `MemTotal: 2048000 kB`,
        `MemFree: 0 kB`,
        `MemAvailable: ${kb} kB`,
      ].join('\n');
    };
    const r = await drainForAdmission({
      targetFreeMB: 500,
      timeoutMs: 2000,
      pollIntervalMs: 1,
      readMemInfo,
    });
    expect(r.recovered).toBe(true);
    expect(r.finalFreeMB).toBeGreaterThanOrEqual(500);
    expect(r.polls).toBeGreaterThan(1);
  });

  it('returns recovered=false on timeout when MemAvailable never recovers', async () => {
    let nowMs = 1000;
    const r = await drainForAdmission({
      targetFreeMB: 2048,
      timeoutMs: 50,
      pollIntervalMs: 10,
      readMemInfo: fakeMemInfo(100 * 1024),
      now: () => {
        nowMs += 20; // advance faster than pollIntervalMs
        return nowMs;
      },
    });
    expect(r.recovered).toBe(false);
    expect(r.finalFreeMB).toBe(100);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('calls onProgress for each poll and tolerates hook failures', async () => {
    const seen: number[] = [];
    const r = await drainForAdmission({
      targetFreeMB: 500,
      timeoutMs: 1000,
      pollIntervalMs: 10,
      readMemInfo: fakeMemInfo(800 * 1024),
      onProgress: ({ polls }) => {
        seen.push(polls);
        throw new Error('observational hooks must not break the loop');
      },
    });
    expect(r.recovered).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  it('never polls fewer than 1 time even on immediate timeout', async () => {
    const r = await drainForAdmission({
      targetFreeMB: 9999,
      timeoutMs: 0,
      pollIntervalMs: 100,
      readMemInfo: fakeMemInfo(0),
    });
    expect(r.polls).toBeGreaterThanOrEqual(1);
    expect(r.recovered).toBe(false);
  });
});
