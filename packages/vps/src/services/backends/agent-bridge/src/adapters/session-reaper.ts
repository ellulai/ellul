// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Effect, Fiber, Schedule } from "effect";
import type { ProviderAdapterShape } from "@ellul.ai/types";
import type { ProviderAdapterError } from "./errors";
import { ProviderSessionDirectory } from "./session-directory";

const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperOptions {
  readonly idleTtlMs?: number;
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
}

export const runProviderSessionReaper = (input: {
  readonly registry: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
  readonly options?: ProviderSessionReaperOptions;
}) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    const idleTtlMs = input.options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    const sweepIntervalMs = input.options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const now = input.options?.now ?? Date.now;

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const cutoff = now() - idleTtlMs;
      const byProvider = new Map<string, ProviderAdapterShape<ProviderAdapterError>>(
        input.registry.map((a) => [a.provider, a]),
      );

      for (const binding of bindings) {
        const seenAtMs = new Date(binding.lastSeenAt).getTime();
        if (seenAtMs > cutoff) continue;
        const adapter = byProvider.get(binding.provider);
        if (!adapter) continue;
        yield* adapter.stopSession(binding.threadId).pipe(Effect.ignore);
        yield* directory.remove(binding.threadId);
      }
    });

    return yield* sweep.pipe(
      Effect.schedule(Schedule.spaced(`${sweepIntervalMs} millis`)),
      Effect.forkChild,
    );
  });

export type ReaperFiber = Fiber.Fiber<void, never>;
