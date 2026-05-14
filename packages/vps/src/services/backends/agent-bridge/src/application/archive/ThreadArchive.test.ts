// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { makeThreadArchive, type ThreadStore } from "./ThreadArchive";

function inMemStore(rows: Array<{ threadId: string; sandboxId: string; archivedAt: number | null; updatedAt: number }>): ThreadStore {
  return {
    async listForSandbox(sandboxId) { return rows.filter((r) => r.sandboxId === sandboxId); },
    async setArchivedAt(threadId, at) {
      const r = rows.find((r) => r.threadId === threadId);
      if (r) r.archivedAt = at;
    },
  };
}

describe("ThreadArchiveService.sweep", () => {
  it("archives least-recent active threads beyond cap", async () => {
    const rows = [
      { threadId: "t1", sandboxId: "s", archivedAt: null, updatedAt: 1000 },
      { threadId: "t2", sandboxId: "s", archivedAt: null, updatedAt: 2000 },
      { threadId: "t3", sandboxId: "s", archivedAt: null, updatedAt: 3000 },
      { threadId: "t4", sandboxId: "s", archivedAt: null, updatedAt: 4000 },
    ];
    const events: Array<{ event: string; threadId: string }> = [];
    const a = makeThreadArchive({ store: inMemStore(rows), now: () => 9999, emit: (e) => events.push(e) });
    const archived = await a.sweep("s", 2);
    expect(archived.sort()).toEqual(["t1", "t2"]);
    expect(rows.find((r) => r.threadId === "t1")!.archivedAt).toBe(9999);
    expect(rows.find((r) => r.threadId === "t2")!.archivedAt).toBe(9999);
    expect(rows.find((r) => r.threadId === "t3")!.archivedAt).toBeNull();
    expect(events.map((e) => e.event)).toEqual(["thread.archived", "thread.archived"]);
  });

  it("idempotent: archived threads aren't re-counted", async () => {
    const rows = [
      { threadId: "a", sandboxId: "s", archivedAt: null, updatedAt: 1 },
      { threadId: "b", sandboxId: "s", archivedAt: 100, updatedAt: 5 },
      { threadId: "c", sandboxId: "s", archivedAt: null, updatedAt: 10 },
    ];
    const a = makeThreadArchive({ store: inMemStore(rows) });
    const r = await a.sweep("s", 2);
    expect(r).toEqual([]);
  });

  it("returns empty when active count ≤ cap", async () => {
    const rows = [{ threadId: "a", sandboxId: "s", archivedAt: null, updatedAt: 1 }];
    const a = makeThreadArchive({ store: inMemStore(rows) });
    expect(await a.sweep("s", 2)).toEqual([]);
  });

  it("scoped per sandbox", async () => {
    const rows = [
      { threadId: "a1", sandboxId: "A", archivedAt: null, updatedAt: 1 },
      { threadId: "a2", sandboxId: "A", archivedAt: null, updatedAt: 2 },
      { threadId: "b1", sandboxId: "B", archivedAt: null, updatedAt: 3 },
    ];
    const a = makeThreadArchive({ store: inMemStore(rows) });
    const arA = await a.sweep("A", 1);
    expect(arA).toEqual(["a1"]);
    const arB = await a.sweep("B", 1);
    expect(arB).toEqual([]);
  });

  it("rejects negative cap", async () => {
    const a = makeThreadArchive({ store: inMemStore([]) });
    await expect(a.sweep("s", -1)).rejects.toThrow();
  });
});

describe("ThreadArchiveService.unarchive", () => {
  it("clears archivedAt and emits event", async () => {
    const rows = [{ threadId: "x", sandboxId: "s", archivedAt: 100, updatedAt: 1 }];
    const events: Array<{ event: string; threadId: string }> = [];
    const a = makeThreadArchive({ store: inMemStore(rows), emit: (e) => events.push(e) });
    await a.unarchive("x", "s");
    expect(rows[0]!.archivedAt).toBeNull();
    expect(events).toEqual([{ event: "thread.unarchived", threadId: "x", sandboxId: "s", archivedAt: null }]);
  });
});
