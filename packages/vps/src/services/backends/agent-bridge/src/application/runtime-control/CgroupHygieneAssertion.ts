// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Cgroup hygiene assertion (resource-v2 Phase D).
//
// Contract enforcement at runtime: bridge's own cgroup is reserved for
// the control plane. Adapter pool spawns and probe spawns route through
// `ellul-spawn-scope` into per-sandbox transient slices or
// `ellul-user-workload.slice`. Anything else landing in the bridge
// cgroup is a regression — most likely a forgotten host-bypass spawn
// without routing vars, or a fork that didn't cross the systemd-run
// scope boundary.
//
// This module reads `cgroup.procs` of the bridge's own cgroup on every
// reconciler tick and emits `bridge.cgroup.violation` events for any
// PID that isn't:
//   1. The bridge node main process itself.
//   2. A transient `ellul-spawn-scope` wrapper younger than the grace
//      window (sudo → spawn-scope script → systemd-run; the moving
//      window between fork and the new scope's cgroup migration).
//
// First detection emits at WARN. Sustained > sustainedThresholdMs across
// consecutive ticks emits at CRITICAL with the same details — that's the
// alarm path operators page on.
//
// SECURITY NOTE: pure observation. Reads cgroup.procs, /proc/<pid>/comm,
// /proc/<pid>/cmdline, /proc/<pid>/stat, /proc/uptime — all world-readable
// for processes the agent owns. No new sudoers, no new namespace
// boundaries, no migration of foreign PIDs. The only side effect is JSONL
// event emission. Strict net-positive: an existing invariant moves from
// "documented" to "runtime-enforced".

import * as fs from "node:fs";
import * as path from "node:path";

import { logEvent } from "../../shared/event-log";

export type CgroupViolationSeverity = "warn" | "critical";

export interface CgroupViolation {
  /** Offending PID. */
  readonly pid: number;
  /** /proc/<pid>/comm — process name (truncated 16 chars by kernel). */
  readonly comm: string;
  /** /proc/<pid>/cmdline — null-separated argv joined with " ", capped 256 chars. */
  readonly cmdline: string;
  /** Process age, ms (now - process start). */
  readonly ageMs: number;
  /** ms timestamp of detection. */
  readonly detectedAt: number;
  /** ms timestamp of FIRST detection across consecutive ticks. */
  readonly firstSeenAt: number;
  /** warn on first detection; critical when sustained past threshold. */
  readonly severity: CgroupViolationSeverity;
}

export interface CgroupHygieneState {
  /** True if /proc + cgroup-v2 detection succeeded for this process. */
  readonly available: boolean;
  /** Bridge process pid (self). */
  readonly bridgePid: number;
  /** Resolved /sys/fs/cgroup absolute path of bridge cgroup, or null. */
  readonly cgroupAbsolutePath: string | null;
  /** Cumulative count of violation events emitted since bridge boot. */
  readonly violationsEmittedSinceBoot: number;
  /** ms timestamp of last successful check. */
  readonly lastCheckAt: number | null;
  /** PIDs currently in violation (carried across ticks for sustained classification). */
  readonly trackedViolatorPids: ReadonlyArray<number>;
}

export interface CgroupHygieneAssertionShape {
  readonly check: () => Promise<ReadonlyArray<CgroupViolation>>;
  readonly state: () => CgroupHygieneState;
}

export interface ProcFs {
  readSelfCgroupRelative(): string | null;
  readCgroupProcs(absoluteCgroupPath: string): ReadonlyArray<number>;
  readProcComm(pid: number): string | null;
  readProcCmdline(pid: number): string | null;
  /** Process age in ms (now - start). null if unreadable. */
  readProcAgeMs(pid: number): number | null;
}

export interface CgroupHygieneDeps {
  /** Override the bridge pid (defaults to process.pid). */
  readonly bridgePid?: number;
  /** Wrappers younger than this are exempt (sudo→spawn-scope→systemd-run). Default 2000 ms. */
  readonly transientWrapperGraceMs?: number;
  /** Violation persisting longer than this escalates to CRITICAL. Default 30000 ms. */
  readonly sustainedThresholdMs?: number;
  /** Cap on number of violations emitted per check (rate-limit log spam). Default 32. */
  readonly maxViolationsPerCheck?: number;
  /** Event sink. Defaults to logEvent("bridge.cgroup.violation", ...). */
  readonly emit?: (event: string, payload: Record<string, unknown>) => void;
  /** /proc + /sys/fs/cgroup access. Tests inject; default reads real fs. */
  readonly procFs?: ProcFs;
  /** Wall clock; tests inject. */
  readonly now?: () => number;
}

