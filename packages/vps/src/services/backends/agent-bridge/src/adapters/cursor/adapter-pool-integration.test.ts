// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Adapter ↔ pool integration: wire the REAL CursorAdapter to the REAL
// CursorAcpServerPool against a stubbed CursorAcpRuntimeFactory. Proves
// the wiring the unit tests can't:
//
//   - Three concurrent startSessions for the same project share ONE
//     spawned cursor-agent (the pool refCount climbs, spawn count
//     stays at 1).
//   - Two stopSessions decrement refCount; the third leaves the entry
//     idle but alive (cursor-agent process keeps running until
//     sweepIdle eviction).
//   - A simulated runtime crash drives the adapter's onCrash callback,
//     which emits `runtime.error` + `session.exited { recoverable:
//     true }` and removes the session — without deadlocking on the
//     pool's per-project mutex (lock-free release regression guard).
//   - startSession for a different project spawns a SECOND
//     cursor-agent.
//   - After a crash, a new startSession respawns with bumped generation.
//
// What this test does NOT cover (intentionally): namespace setup
// (`setupNamespace` is mocked via the factory boundary), full ACP
// semantics (newSession returns canned data), the seccomp/AppArmor
// floor (kernel-level, not testable from JS).

import { describe, it, expect, vi } from "vitest";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Path,
  Queue,
  Scope,
  Stream,
} from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";

import {
  CursorAdapter,
  CursorAdapterLive,
  CursorAcpRuntimeFactory,
  type CursorAcpRuntimeFactoryShape,
  CursorAcpServerPool,
  CursorAcpServerPoolLive,
} from "./index";
import type {
  AcpProjectRuntimeShape,
  AcpSessionHandle,
} from "./acp/AcpProjectRuntime";
import { defaultServerConfig, ServerConfig } from "../../shared/config";
import {
  makeStaticServerSettings,
  ServerSettingsService,
} from "../../shared/serverSettings";
import * as namespaceService from "../../application/namespace/NamespaceSpawn";

// setupNamespace touches the host filesystem on Linux; on darwin /
// in unit tests it'd throw. Mock it to a resolved no-op so the adapter
// can flow through to pool.acquire on any platform.
vi.spyOn(namespaceService, "setupNamespace").mockResolvedValue(undefined);

const PROJECT_A = "sbx-aaa1234";
const PROJECT_B = "sbx-bbb5678";
const CWD_A = `/home/dev/projects/${PROJECT_A}/app`;
const CWD_B = `/home/dev/projects/${PROJECT_B}/app`;

interface StubRuntimeHandle {
  readonly project: string;
  readonly pid: number;
  readonly exitDeferred: Deferred.Deferred<number, never>;
  // Accumulated session ids minted via newSession for this project.
  readonly sessionIds: Array<string>;
  // Marks each session id as closed when the handle's close fires.
  readonly closedSessionIds: Set<string>;
}

interface StubControl {
  readonly layer: Layer.Layer<CursorAcpRuntimeFactory>;
  readonly handlesByProject: Map<string, StubRuntimeHandle>;
  readonly getTotalSpawns: () => number;
}

const makeStubFactory = (): StubControl => {
  const handlesByProject = new Map<string, StubRuntimeHandle>();
  let totalSpawns = 0;
  let nextSessionSeq = 0;

  const stub: CursorAcpRuntimeFactoryShape = {
    spawnProjectRuntime: (input) =>
      Effect.gen(function* () {
        totalSpawns += 1;
        const exitDeferred = yield* Deferred.make<number, never>();
        const handle: StubRuntimeHandle = {
          project: input.project,
          pid: 50000 + handlesByProject.size + 1,
          exitDeferred,
          sessionIds: [],
          closedSessionIds: new Set(),
        };
        handlesByProject.set(input.project, handle);

        const eventQueueByName = new Map<string, Queue.Queue<never>>();

        const newSession: AcpProjectRuntimeShape["newSession"] = () =>
          Effect.gen(function* () {
            nextSessionSeq += 1;
            const sessionId = `sess-${input.project}-${nextSessionSeq}`;
            handle.sessionIds.push(sessionId);
            const eventQueue = yield* Queue.unbounded<never>();
            eventQueueByName.set(sessionId, eventQueue);
            const sessionHandle: AcpSessionHandle = {
              sessionId,
              initializeResult: { protocolVersion: 1 } as never,
              sessionSetupResult: {
                sessionId,
                configOptions: [],
              } as never,
              modelConfigId: undefined,
              handleRequestPermission: () => Effect.void,
              handleExtRequest: () => Effect.void,
              handleExtNotification: () => Effect.void,
              getEvents: () => Stream.fromQueue(eventQueue),
              getModeState: Effect.succeed(undefined),
              getConfigOptions: Effect.succeed([]),
              prompt: () => Effect.succeed({ stopReason: "end_turn" } as never),
              cancel: Effect.void,
              setMode: () => Effect.succeed({} as never),
              setConfigOption: () => Effect.succeed({ configOptions: [] } as never),
              setModel: () => Effect.void,
              close: Effect.gen(function* () {
                handle.closedSessionIds.add(sessionId);
                yield* Queue.shutdown(eventQueue).pipe(Effect.ignore);
              }),
            };
            return sessionHandle;
          });

        const fake: AcpProjectRuntimeShape = {
          initialize: Effect.succeed({ protocolVersion: 1 } as never),
          newSession,
          closeSession: () => Effect.void,
          listSessions: Effect.sync(() => [...handle.sessionIds]),
          exitCode: Deferred.await(exitDeferred),
          pid: handle.pid,
        };
        return fake;
      }),
  };

  return {
    layer: Layer.succeed(CursorAcpRuntimeFactory, stub),
    handlesByProject,
    getTotalSpawns: () => totalSpawns,
  };
};

const TestPlatformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  Path.layer,
  // Even though the cursor adapter no longer depends on
  // ChildProcessSpawner, the live AcpProjectRuntime factory does — but
  // the test factory stub shadows the live factory entirely, so the
  // spawner here is just a satisfied dep for any peripheral service
  // wiring the platform layer pulls in.
  NodeChildProcessSpawner.layer.pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(Path.layer),
  ),
  Layer.effect(ServerConfig, Effect.succeed(defaultServerConfig)),
  Layer.effect(ServerSettingsService, Effect.succeed(makeStaticServerSettings())),
);

interface AdapterHarness {
  readonly runtime: ManagedRuntime.ManagedRuntime<
    CursorAdapter | CursorAcpServerPool,
    never
  >;
  readonly stub: StubControl;
  readonly teardown: () => Promise<void>;
}

const makeAdapterHarness = (): AdapterHarness => {
  const stub = makeStubFactory();
  const layer = CursorAdapterLive.pipe(
    Layer.provideMerge(CursorAcpServerPoolLive),
    Layer.provide(stub.layer),
    Layer.provide(TestPlatformLayer),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    runtime,
    stub,
    teardown: () => runtime.dispose(),
  };
};

const startSessionFor = (
  harness: AdapterHarness,
  threadId: string,
  cwd: string,
) =>
  harness.runtime.runPromise(
    Effect.flatMap(Effect.service(CursorAdapter), (a) =>
      a.startSession({
        threadId: threadId as never,
        cwd: cwd as never,
        runtimeMode: "full-access",
      }),
    ),
  );

const stopSessionFor = (harness: AdapterHarness, threadId: string) =>
  harness.runtime.runPromise(
    Effect.flatMap(Effect.service(CursorAdapter), (a) =>
      a.stopSession(threadId as never),
    ),
  );

const listPoolEntries = (harness: AdapterHarness) =>
  harness.runtime.runPromise(
    Effect.flatMap(Effect.service(CursorAcpServerPool), (p) => p.listEntries),
  );


