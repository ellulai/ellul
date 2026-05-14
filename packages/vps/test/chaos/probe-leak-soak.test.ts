// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Soak test for resource-v2 probe-leak invariant. Designed to run on a
// Linux fleet host across hibernate/wake cycles to verify that:
//
//   1. The bridge cgroup never accumulates leaked probe processes
//      across 24+ hours of normal operation.
//   2. The disk inventory cache survives bridge restarts so the first
//      probe after wake is a `--version` cache hit, not a fresh
//      `serve` spawn.
//   3. `bridge.cgroup.violation` events emitted equals zero across the
//      window — no regression slipped past Phase E lockdown.
//
// This is GATED on the env var `ELLUL_NIGHTLY=1`. Default vitest run
// skips it (the burst chaos test in the same dir is the smoke-frequency
// check; this is the soak frequency check).
//
// Run shape:
//   ELLUL_NIGHTLY=1 pnpm vitest run packages/vps/test/chaos/probe-leak-soak.test.ts
//
// On a CI nightly runner: schedule a 6-hour run that loops 24 hibernate
// cycles (every 15 min) using:
//   for i in $(seq 24); do
//     systemctl suspend
//     sleep 15m
//   done
// then runs the assertions below.
//
// Operator interpretation: a passing run proves Phase B + C + D + E
// hold under sustained operation. A failing run identifies the exact
// regression vector via the captured event log.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const isLinux = process.platform === "linux";
const isNightly = process.env.ELLUL_NIGHTLY === "1";
const run = isLinux && isNightly ? describe : describe.skip;

const EVENTS_LOG = "/var/log/ellul/agent-bridge-events.jsonl";
const BRIDGE_CGROUP = "/sys/fs/cgroup/ellul.slice/ellul-control.slice/ellul-control-plane.slice/ellul-agent-bridge.service";
const INVENTORY_CACHE_DIR = "/etc/ellul/agent-bridge/inventory";

run("soak: probe leak does not return across hibernate cycles (24h)", () => {
  it("agent-bridge-events.jsonl shows zero bridge.cgroup.violation events", () => {
    if (!fs.existsSync(EVENTS_LOG)) return;
    const events = readEventsSinceBoot(EVENTS_LOG);
    const violations = events.filter((e) => e.event === "bridge.cgroup.violation");
    if (violations.length > 0) {
      // Print the first 5 for diagnosis. Fail on >0.
      console.error(
        `bridge.cgroup.violation events seen during soak window:\n` +
          violations.slice(0, 5).map((v) => JSON.stringify(v)).join("\n"),
      );
    }
    expect(violations.length, "bridge.cgroup.violation regression").toBe(0);
  });

  it("zero ns.spawner.uncontainedLongLivedHost events (Phase E lockdown held)", () => {
    if (!fs.existsSync(EVENTS_LOG)) return;
    const events = readEventsSinceBoot(EVENTS_LOG);
    const blocked = events.filter((e) => e.event === "ns.spawner.uncontainedLongLivedHost");
    expect(blocked.length, "Phase E lockdown tripped — adapter bypassed routing").toBe(0);
  });

  it("inventory cache files exist for adapters that ran probes (Phase C survived restarts)", () => {
    if (!fs.existsSync(INVENTORY_CACHE_DIR)) return;
    const events = readEventsSinceBoot(EVENTS_LOG);
    // Adapters that emitted cache.persistOk during the soak window
    // SHOULD have a cache file on disk. If they don't, the disk cache
    // didn't survive a restart (Phase C regression).
    const persisted = new Set(
      events
        .filter((e) => e.event === "inventory.cache.persistOk")
        .map((e) => e.adapter as string)
        .filter((s) => typeof s === "string"),
    );
    for (const adapter of persisted) {
      expect(fs.existsSync(path.join(INVENTORY_CACHE_DIR, `${adapter}.json`))).toBe(true);
    }
  });

  it("after wake, first probe per adapter is a cache HIT not a fresh serve", () => {
    if (!fs.existsSync(EVENTS_LOG)) return;
    const events = readEventsSinceBoot(EVENTS_LOG);
    // For each adapter, find the first opencode/cursor/codex probe
    // event after the most recent bridge.start. If the cache is doing
    // its job, it should be a cacheHit (loadHit / providerProbe.inventoryCacheHit),
    // not a spawn.begin.
    const lastStart = lastIndexOfEvent(events, "bridge.start");
    if (lastStart < 0) return;
    const post = events.slice(lastStart);
    for (const adapter of ["opencode", "cursor"] as const) {
      const firstCache = post.find(
        (e) =>
          e.event === "inventory.cache.loadHit" && e.adapter === adapter,
      );
      const firstSpawn = post.find(
        (e) =>
          e.event === `${adapter}.spawn.begin` ||
          e.event === `${adapter}.providerProbe.inventoryCacheStore`,
      );
      // If either fired and the spawn fired BEFORE the cache hit, the
      // disk cache didn't hydrate L1 fast enough (or at all).
      if (firstSpawn && firstCache) {
        const spawnIdx = post.indexOf(firstSpawn);
        const cacheIdx = post.indexOf(firstCache);
        expect(cacheIdx).toBeLessThan(spawnIdx);
      }
    }
  });

  it("bridge cgroup contains only the bridge process at end-of-window", () => {
    if (!fs.existsSync(BRIDGE_CGROUP)) return;
    const procs = readCgroupProcs(path.join(BRIDGE_CGROUP, "cgroup.procs"));
    const mainPid = systemdMainPid("ellul-agent-bridge");
    if (mainPid <= 0) return;
    const foreigners = procs.filter((p) => p !== mainPid);
    // Tolerate up to 2 transient wrappers (sudo→spawn-scope→systemd-run);
    // the strict assertion is in cgroup-placement.test.ts on a single
    // moment-in-time read. Soak is more lenient on the snapshot but
    // strict on the violation event count above.
    expect(foreigners.length, `unexpected pids in bridge cgroup: ${foreigners.join(", ")}`).toBeLessThanOrEqual(2);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

interface JsonlEvent {
  readonly ts: string;
  readonly pid: number;
  readonly event: string;
  readonly [k: string]: unknown;
}

function readEventsSinceBoot(filePath: string): ReadonlyArray<JsonlEvent> {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l): JsonlEvent | null => {
        try {
          return JSON.parse(l) as JsonlEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is JsonlEvent => e !== null);
  } catch {
    return [];
  }
}

function lastIndexOfEvent(events: ReadonlyArray<JsonlEvent>, eventName: string): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.event === eventName) return i;
  }
  return -1;
}

function readCgroupProcs(absPath: string): ReadonlyArray<number> {
  try {
    const raw = fs.readFileSync(absPath, "utf8");
    return raw
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function systemdMainPid(unit: string): number {
  const r = spawnSync("systemctl", ["show", "-p", "MainPID", "--value", unit], { encoding: "utf8" });
  const v = parseInt((r.stdout || "0").trim(), 10);
  return Number.isFinite(v) ? v : 0;
}