const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_SUSTAINED_MS = 30_000;
const DEFAULT_MAX_VIOLATIONS_PER_CHECK = 32;
const COMM_TRANSIENT_WRAPPERS = new Set([
  "sudo",
  "ellul-spawn-scope",
  "systemd-run",
  "bash",
  "sh",
]);
const CMDLINE_TRANSIENT_MARKERS = ["ellul-spawn-scope", "systemd-run"];

export function makeCgroupHygieneAssertion(
  deps: CgroupHygieneDeps = {},
): CgroupHygieneAssertionShape {
  const bridgePid = deps.bridgePid ?? process.pid;
  const grace = deps.transientWrapperGraceMs ?? DEFAULT_GRACE_MS;
  const sustained = deps.sustainedThresholdMs ?? DEFAULT_SUSTAINED_MS;
  const maxPerCheck = deps.maxViolationsPerCheck ?? DEFAULT_MAX_VIOLATIONS_PER_CHECK;
  const procFs = deps.procFs ?? defaultProcFs;
  const now = deps.now ?? Date.now;
  const emit = deps.emit ?? defaultEmit;

  // Persistent across ticks: pid → first time it was seen as a violator.
  const firstSeen: Map<number, number> = new Map();
  let violationsEmittedSinceBoot = 0;
  let lastCheckAt: number | null = null;
  let cachedAbsolutePath: string | null | undefined;

  function resolveCgroupAbsolutePath(): string | null {
    if (cachedAbsolutePath !== undefined) return cachedAbsolutePath;
    const rel = procFs.readSelfCgroupRelative();
    if (!rel) {
      cachedAbsolutePath = null;
      return null;
    }
    // /proc/self/cgroup format on cgroup-v2: "0::/ellul.slice/...".
    // Anything else (cgroup-v1 hybrid, no cgroup) is "not available".
    if (!rel.startsWith("0::")) {
      cachedAbsolutePath = null;
      return null;
    }
    const relativePath = rel.slice(3).trim();
    if (!relativePath || !relativePath.startsWith("/")) {
      cachedAbsolutePath = null;
      return null;
    }
    // Defense in depth: only assert hygiene on the bridge cgroup. If the
    // bridge is running outside its expected slice (developer machine,
    // test harness) we silently no-op rather than spam violations for
    // anything in the calling shell's cgroup.
    if (!relativePath.includes("ellul-agent-bridge.service")) {
      cachedAbsolutePath = null;
      return null;
    }
    cachedAbsolutePath = path.join("/sys/fs/cgroup", relativePath);
    return cachedAbsolutePath;
  }

  async function check(): Promise<ReadonlyArray<CgroupViolation>> {
    const cgroupAbs = resolveCgroupAbsolutePath();
    if (!cgroupAbs) return [];
    let pids: ReadonlyArray<number>;
    try {
      pids = procFs.readCgroupProcs(cgroupAbs);
    } catch {
      return [];
    }
    const detectedAt = now();
    lastCheckAt = detectedAt;
    const violations: Array<CgroupViolation> = [];
    const stillViolating: Set<number> = new Set();

    for (const pid of pids) {
      if (pid === bridgePid) continue;
      const comm = procFs.readProcComm(pid) ?? "?";
      const cmdline = (procFs.readProcCmdline(pid) ?? "").slice(0, 256);
      const ageMs = procFs.readProcAgeMs(pid);
      // Transient wrapper allowlist: a sudo→ellul-spawn-scope→systemd-run
      // chain takes ~ms to migrate the child into the new scope. Anything
      // matching that shape and younger than the grace window is exempt.
      const isTransientWrapper =
        ageMs !== null &&
        ageMs < grace &&
        COMM_TRANSIENT_WRAPPERS.has(comm) &&
        CMDLINE_TRANSIENT_MARKERS.some((m) => cmdline.includes(m));
      if (isTransientWrapper) continue;

      stillViolating.add(pid);
      const previousFirstSeen = firstSeen.get(pid);
      const firstSeenAt = previousFirstSeen ?? detectedAt;
      if (previousFirstSeen === undefined) firstSeen.set(pid, detectedAt);
      const sustainedMs = detectedAt - firstSeenAt;
      const severity: CgroupViolationSeverity =
        sustainedMs >= sustained ? "critical" : "warn";

      const violation: CgroupViolation = {
        pid,
        comm,
        cmdline,
        ageMs: ageMs ?? -1,
        detectedAt,
        firstSeenAt,
        severity,
      };
      violations.push(violation);
      if (violations.length >= maxPerCheck) break;
    }

    // Drop trackers for pids no longer present (process exited or moved out).
    for (const pid of Array.from(firstSeen.keys())) {
      if (!stillViolating.has(pid)) firstSeen.delete(pid);
    }

    for (const v of violations) {
      emit("bridge.cgroup.violation", {
        pid: v.pid,
        comm: v.comm,
        cmdline: v.cmdline,
        ageMs: v.ageMs,
        firstSeenAt: v.firstSeenAt,
        sustainedMs: v.detectedAt - v.firstSeenAt,
        severity: v.severity,
        cgroupAbsolutePath: cgroupAbs,
      });
      violationsEmittedSinceBoot++;
    }
    return violations;
  }

  function stateOf(): CgroupHygieneState {
    return {
      available: resolveCgroupAbsolutePath() !== null,
      bridgePid,
      cgroupAbsolutePath: resolveCgroupAbsolutePath(),
      violationsEmittedSinceBoot,
      lastCheckAt,
      trackedViolatorPids: Array.from(firstSeen.keys()),
    };
  }

  return { check, state: stateOf };
}

