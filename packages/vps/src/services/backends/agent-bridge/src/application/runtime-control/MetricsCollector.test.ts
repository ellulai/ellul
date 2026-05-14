// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveKey,
  discoverCgroups,
  makeMetricsCollector,
  renderPrometheus,
  type CgroupSample,
} from "./MetricsCollector";

function makeFakeCgroupTree(): string {
  const root = mkdtempSync(join(tmpdir(), "metrics-collector-"));
  const make = (rel: string, files: Record<string, string>) => {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cgroup.controllers"), "memory cpu pids\n");
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  };
  make("ellul-user-workload.slice", {
    "memory.current": "4718592000\n",
    "memory.high": "max\n",
    "memory.max": "5368709120\n",
    "memory.events": "low 0\nhigh 12\nmax 0\noom 0\noom_kill 0\n",
    "memory.pressure": "some avg10=4.30 avg60=2.10 avg300=0.50 total=12345\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    "cpu.stat": "usage_usec 100000\nuser_usec 80000\nsystem_usec 20000\n",
    "cpu.pressure": "some avg10=1.0 avg60=0.5 avg300=0.1 total=0\n",
    "pids.current": "42\n",
  });
  make("ellul-user-workload.slice/ellul-user-workload-sbx-abc1234.slice", {
    "memory.current": "1572864000\n",
    "memory.high": "1610612736\n",
    "memory.max": "max\n",
    "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    "memory.pressure": "some avg10=0.0 avg60=0.0 avg300=0.0 total=0\n",
    "cpu.stat": "usage_usec 50000\nuser_usec 40000\nsystem_usec 10000\n",
    "cpu.pressure": "some avg10=0 avg60=0 avg300=0 total=0\n",
    "pids.current": "12\n",
  });
  make("ellul-user-workload.slice/ellul-user-workload-sbx-abc1234.slice/ellul-pool-sbx-abc1234-opencode-pool1.scope", {
    "memory.current": "251658240\n",
    "memory.high": "max\n",
    "memory.max": "max\n",
    "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    "memory.pressure": "some avg10=0 avg60=0 avg300=0 total=0\n",
    "cpu.stat": "usage_usec 1000\nuser_usec 800\nsystem_usec 200\n",
    "cpu.pressure": "some avg10=0 avg60=0 avg300=0 total=0\n",
    "pids.current": "5\n",
  });
  make("ellul-user-workload.slice/ellul-pro-claude-slot1.scope", {
    "memory.current": "234881024\n",
    "memory.high": "335544320\n",
    "memory.max": "max\n",
    "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    "memory.pressure": "some avg10=0 avg60=0 avg300=0 total=0\n",
    "cpu.stat": "usage_usec 9999\nuser_usec 9000\nsystem_usec 999\n",
    "cpu.pressure": "some avg10=0 avg60=0 avg300=0 total=0\n",
    "pids.current": "3\n",
  });
  make("ellul-control-plane.slice", {
    "memory.current": "655360000\n",
    "memory.high": "max\n",
    "memory.max": "max\n",
    "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    "memory.pressure": "some avg10=0 avg60=0 avg300=0 total=0\n",
    "cpu.stat": "usage_usec 5000\nuser_usec 4000\nsystem_usec 1000\n",
    "cpu.pressure": "some avg10=0 avg60=0 avg300=0 total=0\n",
    "pids.current": "20\n",
  });
  return root;
}

describe("deriveKey", () => {
  it("parses sandbox-only slice", () => {
    const k = deriveKey("ellul-user-workload.slice/ellul-user-workload-sbx-abc1234.slice");
    expect(k.sandbox).toBe("sbx-abc1234");
    expect(k.adapter).toBeNull();
    expect(k.scope).toBeNull();
  });

  it("parses pool scope", () => {
    const k = deriveKey("ellul-user-workload.slice/ellul-user-workload-sbx-abc1234.slice/ellul-pool-sbx-abc1234-opencode-pool1.scope");
    expect(k.sandbox).toBe("sbx-abc1234");
    expect(k.adapter).toBe("opencode");
    expect(k.scope).toBe("pool1");
  });

  it("parses Pro Claude slot scope", () => {
    const k = deriveKey("ellul-user-workload.slice/ellul-pro-claude-slot1.scope");
    expect(k.adapter).toBe("claude");
    expect(k.scope).toBe("ellul-pro-claude-slot1");
  });

  it("falls back to slice for control-plane", () => {
    const k = deriveKey("ellul-control-plane.slice");
    expect(k.slice).toBe("ellul-control-plane.slice");
    expect(k.sandbox).toBeNull();
  });
});

describe("discoverCgroups", () => {
  it("walks the fake tree and finds every cgroup", () => {
    const root = makeFakeCgroupTree();
    const keys = discoverCgroups(root);
    const paths = keys.map((k) => k.cgroupPath).sort();
    expect(paths).toEqual([
      "ellul-control-plane.slice",
      "ellul-user-workload.slice",
      "ellul-user-workload.slice/ellul-pro-claude-slot1.scope",
      "ellul-user-workload.slice/ellul-user-workload-sbx-abc1234.slice",
      "ellul-user-workload.slice/ellul-user-workload-sbx-abc1234.slice/ellul-pool-sbx-abc1234-opencode-pool1.scope",
    ]);
  });
});

