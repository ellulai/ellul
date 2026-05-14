// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Layer-level smoke test for the ZeroClaw adapter + provider.
//
// Does NOT spawn the daemon. Verifies the Effect Layer chain has no
// unsatisfied Context requirements, every method on the adapter shape is
// callable, and the adapter+pool wire correctly through the composite
// layer using a stub ZeroClawRuntime.

import { describe, expect, it } from "vitest";
import { Deferred, Effect, Layer, Path, Stream } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";

import {
  ZeroClawAdapter,
  ZeroClawAdapterLive,
  ZeroClawDaemonPoolLive,
  ZeroClawProvider,
  ZeroClawProviderLive,
  ZeroClawRuntime,
  type ZeroClawDaemonProcess,
  type ZeroClawRuntimeShape,
} from "./index";
import {
  defaultServerConfig,
  ServerConfig,
} from "../../shared/config";
import {
  makeStaticServerSettings,
  ServerSettingsService,
} from "../../shared/serverSettings";

const TestPlatformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  Path.layer,
  NodeChildProcessSpawner.layer.pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(Path.layer),
  ),
  Layer.effect(ServerConfig, Effect.succeed(defaultServerConfig)),
  Layer.effect(ServerSettingsService, Effect.succeed(makeStaticServerSettings())),
);

// Stub runtime — never actually spawns. The adapter's Layer can build
// against this; tests don't drive any chunks through (the pool +
// runtime integration is covered by server-pool.test.ts).
function makeStubRuntime(): Layer.Layer<ZeroClawRuntime> {
  const stub: ZeroClawRuntimeShape = {
    startDaemon: (input) =>
      Effect.gen(function* () {
        const exitDeferred = yield* Deferred.make<number, never>();
        return {
          url: `http://${input.hostAddress}:${input.port}`,
          hostAddress: input.hostAddress,
          port: input.port,
          pid: 99_999,
          hasChannels: false,
          generation: input.generation,
          project: input.project,
          exitCode: Deferred.await(exitDeferred),
        } satisfies ZeroClawDaemonProcess;
      }),
    sendOnSession: () =>
      Effect.die("sendOnSession should not be called by smoke tests"),
    checkBinaryHealth: Effect.succeed(true),
  };
  return Layer.succeed(ZeroClawRuntime, stub);
}

const buildAdapterLayer = (runtimeStub: Layer.Layer<ZeroClawRuntime>) =>
  ZeroClawAdapterLive.pipe(
    Layer.provideMerge(ZeroClawDaemonPoolLive),
    Layer.provide(runtimeStub),
    Layer.provide(TestPlatformLayer),
  );

describe("ZeroClawAdapter (smoke)", () => {
  it("Layer builds and exposes the full adapter shape", async () => {
    const adapter = await Effect.runPromise(
      Effect.provide(Effect.service(ZeroClawAdapter), buildAdapterLayer(makeStubRuntime())),
    );
    expect(adapter.provider).toBe("zeroclaw");
    expect(adapter.capabilities.sessionModelSwitch).toBe("in-session");
    expect(typeof adapter.startSession).toBe("function");
    expect(typeof adapter.sendTurn).toBe("function");
    expect(typeof adapter.interruptTurn).toBe("function");
    expect(typeof adapter.respondToRequest).toBe("function");
    expect(typeof adapter.respondToUserInput).toBe("function");
    expect(typeof adapter.readThread).toBe("function");
    expect(typeof adapter.rollbackThread).toBe("function");
    expect(typeof adapter.stopSession).toBe("function");
    expect(typeof adapter.hasSession).toBe("function");
    expect(typeof adapter.listSessions).toBe("function");
    expect(typeof adapter.stopAll).toBe("function");
    expect(Stream.isStream(adapter.streamEvents)).toBe(true);
  });

  it("listSessions returns an empty array before any session starts", async () => {
    const sessions = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Effect.service(ZeroClawAdapter), (a) => a.listSessions()),
        buildAdapterLayer(makeStubRuntime()),
      ),
    );
    expect(sessions).toEqual([]);
  });

  it("hasSession returns false for a random threadId when no session started", async () => {
    const has = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Effect.service(ZeroClawAdapter), (a) =>
          a.hasSession("ThreadId-nonexistent" as never),
        ),
        buildAdapterLayer(makeStubRuntime()),
      ),
    );
    expect(has).toBe(false);
  });

  it("respondToRequest and respondToUserInput are no-ops (ZeroClaw has no HITL)", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Effect.service(ZeroClawAdapter), (a) =>
          Effect.all([
            a.respondToRequest(
              "ThreadId-x" as never,
              "ApprovalRequestId-x" as never,
              "accept" as never,
            ),
            a.respondToUserInput("ThreadId-x" as never, "ApprovalRequestId-x" as never, {} as never),
          ]),
        ),
        buildAdapterLayer(makeStubRuntime()),
      ),
    );
  });

  it("readThread returns empty turns (orchestration projector is the source of truth)", async () => {
    const snapshot = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Effect.service(ZeroClawAdapter), (a) =>
          a.readThread("ThreadId-x" as never),
        ),
        buildAdapterLayer(makeStubRuntime()),
      ),
    );
    expect(snapshot.turns).toEqual([]);
  });

  it("stopAll is a no-op when no sessions exist", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Effect.service(ZeroClawAdapter), (a) => a.stopAll()),
        buildAdapterLayer(makeStubRuntime()),
      ),
    );
  });
});

describe("ZeroClawProvider (smoke)", () => {
  it("Layer builds and exposes the ServerProviderShape", async () => {
    const provider = await Effect.runPromise(
      Effect.provide(
        Effect.service(ZeroClawProvider),
        ZeroClawProviderLive.pipe(
          Layer.provide(makeStubRuntime()),
          Layer.provide(TestPlatformLayer),
        ),
      ).pipe(Effect.scoped),
    );
    expect(typeof provider.getSnapshot).toBe("object");
    expect(typeof provider.refresh).toBe("object");
    expect(Stream.isStream(provider.streamChanges)).toBe(true);
  });
});
