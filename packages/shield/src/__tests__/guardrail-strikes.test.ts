// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';
import { recordStrike, clearStrikes, isHardStopped, MAX_STRIKES } from '../local/guardrails/strikes';

describe('guardrail strikes', () => {
  it('records strikes and returns count', () => {
    expect(recordStrike('proj-strike-test', 'cmd1')).toBe(1);
    expect(recordStrike('proj-strike-test', 'cmd1')).toBe(2);
    expect(recordStrike('proj-strike-test', 'cmd1')).toBe(3);
  });

  it('hard stops after MAX_STRIKES', () => {
    const proj = 'proj-hard-stop';
    const cmd = 'test-cmd';
    for (let i = 0; i < MAX_STRIKES; i++) {
      recordStrike(proj, cmd);
    }
    expect(isHardStopped(proj, cmd)).toBe(true);
  });

  it('does not hard stop before MAX_STRIKES', () => {
    const proj = 'proj-not-stopped';
    const cmd = 'test-cmd2';
    for (let i = 0; i < MAX_STRIKES - 1; i++) {
      recordStrike(proj, cmd);
    }
    expect(isHardStopped(proj, cmd)).toBe(false);
  });

  it('clears strikes on success', () => {
    const proj = 'proj-clear';
    const cmd = 'cmd-clear';
    recordStrike(proj, cmd);
    recordStrike(proj, cmd);
    clearStrikes(proj, cmd);
    expect(isHardStopped(proj, cmd)).toBe(false);
    expect(recordStrike(proj, cmd)).toBe(1); // Resets to 1
  });

  it('isolates strikes per project:command pair', () => {
    recordStrike('proj-a', 'cmd-x');
    recordStrike('proj-a', 'cmd-x');
    recordStrike('proj-a', 'cmd-x');
    expect(isHardStopped('proj-a', 'cmd-x')).toBe(true);
    expect(isHardStopped('proj-a', 'cmd-y')).toBe(false);
    expect(isHardStopped('proj-b', 'cmd-x')).toBe(false);
  });

  it('returns false for never-struck project', () => {
    expect(isHardStopped('never-struck', 'anything')).toBe(false);
  });
});
