// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Bridge-startup memory discipline. Two best-effort mechanisms:
//   1. mlock adapter binary pages within tier budget.
//   2. Write `memory.high` on the bridge's own cgroup so V8 GC fires
//      before the kernel reclaims. `memory.max` stays unset; OOM-killing
//      the bridge would be worse than any pressure.
// Both fail-soft. Binary paths are an allow-list, canonicalized via
// realpath; cgroup writes refuse anything outside /sys/fs/cgroup or
// not ending /memory.high.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import {
  computeAdapterPoolProfile,
  computeNodeHeapCaps,
  computeWorkloadSliceBudget,
} from "@vps/shared/memory-budget";
import { logEvent, serializeError } from "../../shared/event-log";

// Allow-list. Empirical hot-page footprint: opencode ~25, cursor ~20,
// codex ~25, claude ~15, zeroclaw ~15 (MB). Anything outside the
// PINNABLE_PATH_ROOTS realpath check is dropped.
const PINNABLE_BINARY_CANDIDATES: readonly string[] = [
  "/usr/local/bin/opencode",
  "/usr/local/libexec/ellul/opencode",
  "/usr/local/bin/cursor-agent",
  "/usr/local/bin/codex",
  "/usr/local/bin/claude",
  "/usr/local/bin/zeroclaw",
] as const;

const PINNABLE_PATH_ROOTS: readonly string[] = [
  "/usr/local/bin/",
  "/usr/local/libexec/ellul/",
] as const;

function isAllowedBinaryPath(p: string): boolean {
  // realpath defends against symlink swaps that would aim mlock elsewhere.
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    return false;
  }
  return PINNABLE_PATH_ROOTS.some((root) => real.startsWith(root));
}

function vmtouchAvailable(): boolean {
  // Cheap: spawnSync exits ~immediately on PATH lookup failure.
  const r = spawnSync("vmtouch", ["-v"], { timeout: 2_000, stdio: "ignore" });
  return r.status === 0 || r.error === undefined;
}

interface PinResult {
  readonly binary: string;
  readonly pinnedMB: number;
  readonly skipped: string | null;
}

