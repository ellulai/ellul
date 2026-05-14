// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// This module never talks to systemd and never reads /proc. It is a

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PreviewMode } from '@vps/shared/preview-spec';
import type { PreviewLifecyclePhase } from '@vps/shared/preview-types';

export type LifecycleState =
  | 'cold'
  | 'starting'
  | 'hot'
  | 'warm'
  | 'demoting-to-warm'
  | 'promoting-to-hot'
  | 'stopping';

export interface LifecycleRecord {
  directory: string;
  state: LifecycleState;
  mode: PreviewMode;
  // ms-epoch of the current state's entry.
  stateEnteredAt: number;
  // Sum of ms spent in `hot` since the last cold→start transition.
  totalHotMs: number;
  // Sum of ms spent in `warm` since the last cold→start transition.
  totalWarmMs: number;
  // ms-epoch of the most recent successful start of any kind.
  lastStartedAt: number | null;
  // Count of hot↔warm transitions in this lifetime.
  transitionCount: number;
  // so the next legitimate post-transition emit is never suppressed.
  lastEmittedPhase?: PreviewLifecyclePhase;
}

type Clock = () => number;

const SNAPSHOT_PATH = '/run/ellul/preview-lifecycle.json';

const records = new Map<string, LifecycleRecord>();
let clock: Clock = Date.now;
let snapshotFailedLogged = false;

// target state anyway, because refusing the transition would leave
// the subsystem out-of-sync with reality for no safety gain.
const LEGAL: Record<LifecycleState, LifecycleState[]> = {
  'cold':              ['starting', 'stopping'],
  'starting':          ['hot', 'warm', 'cold', 'stopping'],
  'hot':               ['demoting-to-warm', 'stopping', 'cold'],
  'warm':              ['promoting-to-hot', 'stopping', 'cold'],
  'demoting-to-warm':  ['warm', 'hot', 'cold', 'stopping'],
  'promoting-to-hot':  ['hot', 'warm', 'cold', 'stopping'],
  'stopping':          ['cold'],
};

export function _setClockForTests(c: Clock): void {
  clock = c;
}

export function _resetForTests(): void {
  records.clear();
  clock = Date.now;
}

// Idempotently retrieve the record for a directory, creating it in
export function ensureRecord(directory: string, defaultMode: PreviewMode = 'hot'): LifecycleRecord {
  let r = records.get(directory);
  if (!r) {
    r = {
      directory,
      state: 'cold',
      mode: defaultMode,
      stateEnteredAt: clock(),
      totalHotMs: 0,
      totalWarmMs: 0,
      lastStartedAt: null,
      transitionCount: 0,
      lastEmittedPhase: undefined,
    };
    records.set(directory, r);
  }
  return { ...r };
}

export function getRecord(directory: string): LifecycleRecord | null {
  const r = records.get(directory);
  return r ? { ...r } : null;
}

export function allRecords(): LifecycleRecord[] {
  return [...records.values()].map(r => ({ ...r }));
}

export interface TransitionRequest {
  directory: string;
  next: LifecycleState;
  mode?: PreviewMode;
  // proceeds but logs a warning via `onIllegal`. Used on reconciler
  force?: boolean;
  onIllegal?: (from: LifecycleState, to: LifecycleState) => void;
}

// Transition a directory into a new state. Returns the updated record
export function transition(req: TransitionRequest): LifecycleRecord {
  const now = clock();
  const r = records.get(req.directory) ?? {
    directory: req.directory,
    state: 'cold' as LifecycleState,
    mode: req.mode ?? 'hot',
    stateEnteredAt: now,
    totalHotMs: 0,
    totalWarmMs: 0,
    lastStartedAt: null,
    transitionCount: 0,
    lastEmittedPhase: undefined,
  };

  const legal = LEGAL[r.state].includes(req.next);
  if (!legal && !req.force) {
    // Refuse — caller's responsibility to coerce via force=true.
    throw new Error(
      `illegal lifecycle transition ${r.state} → ${req.next} for ${req.directory}`,
    );
  }
  if (!legal && req.onIllegal) {
    req.onIllegal(r.state, req.next);
  }

  // Accumulate time-in-state.
  const timeInState = Math.max(0, now - r.stateEnteredAt);
  if (r.state === 'hot') r.totalHotMs += timeInState;
  if (r.state === 'warm') r.totalWarmMs += timeInState;

  // hot↔warm moves count as transitions even through the intermediate
  if (
    (r.state === 'demoting-to-warm' && req.next === 'warm') ||
    (r.state === 'promoting-to-hot' && req.next === 'hot')
  ) {
    r.transitionCount += 1;
  }

  // Cold→serving marks a fresh start.
  if ((r.state === 'cold' || r.state === 'starting') && (req.next === 'hot' || req.next === 'warm')) {
    r.lastStartedAt = now;
  }

  r.state = req.next;
  r.stateEnteredAt = now;
  if (req.mode) r.mode = req.mode;
  // stopping → cold → starting → hot) wouldn't re-emit `ready` because
  r.lastEmittedPhase = undefined;
  records.set(r.directory, r);

  saveSnapshot();
  return { ...r };
}

// Atomic test-and-set for phase emissions. Returns true when the caller
export function markPhaseEmitted(
  directory: string,
  phase: PreviewLifecyclePhase,
): boolean {
  let r = records.get(directory);
  if (!r) {
    r = {
      directory,
      state: 'cold',
      mode: 'hot',
      stateEnteredAt: clock(),
      totalHotMs: 0,
      totalWarmMs: 0,
      lastStartedAt: null,
      transitionCount: 0,
      lastEmittedPhase: phase,
    };
    records.set(directory, r);
    saveSnapshot();
    return true;
  }
  if (r.lastEmittedPhase === phase) return false;
  r.lastEmittedPhase = phase;
  saveSnapshot();
  return true;
}

// Pure helper used by the reconciler to decide demotion candidates.
export function msInCurrentState(directory: string, now: number = clock()): number {
  const r = records.get(directory);
  if (!r) return 0;
  return Math.max(0, now - r.stateEnteredAt);
}

// Forget a directory entirely — called by the delete path.
export function forget(directory: string): void {
  records.delete(directory);
  saveSnapshot();
}

// ── Snapshot ────────────────────────────────────────────────────

function saveSnapshot(): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const body = JSON.stringify(
      {
        writtenAt: clock(),
        records: [...records.values()],
      },
      null,
      2,
    );
    const tmp = `${SNAPSHOT_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, body, { mode: 0o644 });
    fs.renameSync(tmp, SNAPSHOT_PATH);
    snapshotFailedLogged = false;
  } catch {
    // /run might not exist on macOS BYOS; emit one log and stay quiet.
    if (!snapshotFailedLogged) {
      snapshotFailedLogged = true;
    }
  }
}
