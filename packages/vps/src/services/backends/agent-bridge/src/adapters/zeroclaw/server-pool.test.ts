// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Unit tests for ZeroClawDaemonPool.
//
// All tests run with a stub ZeroClawRuntime — no real `zeroclaw daemon`
// process is spawned. The stub gives the test deterministic control
// over when each "spawn" succeeds, what URL/port it reports, and when
// its `exitCode` resolves (simulated crash).
//
// Coverage:
//   - Concurrent acquires for the same project spawn exactly one daemon.
//   - refCount lifecycle: release → idleSince set on drop to 0;
//     sweepIdle past TTL evicts; sweepIdle within TTL retains;
//     sweepIdle never evicts entries with refCount > 0.
//   - Cross-project isolation: separate projects produce separate entries.
//   - Crash path: simulated daemon exit fires session callbacks and
//     removes the entry; subsequent acquire spawns fresh with bumped
//     generation.
//   - forceEvict closes regardless of refCount.
//   - Validation: cwd that doesn't match the requested sandbox id fails
//     acquire; spawn errors propagate without registering an entry.
//   - Crash callback path does NOT deadlock when the callback re-enters
//     pool.release (Effect's Semaphore is not reentrant).
//
// The structural pattern (stub runtime + ManagedRuntime) mirrors
// opencode/server-pool.test.ts so failures here imply a regression
// against a known-good shape.

import { describe, expect, it } from "vitest";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Ref,
  Scope,
} from "effect";

import {
  ZeroClawRuntime,
  ZeroClawRuntimeError,
  type ZeroClawRuntimeShape,
  type ZeroClawDaemonProcess,
} from "./runtime";
import {
  ZeroClawDaemonPool,
  ZeroClawDaemonPoolLive,
} from "./server-pool";

interface StubDaemon {
  readonly url: string;
  readonly port: number;
  readonly hostAddress: string;
  readonly pid: number;
  readonly exitDeferred: Deferred.Deferred<number, never>;
  spawnCount: number;
}

interface StubControl {
  readonly layer: Layer.Layer<ZeroClawRuntime>;
  readonly stubsByProject: Map<string, StubDaemon>;
  readonly getTotalSpawns: () => number;
  readonly nextSpawnShouldFail: (project: string, message: string) => void;
}

const makeStubRuntime = (): StubControl => {
  const stubsByProject = new Map<string, StubDaemon>();
  const failureQueue = new Map<string, Array<string>>();
  let totalSpawns = 0;

  const stub: ZeroClawRuntimeShape = {
    startDaemon: (input) =>
      Effect.gen(function* () {
        totalSpawns += 1;
        const queuedFailure = failureQueue.get(input.project)?.shift();
        if (queuedFailure) {
          return yield* Effect.fail(
            new ZeroClawRuntimeError({
              operation: "startDaemon",
              detail: queuedFailure,
            }),
          );
        }
        const exitDeferred = yield* Deferred.make<number, never>();
        const stubServer: StubDaemon = {
          url: `http://${input.hostAddress}:${input.port}`,
          port: input.port,
          hostAddress: input.hostAddress,
          pid: 50_000 + stubsByProject.size + 1,
          exitDeferred,
          spawnCount: (stubsByProject.get(input.project)?.spawnCount ?? 0) + 1,
        };
        stubsByProject.set(input.project, stubServer);
        return {
          url: stubServer.url,
          hostAddress: stubServer.hostAddress,
          port: stubServer.port,
          pid: stubServer.pid,
          hasChannels: false,
          generation: input.generation,
          project: input.project,
          exitCode: Deferred.await(exitDeferred),
        } satisfies ZeroClawDaemonProcess;
      }),
    sendOnSession: () =>
      Effect.die("sendOnSession should not be called from pool tests"),
    checkBinaryHealth: Effect.succeed(true),
  };

  return {
    layer: Layer.succeed(ZeroClawRuntime, stub),
    stubsByProject,
    getTotalSpawns: () => totalSpawns,
    nextSpawnShouldFail: (project, message) => {
      const queue = failureQueue.get(project) ?? [];
      queue.push(message);
      failureQueue.set(project, queue);
    },
  };
};

const PROJECT_A = "sbx-aaa1234";
const PROJECT_B = "sbx-bbb5678";
const CWD_A = `/home/dev/projects/${PROJECT_A}/app`;
const CWD_B = `/home/dev/projects/${PROJECT_B}/app`;

const noopCrash = () => Effect.void;

const buildRuntime = (control: StubControl) => {
  const layer = ZeroClawDaemonPoolLive.pipe(Layer.provide(control.layer));
  return ManagedRuntime.make(layer);
};