function pinSingleBinary(p: string, remainingBudgetMB: number): PinResult {
  if (remainingBudgetMB <= 0) {
    return { binary: p, pinnedMB: 0, skipped: "budget-exhausted" };
  }
  if (!fs.existsSync(p)) {
    return { binary: p, pinnedMB: 0, skipped: "missing" };
  }
  if (!isAllowedBinaryPath(p)) {
    return { binary: p, pinnedMB: 0, skipped: "path-not-allowed" };
  }

  // -t touches pages into cache before -l locks them; without -t we'd
  // lock whatever happens to be resident (nothing, on cold start). -m
  // caps per-binary lock so an overshoot can't blow the budget.
  const res = spawnSync(
    "vmtouch",
    ["-tlqm", `${remainingBudgetMB}M`, p],
    { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (res.status !== 0) {
    return {
      binary: p,
      pinnedMB: 0,
      skipped: `vmtouch-exit-${res.status}-${(res.error ?? "").toString().slice(0, 40)}`,
    };
  }
  // vmtouch's stdout has lines like "Files locked: 1\nDirectories locked: 0\n
  // Resident pages locked: NNN/NNN  X.XM/Y.YM ...". We extract the locked MB.
  const out = res.stdout?.toString() ?? "";
  const m = out.match(/Resident pages locked:\s*\d+\/\d+\s+([\d.]+)M/i);
  const lockedMB = m ? Math.round(parseFloat(m[1] ?? "0")) : 0;
  return { binary: p, pinnedMB: lockedMB, skipped: null };
}

/** Pin hot adapter binary pages within tier budget. Best-effort. */
export function pinAdapterBinaries(): void {
  const physMB = Math.max(512, Math.round(os.totalmem() / (1024 * 1024)));
  const profile = computeAdapterPoolProfile(physMB);
  const budget = profile.binaryMlockBudgetMB;
  if (budget <= 0) {
    logEvent("memory.discipline.pin.skipped", { reason: "budget-zero", physMB });
    return;
  }
  if (!vmtouchAvailable()) {
    logEvent("memory.discipline.pin.skipped", { reason: "vmtouch-missing", physMB });
    return;
  }

  let remaining = budget;
  const results: PinResult[] = [];
  // Dedupe via realpath: /usr/local/bin and /usr/local/libexec/ellul
  // can alias the same binary.
  const seen = new Set<string>();
  for (const candidate of PINNABLE_BINARY_CANDIDATES) {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      results.push({ binary: candidate, pinnedMB: 0, skipped: "missing" });
      continue;
    }
    if (seen.has(real)) {
      results.push({ binary: candidate, pinnedMB: 0, skipped: "duplicate-of-prior" });
      continue;
    }
    seen.add(real);

    const r = pinSingleBinary(candidate, remaining);
    results.push(r);
    remaining = Math.max(0, remaining - r.pinnedMB);
  }

  const totalPinned = results.reduce((acc, r) => acc + r.pinnedMB, 0);
  logEvent("memory.discipline.pin.done", {
    physMB,
    budgetMB: budget,
    pinnedMB: totalPinned,
    remainingMB: remaining,
    perBinary: results,
  });
}

// ── Cgroup soft-cap (memory.high) ──────────────────────────────────────
// Read /proc/self/cgroup, write `<sys/fs/cgroup>/<path>/memory.high`.
// Refuses anything that resolves outside /sys/fs/cgroup or doesn't end
// in /memory.high — there is no path to walk into another service's
// cgroup.

function readOwnCgroupPath(): string | null {
  try {
    const raw = fs.readFileSync("/proc/self/cgroup", "utf8");
    // cgroup v2: single line "0::/path"
    const line = raw.split("\n").find((l) => l.startsWith("0::"));
    if (!line) return null;
    const cgPath = line.slice(3).trim(); // after "0::"
    if (!cgPath.startsWith("/")) return null;
    return cgPath;
  } catch {
    return null;
  }
}

function setBridgeCgroupSoftCap(): void {
  const physMB = Math.max(512, Math.round(os.totalmem() / (1024 * 1024)));
  const heapCaps = computeNodeHeapCaps(physMB);
  // 1.6× heap + 64 MB off-heap cushion (libuv, sqlite, native bindings).
  const softCapMB = Math.round(heapCaps.agentBridge * 1.6) + 64;

  const cgRel = readOwnCgroupPath();
  if (!cgRel) {
    logEvent("memory.discipline.cgroup.skipped", { reason: "cgroup-path-missing", softCapMB });
    return;
  }
  const cgAbs = path.join("/sys/fs/cgroup", cgRel);
  const target = path.join(cgAbs, "memory.high");
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.dirname(target)) + "/memory.high";
  } catch (e) {
    logEvent("memory.discipline.cgroup.skipped", {
      reason: "realpath-failed",
      target,
      ...serializeError(e),
    });
    return;
  }
  if (!resolved.startsWith("/sys/fs/cgroup/") || !resolved.endsWith("/memory.high")) {
    logEvent("memory.discipline.cgroup.skipped", {
      reason: "path-not-allowed",
      target,
      resolved,
    });
    return;
  }
  try {
    fs.writeFileSync(resolved, `${softCapMB * 1024 * 1024}`);
    logEvent("memory.discipline.cgroup.set", {
      cgroup: cgRel,
      softCapMB,
      heapCapMB: heapCaps.agentBridge,
    });
  } catch (e) {
    // EACCES means systemd hasn't delegated cgroup write — deployment
    // posture choice, not a bridge error.
    logEvent("memory.discipline.cgroup.skipped", {
      reason: "write-failed",
      target: resolved,
      softCapMB,
      ...serializeError(e),
    });
  }
}

/** One-shot at bridge startup. Failures logged, never thrown. */
export async function applyMemoryDiscipline(): Promise<void> {
  const physMB = Math.max(512, Math.round(os.totalmem() / (1024 * 1024)));
  const sliceBudget = computeWorkloadSliceBudget(physMB);
  logEvent("memory.discipline.begin", {
    physMB,
    controlPlaneCapMB: sliceBudget.controlPlaneAggregateMB,
    workloadCapMB: sliceBudget.workloadMaxMB,
  });
  try {
    pinAdapterBinaries();
  } catch (e) {
    logEvent("memory.discipline.pin.error", serializeError(e));
  }
  try {
    setBridgeCgroupSoftCap();
  } catch (e) {
    logEvent("memory.discipline.cgroup.error", serializeError(e));
  }
  logEvent("memory.discipline.end", {});
}
