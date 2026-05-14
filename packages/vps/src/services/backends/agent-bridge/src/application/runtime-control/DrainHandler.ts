// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

export interface DrainBroadcast {
  broadcastShutdown(payload: { event: "bridge_shutting_down"; drainStart: number; drainEnd: number }): void;
  closeWsAccepts(): void;
}

export interface DrainSlots {
  evictAll(reason: string): Promise<void>;
}

export interface DrainPools {
  flushIdle(reason: string): Promise<void>;
}

export interface DrainCheckpoints {
  flushPending(): Promise<void>;
}

export interface DrainHandlerDeps {
  broadcast: DrainBroadcast;
  slots: DrainSlots;
  pools: DrainPools;
  checkpoints: DrainCheckpoints;
  drainAdvanceMs?: number;
  inflightTimeoutMs?: number;
  now?: () => number;
  emit?: (event: { event: string; reason?: string; durationMs?: number }) => void;
}

export interface DrainHandler {
  drain(reason: string): Promise<{ durationMs: number }>;
}

export function makeDrainHandler(deps: DrainHandlerDeps): DrainHandler {
  const drainAdvance = deps.drainAdvanceMs ?? 5000;
  const inflightTimeout = deps.inflightTimeoutMs ?? 30_000;
  const now = deps.now ?? Date.now;
  const emit = deps.emit ?? (() => {});
  let draining = false;

  return {
    async drain(reason) {
      if (draining) return { durationMs: 0 };
      draining = true;
      const start = now();
      const drainStart = start;
      const drainEnd = start + drainAdvance;
      deps.broadcast.broadcastShutdown({ event: "bridge_shutting_down", drainStart, drainEnd });
      deps.broadcast.closeWsAccepts();
      try {
        await Promise.race([
          Promise.allSettled([
            deps.slots.evictAll(reason),
            deps.pools.flushIdle(reason),
            deps.checkpoints.flushPending(),
          ]),
          new Promise((r) => setTimeout(r, inflightTimeout)),
        ]);
      } catch (err) {
        emit({ event: "drain.partial", reason: String(err) });
      }
      const durationMs = now() - start;
      emit({ event: "drain.complete", reason, durationMs });
      return { durationMs };
    },
  };
}
