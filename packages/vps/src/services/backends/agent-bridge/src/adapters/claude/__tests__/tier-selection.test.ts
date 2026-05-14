// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Boot-time tier selection: the composition root reads
// `claudeAgent.runtimeMode` and provides either the SDK helper
// (`ClaudeAdapterLive`) or the one-shot CLI (`ClaudeLiteAdapterLive`).
// Both Layers MUST satisfy the same `ClaudeAdapter` Service tag so the
// downstream registry / provider service is tier-agnostic.

import { describe, it, expect } from "vitest";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import { ClaudeAdapter, ClaudeAdapterLive, ClaudeLiteAdapterLive } from "../index";
import {
  defaultServerSettings,
  makeStaticServerSettings,
  ServerSettingsService,
} from "../../../shared/serverSettings";
import { defaultServerConfig, ServerConfig } from "../../../shared/config";

function makeRuntime(layer: Layer.Layer<ClaudeAdapter>) {
  return ManagedRuntime.make(
    layer.pipe(
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(Layer.succeed(ServerSettingsService, makeStaticServerSettings())),
      Layer.provide(Layer.succeed(ServerConfig, defaultServerConfig)),
    ),
  );
}

describe("Tier selection", () => {
  it("ClaudeAdapterLive (Pro/SDK) reports sessionModelSwitch='in-session'", async () => {
    const rt = makeRuntime(ClaudeAdapterLive);
    try {
      const adapter = await rt.runPromise(Effect.service(ClaudeAdapter));
      expect(adapter.provider).toBe("claudeAgent");
      expect(adapter.capabilities.sessionModelSwitch).toBe("in-session");
    } finally {
      await rt.dispose();
    }
  });

  it("ClaudeLiteAdapterLive reports sessionModelSwitch='unsupported'", async () => {
    const rt = makeRuntime(ClaudeLiteAdapterLive);
    try {
      const adapter = await rt.runPromise(Effect.service(ClaudeAdapter));
      expect(adapter.provider).toBe("claudeAgent");
      expect(adapter.capabilities.sessionModelSwitch).toBe("unsupported");
    } finally {
      await rt.dispose();
    }
  });

  it("both Layers expose a streamEvents Stream<ProviderRuntimeEvent>", async () => {
    const proRt = makeRuntime(ClaudeAdapterLive);
    const liteRt = makeRuntime(ClaudeLiteAdapterLive);
    try {
      const proAdapter = await proRt.runPromise(Effect.service(ClaudeAdapter));
      const liteAdapter = await liteRt.runPromise(Effect.service(ClaudeAdapter));
      expect(Stream.isStream(proAdapter.streamEvents)).toBe(true);
      expect(Stream.isStream(liteAdapter.streamEvents)).toBe(true);
    } finally {
      await proRt.dispose();
      await liteRt.dispose();
    }
  });

  it("both Layers expose the full ClaudeAdapterShape surface", async () => {
    const requiredOps = [
      "startSession",
      "sendTurn",
      "interruptTurn",
      "respondToRequest",
      "respondToUserInput",
      "stopSession",
      "listSessions",
      "hasSession",
      "readThread",
      "rollbackThread",
      "stopAll",
    ] as const;

    for (const layer of [ClaudeAdapterLive, ClaudeLiteAdapterLive]) {
      const rt = makeRuntime(layer);
      try {
        const adapter = await rt.runPromise(Effect.service(ClaudeAdapter));
        for (const op of requiredOps) {
          expect(typeof adapter[op]).toBe("function");
        }
      } finally {
        await rt.dispose();
      }
    }
  });

  it("default settings yield Pro tier (runtimeMode='pro')", () => {
    expect(defaultServerSettings.providers.claudeAgent.runtimeMode).toBe("pro");
  });

  it("default settings include lite.hotWindowMs (30s)", () => {
    expect(defaultServerSettings.providers.claudeAgent.lite.hotWindowMs).toBe(30_000);
  });
});
