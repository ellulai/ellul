// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

export type Adapter = "claude" | "opencode" | "cursor" | "codex";

export interface CompactableAdapter {
  readonly adapter: Adapter;
  listSessions(): Promise<ReadonlyArray<{ sessionId: string; turnCount: number; sandbox: string }>>;
  compactSession(sessionId: string, keepLastN: number): Promise<{ droppedTurns: number; freedBytesEst: number }>;
}

export interface CompactorEvent {
  event: "compactor.run";
  intervalReason: "tick" | "runNow" | "yellow_mode";
  byAdapter: Array<{
    adapter: Adapter;
    inspected: number;
    compacted: number;
    droppedTurnsTotal: number;
    freedBytesEstTotal: number;
    errors: number;
  }>;
}

export interface CompactorDeps {
  adapters: ReadonlyArray<CompactableAdapter>;
  intervalMs?: number;
  jitterMs?: number;
  defaultKeepLastN?: number;
  thresholdTurns?: number;
  now?: () => number;
  emit?: (event: CompactorEvent) => void;
}

export interface SessionCompactor {
  start(): void;
  stop(): void;
  runNow(opts?: { keepLastN?: number; reason?: CompactorEvent["intervalReason"] }): Promise<CompactorEvent>;
}

export function makeSessionCompactor(deps: CompactorDeps): SessionCompactor {
  const intervalMs = deps.intervalMs ?? 60_000;
  const jitterMs = deps.jitterMs ?? 10_000;
  const defaultKeepLastN = deps.defaultKeepLastN ?? 8;
  const thresholdTurns = deps.thresholdTurns ?? 8;
  const emit = deps.emit ?? (() => {});

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function run(reason: CompactorEvent["intervalReason"], keepLastN: number): Promise<CompactorEvent> {
    const byAdapter: CompactorEvent["byAdapter"] = [];
    for (const a of deps.adapters) {
      let inspected = 0;
      let compacted = 0;
      let droppedTurnsTotal = 0;
      let freedBytesEstTotal = 0;
      let errors = 0;
      try {
        const sessions = await a.listSessions();
        inspected = sessions.length;
        for (const s of sessions) {
          if (s.turnCount <= thresholdTurns) continue;
          try {
            const r = await a.compactSession(s.sessionId, keepLastN);
            compacted++;
            droppedTurnsTotal += r.droppedTurns;
            freedBytesEstTotal += r.freedBytesEst;
          } catch {
            errors++;
          }
        }
      } catch {
        errors++;
      }
      byAdapter.push({ adapter: a.adapter, inspected, compacted, droppedTurnsTotal, freedBytesEstTotal, errors });
    }
    const event: CompactorEvent = { event: "compactor.run", intervalReason: reason, byAdapter };
    emit(event);
    return event;
  }

  function schedule(): void {
    if (stopped) return;
    const delay = intervalMs + (Math.random() * 2 * jitterMs - jitterMs);
    timer = setTimeout(() => {
      run("tick", defaultKeepLastN).catch(() => {}).finally(() => schedule());
    }, Math.max(10, delay));
  }

  return {
    start() { schedule(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    runNow(opts) {
      return run(opts?.reason ?? "runNow", opts?.keepLastN ?? defaultKeepLastN);
    },
  };
}
