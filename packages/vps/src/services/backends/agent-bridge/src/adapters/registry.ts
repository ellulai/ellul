// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { ProviderKind } from "@ellul.ai/types";
import type { ProviderAdapterShape } from "@ellul.ai/types";
import { Context, Effect } from "effect";
import { ProviderUnsupportedError, type ProviderAdapterError } from "./errors";

export interface ProviderAdapterRegistryShape {
  readonly getByProvider: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderUnsupportedError>;
  readonly listProviders: () => Effect.Effect<ReadonlyArray<ProviderKind>>;
}

export class ProviderAdapterRegistry extends Context.Service<
  ProviderAdapterRegistry,
  ProviderAdapterRegistryShape
>()("ellul/adapters/ProviderAdapterRegistry") {}

export const makeProviderAdapterRegistry = (input: {
  readonly adapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
}): ProviderAdapterRegistryShape => {
  const byProvider = new Map<string, ProviderAdapterShape<ProviderAdapterError>>(
    input.adapters.map((adapter) => [adapter.provider, adapter]),
  );

  return {
    getByProvider: (provider) => {
      const adapter = byProvider.get(provider);
      return adapter
        ? Effect.succeed(adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider }));
    },
    listProviders: () =>
      Effect.succeed(Array.from(byProvider.keys()) as ReadonlyArray<ProviderKind>),
  };
};
