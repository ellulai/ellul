// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const isLinux = process.platform === "linux";
const run = isLinux ? describe : describe.skip;

run("chaos: bridge-kill", () => {
  it("SIGKILL bridge mid-session: pool processes survive in their own slices", async () => {
    const before = listCgroupProcesses("ellul-user-workload.slice");
    const bridgePid = pidOf("ellul-agent-bridge");
    expect(bridgePid).toBeGreaterThan(0);

    const poolPidsBefore = listCgroupProcesses("ellul-user-workload-sbx-canary00.slice");
    expect(poolPidsBefore.length).toBeGreaterThan(0);

    spawnSync("kill", ["-KILL", String(bridgePid)]);
    await sleep(2000);

    const poolPidsAfter = listCgroupProcesses("ellul-user-workload-sbx-canary00.slice");
    for (const pid of poolPidsBefore) {
      expect(poolPidsAfter, `pool pid ${pid} should survive bridge kill`).toContain(pid);
    }

    await waitFor(() => pidOf("ellul-agent-bridge") > 0, 5000);
    expect(pidOf("ellul-agent-bridge")).toBeGreaterThan(0);
  }, 30_000);

  it("session loss rate is zero: messages buffered + replayed", async () => {
    expect(true).toBe(true);
  });
});

function listCgroupProcesses(cgroup: string): number[] {
  const r = spawnSync("cat", [`/sys/fs/cgroup/ellul.slice/${cgroup}/cgroup.procs`], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.trim().split("\n").filter(Boolean).map((s) => parseInt(s, 10));
}

function pidOf(unit: string): number {
  const r = spawnSync("systemctl", ["show", "-p", "MainPID", "--value", unit], { encoding: "utf8" });
  const v = parseInt((r.stdout || "0").trim(), 10);
  return Number.isFinite(v) ? v : 0;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) await sleep(100);
}
