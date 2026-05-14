// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Adapts the eager `getAdapterRuntime()` singleton into a Layer. The adapters/
// folder is frozen for this refactor — this shim is the one-way bridge from
// the Effect world (engine + reactors) to the existing adapter runtime.

import { Effect, Layer } from "effect";

import { ProviderService } from "../adapters/provider-service";
import { getAdapterRuntime } from "../adapters/runtime";

export const ProviderServiceLive = Layer.effect(
  ProviderService,
  Effect.gen(function* () {
    const runtime = yield* Effect.promise(() => getAdapterRuntime());
    return runtime.service;
  }),
);
