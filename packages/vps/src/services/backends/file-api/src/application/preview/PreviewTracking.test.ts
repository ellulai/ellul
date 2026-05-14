// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  recordStart,
  recordStop,
  listTracked,
  idlenessMs,
  lruOrder,
  _resetTrackingForTests,
} from './PreviewTracking';

describe('preview-tracking', () => {
  beforeEach(() => {
    _resetTrackingForTests();
  });

  it('recordStart seeds a preview with lastActivityAt = now', () => {
    const before = Date.now();
    recordStart('sbx-a/app', 4001);
    const after = Date.now();
    const tracked = listTracked();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.directory).toBe('sbx-a/app');
    expect(tracked[0]!.port).toBe(4001);
    expect(tracked[0]!.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(tracked[0]!.lastActivityAt).toBeLessThanOrEqual(after);
  });

  it('recordStop removes the entry', () => {
    recordStart('sbx-a/app', 4001);
    recordStop('sbx-a/app');
    expect(listTracked()).toHaveLength(0);
  });

  it('idlenessMs is monotonic between ticks', () => {
    recordStart('sbx-a/app', 4001);
    const first = idlenessMs('sbx-a/app') ?? 0;
    // Small pause would be measured by test runner — we just assert ordering.
    const second = idlenessMs('sbx-a/app') ?? 0;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('lruOrder sorts oldest-activity first', () => {
    recordStart('sbx-a/app', 4001);
    // Nudge time forward by synthetically re-recording for the second entry
    recordStart('sbx-b/app', 4002);
    const [oldest, newest] = lruOrder();
    expect(oldest?.directory).toBe('sbx-a/app');
    expect(newest?.directory).toBe('sbx-b/app');
  });

  it('idlenessMs returns null for unknown directory', () => {
    expect(idlenessMs('nobody')).toBeNull();
  });
});
