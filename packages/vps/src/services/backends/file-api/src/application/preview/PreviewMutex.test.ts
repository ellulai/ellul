// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  withPreviewLock,
  PreviewMutexTimeoutError,
  _mutexInspect,
  _resetMutexForTests,
} from './PreviewMutex';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('preview-mutex', () => {
  beforeEach(() => {
    _resetMutexForTests();
  });

  it('serializes two concurrent holders of the same directory', async () => {
    const events: string[] = [];
    const first = withPreviewLock('sbx-a/app', 5000, async () => {
      events.push('A start');
      await sleep(40);
      events.push('A end');
    });
    const second = withPreviewLock('sbx-a/app', 5000, async () => {
      events.push('B start');
      events.push('B end');
    });
    await Promise.all([first, second]);
    expect(events).toEqual(['A start', 'A end', 'B start', 'B end']);
  });

  it('does NOT serialize different directories', async () => {
    const events: string[] = [];
    const a = withPreviewLock('sbx-a/app', 5000, async () => {
      events.push('A start');
      await sleep(30);
      events.push('A end');
    });
    const b = withPreviewLock('sbx-b/app', 5000, async () => {
      events.push('B start');
      await sleep(10);
      events.push('B end');
    });
    await Promise.all([a, b]);
    // Different dirs → B starts AND ends inside A's critical section.
    expect(events.slice(0, 2)).toEqual(['A start', 'B start']);
    expect(events).toContain('B end');
  });

  it('releases lock on thrown error', async () => {
    await expect(
      withPreviewLock('sbx-a/app', 5000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // After rejection the lock must be gone — second call should not timeout.
    const result = await withPreviewLock('sbx-a/app', 500, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('times out when a holder exceeds wait budget', async () => {
    const slow = withPreviewLock('sbx-a/app', 5000, async () => {
      await sleep(200);
    });
    await expect(
      withPreviewLock('sbx-a/app', 50, async () => 'should not run'),
    ).rejects.toBeInstanceOf(PreviewMutexTimeoutError);
    await slow;
    // Slow holder finished; fresh acquire works.
    const after = await withPreviewLock('sbx-a/app', 500, async () => 'cleared');
    expect(after).toBe('cleared');
  });

  it('inspection helpers report contention correctly', async () => {
    const hold = withPreviewLock('sbx-a/app', 2000, async () => {
      await sleep(50);
    });
    await sleep(5);
    // While held, another acquire queues up.
    const waiter = withPreviewLock('sbx-a/app', 2000, async () => 'second');
    await sleep(5);
    const snap = _mutexInspect();
    expect(snap.activeLocks).toContain('sbx-a/app');
    expect(snap.waiters['sbx-a/app']).toBe(1);
    await Promise.all([hold, waiter]);
  });
});
