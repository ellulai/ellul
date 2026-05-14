// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Adapter ↔ pool integration: wire the REAL OpenCodeAdapter to the
// REAL OpenCodeServerPool against a stubbed OpenCodeRuntime + stubbed
// SDK client. Proves the wiring the unit tests can't:
//
//   - Three concurrent startSessions for the same project share ONE
//     spawned server (the pool refCount climbs, spawn count stays at 1).
//   - Two stopSessions decrement refCount; the third leaves the entry
//     idle but alive.
//   - A simulated server crash drives the adapter's onCrash callback,
//     which emits `runtime.error` + `session.exited { recoverable: true }`
//     and removes the session — without deadlocking on the pool's
//     per-project mutex (this would have hung pre lock-free release).
//   - startSession for a different project spawns a SECOND server.
//
// What this test does NOT cover (intentionally): namespace setup
// (`setupNamespace` is a no-op on darwin), full SDK semantics
// (session.create returns canned data), the seccomp/AppArmor floor
// (kernel-level, not testable from JS).

import { describe, it, expect } from "vitest";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Path,
  Ref,
  Scope,
  Stream,
} from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  OpenCodeAdapter,
  OpenCodeAdapterLive,
  OpenCodeRuntime,
  OpenCodeServerPool,
  OpenCodeServerPoolLive,
  type OpenCodeRuntimeShape,
} from "./index";
import { defaultServerConfig, ServerConfig } from "../../shared/config";
import {
  makeStaticServerSettings,
  ServerSettingsService,
} from "../../shared/serverSettings";

const PROJECT_A = "sbx-aaa1234";
const PROJECT_B = "sbx-bbb5678";
const CWD_A = `/home/dev/projects/${PROJECT_A}/app`;
const CWD_B = `/home/dev/projects/${PROJECT_B}/app`;

interface StubServerHandle {
  readonly url: string;
  readonly pid: number;
  readonly exitDeferred: Deferred.Deferred<number, never>;
  // Fired when the SDK's event.subscribe abort signal is tripped (i.e.
  // the adapter is tearing the subscription down). Lets the test detect
  // graceful teardown without polling.
  readonly subscriptionAborted: Deferred.Deferred<void, never>;
}

interface StubControl {
  readonly layer: Layer.Layer<OpenCodeRuntime>;
  readonly handlesByProject: Map<string, StubServerHandle>;
  readonly getTotalSpawns: () => number;
  // Counter of session.create / session.abort calls per project, so we
  // can assert the SDK calls happen against the right server.
  readonly sessionCreates: () => Array<{ readonly project: string; readonly id: string }>;
  readonly sessionAborts: () => Array<{ readonly project: string; readonly id: string }>;
}

