// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Unit tests for CursorAcpServerPool.
//
// All tests run with a stub CursorAcpRuntimeFactory — no real
// `cursor-agent` process is spawned. The stub gives the test
// deterministic control over when each "spawn" succeeds, what fake
// runtime it returns, and when the runtime's `exitCode` resolves
// (simulated crash).
//
// Coverage mirrors opencode's server-pool.test.ts one-for-one:
//   - Concurrent acquires for the same project spawn exactly one runtime.
//   - Cross-project isolation: separate projects produce separate
//     entries.
//   - refCount lifecycle: release → idleSince set on drop to 0;
//     sweepIdle past TTL evicts; sweepIdle within TTL retains;
//     sweepIdle never evicts entries with refCount > 0.
//   - Crash path: simulated runtime exit fires session callbacks and
//     removes the entry; subsequent acquire spawns fresh with bumped
//     generation.
//   - Crash callback calling release must not deadlock (regression
//     guard for the opencode pool's per-project mutex bug).
//   - Validation: cwd that doesn't contain the requested sandbox id
//     fails acquire; spawn errors propagate without registering an
//     entry.

import { describe, it, expect } from "vitest";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Ref } from "effect";

import * as EffectAcpErrors from "../vendor/t3code/effect-acp/errors";
import {
  CursorAcpRuntimeFactory,
  type CursorAcpRuntimeFactoryShape,
  CursorAcpServerPool,
  CursorAcpServerPoolLive,
} from "./server-pool";
import type {
  AcpProjectRuntimeShape,
  AcpSessionHandle,
} from "./acp/AcpProjectRuntime";

interface StubRuntime {
  readonly project: string;
  readonly pid: number;
  readonly exitDeferred: Deferred.Deferred<number, never>;
  spawnCount: number;
}

interface StubControl {
  readonly layer: Layer.Layer<CursorAcpRuntimeFactory>;
  readonly stubsByProject: Map<string, StubRuntime>;
  readonly getTotalSpawns: () => number;
  readonly nextSpawnShouldFail: (project: string, message: string) => void;
}

const makeStubFactory = (): StubControl => {
  const stubsByProject = new Map<string, StubRuntime>();
  const failureQueue = new Map<string, Array<string>>();
  let totalSpawns = 0;

  const stub: CursorAcpRuntimeFactoryShape = {
    spawnProjectRuntime: (input) =>
      Effect.gen(function* () {
        totalSpawns += 1;
        const queuedFailure = failureQueue.get(input.project)?.shift();
        if (queuedFailure) {
          return yield* Effect.fail(
            new EffectAcpErrors.AcpTransportError({
              detail: queuedFailure,
              cause: new Error(queuedFailure),
            }),
          );
        }
        const exitDeferred = yield* Deferred.make<number, never>();
        const stubRuntime: StubRuntime = {
          project: input.project,
          pid: 50000 + stubsByProject.size + 1,
          exitDeferred,
          spawnCount: (stubsByProject.get(input.project)?.spawnCount ?? 0) + 1,
        };
        stubsByProject.set(input.project, stubRuntime);

        // Build a minimal AcpProjectRuntimeShape — only `pid` and
        // `exitCode` are touched by the pool; newSession is exercised by
        // adapter-level tests, not here.
        const fake: AcpProjectRuntimeShape = {
          initialize: Effect.fail(
            new EffectAcpErrors.AcpTransportError({
              detail: "stub: initialize never called by pool",
              cause: new Error("stub"),
            }),
          ) as never,
          newSession: () =>
            Effect.fail(
              new EffectAcpErrors.AcpTransportError({
                detail: "stub: newSession never called by server-pool unit tests",
                cause: new Error("stub"),
              }),
            ) as Effect.Effect<AcpSessionHandle, EffectAcpErrors.AcpError>,
          closeSession: () => Effect.void,
          listSessions: Effect.succeed([]),
          exitCode: Deferred.await(exitDeferred),
          pid: stubRuntime.pid,
        };
        return fake;
      }),
  };

  return {
    layer: Layer.succeed(CursorAcpRuntimeFactory, stub),
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

const STUB_CLIENT_INFO = { name: "ellul-test", version: "0.0.0" } as const;
const STUB_CURSOR_SETTINGS = {
  binaryPath: "/usr/local/bin/cursor-agent",
  apiEndpoint: "",
} as const;

const noopCrash = () => Effect.void;

const makePoolHarness = () => {
  const stub = makeStubFactory();
  const layer = CursorAcpServerPoolLive.pipe(Layer.provide(stub.layer));
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
      Effect.flatMap(Effect.service(CursorAcpServerPool), (pool) =>
        pool.acquire({
          project: input.project,
          cwd: input.cwd,
          sessionId: input.sessionId,
          cursorSettings: STUB_CURSOR_SETTINGS,
          clientInfo: STUB_CLIENT_INFO,
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
      Effect.flatMap(Effect.service(CursorAcpServerPool), (pool) =>
        pool.acquire({
          project: input.project,
          cwd: input.cwd,
          sessionId: input.sessionId,
          cursorSettings: STUB_CURSOR_SETTINGS,
          clientInfo: STUB_CLIENT_INFO,
          onCrash: input.onCrash ?? noopCrash,
        }),
      ),
    );
  const release = (input: { readonly project: string; readonly sessionId: string }) =>
    runtime.runPromise(
      Effect.flatMap(Effect.service(CursorAcpServerPool), (pool) => pool.release(input)),
    );
  const sweepIdle = (ttl: number) =>
    runtime.runPromise(
      Effect.flatMap(Effect.service(CursorAcpServerPool), (pool) => pool.sweepIdle(ttl)),
    );
  const listEntries = () =>
    runtime.runPromise(
      Effect.flatMap(Effect.service(CursorAcpServerPool), (pool) => pool.listEntries),
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
      Effect.flatMap(Effect.service(CursorAcpServerPool), (pool) =>
        Effect.all(
          inputs.map((input) =>
            pool.acquire({
              project: input.project,
              cwd: input.cwd,
              sessionId: input.sessionId,
              cursorSettings: STUB_CURSOR_SETTINGS,
              clientInfo: STUB_CLIENT_INFO,
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


describe("CursorAcpServerPool", () => {
  it("spawns at most one runtime for concurrent acquires of the same project", async () => {
    const harness = makePoolHarness();
    try {
      const inputs = Array.from({ length: 10 }).map((_, i) => ({
        project: PROJECT_A,
        cwd: CWD_A,
        sessionId: `s-${i}`,
      }));
      const results = await harness.concurrentAcquires(inputs);
      expect(harness.stub.getTotalSpawns()).toBe(1);
      const pids = new Set(results.map((r) => r.pid));
      expect(pids.size).toBe(1);
      expect(new Set(results.map((r) => r.generation))).toEqual(new Set([1]));

      const entries = await harness.listEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.refCount).toBe(10);
      expect(entries[0]?.sessionCount).toBe(10);
    } finally {
      await harness.teardown();
    }
  });

  it("spawns one runtime per project and keeps them isolated", async () => {
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
  // deadlock the moment a runtime crashed in production.
  it("crash callback calling release must not deadlock", async () => {
    const harness = makePoolHarness();
    try {
      const pool = await harness.runtime.runPromise(Effect.service(CursorAcpServerPool));
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

  it("re-acquires after crash spawn a fresh runtime with bumped generation", async () => {
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
