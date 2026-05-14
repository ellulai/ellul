// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/OrchestrationReactor.ts

import { Effect, Layer } from "effect";

import { CheckpointReactor } from "../Services/CheckpointReactor";
import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor";

const make = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(OrchestrationReactor, make);
