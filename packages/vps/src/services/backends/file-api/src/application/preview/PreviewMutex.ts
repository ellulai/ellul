// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Prevents three concrete race conditions observed in production:

type Resolver = () => void;

interface LockState {
  // The currently-executing operation's release hook.
  currentRelease: Resolver | null;
  // FIFO waiters, head acquires next.
  queue: Resolver[];
}

const locks = new Map<string, LockState>();

export class PreviewMutexTimeoutError extends Error {
  constructor(public directory: string, public timeoutMs: number) {
    super(`PreviewMutex timed out acquiring lock for "${directory}" after ${timeoutMs}ms`);
    this.name = 'PreviewMutexTimeoutError';
  }
}

// is released whether `body` resolves or rejects — no leaks even on
export async function withPreviewLock<T>(
  directory: string,
  timeoutMs: number,
  body: () => Promise<T>,
): Promise<T> {
  await acquire(directory, timeoutMs);
  try {
    return await body();
  } finally {
    release(directory);
  }
}

async function acquire(directory: string, timeoutMs: number): Promise<void> {
  let state = locks.get(directory);
  if (!state) {
    state = { currentRelease: null, queue: [] };
    locks.set(directory, state);
  }

  if (state.currentRelease === null) {
    // Fast path: uncontended. Take the lock immediately.
    state.currentRelease = () => {}; // placeholder; real release swapped in below.
    return;
  }

  // Slow path: queue and wait.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove this waiter from the queue if it's still there.
      const i = state!.queue.indexOf(grant);
      if (i >= 0) state!.queue.splice(i, 1);
      reject(new PreviewMutexTimeoutError(directory, timeoutMs));
    }, timeoutMs);
    const grant: Resolver = () => {
      clearTimeout(timer);
      resolve();
    };
    state!.queue.push(grant);
  });
}

function release(directory: string): void {
  const state = locks.get(directory);
  if (!state) return;
  const next = state.queue.shift();
  if (next) {
    // critical section. currentRelease is placeholder; replaced by
    state.currentRelease = () => {};
    next();
  } else {
    state.currentRelease = null;
    // Free the Map slot if nobody's waiting — prevents unbounded
    locks.delete(directory);
  }
}

// Tests — inspect current lock state.
export function _mutexInspect(): { activeLocks: string[]; waiters: Record<string, number> } {
  const active: string[] = [];
  const waiters: Record<string, number> = {};
  for (const [dir, state] of locks.entries()) {
    if (state.currentRelease !== null) active.push(dir);
    if (state.queue.length > 0) waiters[dir] = state.queue.length;
  }
  return { activeLocks: active.sort(), waiters };
}

// Tests — clear every lock.
export function _resetMutexForTests(): void {
  locks.clear();
}
