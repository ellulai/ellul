// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { makeProClaudeSlotMachine, type ProClaudeSlotState } from "@vps/services/shared/state-machines";
import type { Machine } from "@vps/services/shared/state-machines";
import type { ProClaudeSlotEvent, ProClaudeSlotCtx } from "@vps/services/shared/state-machines";

export type TypedSlotRejection =
  | "ERR_ADMISSION_TIER_CAP"
  | "ERR_ADMISSION_DEGRADED_RED"
  | "ERR_ADMISSION_PRESSURE_HIGH"
  | "ERR_SLOT_HYDRATE_FAILED"
  | "ERR_SLOT_SPAWN_FAILED"
  | "ERR_SLOT_EVICT_TIMEOUT";

export type BindResult =
  | { ok: true; slotIndex: number; processPid: number; warmHit: boolean; tookMs: number }
  | { ok: false; reason: TypedSlotRejection; details?: string };

export interface SlotSnapshot {
  slotIndex: number;
  state: ProClaudeSlotState;
  threadId: string | null;
  processPid: number | null;
  lastUseAt: number;
  inWarmCache: boolean;
}

export interface SlotAdmission {
  admit(): Promise<{ ok: true } | { ok: false; reason: TypedSlotRejection; details?: string }>;
}

export interface SlotSpawn {
  spawnSlot(slotIndex: number, threadId: string, resumeSessionId: string | null): Promise<{ pid: number }>;
  killSlot(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  waitExit(pid: number, timeoutMs: number): Promise<"exited" | "timeout">;
}

export interface SlotCheckpoint {
  save(threadId: string): Promise<void>;
  loadResumeId(threadId: string): Promise<string | null>;
}

export interface SlotManagerDeps {
  slotCap: number;
  warmCacheSize?: number;
  admit: SlotAdmission;
  spawn: SlotSpawn;
  checkpoint: SlotCheckpoint;
  evictWaitMs?: number;
  killTimeoutMs?: number;
  now?: () => number;
  emit?: (event: { event: string; slotIndex?: number; threadId?: string; reason?: string; details?: string }) => void;
}

export interface ProClaudeSlotManager {
  bind(threadId: string): Promise<BindResult>;
  releaseActive(threadId: string): void;
  evictAll(reason: string): Promise<void>;
  snapshot(): ReadonlyArray<SlotSnapshot>;
}

interface SlotState {
  index: number;
  machine: Machine<ProClaudeSlotState, ProClaudeSlotEvent, ProClaudeSlotCtx>;
}

export function makeProClaudeSlotManager(deps: SlotManagerDeps): ProClaudeSlotManager {
  if (deps.slotCap < 1) throw new Error("slotCap must be >= 1");
  const warmCacheSize = Math.min(deps.warmCacheSize ?? 2, deps.slotCap);
  const evictWait = deps.evictWaitMs ?? 30_000;
  const killTimeout = deps.killTimeoutMs ?? 10_000;
  const now = deps.now ?? Date.now;
  const emit = deps.emit ?? (() => {});

  const slots: SlotState[] = Array.from({ length: deps.slotCap }, (_, i) => ({
    index: i + 1,
    machine: makeProClaudeSlotMachine(),
  }));
  const warmCacheLru: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  function findSlotByThread(threadId: string): SlotState | null {
    for (const s of slots) if (s.machine.context().threadId === threadId) return s;
    return null;
  }

  function pickSlotForBind(): SlotState {
    for (const s of slots) if (s.machine.current() === "empty" || s.machine.current() === "evicted") return s;
    let lru: SlotState | null = null;
    for (const s of slots) {
      const tid = s.machine.context().threadId;
      if (s.machine.current() !== "warm" || !tid) continue;
      const lruIdx = warmCacheLru.indexOf(tid);
      if (lruIdx === warmCacheLru.length - 1) continue;
      if (!lru || s.machine.context().lastUseAt < lru.machine.context().lastUseAt) lru = s;
    }
    if (lru) return lru;
    let oldest = slots[0]!;
    for (const s of slots) if (s.machine.context().lastUseAt < oldest.machine.context().lastUseAt) oldest = s;
    return oldest;
  }

  function touchWarmCache(threadId: string): void {
    const i = warmCacheLru.indexOf(threadId);
    if (i >= 0) warmCacheLru.splice(i, 1);
    warmCacheLru.push(threadId);
    while (warmCacheLru.length > warmCacheSize) warmCacheLru.shift();
  }

  async function evictSlot(slot: SlotState, nextThreadId: string | null, reason: string): Promise<TypedSlotRejection | null> {
    const ctx = slot.machine.context();
    if (slot.machine.current() === "active") {
      const start = now();
      while (slot.machine.current() === "active" && now() - start < evictWait) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (slot.machine.current() === "active") {
        emit({ event: "slot.evict.timeout", slotIndex: slot.index, reason });
        return "ERR_SLOT_EVICT_TIMEOUT";
      }
    }
    if (ctx.threadId) {
      try { await deps.checkpoint.save(ctx.threadId); }
      catch (err) { emit({ event: "slot.checkpoint.failed", slotIndex: slot.index, threadId: ctx.threadId, details: String(err) }); }
    }
    slot.machine.send({ type: "evict_start", nextThreadId });
    if (ctx.processPid) {
      try { await deps.spawn.killSlot(ctx.processPid, "SIGTERM"); } catch { /* may already be dead */ }
      const exit = await deps.spawn.waitExit(ctx.processPid, killTimeout);
      if (exit === "timeout") {
        try { await deps.spawn.killSlot(ctx.processPid, "SIGKILL"); } catch { /* SIGKILL best-effort */ }
        await deps.spawn.waitExit(ctx.processPid, 5000);
      }
    }
    slot.machine.send({ type: "evict_done" });
    if (ctx.threadId) {
      const i = warmCacheLru.indexOf(ctx.threadId);
      if (i >= 0) warmCacheLru.splice(i, 1);
    }
    slot.machine.send({ type: "reset" });
    emit({ event: "slot.evicted", slotIndex: slot.index, threadId: ctx.threadId ?? undefined, reason });
    return null;
  }

  async function bindLocked(threadId: string): Promise<BindResult> {
    const start = now();
    const existing = findSlotByThread(threadId);
    if (existing && (existing.machine.current() === "warm" || existing.machine.current() === "active")) {
      touchWarmCache(threadId);
      const ctx = existing.machine.context();
      return { ok: true, slotIndex: existing.index, processPid: ctx.processPid!, warmHit: true, tookMs: now() - start };
    }

    const adm = await deps.admit.admit();
    if (!adm.ok) return { ok: false, reason: adm.reason, details: adm.details };

    const slot = pickSlotForBind();
    if (slot.machine.current() === "warm" || slot.machine.current() === "active") {
      const evictErr = await evictSlot(slot, threadId, "switch");
      if (evictErr) return { ok: false, reason: evictErr };
    }

    let resumeId: string | null = null;
    try { resumeId = await deps.checkpoint.loadResumeId(threadId); }
    catch (err) { emit({ event: "slot.resume.load.failed", slotIndex: slot.index, threadId, details: String(err) }); }

    slot.machine.send({ type: "bind", threadId, resumeToken: resumeId });
    let pid: number;
    try {
      const r = await deps.spawn.spawnSlot(slot.index, threadId, resumeId);
      pid = r.pid;
    } catch (err) {
      emit({ event: "slot.spawn.failed", slotIndex: slot.index, threadId, details: String(err) });
      slot.machine.send({ type: "process_died", error: "ERR_SLOT_SPAWN_FAILED" });
      slot.machine.send({ type: "reset" });
      return { ok: false, reason: "ERR_SLOT_SPAWN_FAILED", details: String(err) };
    }
    slot.machine.send({ type: "hydrate_done", processPid: pid });
    touchWarmCache(threadId);
    emit({ event: "slot.bound", slotIndex: slot.index, threadId });
    return { ok: true, slotIndex: slot.index, processPid: pid, warmHit: false, tookMs: now() - start };
  }

  return {
    bind(threadId) {
      const next = chain.then(() => bindLocked(threadId));
      chain = next.catch(() => undefined);
      return next as Promise<BindResult>;
    },
    releaseActive(threadId) {
      const slot = findSlotByThread(threadId);
      if (!slot) return;
      if (slot.machine.current() === "active") slot.machine.send({ type: "send_complete" });
      touchWarmCache(threadId);
    },
    async evictAll(reason) {
      const next = chain.then(async () => {
        for (const s of slots) {
          if (s.machine.current() === "warm" || s.machine.current() === "active" || s.machine.current() === "warming") {
            await evictSlot(s, null, reason);
          }
        }
      });
      chain = next.catch(() => undefined);
      await next;
    },
    snapshot() {
      return slots.map((s) => {
        const ctx = s.machine.context();
        return {
          slotIndex: s.index,
          state: s.machine.current(),
          threadId: ctx.threadId,
          processPid: ctx.processPid,
          lastUseAt: ctx.lastUseAt,
          inWarmCache: ctx.threadId ? warmCacheLru.includes(ctx.threadId) : false,
        };
      });
    },
  };
}
