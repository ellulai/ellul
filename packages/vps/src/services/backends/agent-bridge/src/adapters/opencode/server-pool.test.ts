// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Unit tests for OpenCodeServerPool.
//
// All tests run with a stub OpenCodeRuntime — no real `opencode serve`
// process is spawned. The stub gives the test deterministic control
// over when each "spawn" succeeds, what URL it returns, and when its
// `exitCode` resolves (simulated crash).
//
// Coverage:
//   - Concurrent acquires for the same project spawn exactly one server.
//   - refCount lifecycle: release → idleSince set on drop to 0;
//     sweepIdle past TTL evicts; sweepIdle within TTL retains;
//     sweepIdle never evicts entries with refCount > 0.
//   - Cross-project isolation: separate projects produce separate
//     entries.
//   - Crash path: simulated server exit fires session callbacks and
//     removes the entry; subsequent acquire spawns fresh with bumped
//     generation.
//   - Validation: cwd that doesn't contain the requested sandbox id
//     fails acquire; spawn errors propagate without registering an entry.

import { describe, it, expect } from "vitest";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Ref } from "effect";

import { OpenCodeRuntime, OpenCodeRuntimeError, type OpenCodeRuntimeShape } from "./runtime";
import { OpenCodeServerPool, OpenCodeServerPoolLive } from "./server-pool";

interface StubServer {
  readonly url: string;
  readonly pid: number;
  readonly exitDeferred: Deferred.Deferred<number, never>;
  spawnCount: number;
}

interface StubControl {
  readonly layer: Layer.Layer<OpenCodeRuntime>;
  readonly stubsByProject: Map<string, StubServer>;
  readonly getTotalSpawns: () => number;
  readonly nextSpawnShouldFail: (project: string, message: string) => void;
}

