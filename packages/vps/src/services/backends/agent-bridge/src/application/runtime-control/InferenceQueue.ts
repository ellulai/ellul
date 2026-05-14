// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

export type Adapter = "claude" | "opencode" | "cursor" | "codex";

export interface QueueKey {
  sandbox: string;
  adapter: Adapter;
}

export type EnqueueResult =
  | { ok: true; tag: "accepted" }
  | { ok: true; tag: "queued"; position: number; etaMs: number }
  | { ok: false; tag: "rejected"; reason: "ERR_QUEUE_FULL" };

export interface QueueSnapshot {
  key: QueueKey;
  inflight: number;
  queued: ReadonlyArray<{ turnId: string; position: number; etaMs: number }>;
  medianTurnMs: number;
}

export interface QueueDeps {
  concurrencyFor?: (key: QueueKey) => number;
  hardCapFor?: (key: QueueKey) => number;
  fallbackTurnMs?: number;
  now?: () => number;
}

export interface InferenceQueue {
  enqueue(key: QueueKey, turnId: string): EnqueueResult;
  complete(key: QueueKey, turnId: string): void;
  snapshot(): ReadonlyArray<QueueSnapshot>;
  subscribe(listener: (snap: ReadonlyArray<QueueSnapshot>) => void): () => void;
}

interface QueueState {
  key: QueueKey;
  inflight: Map<string, number>; // turnId → startedAt
  queue: Array<{ turnId: string; enqueuedAt: number }>;
  recentDurations: number[];
}

const SAMPLE_WINDOW = 100;

export function makeInferenceQueue(deps: QueueDeps = {}): InferenceQueue {
  const now = deps.now ?? Date.now;
  const concurrencyFor = deps.concurrencyFor ?? (() => 2);
  const hardCapFor = deps.hardCapFor ?? (() => 16);
  const fallbackTurnMs = deps.fallbackTurnMs ?? 10_000;

  const states = new Map<string, QueueState>();
  const listeners = new Set<(snap: ReadonlyArray<QueueSnapshot>) => void>();

  function key(k: QueueKey): string { return `${k.sandbox}:${k.adapter}`; }
  function ensure(k: QueueKey): QueueState {
    const id = key(k);
    let s = states.get(id);
    if (!s) {
      s = { key: k, inflight: new Map(), queue: [], recentDurations: [] };
      states.set(id, s);
    }
    return s;
  }

  function median(arr: ReadonlyArray<number>): number {
    if (arr.length === 0) return fallbackTurnMs;
    const sorted = [...arr].sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m]! : Math.round((sorted[m - 1]! + sorted[m]!) / 2);
  }

  function snap(): QueueSnapshot[] {
    const out: QueueSnapshot[] = [];
    for (const s of states.values()) {
      const med = median(s.recentDurations);
      out.push({
        key: s.key,
        inflight: s.inflight.size,
        queued: s.queue.map((q, i) => ({ turnId: q.turnId, position: i, etaMs: i * med })),
        medianTurnMs: med,
      });
    }
    return out;
  }

  function fire(): void {
    const s = snap();
    for (const l of listeners) {
      try { l(s); } catch { /* listener errors not fatal */ }
    }
  }

  return {
    enqueue(k, turnId) {
      const s = ensure(k);
      const conc = concurrencyFor(k);
      const cap = hardCapFor(k);
      if (s.inflight.size < conc) {
        s.inflight.set(turnId, now());
        fire();
        return { ok: true, tag: "accepted" };
      }
      if (s.queue.length + s.inflight.size >= cap) {
        return { ok: false, tag: "rejected", reason: "ERR_QUEUE_FULL" };
      }
      s.queue.push({ turnId, enqueuedAt: now() });
      const med = median(s.recentDurations);
      const position = s.queue.length - 1;
      fire();
      return { ok: true, tag: "queued", position, etaMs: position * med };
    },
    complete(k, turnId) {
      const s = states.get(key(k));
      if (!s) return;
      const startedAt = s.inflight.get(turnId);
      if (startedAt !== undefined) {
        s.inflight.delete(turnId);
        const dur = Math.max(1, now() - startedAt);
        s.recentDurations.push(dur);
        if (s.recentDurations.length > SAMPLE_WINDOW) s.recentDurations.shift();
      }
      while (s.inflight.size < concurrencyFor(k) && s.queue.length > 0) {
        const head = s.queue.shift()!;
        s.inflight.set(head.turnId, now());
      }
      fire();
    },
    snapshot() { return snap(); },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}