describe("MetricsCollector", () => {
  it("samples every known cgroup with parsed memory/PSI/cpu/pids", async () => {
    const root = makeFakeCgroupTree();
    const c = makeMetricsCollector({
      cgroupRoot: root,
      intervalMs: 50,
      prometheusPort: null,
      snapshotDir: null,
    });
    await new Promise((r) => setTimeout(r, 200));
    const samples = c.snapshot();
    await c.stop();

    expect(samples.length).toBe(5);
    const workload = samples.find((s) => s.key.cgroupPath === "ellul-user-workload.slice")!;
    expect(workload.memoryCurrentBytes).toBe(4_718_592_000);
    expect(workload.psiMem.avg10).toBeCloseTo(4.30, 5);
    expect(workload.cpuUsageUsec).toBe(100_000);
    expect(workload.pidsCurrent).toBe(42);
    expect(workload.memoryEvents.high).toBe(12);

    const sbxSlice = samples.find((s) => s.key.sandbox === "sbx-abc1234" && s.key.adapter === null)!;
    expect(sbxSlice.memoryHighBytes).toBe(1_610_612_736);
    expect(sbxSlice.memoryMaxBytes).toBeNull();

    const opencode = samples.find((s) => s.key.adapter === "opencode")!;
    expect(opencode.memoryCurrentBytes).toBe(251_658_240);
    expect(opencode.key.scope).toBe("pool1");
  });

  it("calls subscribers on every tick", async () => {
    const root = makeFakeCgroupTree();
    const c = makeMetricsCollector({
      cgroupRoot: root,
      intervalMs: 30,
      prometheusPort: null,
      snapshotDir: null,
    });
    let calls = 0;
    const off = c.subscribe(() => { calls++; });
    await new Promise((r) => setTimeout(r, 200));
    off();
    await c.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("window returns recent samples within lastSeconds", async () => {
    const root = makeFakeCgroupTree();
    const c = makeMetricsCollector({
      cgroupRoot: root,
      intervalMs: 30,
      prometheusPort: null,
      snapshotDir: null,
    });
    await new Promise((r) => setTimeout(r, 200));
    const w = c.window("ellul-user-workload.slice", 10);
    await c.stop();
    expect(w.length).toBeGreaterThanOrEqual(1);
    for (const s of w) expect(s.key.cgroupPath).toBe("ellul-user-workload.slice");
  });

  it("does not throw if cgroup files vanish mid-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "metrics-empty-"));
    const c = makeMetricsCollector({
      cgroupRoot: root,
      intervalMs: 30,
      prometheusPort: null,
      snapshotDir: null,
    });
    await new Promise((r) => setTimeout(r, 100));
    await c.stop();
    expect(c.snapshot().length).toBe(0);
  });
});

describe("renderPrometheus", () => {
  const baseSample = (overrides: Partial<CgroupSample> = {}): CgroupSample => ({
    key: { cgroupPath: "x", slice: "ellul-user-workload.slice", sandbox: null, adapter: null, scope: null },
    at: 1,
    memoryCurrentBytes: 100,
    memoryHighBytes: 200,
    memoryMaxBytes: null,
    memoryEvents: { low: 0, high: 0, max: 0, oom: 0, oomKill: 0 },
    psiMem: { avg10: 1.5, avg60: 0.5, avg300: 0.1 },
    cpuUsageUsec: 999,
    cpuUserUsec: 800,
    cpuSystemUsec: 199,
    psiCpu: { avg10: 0, avg60: 0, avg300: 0 },
    pidsCurrent: 7,
    ...overrides,
  });

  it("renders HELP+TYPE+samples per metric", () => {
    const out = renderPrometheus([baseSample()]);
    expect(out).toContain("# HELP ellul_cgroup_memory_current_bytes");
    expect(out).toContain("# TYPE ellul_cgroup_memory_current_bytes gauge");
    expect(out).toContain("ellul_cgroup_memory_current_bytes{slice=\"ellul-user-workload.slice\",sandbox=\"\",adapter=\"\",scope=\"\"} 100");
    expect(out).toContain("ellul_cgroup_psi_memory_avg10{slice=\"ellul-user-workload.slice\",sandbox=\"\",adapter=\"\",scope=\"\"} 1.5");
    expect(out).toContain("ellul_cgroup_pids_current{slice=\"ellul-user-workload.slice\",sandbox=\"\",adapter=\"\",scope=\"\"} 7");
  });

  it("renders memory.high=max as -1", () => {
    const out = renderPrometheus([baseSample({ memoryHighBytes: null, memoryMaxBytes: null })]);
    expect(out).toContain("ellul_cgroup_memory_high_bytes{slice=\"ellul-user-workload.slice\",sandbox=\"\",adapter=\"\",scope=\"\"} -1");
  });

  it("escapes label values", () => {
    const out = renderPrometheus([baseSample({
      key: { cgroupPath: "x", slice: 'evil"slice', sandbox: "sbx-xyz1234", adapter: "opencode", scope: "p1" },
    })]);
    expect(out).toContain('slice="evil\\"slice"');
    expect(out).toContain('adapter="opencode"');
  });
});
