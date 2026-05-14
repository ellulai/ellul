// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@ellul.ai/types";
import { Context, Effect, Equal, Layer, Stream } from "effect";

import { makeManagedServerProvider } from "../../shared/makeManagedServerProvider";
import {
  buildServerProvider,
  providerModelsFromSettings,
} from "../../shared/providerSnapshot";
import type { ServerProviderShape } from "../../shared/ServerProvider";
import {
  ServerSettingsService,
  type ZeroClawAgentSettings,
} from "../../shared/serverSettings";
import { ZeroClawRuntime } from "./runtime";

const PROVIDER = "zeroclaw" as const;

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

// Single static model — the daemon picks its upstream from `~/.zeroclaw/config.toml`.
const STATIC_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "ZeroClaw Default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export interface ZeroClawProviderShape extends ServerProviderShape {}

export class ZeroClawProvider extends Context.Service<ZeroClawProvider, ZeroClawProviderShape>()(
  "ellul/provider/ZeroClawProvider",
) {}

const makeInitialSnapshot = (settings: ZeroClawAgentSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    STATIC_MODELS,
    PROVIDER,
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "ZeroClaw is disabled in settings.",
      },
    });
  }
  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking ZeroClaw daemon availability...",
    },
  });
};

export const ZeroClawProviderLive = Layer.effect(
  ZeroClawProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const runtime = yield* ZeroClawRuntime;

    const checkProvider = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.map((s) => s.providers.zeroclaw),
      );
      const checkedAt = new Date().toISOString();
      const models = providerModelsFromSettings(
        STATIC_MODELS,
        PROVIDER,
        settings.customModels,
        EMPTY_CAPABILITIES,
      );
      if (!settings.enabled) {
        return buildServerProvider({
          provider: PROVIDER,
          enabled: false,
          checkedAt,
          models,
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "ZeroClaw is disabled in settings.",
          },
        });
      }

      const installed = yield* runtime.checkBinaryHealth;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed,
          version: null,
          status: installed ? "ready" : "error",
          auth: { status: installed ? "authenticated" : "unknown" },
          message: installed
            ? "ZeroClaw daemon binary detected."
            : "ZeroClaw daemon binary (`zeroclaw`) is not installed or not on PATH.",
        },
      });
    });

    const getProviderSettings = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.zeroclaw),
    );

    return yield* makeManagedServerProvider<ZeroClawAgentSettings>({
      getSettings: getProviderSettings.pipe(Effect.orDie),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.zeroclaw),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makeInitialSnapshot,
      checkProvider,
    });
  }),
);