function makeStubRuntime(): StubControl {
  const handlesByProject = new Map<string, StubServerHandle>();
  // Reverse lookup: SDK client back to the project it belongs to. The
  // stub's createOpenCodeSdkClient receives just baseUrl/directory, so
  // we tag clients by URL → project via this map.
  const projectByBaseUrl = new Map<string, string>();
  let totalSpawns = 0;
  const creates: Array<{ project: string; id: string }> = [];
  const aborts: Array<{ project: string; id: string }> = [];
  let nextSessionSeq = 0;

  const stub: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: (input) =>
      Effect.gen(function* () {
        const project = input.additionalEnv?.["ELLUL_NS_PROJECT"] ?? "unknown";
        totalSpawns += 1;
        const exitDeferred = yield* Deferred.make<number, never>();
        const subscriptionAborted = yield* Deferred.make<void, never>();
        const handle: StubServerHandle = {
          url: `http://127.0.0.1:${10000 + handlesByProject.size + 1}`,
          pid: 50000 + handlesByProject.size + 1,
          exitDeferred,
          subscriptionAborted,
        };
        handlesByProject.set(project, handle);
        projectByBaseUrl.set(handle.url, project);
        return {
          url: handle.url,
          pid: handle.pid,
          exitCode: Deferred.await(exitDeferred),
        };
      }),
    connectToOpenCodeServer: () =>
      Effect.die("connectToOpenCodeServer should not be called by the adapter under the pool"),
    runOpenCodeCommand: () =>
      Effect.die("runOpenCodeCommand is not exercised by startSession"),
    createOpenCodeSdkClient: (input) => {
      // The adapter calls this with the URL the pool returned. Map it
      // back to the owning project so session.create / abort assertions
      // can attribute calls correctly.
      const project = projectByBaseUrl.get(input.baseUrl) ?? "unknown";
      // Block subscribers until the adapter aborts (signal trip). The
      // adapter wires its sessionScope finalizer to abort this signal,
      // so the stub stream resolves cleanly on teardown without leaking
      // a fiber.
      const subscribe = (
        _params: unknown,
        opts: { readonly signal?: AbortSignal },
      ): Promise<{ stream: AsyncIterable<unknown> }> => {
        // Wire the abort listener BEFORE returning, so the listener is
        // registered the moment the SDK consumer enters the await.
        // Doing this inside the async generator's body would race the
        // listener registration against an abort that fires during the
        // microtask gap (the Stream's first .next() takes a tick to
        // execute, and abort can fire from another fiber's finalizer in
        // between).
        const handle = handlesByProject.get(project);
        const signal = opts?.signal;
        const subscriptionPromise = new Promise<void>((resolve) => {
          if (!signal) return resolve();
          if (signal.aborted) {
            if (handle) {
              Effect.runFork(Deferred.succeed(handle.subscriptionAborted, undefined));
            }
            return resolve();
          }
          const onAbort = () => {
            if (handle) {
              Effect.runFork(Deferred.succeed(handle.subscriptionAborted, undefined));
            }
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        return Promise.resolve({
          stream: (async function* () {
            await subscriptionPromise;
          })(),
        });
      };
      const client = {
        session: {
          create: (_args: unknown) => {
            const id = `sess-${project}-${++nextSessionSeq}`;
            creates.push({ project, id });
            return Promise.resolve({ data: { id } });
          },
          abort: (args: { sessionID: string }) => {
            aborts.push({ project, id: args.sessionID });
            return Promise.resolve({});
          },
          messages: () => Promise.resolve({ data: [] }),
          revert: () => Promise.resolve({}),
          promptAsync: () => Promise.resolve({}),
        },
        event: { subscribe },
        permission: { reply: () => Promise.resolve({}) },
        question: { reply: () => Promise.resolve({}) },
      };
      return client as unknown as OpencodeClient;
    },
    loadOpenCodeInventory: () =>
      Effect.die("loadOpenCodeInventory is not exercised by startSession"),
  };

  return {
    layer: Layer.succeed(OpenCodeRuntime, stub),
    handlesByProject,
    getTotalSpawns: () => totalSpawns,
    sessionCreates: () => [...creates],
    sessionAborts: () => [...aborts],
  };
}

// Minimal platform layer: NodeFileSystem + Path for adapter deps;
// in-memory ServerSettings (the static defaults enable opencode with
// no serverUrl, putting us on the pool path); ServerConfig for cwd.
const TestPlatformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  Path.layer,
  Layer.effect(ServerConfig, Effect.succeed(defaultServerConfig)),
  Layer.effect(ServerSettingsService, Effect.succeed(makeStaticServerSettings())),
);

interface AdapterHarness {
  readonly runtime: ManagedRuntime.ManagedRuntime<OpenCodeAdapter | OpenCodeServerPool, never>;
  readonly stub: StubControl;
  readonly teardown: () => Promise<void>;
}

function makeAdapterHarness(): AdapterHarness {
  const stub = makeStubRuntime();
  const layer = OpenCodeAdapterLive.pipe(
    Layer.provideMerge(OpenCodeServerPoolLive),
    Layer.provide(stub.layer),
    Layer.provide(TestPlatformLayer),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    runtime,
    stub,
    teardown: () => runtime.dispose(),
  };
}

const startSessionFor = (
  harness: AdapterHarness,
  threadId: string,
  cwd: string,
) =>
  harness.runtime.runPromise(
    Effect.flatMap(Effect.service(OpenCodeAdapter), (a) =>
      a.startSession({
        threadId: threadId as never,
        cwd: cwd as never,
        runtimeMode: "full-access",
      }),
    ),
  );

const stopSessionFor = (harness: AdapterHarness, threadId: string) =>
  harness.runtime.runPromise(
    Effect.flatMap(Effect.service(OpenCodeAdapter), (a) =>
      a.stopSession(threadId as never),
    ),
  );

const listPoolEntries = (harness: AdapterHarness) =>
  harness.runtime.runPromise(
    Effect.flatMap(Effect.service(OpenCodeServerPool), (p) => p.listEntries),
  );

// Drain the adapter's runtime event stream into an array. Spawned in a
// scope so the test can inspect what flowed without keeping the queue
// open across other operations.
const collectEvents = async (
  harness: AdapterHarness,
  windowMs: number,
): Promise<ReadonlyArray<{ readonly type: string; readonly threadId: string; readonly payload?: unknown }>> => {
  const collected: Array<{ type: string; threadId: string; payload?: unknown }> = [];
  const collectorScope = Effect.runSync(Scope.make());
  await harness.runtime.runPromise(
    Effect.flatMap(Effect.service(OpenCodeAdapter), (a) =>
      Stream.runForEach(a.streamEvents, (e) =>
        Effect.sync(() => {
          collected.push({
            type: e.type,
            threadId: e.threadId as unknown as string,
            payload: (e as unknown as { payload?: unknown }).payload,
          });
        }),
      ).pipe(Effect.forkIn(collectorScope), Effect.asVoid),
    ),
  );
  // Hold the collector open for `windowMs`, then close.
  await new Promise((r) => setTimeout(r, windowMs));
  await Effect.runPromise(Scope.close(collectorScope, Exit.void));
  return collected;
};

describe("OpenCodeAdapter ↔ OpenCodeServerPool integration", () => {
  it("three startSessions for the same project share ONE pooled server", async () => {
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

      // Each thread got its own opencode session (multiplexed onto the
      // shared server) — three distinct session.create calls.
      const creates = harness.stub.sessionCreates();
      expect(creates).toHaveLength(3);
      expect(new Set(creates.map((c) => c.id)).size).toBe(3);
      for (const create of creates) {
        expect(create.project).toBe(PROJECT_A);
      }
    } finally {
      await harness.teardown();
    }
  });

  it("a fourth startSession in a DIFFERENT project spawns a second server", async () => {
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

  it("stopSession releases the pool ref but keeps the server warm until sweep", async () => {
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
      // session.abort fired for each stopped session.
      expect(harness.stub.sessionAborts()).toHaveLength(2);

      await stopSessionFor(harness, "thread-c");
      entries = await listPoolEntries(harness);
      expect(entries[0]?.refCount).toBe(0);
      expect(entries[0]?.idleSince).not.toBeNull();
      // Server is still alive — the pool waits for sweepIdle, NOT a
      // refCount=0 trigger, before killing.
      expect(harness.stub.getTotalSpawns()).toBe(1);
      expect(harness.stub.sessionAborts()).toHaveLength(3);
    } finally {
      await harness.teardown();
    }
  });

  // The end-to-end demo of the deadlock fix: in production the crash
  // chain is server exit → pool teardown → adapter onCrash →
  // emitUnexpectedExit → releasePoolEntry → pool.release. Pre-fix,
  // pool.release re-acquired the per-project mutex held by the crash
  // watcher and the whole chain hung. Post-fix release is lock-free,
  // so the chain unwinds and the adapter cleanly emits both
  // runtime.error and session.exited { recoverable: true } AND removes
  // the session. If this test ever times out, the deadlock is back.
  it("simulated server crash drives the adapter to emit recoverable runtime.error without deadlocking", async () => {
    const harness = makeAdapterHarness();
    try {
      // Start collecting events BEFORE we trigger work, so we don't
      // miss the crash emissions.
      const eventLog: Array<{ type: string; threadId: string; payload?: unknown }> = [];
      const collectorScope = Effect.runSync(Scope.make());
      await harness.runtime.runPromise(
        Effect.flatMap(Effect.service(OpenCodeAdapter), (a) =>
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

      // Wait for the crash chain to settle deterministically: we use
      // the subscription-aborted Deferred as the "everything cleaned
      // up" signal, since the adapter's sessionScope finalizer fires
      // the abort controller as part of the crash teardown.
      // Both threads share one server → one subscription abort.
      await harness.runtime.runPromise(Deferred.await(handle!.subscriptionAborted));

      // Settle the event collector so we can inspect what flowed.
      await new Promise((r) => setTimeout(r, 50));
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

  it("after a crash, a new startSession respawns a fresh server with bumped generation", async () => {
    const harness = makeAdapterHarness();
    try {
      await startSessionFor(harness, "thread-a", CWD_A);
      const handle = harness.stub.handlesByProject.get(PROJECT_A);
      await harness.runtime.runPromise(Deferred.succeed(handle!.exitDeferred, 137));
      // Wait for adapter teardown to settle.
      await harness.runtime.runPromise(Deferred.await(handle!.subscriptionAborted));

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
