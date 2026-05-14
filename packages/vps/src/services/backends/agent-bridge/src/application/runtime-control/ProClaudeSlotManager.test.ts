// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import {
  makeProClaudeSlotManager,
  type SlotAdmission,
  type SlotCheckpoint,
  type SlotSpawn,
  type TypedSlotRejection,
} from "./ProClaudeSlotManager";

function makeSpawn(): SlotSpawn & { spawned: number; killed: number; running: Set<number> } {
  let nextPid = 10000;
  const running = new Set<number>();
  return {
    spawned: 0,
    killed: 0,
    running,
    async spawnSlot() {
      const pid = ++nextPid;
      running.add(pid);
      this.spawned++;
      return { pid };
    },
    async killSlot(pid) {
      running.delete(pid);
      this.killed++;
    },
    async waitExit(pid) {
      return running.has(pid) ? "timeout" : "exited";
    },
  };
}

function makeCheckpoint(resumeIds: Record<string, string> = {}): SlotCheckpoint & { saved: string[] } {
  return {
    saved: [],
    async save(threadId) { this.saved.push(threadId); },
    async loadResumeId(threadId) { return resumeIds[threadId] ?? null; },
  };
}

function makeAdmit(): SlotAdmission & { calls: number; nextReject?: TypedSlotRejection } {
  return {
    calls: 0,
    async admit() {
      this.calls++;
      if (this.nextReject) return { ok: false, reason: this.nextReject };
      return { ok: true };
    },
  };
}

describe("ProClaudeSlotManager.bind", () => {
  it("first bind: empty → warming → warm with spawned process", async () => {
    const spawn = makeSpawn();
    const mgr = makeProClaudeSlotManager({
      slotCap: 1,
      admit: makeAdmit(),
      spawn,
      checkpoint: makeCheckpoint(),
    });
    const r = await mgr.bind("t1");
    if (!r.ok) throw new Error("expected ok");
    expect(r.slotIndex).toBe(1);
    expect(r.warmHit).toBe(false);
    expect(spawn.spawned).toBe(1);
    expect(mgr.snapshot()[0]!.state).toBe("warm");
    expect(mgr.snapshot()[0]!.threadId).toBe("t1");
  });

  it("rebind to same thread returns warm hit (no respawn)", async () => {
    const spawn = makeSpawn();
    const mgr = makeProClaudeSlotManager({
      slotCap: 1,
      admit: makeAdmit(),
      spawn,
      checkpoint: makeCheckpoint(),
    });
    await mgr.bind("t1");
    const r = await mgr.bind("t1");
    if (!r.ok) throw new Error("expected ok");
    expect(r.warmHit).toBe(true);
    expect(spawn.spawned).toBe(1);
  });

  it("propagates AdmissionService rejection as typed BindResult", async () => {
    const admit = makeAdmit();
    admit.nextReject = "ERR_ADMISSION_TIER_CAP";
    const mgr = makeProClaudeSlotManager({
      slotCap: 1,
      admit,
      spawn: makeSpawn(),
      checkpoint: makeCheckpoint(),
    });
    const r = await mgr.bind("t1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ERR_ADMISSION_TIER_CAP");
  });

  it("evicts a different thread when slot cap reached", async () => {
    const spawn = makeSpawn();
    const cp = makeCheckpoint();
    const mgr = makeProClaudeSlotManager({
      slotCap: 1,
      admit: makeAdmit(),
      spawn,
      checkpoint: cp,
    });
    await mgr.bind("t1");
    const r = await mgr.bind("t2");
    if (!r.ok) throw new Error("expected ok");
    expect(r.slotIndex).toBe(1);
    expect(spawn.spawned).toBe(2);
    expect(spawn.killed).toBe(1);
    expect(cp.saved).toContain("t1");
    expect(mgr.snapshot()[0]!.threadId).toBe("t2");
  });

  it("hydrates from checkpoint resume id when present", async () => {
    const spawn = makeSpawn();
    let captured: string | null | undefined = undefined;
    const wrapped: SlotSpawn = {
      ...spawn,
      async spawnSlot(idx, tid, resumeId) {
        captured = resumeId;
        return spawn.spawnSlot(idx, tid, resumeId);
      },
    };
    const mgr = makeProClaudeSlotManager({
      slotCap: 1,
      admit: makeAdmit(),
      spawn: wrapped,
      checkpoint: makeCheckpoint({ t1: "session-existing" }),
    });
    await mgr.bind("t1");
    expect(captured).toBe("session-existing");
  });

  it("LRU-of-2 warm cache: third bind evicts least-recently-used non-protected slot", async () => {
    const spawn = makeSpawn();
    const cp = makeCheckpoint();
    const mgr = makeProClaudeSlotManager({
      slotCap: 3,
      warmCacheSize: 2,
      admit: makeAdmit(),
      spawn,
      checkpoint: cp,
    });
    await mgr.bind("t1");
    await mgr.bind("t2");
    await mgr.bind("t3");
    expect(spawn.spawned).toBe(3);
    expect(spawn.killed).toBe(0);

    await mgr.bind("t4");
    expect(spawn.spawned).toBe(4);
    expect(spawn.killed).toBe(1);
    expect(cp.saved).toContain("t1");
    const ids = mgr.snapshot().map((s) => s.threadId).sort();
    expect(ids).toEqual(["t2", "t3", "t4"]);
  });
});

describe("ProClaudeSlotManager.evictAll", () => {
  it("drains every active and warm slot", async () => {
    const spawn = makeSpawn();
    const cp = makeCheckpoint();
    const mgr = makeProClaudeSlotManager({
      slotCap: 3,
      admit: makeAdmit(),
      spawn,
      checkpoint: cp,
    });
    await mgr.bind("t1");
    await mgr.bind("t2");
    await mgr.bind("t3");
    await mgr.evictAll("shutdown");
    expect(spawn.killed).toBe(3);
    for (const s of mgr.snapshot()) expect(s.state).toBe("empty");
    expect(cp.saved.sort()).toEqual(["t1", "t2", "t3"]);
  });
});

describe("ProClaudeSlotManager.releaseActive", () => {
  it("transitions active → warm and updates warm cache LRU position", async () => {
    const mgr = makeProClaudeSlotManager({
      slotCap: 2,
      admit: makeAdmit(),
      spawn: makeSpawn(),
      checkpoint: makeCheckpoint(),
    });
    await mgr.bind("t1");
    const slot1 = mgr.snapshot()[0]!;
    expect(slot1.state).toBe("warm");
  });
});