// ── default ProcFs ───────────────────────────────────────────────────

const SELF_CGROUP_PATH = "/proc/self/cgroup";

const defaultProcFs: ProcFs = {
  readSelfCgroupRelative(): string | null {
    try {
      return fs.readFileSync(SELF_CGROUP_PATH, "utf8").split("\n")[0] ?? null;
    } catch {
      return null;
    }
  },
  readCgroupProcs(absoluteCgroupPath: string): ReadonlyArray<number> {
    const procs = fs.readFileSync(path.join(absoluteCgroupPath, "cgroup.procs"), "utf8");
    return procs
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  },
  readProcComm(pid: number): string | null {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      return null;
    }
  },
  readProcCmdline(pid: number): string | null {
    try {
      // /proc/<pid>/cmdline is null-separated argv with a trailing null.
      // Replace nulls with spaces for human-readable logs; trim trailing.
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return raw.replace(/\0/g, " ").trim();
    } catch {
      return null;
    }
  },
  readProcAgeMs(pid: number): number | null {
    try {
      // /proc/<pid>/stat: field 22 is starttime in clock ticks since boot.
      // Format: "pid (comm) state ppid pgrp ... starttime ..."
      // The comm field can contain spaces and parens; split after the
      // last ')' to be robust.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const lastParen = stat.lastIndexOf(")");
      if (lastParen < 0) return null;
      const after = stat.slice(lastParen + 2).split(/\s+/);
      // After the final ')' the next fields are: state(0) ppid(1) pgrp(2)
      // session(3) tty_nr(4) tpgid(5) flags(6) minflt(7) cminflt(8)
      // majflt(9) cmajflt(10) utime(11) stime(12) cutime(13) cstime(14)
      // priority(15) nice(16) num_threads(17) itrealvalue(18) starttime(19).
      // (procfs field index 22 minus the 3 fields we ate = position 19.)
      const startTimeTicks = Number.parseInt(after[19] ?? "", 10);
      if (!Number.isFinite(startTimeTicks)) return null;
      const clkTck = readClockTicksPerSecond();
      const uptime = readUptimeSeconds();
      if (clkTck <= 0 || uptime === null) return null;
      const startSecondsSinceBoot = startTimeTicks / clkTck;
      const ageSeconds = uptime - startSecondsSinceBoot;
      if (ageSeconds < 0) return 0;
      return Math.round(ageSeconds * 1000);
    } catch {
      return null;
    }
  },
};

// _SC_CLK_TCK isn't directly exposed by Node. POSIX guarantees 100 on
// every Linux distro shipped this decade; if the kernel ever changes
// this we'd need to read getconf. Cached because it never changes for a
// running process.
let _cachedClkTck: number | null = null;
function readClockTicksPerSecond(): number {
  if (_cachedClkTck !== null) return _cachedClkTck;
  _cachedClkTck = 100;
  return _cachedClkTck;
}

function readUptimeSeconds(): number | null {
  try {
    const uptime = fs.readFileSync("/proc/uptime", "utf8").split(/\s+/)[0];
    const v = Number.parseFloat(uptime ?? "");
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function defaultEmit(event: string, payload: Record<string, unknown>): void {
  logEvent(event, payload);
}