describe("ZeroClawDaemonPool — acquire / release", () => {
  it("acquires a fresh entry on first call and reuses on second", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      const first = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
        }),
      );
      const second = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s2",
            onCrash: noopCrash,
          });
        }),
      );
      expect(first.generation).toBe(1);
      expect(second.generation).toBe(1);
      expect(first.daemon.url).toBe(second.daemon.url);
      expect(control.getTotalSpawns()).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("two concurrent acquires for the same project spawn exactly one daemon", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      const [a, b] = await Promise.all([
        runtime.runPromise(
          Effect.gen(function* () {
            const pool = yield* ZeroClawDaemonPool;
            return yield* pool.acquire({
              project: PROJECT_A,
              cwd: CWD_A,
              sessionId: "s1",
              onCrash: noopCrash,
            });
          }),
        ),
        runtime.runPromise(
          Effect.gen(function* () {
            const pool = yield* ZeroClawDaemonPool;
            return yield* pool.acquire({
              project: PROJECT_A,
              cwd: CWD_A,
              sessionId: "s2",
              onCrash: noopCrash,
            });
          }),
        ),
      ]);
      expect(a.daemon.url).toBe(b.daemon.url);
      expect(control.getTotalSpawns()).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("acquires a separate daemon for a different project", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      const a = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
        }),
      );
      const b = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_B,
            cwd: CWD_B,
            sessionId: "s1",
            onCrash: noopCrash,
          });
        }),
      );
      expect(a.daemon.url).not.toBe(b.daemon.url);
      expect(a.daemon.port).not.toBe(b.daemon.port);
      expect(control.getTotalSpawns()).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects acquire when cwd's sandbox id mismatches the requested project", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_B, // wrong project
            sessionId: "s1",
            onCrash: noopCrash,
          });
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(control.getTotalSpawns()).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("propagates spawn failures without registering an entry", async () => {
    const control = makeStubRuntime();
    control.nextSpawnShouldFail(PROJECT_A, "binary not found");
    const runtime = buildRuntime(control);
    try {
      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);

      // Next acquire should retry — entry was never registered.
      const ok = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
        }),
      );
      expect(ok.generation).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("ZeroClawDaemonPool — sweepIdle", () => {
  it("evicts an entry whose refCount has been zero past the TTL", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
          yield* pool.release({ project: PROJECT_A, sessionId: "s1" });
        }),
      );
      // Force-evict everything with idle ≥ 0ms.
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.sweepIdle(0);
        }),
      );
      expect(result.evicted).toBe(1);
      expect(result.retained).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("never evicts entries that still have refCount > 0", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
          // No release — refCount stays at 1.
        }),
      );
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.sweepIdle(0);
        }),
      );
      expect(result.evicted).toBe(0);
      expect(result.retained).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("retains idle entries inside the TTL window", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
          yield* pool.release({ project: PROJECT_A, sessionId: "s1" });
        }),
      );
      // 60-second TTL; idleSince was just set, so nothing should evict.
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.sweepIdle(60_000);
        }),
      );
      expect(result.evicted).toBe(0);
      expect(result.retained).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("ZeroClawDaemonPool — crash recovery", () => {
  it("fires registered onCrash callbacks and removes the entry", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      const reasonRef = await runtime.runPromise(Ref.make<string | null>(null));
      await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: (reason) => Ref.set(reasonRef, reason),
          });
        }),
      );

      // Trip the simulated crash by completing the daemon's exitDeferred.
      const stub = control.stubsByProject.get(PROJECT_A);
      expect(stub).toBeDefined();
      await runtime.runPromise(Deferred.succeed(stub!.exitDeferred, 137));

      // Give the watcher fiber a tick to process the exit.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const reason = await runtime.runPromise(Ref.get(reasonRef));
      expect(reason).toContain("ZeroClaw daemon exited unexpectedly");
      expect(reason).toContain("code=137");

      // Subsequent acquire spawns fresh — generation N+1, total spawns 2.
      const fresh = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s2",
            onCrash: noopCrash,
          });
        }),
      );
      expect(fresh.generation).toBe(2);
      expect(control.getTotalSpawns()).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("crash callback that calls release does NOT deadlock on the project mutex", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      const releasedRef = await runtime.runPromise(Ref.make(false));
      await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: () =>
              Effect.gen(function* () {
                // The adapter's onCrash chains into pool.release. If
                // release re-took the project mutex held by the crash
                // watcher, this would block forever (Effect's Semaphore
                // is not reentrant). The pool's release path is
                // intentionally lock-free for exactly this reason.
                yield* pool.release({ project: PROJECT_A, sessionId: "s1" });
                yield* Ref.set(releasedRef, true);
              }),
          });
        }),
      );

      const stub = control.stubsByProject.get(PROJECT_A)!;
      await runtime.runPromise(Deferred.succeed(stub.exitDeferred, 1));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const released = await runtime.runPromise(Ref.get(releasedRef));
      expect(released).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("ZeroClawDaemonPool — forceEvict", () => {
  it("closes an entry regardless of refCount and notifies sessions", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      const reasonRef = await runtime.runPromise(Ref.make<string | null>(null));
      await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: (reason) => Ref.set(reasonRef, reason),
          });
          // refCount > 0: sweepIdle would skip. forceEvict must NOT.
          const fired = yield* pool.forceEvict({
            project: PROJECT_A,
            reason: "operator restart for test",
          });
          expect(fired).toBe(1);
        }),
      );

      const reason = await runtime.runPromise(Ref.get(reasonRef));
      expect(reason).toBe("operator restart for test");

      // Next acquire spawns fresh.
      const fresh = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s2",
            onCrash: noopCrash,
          });
        }),
      );
      expect(fresh.generation).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("ZeroClawDaemonPool — EADDRINUSE regression guard", () => {
  // The original bug (2026-04-27): the pre-pool implementation deleted
  // an entry from the in-memory map and released its port number from
  // the `usedPorts` Set, but never killed the OS process. The next
  // spawn would allocate the same port and fail to bind because the
  // dead-from-the-bridge's-perspective process was still alive and
  // listening. The daemon would log
  // `Daemon component 'gateway' failed: Address already in use`
  // every 8 seconds forever.
  //
  // The pool architecture makes this structurally impossible: the
  // entry's scope owns the runtime.startDaemon call AND the port
  // release finalizer. tearDownEntryLocked closes the scope, which
  // fires runtime.startDaemon's kill finalizer + the port-release
  // finalizer atomically. There's no path that releases the port
  // without also killing the process.
  //
  // These tests prove that property end-to-end with the stub runtime.

  it("crash releases the port — next acquire can re-allocate from the freed range", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      const first = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
        }),
      );
      const firstPort = first.daemon.port;

      // Crash daemon A.
      const stub = control.stubsByProject.get(PROJECT_A)!;
      await runtime.runPromise(Deferred.succeed(stub.exitDeferred, 137));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Acquire again — pool should be able to allocate the SAME port
      // because the crash finalizer released it. (If the bug regressed,
      // the port would still be in `usedPorts` and the allocator would
      // skip it; with only one project active, that means we'd see
      // port=firstPort+1 instead of firstPort.)
      const second = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s2",
            onCrash: noopCrash,
          });
        }),
      );
      expect(second.daemon.port).toBe(firstPort);
      expect(second.generation).toBe(2);
      expect(control.getTotalSpawns()).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("100 sequential crash+respawn cycles do not exhaust the port range", async () => {
    // The port range is [18800, 18899] — 100 ports. If the crash path
    // ever leaked a port allocation (the original bug shape), this
    // loop would exhaust the range and allocatePort would throw.
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      for (let i = 0; i < 100; i++) {
        await runtime.runPromise(
          Effect.gen(function* () {
            const pool = yield* ZeroClawDaemonPool;
            yield* pool.acquire({
              project: PROJECT_A,
              cwd: CWD_A,
              sessionId: `s-${i}`,
              onCrash: noopCrash,
            });
          }),
        );
        const stub = control.stubsByProject.get(PROJECT_A)!;
        await runtime.runPromise(Deferred.succeed(stub.exitDeferred, 1));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // 101st acquire still works — proves the allocator hasn't
      // leaked any ports.
      const final = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s-final",
            onCrash: noopCrash,
          });
        }),
      );
      expect(final.daemon.port).toBeGreaterThanOrEqual(18800);
      expect(final.daemon.port).toBeLessThanOrEqual(18899);
      expect(final.generation).toBe(101);
    } finally {
      await runtime.dispose();
    }
  });

  it("forceEvict releases the port even though refCount > 0", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      const first = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
        }),
      );
      const firstPort = first.daemon.port;

      await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          yield* pool.forceEvict({
            project: PROJECT_A,
            reason: "test",
          });
        }),
      );

      // Port must be reusable on next acquire. If forceEvict's
      // tearDown skipped the scope finalizer, the port would still
      // be marked allocated and the next entry would get a different one.
      const second = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s2",
            onCrash: noopCrash,
          });
        }),
      );
      expect(second.daemon.port).toBe(firstPort);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("ZeroClawDaemonPool — listEntries", () => {
  it("reports active entries with refCount, generation, and pid", async () => {
    const control = makeStubRuntime();
    const runtime = buildRuntime(control);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          yield* pool.acquire({
            project: PROJECT_A,
            cwd: CWD_A,
            sessionId: "s1",
            onCrash: noopCrash,
          });
        }),
      );
      const entries = await runtime.runPromise(
        Effect.gen(function* () {
          const pool = yield* ZeroClawDaemonPool;
          return yield* pool.listEntries;
        }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.project).toBe(PROJECT_A);
      expect(entries[0]?.refCount).toBe(1);
      expect(entries[0]?.generation).toBe(1);
      expect(entries[0]?.pid).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  });
});
