// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Unit tests for the cgroup hygiene assertion (resource-v2 Phase D).
// The assertion is read-only and side-effect-bounded to JSONL events;
// these tests inject a fake ProcFs so they run on every platform.

import { describe, expect, it } from "vitest";
import {
  makeCgroupHygieneAssertion,
  type ProcFs,
} from "./CgroupHygieneAssertion";

interface FakeProc {
  pid: number;
  comm: string;
  cmdline: string;
  ageMs: number;
}

function makeFakeProcFs(opts: {
  selfCgroup?: string | null;
  procs?: ReadonlyArray<number>;
  byPid?: Map<number, FakeProc>;
}): ProcFs {
  const byPid = opts.byPid ?? new Map<number, FakeProc>();
  return {
    readSelfCgroupRelative() {
      // Distinguish "not specified" (use default) from "explicitly null".
      return Object.prototype.hasOwnProperty.call(opts, "selfCgroup")
        ? (opts.selfCgroup ?? null)
        : "0::/ellul.slice/ellul-control.slice/ellul-control-plane.slice/ellul-agent-bridge.service";
    },
    readCgroupProcs() {
      return opts.procs ?? [];
    },
    readProcComm(pid) {
      return byPid.get(pid)?.comm ?? null;
    },
    readProcCmdline(pid) {
      return byPid.get(pid)?.cmdline ?? null;
    },
    readProcAgeMs(pid) {
      return byPid.get(pid)?.ageMs ?? null;
    },
  };
}

describe("makeCgroupHygieneAssertion — availability gating", () => {
  it("is unavailable when /proc/self/cgroup is missing", async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ selfCgroup: null }),
      emit: (e, p) => events.push([e, p]),
    });
    expect(a.state().available).toBe(false);
    expect(await a.check()).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it("is unavailable on cgroup-v1 hybrid (line not 0::)", async () => {
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ selfCgroup: "11:memory:/some/group" }),
    });
    expect(a.state().available).toBe(false);
  });

  it("is unavailable when cgroup path doesn't include the bridge service", async () => {
    // Dev / test machines run the bridge outside its production slice;
    // hygiene assertion no-ops rather than spamming violations for the
    // calling shell's cgroup.
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ selfCgroup: "0::/user.slice/user-1000.slice/session-1.scope" }),
    });
    expect(a.state().available).toBe(false);
  });
});

describe("makeCgroupHygieneAssertion — allowlist", () => {
  it("never flags the bridge's own pid", async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ procs: [100] }),
      emit: (e, p) => events.push([e, p]),
    });
    expect(await a.check()).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it("allowlists transient sudo→spawn-scope→systemd-run wrappers under grace", async () => {
    const byPid = new Map<number, FakeProc>([
      [200, { pid: 200, comm: "sudo", cmdline: "sudo -n /usr/local/bin/ellul-spawn-scope ...", ageMs: 50 }],
      [201, { pid: 201, comm: "bash", cmdline: "bash /usr/local/bin/ellul-spawn-scope ...", ageMs: 80 }],
      [202, { pid: 202, comm: "systemd-run", cmdline: "systemd-run --scope ...", ageMs: 150 }],
    ]);
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ procs: [100, 200, 201, 202], byPid }),
    });
    expect(await a.check()).toEqual([]);
  });

  it("flags transient wrappers that exceed the grace window", async () => {
    const byPid = new Map<number, FakeProc>([
      [200, { pid: 200, comm: "sudo", cmdline: "sudo /usr/local/bin/ellul-spawn-scope ...", ageMs: 5_000 }],
    ]);
    const events: Array<[string, Record<string, unknown>]> = [];
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      transientWrapperGraceMs: 2_000,
      procFs: makeFakeProcFs({ procs: [100, 200], byPid }),
      emit: (e, p) => events.push([e, p]),
    });
    const v = await a.check();
    expect(v).toHaveLength(1);
    expect(v[0]?.pid).toBe(200);
    expect(events[0]?.[0]).toBe("bridge.cgroup.violation");
  });

  it("flags processes whose comm is in the wrapper set but cmdline doesn't reference spawn-scope", async () => {
    const byPid = new Map<number, FakeProc>([
      [200, { pid: 200, comm: "bash", cmdline: "bash -c 'cat /etc/passwd'", ageMs: 10 }],
    ]);
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ procs: [100, 200], byPid }),
      emit: () => {},
    });
    const v = await a.check();
    expect(v).toHaveLength(1);
    expect(v[0]?.pid).toBe(200);
  });
});

