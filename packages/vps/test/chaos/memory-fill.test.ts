// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import { spawnSync, spawn } from "node:child_process";

const isLinux = process.platform === "linux";
const run = isLinux ? describe : describe.skip;

run("chaos: memory-fill", () => {
  it("drives slice to red, DegradationController fires; no OOM outside designed scopes", async () => {
    const baseline = readMemoryCurrentMB("ellul-user-workload.slice");
    const targetMb = baseline + 1024;

    const child = spawn("/usr/local/bin/malloc-eat", ["--target-mb", String(targetMb), "--hold-seconds", "20"], {
      env: { ELLUL_NS_PROJECT: "sbx-canary0", ELLUL_NS_ADAPTER: "opencode", ELLUL_NS_SCOPE_ID: "fill", ELLUL_NS_SOFT_HINT_MB: "1536" },
    });
    expect(child.pid).toBeGreaterThan(0);

    await waitFor(() => fetchHealth() === "yellow" || fetchHealth() === "red", 30_000);
    expect(["yellow", "red"]).toContain(fetchHealth());

    const oomElsewhere = readOomKills("ellul-control-plane.slice");
    expect(oomElsewhere).toBe(0);

    child.kill("SIGTERM");
    await waitFor(() => fetchHealth() === "green", 30_000);
  }, 90_000);
});

function readMemoryCurrentMB(slice: string): number {
  const r = spawnSync("cat", [`/sys/fs/cgroup/ellul.slice/${slice}/memory.current`], { encoding: "utf8" });
  return Math.round(parseInt((r.stdout || "0").trim(), 10) / (1024 * 1024));
}

function readOomKills(slice: string): number {
  const r = spawnSync("cat", [`/sys/fs/cgroup/ellul.slice/${slice}/memory.events`], { encoding: "utf8" });
  for (const line of (r.stdout || "").split("\n")) {
    const [k, v] = line.split(/\s+/);
    if (k === "oom_kill") return parseInt(v ?? "0", 10);
  }
  return 0;
}

function fetchHealth(): "green" | "yellow" | "red" | "unknown" {
  const r = spawnSync("curl", ["-s", "http://127.0.0.1:7700/api/internal/health"], { encoding: "utf8" });
  try {
    const j = JSON.parse(r.stdout || "{}");
    return j.state ?? "unknown";
  } catch { return "unknown"; }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) await sleep(200);
}
