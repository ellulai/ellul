// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.
//
// Layer-level smoke test for the ported Cursor adapter + provider.
//
// This does NOT spawn cursor-agent. It verifies the Effect Layer chain has
// no unsatisfied Context requirements and that every method on the ported
// adapter shape is callable without touching the subprocess. Full end-to-end
// ACP prompt/response testing requires a real VPS with cursor-agent installed
// — track that as a live-environment smoke test, not a unit test.

import { describe, it, expect } from "vitest";
import { Effect, Layer, Path, Stream } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";

import {
  CursorAdapter,
  CursorAdapterLive,
  CursorAcpRuntimeFactoryLive,
  CursorAcpServerPoolLive,
  CursorProvider,
  CursorProviderLive,
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

// CursorAdapterLive now depends on CursorAcpServerPool. Compose the
// pool + factory layers into the adapter test layer so the smoke tests
// (which never spawn cursor-agent — listSessions / hasSession / stopAll
// only) build cleanly.
const CursorAdapterTestLayer = CursorAdapterLive.pipe(
  Layer.provideMerge(CursorAcpServerPoolLive),
  Layer.provide(CursorAcpRuntimeFactoryLive),
  Layer.provide(TestPlatformLayer),
);

describe("CursorAdapter (smoke)", () => {
  it("Layer builds and exposes the full adapter shape", async () => {
    const adapter = await Effect.runPromise(
      Effect.provide(Effect.service(CursorAdapter), CursorAdapterTestLayer),
    );
    expect(adapter.provider).toBe("cursor");
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
        Effect.flatMap(Effect.service(CursorAdapter), (a) => a.listSessions()),
        CursorAdapterTestLayer,
      ),
    );
    expect(sessions).toEqual([]);
  });

  it("hasSession returns false for a random threadId when no session started", async () => {
    const has = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Effect.service(CursorAdapter), (a) =>
          a.hasSession("ThreadId-nonexistent" as never),
        ),
        CursorAdapterTestLayer,
      ),
    );
    expect(has).toBe(false);
  });

  it("stopAll is a no-op when no sessions exist", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Effect.service(CursorAdapter), (a) => a.stopAll()),
        CursorAdapterTestLayer,
      ),
    );
  });
});

describe("CursorProvider (smoke)", () => {
  it("Layer builds and exposes the ServerProviderShape", async () => {
    const provider = await Effect.runPromise(
      Effect.provide(
        Effect.service(CursorProvider),
        CursorProviderLive.pipe(Layer.provide(TestPlatformLayer)),
      ).pipe(Effect.scoped),
    );
    expect(typeof provider.getSnapshot).toBe("object");
    expect(typeof provider.refresh).toBe("object");
    expect(Stream.isStream(provider.streamChanges)).toBe(true);
  });
});