const makeStubRuntime = (): StubControl => {
  const stubsByProject = new Map<string, StubServer>();
  const failureQueue = new Map<string, Array<string>>();
  let totalSpawns = 0;

  const stub: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: (input) =>
      Effect.gen(function* () {
        const project = input.additionalEnv?.["ELLUL_NS_PROJECT"] ?? "unknown";
        totalSpawns += 1;
        const queuedFailure = failureQueue.get(project)?.shift();
        if (queuedFailure) {
          return yield* Effect.fail(
            new OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              detail: queuedFailure,
            }),
          );
        }
        const exitDeferred = yield* Deferred.make<number, never>();
        const stubServer: StubServer = {
          url: `http://127.0.0.1:${10000 + (stubsByProject.size + 1)}`,
          pid: 50000 + stubsByProject.size + 1,
          exitDeferred,
          spawnCount: (stubsByProject.get(project)?.spawnCount ?? 0) + 1,
        };
        stubsByProject.set(project, stubServer);
        return {
          url: stubServer.url,
          pid: stubServer.pid,
          exitCode: Deferred.await(exitDeferred),
        };
      }),
    connectToOpenCodeServer: () =>
      Effect.die("connectToOpenCodeServer should not be called by the pool"),
    runOpenCodeCommand: () =>
      Effect.die("runOpenCodeCommand should not be called by the pool"),
    createOpenCodeSdkClient: () => ({}) as never,
    loadOpenCodeInventory: () =>
      Effect.die("loadOpenCodeInventory should not be called by the pool"),
  };

  return {
    layer: Layer.succeed(OpenCodeRuntime, stub),
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

const makePoolHarness = () => {
  const stub = makeStubRuntime();
  const layer = OpenCodeServerPoolLive.pipe(Layer.provide(stub.layer));
  // ManagedRuntime keeps the layer scope open across multiple runPromise
  // calls — exactly what we need to share one pool instance across the
  // test's assertions.
  const runtime = ManagedRuntime.make(layer);
  const acquire = (input: {
    readonly project: string;
    readonly cwd: string;
    readonly sessionId: string;
    readonly onCrash?: (reason: string) => Effect.Effect<void, never>;
  }) =>
    runtime.runPromise(
      Effect.flatMap(Effect.service(OpenCodeServerPool), (pool) =>
        pool.acquire({
          project: input.project,
          binaryPath: "/usr/local/bin/opencode",
          cwd: input.cwd,
          sessionId: input.sessionId,
          onCrash: input.onCrash ?? noopCrash,
        }),
      ),
    );
  const acquireExit = (input: {
    readonly project: string;
    readonly cwd: string;
    readonly sessionId: string;
    readonly onCrash?: (reason: string) => Effect.Effect<void, never>;
  }) =>
    runtime.runPromiseExit(
      Effect.flatMap(Effect.service(OpenCodeServerPool), (pool) =>
        pool.acquire({
          project: input.project,
          binaryPath: "/usr/local/bin/opencode",
          cwd: input.cwd,
          sessionId: input.sessionId,
          onCrash: input.onCrash ?? noopCrash,
        }),
      ),
    );
  const release = (input: { readonly project: string; readonly sessionId: string }) =>
    runtime.runPromise(
      Effect.flatMap(Effect.service(OpenCodeServerPool), (pool) => pool.release(input)),
    );
  const sweepIdle = (ttl: number) =>
    runtime.runPromise(
      Effect.flatMap(Effect.service(OpenCodeServerPool), (pool) => pool.sweepIdle(ttl)),
    );
  const listEntries = () =>
    runtime.runPromise(
      Effect.flatMap(Effect.service(OpenCodeServerPool), (pool) => pool.listEntries),
    );
  const concurrentAcquires = (
    inputs: ReadonlyArray<{
      readonly project: string;
      readonly cwd: string;
      readonly sessionId: string;
      readonly onCrash?: (reason: string) => Effect.Effect<void, never>;
    }>,
  ) =>
    runtime.runPromise(
      Effect.flatMap(Effect.service(OpenCodeServerPool), (pool) =>
        Effect.all(
          inputs.map((input) =>
            pool.acquire({
              project: input.project,
              binaryPath: "/usr/local/bin/opencode",
              cwd: input.cwd,
              sessionId: input.sessionId,
              onCrash: input.onCrash ?? noopCrash,
            }),
          ),
          { concurrency: "unbounded" },
        ),
      ),
    );
  return {
    runtime,
    stub,
    acquire,
    acquireExit,
    release,
    sweepIdle,
    listEntries,
    concurrentAcquires,
    teardown: () => runtime.dispose(),
  };
};

describe("OpenCodeServerPool", () => {
  it("spawns at most one server for concurrent acquires of the same project", async () => {
    const harness = makePoolHarness();
    try {
      const inputs = Array.from({ length: 10 }).map((_, i) => ({
        project: PROJECT_A,
        cwd: CWD_A,
        sessionId: `s-${i}`,
      }));
      const results = await harness.concurrentAcquires(inputs);
      expect(harness.stub.getTotalSpawns()).toBe(1);
      const urls = new Set(results.map((r) => r.url));
      expect(urls.size).toBe(1);
      expect(new Set(results.map((r) => r.generation))).toEqual(new Set([1]));

      const entries = await harness.listEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.refCount).toBe(10);
      expect(entries[0]?.sessionCount).toBe(10);
    } finally {
      await harness.teardown();
    }
  });

  it("spawns one server per project and keeps them isolated", async () => {
    const harness = makePoolHarness();
    try {
      await harness.concurrentAcquires([
        { project: PROJECT_A, cwd: CWD_A, sessionId: "a-1" },
        { project: PROJECT_A, cwd: CWD_A, sessionId: "a-2" },
        { project: PROJECT_A, cwd: CWD_A, sessionId: "a-3" },
        { project: PROJECT_B, cwd: CWD_B, sessionId: "b-1" },
        { project: PROJECT_B, cwd: CWD_B, sessionId: "b-2" },
      ]);
      expect(harness.stub.getTotalSpawns()).toBe(2);
      const entries = (await harness.listEntries())
        .slice()
        .sort((a, b) => a.project.localeCompare(b.project));
      expect(entries.map((e) => e.project)).toEqual([PROJECT_A, PROJECT_B]);
      expect(entries[0]?.refCount).toBe(3);
      expect(entries[1]?.refCount).toBe(2);
    } finally {
      await harness.teardown();
    }
  });

  it("release decrements refCount; idleSince fires only at refCount===0", async () => {
    const harness = makePoolHarness();
    try {
      await harness.concurrentAcquires([
        { project: PROJECT_A, cwd: CWD_A, sessionId: "s1" },
        { project: PROJECT_A, cwd: CWD_A, sessionId: "s2" },
      ]);
      let entries = await harness.listEntries();
      expect(entries[0]?.refCount).toBe(2);
      expect(entries[0]?.idleSince).toBeNull();

      await harness.release({ project: PROJECT_A, sessionId: "s1" });
      entries = await harness.listEntries();
      expect(entries[0]?.refCount).toBe(1);
      expect(entries[0]?.idleSince).toBeNull();

      await harness.release({ project: PROJECT_A, sessionId: "s2" });
      entries = await harness.listEntries();
      expect(entries[0]?.refCount).toBe(0);
      expect(entries[0]?.idleSince).not.toBeNull();
      // Server is NOT killed yet — sweepIdle handles that.
      expect(harness.stub.getTotalSpawns()).toBe(1);
    } finally {
      await harness.teardown();
    }
  });

  it("sweepIdle past TTL evicts; within TTL retains", async () => {
    const harness = makePoolHarness();
    try {
      await harness.acquire({ project: PROJECT_A, cwd: CWD_A, sessionId: "s1" });
      await harness.release({ project: PROJECT_A, sessionId: "s1" });

      const sweepRetain = await harness.sweepIdle(10 * 60 * 1000);
      expect(sweepRetain.evicted).toBe(0);
      expect(sweepRetain.retained).toBe(1);
      let entries = await harness.listEntries();
      expect(entries).toHaveLength(1);

      const sweepEvict = await harness.sweepIdle(0);
      expect(sweepEvict.evicted).toBe(1);
      expect(sweepEvict.retained).toBe(0);
      entries = await harness.listEntries();
      expect(entries).toHaveLength(0);
    } finally {
      await harness.teardown();
    }
  });

  it("sweepIdle skips entries with refCount > 0", async () => {
    const harness = makePoolHarness();
    try {
      await harness.acquire({ project: PROJECT_A, cwd: CWD_A, sessionId: "s1" });
      const sweep = await harness.sweepIdle(0);
      expect(sweep.evicted).toBe(0);
      expect(sweep.retained).toBe(1);
      const entries = await harness.listEntries();
      expect(entries[0]?.refCount).toBe(1);
    } finally {
      await harness.teardown();
    }
  });

  it("crash fires onCrash callbacks and removes the entry", async () => {
    const harness = makePoolHarness();
    try {
      const callbackCount = await harness.runtime.runPromise(Ref.make(0));
      const reasonsRef = await harness.runtime.runPromise(Ref.make<Array<string>>([]));
      // Deterministic wait: each callback signals its own Deferred. Two
      // sessions ⇒ two Deferreds. We then await both. Avoids the racy
      // setImmediate flushing pattern that masks real timing bugs.
      const fired1 = await harness.runtime.runPromise(Deferred.make<void>());
      const fired2 = await harness.runtime.runPromise(Deferred.make<void>());
      const slots = [fired1, fired2];
      let nextSlot = 0;
      const crashCallback = (reason: string) =>
        Effect.gen(function* () {
          yield* Ref.update(callbackCount, (n) => n + 1);
          yield* Ref.update(reasonsRef, (xs) => [...xs, reason]);
          const slot = slots[nextSlot++];
          if (slot) yield* Deferred.succeed(slot, undefined);
        });

      await harness.concurrentAcquires([
        { project: PROJECT_A, cwd: CWD_A, sessionId: "s1", onCrash: crashCallback },
        { project: PROJECT_A, cwd: CWD_A, sessionId: "s2", onCrash: crashCallback },
      ]);

      const stub = harness.stub.stubsByProject.get(PROJECT_A);
      expect(stub).toBeTruthy();
      await harness.runtime.runPromise(Deferred.succeed(stub!.exitDeferred, 134));

      // Wait deterministically for BOTH callbacks. If the crash watcher
      // ever started serializing callbacks behind a broken mutex, this
      // would either hang (caught by vitest's testTimeout) or one of the
      // Deferreds would never fire.
      await harness.runtime.runPromise(
        Effect.all([Deferred.await(fired1), Deferred.await(fired2)]),
      );

      const callbacksFired = await harness.runtime.runPromise(Ref.get(callbackCount));
      expect(callbacksFired).toBe(2);
      const reasons = await harness.runtime.runPromise(Ref.get(reasonsRef));
      for (const reason of reasons) {
        expect(reason).toMatch(/exited unexpectedly/);
        expect(reason).toContain(PROJECT_A);
        expect(reason).toContain("134");
      }
      const entries = await harness.listEntries();
      expect(entries).toHaveLength(0);
    } finally {
      await harness.teardown();
    }
  });

  // REGRESSION: pre-fix the per-project mutex was held across crash
  // callbacks, and pool.release re-took the same mutex. Effect's
  // Semaphore is non-reentrant, so the adapter's real onCrash chain
  // (emitUnexpectedExit → releasePoolEntry → pool.release) would
  // deadlock the moment a server crashed in production. This test
  // makes the deadlock visible by having the callback do the same
  // thing the adapter does — call pool.release — and asserting the
  // chain completes within vitest's timeout.
  it("crash callback calling release must not deadlock", async () => {
    const harness = makePoolHarness();
    try {
      // Capture the live pool service so the callback can call release
      // directly (mirroring the closure capture the adapter does at
      // layer-build time).
      const pool = await harness.runtime.runPromise(Effect.service(OpenCodeServerPool));
      const releaseCompleted = await harness.runtime.runPromise(Deferred.make<void>());

      const crashCallback = () =>
        pool
          .release({ project: PROJECT_A, sessionId: "s1" })
          .pipe(
            Effect.tap(() => Deferred.succeed(releaseCompleted, undefined)),
            Effect.asVoid,
          );

      await harness.acquire({
        project: PROJECT_A,
        cwd: CWD_A,
        sessionId: "s1",
        onCrash: crashCallback,
      });

      const stub = harness.stub.stubsByProject.get(PROJECT_A);
      await harness.runtime.runPromise(Deferred.succeed(stub!.exitDeferred, 1));

      // If release re-took the per-project mutex, this await would hang
      // forever (until vitest's testTimeout). Passing it is the
      // assertion.
      await harness.runtime.runPromise(Deferred.await(releaseCompleted));
      expect(true).toBe(true);
    } finally {
      await harness.teardown();
    }
  });

  it("re-acquires after crash spawn a fresh server with bumped generation", async () => {
    const harness = makePoolHarness();
    try {
      const fired = await harness.runtime.runPromise(Deferred.make<void>());
      const onCrash = () =>
        Effect.flatMap(Deferred.succeed(fired, undefined), () => Effect.void);
      await harness.acquire({
        project: PROJECT_A,
        cwd: CWD_A,
        sessionId: "s1",
        onCrash,
      });
      const stub = harness.stub.stubsByProject.get(PROJECT_A);
      await harness.runtime.runPromise(Deferred.succeed(stub!.exitDeferred, 137));
      await harness.runtime.runPromise(Deferred.await(fired));

      const next = await harness.acquire({
        project: PROJECT_A,
        cwd: CWD_A,
        sessionId: "s1-recovered",
      });
      expect(next.generation).toBe(2);
      expect(harness.stub.getTotalSpawns()).toBe(2);
    } finally {
      await harness.teardown();
    }
  });

  // Defense-in-depth: the lock-free release path must remain safe under
  // concurrent acquires. Spawn one entry, then race a release against
  // five acquires for the same project. The session being released is
  // distinct from the acquired sessions; refCount must end equal to
  // (1 - 1) + 5 = 5.
  it("release runs concurrently with acquires without losing or double-counting refs", async () => {
    const harness = makePoolHarness();
    try {
      await harness.acquire({ project: PROJECT_A, cwd: CWD_A, sessionId: "owner" });
      const ops: Array<Promise<unknown>> = [
        harness.release({ project: PROJECT_A, sessionId: "owner" }),
        ...Array.from({ length: 5 }).map((_, i) =>
          harness.acquire({ project: PROJECT_A, cwd: CWD_A, sessionId: `s-${i}` }),
        ),
      ];
      await Promise.all(ops);
      const entries = await harness.listEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.refCount).toBe(5);
      expect(entries[0]?.sessionCount).toBe(5);
      // Still exactly one server — release/acquire interleaving must not
      // trigger a respawn.
      expect(harness.stub.getTotalSpawns()).toBe(1);
    } finally {
      await harness.teardown();
    }
  });

  it("rejects acquire when cwd's sandbox segment doesn't match the requested project", async () => {
    const harness = makePoolHarness();
    try {
      const result = await harness.acquireExit({
        project: PROJECT_A,
        cwd: CWD_B,
        sessionId: "evil-1",
      });
      expect(Exit.isFailure(result)).toBe(true);
      expect(harness.stub.getTotalSpawns()).toBe(0);
    } finally {
      await harness.teardown();
    }
  });

  it("rejects acquire when cwd has no sandbox segment", async () => {
    const harness = makePoolHarness();
    try {
      const result = await harness.acquireExit({
        project: PROJECT_A,
        cwd: "/home/dev/no-sandbox-here",
        sessionId: "weird-1",
      });
      expect(Exit.isFailure(result)).toBe(true);
    } finally {
      await harness.teardown();
    }
  });

  it("propagates spawn errors and does not register an entry", async () => {
    const harness = makePoolHarness();
    try {
      harness.stub.nextSpawnShouldFail(PROJECT_A, "synthetic spawn failure");
      const result = await harness.acquireExit({
        project: PROJECT_A,
        cwd: CWD_A,
        sessionId: "s1",
      });
      expect(Exit.isFailure(result)).toBe(true);
      const entries = await harness.listEntries();
      expect(entries).toHaveLength(0);
    } finally {
      await harness.teardown();
    }
  });
});
