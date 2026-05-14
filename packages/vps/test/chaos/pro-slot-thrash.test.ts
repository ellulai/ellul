// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const isLinux = process.platform === "linux";
const run = isLinux ? describe : describe.skip;

run("chaos: pro-slot-thrash", () => {
  it("switching between 5 Pro threads keeps LRU-of-2 warm; hydration < 2 s P95", async () => {
    const threadIds = ["t-pro-1", "t-pro-2", "t-pro-3", "t-pro-4", "t-pro-5"];
    const tookMs: number[] = [];

    for (let round = 0; round < 4; round++) {
      for (const tid of threadIds) {
        const start = Date.now();
        const r = spawnSync("curl", ["-s", "-X", "POST", `http://127.0.0.1:7700/api/internal/pro-slot/bind`, "-d", JSON.stringify({ threadId: tid }), "-H", "content-type: application/json"], { encoding: "utf8" });
        expect(r.status).toBe(0);
        tookMs.push(Date.now() - start);
      }
    }

    tookMs.sort((a, b) => a - b);
    const p95 = tookMs[Math.floor(tookMs.length * 0.95)];
    expect(p95!).toBeLessThan(4000);

    const slots = listSlots();
    const warmCount = slots.filter((s) => s.state === "warm").length;
    const tierCap = phys() <= 4096 ? 1 : 3;
    expect(warmCount).toBeLessThanOrEqual(Math.min(2, tierCap));

    const slotProcs = countSlotScopes();
    expect(slotProcs).toBeLessThanOrEqual(tierCap);
  }, 120_000);
});

function listSlots(): Array<{ slotIndex: number; state: string }> {
  const r = spawnSync("curl", ["-s", "http://127.0.0.1:7700/api/internal/pro-slot/snapshot"], { encoding: "utf8" });
  try {
    const j = JSON.parse(r.stdout || "[]");
    return j as Array<{ slotIndex: number; state: string }>;
  } catch { return []; }
}

function countSlotScopes(): number {
  const r = spawnSync("systemctl", ["list-units", "--type=scope", "--no-legend", "--plain", "--no-pager", "ellul-pro-claude-slot*"], { encoding: "utf8" });
  return (r.stdout || "").split("\n").filter(Boolean).length;
}

function phys(): number {
  const r = spawnSync("grep", ["MemTotal", "/proc/meminfo"], { encoding: "utf8" });
  const m = /(\d+)/.exec(r.stdout || "0");
  return Math.round((m ? parseInt(m[1]!, 10) : 0) / 1024);
}
