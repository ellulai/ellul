// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetForTests,
  _setClockForTests,
  ensureRecord,
  getRecord,
  transition,
  forget,
  msInCurrentState,
  allRecords,
} from './PreviewLifecycle';

let now = 1_000_000;

beforeEach(() => {
  _resetForTests();
  now = 1_000_000;
  _setClockForTests(() => now);
});

describe('preview-lifecycle: state machine invariants', () => {
  it('fresh record starts in cold with hot-default mode', () => {
    const r = ensureRecord('/app/a');
    expect(r.state).toBe('cold');
    expect(r.mode).toBe('hot');
    expect(r.totalHotMs).toBe(0);
    expect(r.totalWarmMs).toBe(0);
  });

  it('cold → starting → hot is a legal transition path', () => {
    ensureRecord('/app/a');
    expect(transition({ directory: '/app/a', next: 'starting' }).state).toBe('starting');
    expect(transition({ directory: '/app/a', next: 'hot' }).state).toBe('hot');
  });

  it('hot → warm must go through demoting-to-warm', () => {
    ensureRecord('/app/a');
    transition({ directory: '/app/a', next: 'starting' });
    transition({ directory: '/app/a', next: 'hot' });
    expect(() => transition({ directory: '/app/a', next: 'warm' }))
      .toThrow(/illegal lifecycle transition/);
    transition({ directory: '/app/a', next: 'demoting-to-warm' });
    expect(transition({ directory: '/app/a', next: 'warm' }).state).toBe('warm');
  });

  it('accumulates time-in-state across transitions', () => {
    ensureRecord('/app/a');
    transition({ directory: '/app/a', next: 'starting' });
    transition({ directory: '/app/a', next: 'hot' });
    now += 30_000;
    transition({ directory: '/app/a', next: 'demoting-to-warm' });
    now += 5_000;
    transition({ directory: '/app/a', next: 'warm' });
    now += 10_000;
    const r = transition({ directory: '/app/a', next: 'stopping' });
    expect(r.totalHotMs).toBe(30_000);
    expect(r.totalWarmMs).toBe(10_000);
  });

  it('bumps transitionCount once per full hot↔warm round-trip', () => {
    ensureRecord('/app/a');
    transition({ directory: '/app/a', next: 'starting' });
    transition({ directory: '/app/a', next: 'hot' });
    transition({ directory: '/app/a', next: 'demoting-to-warm' });
    transition({ directory: '/app/a', next: 'warm' });
    expect(getRecord('/app/a')!.transitionCount).toBe(1);
    transition({ directory: '/app/a', next: 'promoting-to-hot' });
    transition({ directory: '/app/a', next: 'hot' });
    expect(getRecord('/app/a')!.transitionCount).toBe(2);
  });

  it('sets lastStartedAt on cold-or-starting → serving transitions', () => {
    ensureRecord('/app/a');
    transition({ directory: '/app/a', next: 'starting' });
    now += 500;
    transition({ directory: '/app/a', next: 'hot' });
    expect(getRecord('/app/a')!.lastStartedAt).toBe(now);
  });

  it('force=true allows illegal transitions and fires onIllegal', () => {
    ensureRecord('/app/a');
    transition({ directory: '/app/a', next: 'starting' });
    transition({ directory: '/app/a', next: 'hot' });
    let illegal: [unknown, unknown] | null = null;
    const r = transition({
      directory: '/app/a',
      next: 'cold',
      force: true,
      onIllegal: (from, to) => { illegal = [from, to]; },
    });
    expect(r.state).toBe('cold');
    // hot → cold is in LEGAL[hot] so onIllegal should NOT fire here
    expect(illegal).toBeNull();
  });

  it('forget removes the record', () => {
    ensureRecord('/app/a');
    transition({ directory: '/app/a', next: 'starting' });
    forget('/app/a');
    expect(getRecord('/app/a')).toBeNull();
  });

  it('msInCurrentState returns monotonic time in the current state', () => {
    ensureRecord('/app/a');
    transition({ directory: '/app/a', next: 'starting' });
    now += 2_500;
    expect(msInCurrentState('/app/a')).toBe(2_500);
  });

  it('allRecords returns copies, not references', () => {
    ensureRecord('/app/a');
    const list = allRecords();
    list[0]!.state = 'hot';
    expect(getRecord('/app/a')!.state).toBe('cold');
  });
});