describe("makeCgroupHygieneAssertion — severity escalation", () => {
  it("emits WARN on first detection, CRITICAL when sustained past threshold", async () => {
    const byPid = new Map<number, FakeProc>([
      [300, { pid: 300, comm: "opencode", cmdline: "/usr/local/libexec/ellul/opencode serve --hostname=127.0.0.1", ageMs: 60_000 }],
    ]);
    let nowVal = 1_000_000;
    const events: Array<[string, Record<string, unknown>]> = [];
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      sustainedThresholdMs: 30_000,
      procFs: makeFakeProcFs({ procs: [100, 300], byPid }),
      emit: (e, p) => events.push([e, p]),
      now: () => nowVal,
    });

    // Tick 1: first sighting → WARN.
    let v = await a.check();
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("warn");
    expect(events[0]?.[1].severity).toBe("warn");

    // Tick 2 at +10s — still WARN (not yet sustained).
    nowVal += 10_000;
    v = await a.check();
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("warn");

    // Tick 3 at +35s total — escalate to CRITICAL.
    nowVal += 25_000;
    v = await a.check();
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("critical");
    expect(events[2]?.[1].severity).toBe("critical");
  });

  it("clears the firstSeen tracker when a violator pid drops out of the cgroup", async () => {
    const byPid = new Map<number, FakeProc>([
      [300, { pid: 300, comm: "opencode", cmdline: "opencode serve", ageMs: 60_000 }],
    ]);
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ procs: [100, 300], byPid }),
      emit: () => {},
    });
    await a.check();
    expect(a.state().trackedViolatorPids).toEqual([300]);

    const a2 = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ procs: [100], byPid }),
      emit: () => {},
    });
    await a2.check();
    expect(a2.state().trackedViolatorPids).toEqual([]);
  });
});

describe("makeCgroupHygieneAssertion — rate limiting + payload shape", () => {
  it("caps emitted violations per check at the configured max", async () => {
    const byPid = new Map<number, FakeProc>();
    const procs: number[] = [];
    for (let i = 0; i < 100; i++) {
      const pid = 1000 + i;
      procs.push(pid);
      byPid.set(pid, { pid, comm: "evil", cmdline: "evil --do-things", ageMs: 60_000 });
    }
    const events: Array<[string, Record<string, unknown>]> = [];
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      maxViolationsPerCheck: 8,
      procFs: makeFakeProcFs({ procs, byPid }),
      emit: (e, p) => events.push([e, p]),
    });
    const v = await a.check();
    expect(v).toHaveLength(8);
    expect(events).toHaveLength(8);
  });

  it("includes pid, comm, cmdline, ageMs, severity, sustainedMs in the event payload", async () => {
    const byPid = new Map<number, FakeProc>([
      [300, { pid: 300, comm: "opencode", cmdline: "opencode serve --port=42131", ageMs: 12_345 }],
    ]);
    const events: Array<[string, Record<string, unknown>]> = [];
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ procs: [100, 300], byPid }),
      emit: (e, p) => events.push([e, p]),
      now: () => 5_000_000,
    });
    await a.check();
    const [name, payload] = events[0]!;
    expect(name).toBe("bridge.cgroup.violation");
    expect(payload.pid).toBe(300);
    expect(payload.comm).toBe("opencode");
    expect(payload.cmdline).toBe("opencode serve --port=42131");
    expect(payload.ageMs).toBe(12_345);
    expect(payload.firstSeenAt).toBe(5_000_000);
    expect(payload.sustainedMs).toBe(0);
    expect(payload.severity).toBe("warn");
    expect(typeof payload.cgroupAbsolutePath).toBe("string");
  });

  it("counts emitted violations into state for monitoring", async () => {
    const byPid = new Map<number, FakeProc>([
      [300, { pid: 300, comm: "x", cmdline: "x", ageMs: 60_000 }],
    ]);
    const a = makeCgroupHygieneAssertion({
      bridgePid: 100,
      procFs: makeFakeProcFs({ procs: [100, 300], byPid }),
      emit: () => {},
    });
    await a.check();
    await a.check();
    await a.check();
    expect(a.state().violationsEmittedSinceBoot).toBe(3);
  });
});