describe("CursorAdapter ↔ CursorAcpServerPool integration", () => {
  it("three startSessions for the same project share ONE pooled cursor-agent", async () => {
    const harness = makeAdapterHarness();
    try {
      await Promise.all([
        startSessionFor(harness, "thread-a", CWD_A),
        startSessionFor(harness, "thread-b", CWD_A),
        startSessionFor(harness, "thread-c", CWD_A),
      ]);

      expect(harness.stub.getTotalSpawns()).toBe(1);
      const entries = await listPoolEntries(harness);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.project).toBe(PROJECT_A);
      expect(entries[0]?.refCount).toBe(3);
      expect(entries[0]?.sessionCount).toBe(3);

      // Each thread got its own ACP session (multiplexed onto the
      // shared cursor-agent).
      const handle = harness.stub.handlesByProject.get(PROJECT_A);
      expect(handle?.sessionIds.length).toBe(3);
      expect(new Set(handle!.sessionIds).size).toBe(3);
    } finally {
      await harness.teardown();
    }
  });

  it("a startSession in a DIFFERENT project spawns a second cursor-agent", async () => {
    const harness = makeAdapterHarness();
    try {
      await Promise.all([
        startSessionFor(harness, "thread-a", CWD_A),
        startSessionFor(harness, "thread-b", CWD_A),
        startSessionFor(harness, "thread-x", CWD_B),
      ]);
      expect(harness.stub.getTotalSpawns()).toBe(2);
      const entries = (await listPoolEntries(harness))
        .slice()
        .sort((a, b) => a.project.localeCompare(b.project));
      expect(entries.map((e) => e.project)).toEqual([PROJECT_A, PROJECT_B]);
      expect(entries[0]?.refCount).toBe(2);
      expect(entries[1]?.refCount).toBe(1);
    } finally {
      await harness.teardown();
    }
  });

  it("stopSession releases the pool ref but keeps the cursor-agent warm until sweep", async () => {
    const harness = makeAdapterHarness();
    try {
      await Promise.all([
        startSessionFor(harness, "thread-a", CWD_A),
        startSessionFor(harness, "thread-b", CWD_A),
        startSessionFor(harness, "thread-c", CWD_A),
      ]);
      await stopSessionFor(harness, "thread-a");
      await stopSessionFor(harness, "thread-b");

      let entries = await listPoolEntries(harness);
      expect(entries[0]?.refCount).toBe(1);
      expect(entries[0]?.idleSince).toBeNull();
      expect(harness.stub.getTotalSpawns()).toBe(1);
      // Each stopped session called handle.close which marks it
      // closed via the stub.
      const handle = harness.stub.handlesByProject.get(PROJECT_A);
      expect(handle?.closedSessionIds.size).toBe(2);

      await stopSessionFor(harness, "thread-c");
      entries = await listPoolEntries(harness);
      expect(entries[0]?.refCount).toBe(0);
      expect(entries[0]?.idleSince).not.toBeNull();
      // cursor-agent still alive — pool waits for sweepIdle.
      expect(harness.stub.getTotalSpawns()).toBe(1);
      expect(handle?.closedSessionIds.size).toBe(3);
    } finally {
      await harness.teardown();
    }
  });

  // The end-to-end demo of the deadlock fix: in production the crash
  // chain is cursor-agent exit → pool teardown → adapter onCrash →
  // emitUnexpectedExit → releasePoolEntry → pool.release. Pre-fix,
  // pool.release re-acquired the per-project mutex held by the crash
  // watcher and the whole chain hung. Post-fix release is lock-free,
  // so the chain unwinds and the adapter cleanly emits both
  // runtime.error and session.exited { recoverable: true } AND removes
  // the session. If this test ever times out, the deadlock is back.
  it("simulated cursor-agent crash drives the adapter to emit recoverable runtime.error without deadlocking", async () => {
    const harness = makeAdapterHarness();
    try {
      // Start collecting events BEFORE we trigger work.
      const eventLog: Array<{ type: string; threadId: string; payload?: unknown }> = [];
      const collectorScope = Effect.runSync(Scope.make());
      await harness.runtime.runPromise(
        Effect.flatMap(Effect.service(CursorAdapter), (a) =>
          Stream.runForEach(a.streamEvents, (e) =>
            Effect.sync(() => {
              eventLog.push({
                type: e.type,
                threadId: e.threadId as unknown as string,
                payload: (e as unknown as { payload?: unknown }).payload,
              });
            }),
          ).pipe(Effect.forkIn(collectorScope), Effect.asVoid),
        ),
      );

      await Promise.all([
        startSessionFor(harness, "thread-a", CWD_A),
        startSessionFor(harness, "thread-b", CWD_A),
      ]);
      // Sanity: pool sees 2 refs.
      expect((await listPoolEntries(harness))[0]?.refCount).toBe(2);

      // Simulate the crash. The exit Deferred trips → pool's exit
      // watcher fires both onCrash callbacks → adapter's
      // emitUnexpectedExit chain runs for each session → pool.release
      // returns lock-free.
      const handle = harness.stub.handlesByProject.get(PROJECT_A);
      expect(handle).toBeTruthy();
      await harness.runtime.runPromise(Deferred.succeed(handle!.exitDeferred, 134));

      // Wait for the crash chain to settle.
      await new Promise((r) => setTimeout(r, 100));
      await Effect.runPromise(Scope.close(collectorScope, Exit.void));

      // Each affected thread must have a runtime.error AND a
      // session.exited { recoverable: true } in its event log.
      for (const tid of ["thread-a", "thread-b"] as const) {
        const runtimeError = eventLog.find(
          (e) => e.threadId === tid && e.type === "runtime.error",
        );
        const sessionExited = eventLog.find(
          (e) => e.threadId === tid && e.type === "session.exited",
        );
        expect(runtimeError, `thread=${tid} expected runtime.error`).toBeTruthy();
        expect(sessionExited, `thread=${tid} expected session.exited`).toBeTruthy();
        expect((sessionExited?.payload as { recoverable?: boolean })?.recoverable).toBe(true);
      }

      // Pool entry is gone after the crash.
      const entries = await listPoolEntries(harness);
      expect(entries).toHaveLength(0);
    } finally {
      await harness.teardown();
    }
  });

  it("after a crash, a new startSession respawns a fresh cursor-agent with bumped generation", async () => {
    const harness = makeAdapterHarness();
    try {
      await startSessionFor(harness, "thread-a", CWD_A);
      const handle = harness.stub.handlesByProject.get(PROJECT_A);
      await harness.runtime.runPromise(Deferred.succeed(handle!.exitDeferred, 137));
      // Allow the crash teardown chain to settle deterministically.
      await new Promise((r) => setTimeout(r, 50));

      // Recovery message: re-acquire and assert generation bumped.
      await startSessionFor(harness, "thread-a-recovered", CWD_A);
      expect(harness.stub.getTotalSpawns()).toBe(2);
      const entries = await listPoolEntries(harness);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.generation).toBe(2);
      expect(entries[0]?.refCount).toBe(1);
    } finally {
      await harness.teardown();
    }
  });
});
