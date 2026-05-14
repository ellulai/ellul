// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Context, Effect, Option, Ref } from "effect";
import type { ProviderKind, ThreadId } from "@ellul.ai/types";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly adapterKey?: string;
  readonly status?: "starting" | "running" | "stopped" | "error";
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
}

export interface ProviderRuntimeBindingWithMetadata extends ProviderRuntimeBinding {
  readonly lastSeenAt: string;
}

export interface ProviderSessionDirectoryShape {
  readonly upsert: (binding: ProviderRuntimeBinding) => Effect.Effect<void>;
  readonly remove: (threadId: ThreadId) => Effect.Effect<void>;
  readonly getProvider: (threadId: ThreadId) => Effect.Effect<Option.Option<ProviderKind>>;
  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeBindingWithMetadata>>;
  readonly listThreadIds: () => Effect.Effect<ReadonlyArray<ThreadId>>;
  readonly listBindings: () => Effect.Effect<ReadonlyArray<ProviderRuntimeBindingWithMetadata>>;
}

export class ProviderSessionDirectory extends Context.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("ellul/adapters/ProviderSessionDirectory") {}

export const makeProviderSessionDirectoryInMemory = (): Effect.Effect<
  ProviderSessionDirectoryShape
> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(new Map<string, ProviderRuntimeBindingWithMetadata>());
    const nowIso = () => new Date().toISOString();

    return {
      upsert: (binding) =>
        Ref.update(ref, (map) => {
          const next = new Map(map);
          next.set(binding.threadId, { ...binding, lastSeenAt: nowIso() });
          return next;
        }),
      remove: (threadId) =>
        Ref.update(ref, (map) => {
          if (!map.has(threadId)) return map;
          const next = new Map(map);
          next.delete(threadId);
          return next;
        }),
      getProvider: (threadId) =>
        Ref.get(ref).pipe(
          Effect.map((map) => Option.fromNullishOr(map.get(threadId)?.provider)),
        ),
      getBinding: (threadId) =>
        Ref.get(ref).pipe(Effect.map((map) => Option.fromNullishOr(map.get(threadId)))),
      listThreadIds: () =>
        Ref.get(ref).pipe(
          Effect.map((map) => Array.from(map.keys()) as unknown as ReadonlyArray<ThreadId>),
        ),
      listBindings: () => Ref.get(ref).pipe(Effect.map((map) => Array.from(map.values()))),
    } satisfies ProviderSessionDirectoryShape;
  });
