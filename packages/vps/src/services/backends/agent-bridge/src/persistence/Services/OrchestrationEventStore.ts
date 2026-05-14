// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/persistence/Services/OrchestrationEventStore.ts

import { OrchestrationEvent } from "@ellul.ai/types";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

import type { OrchestrationEventStoreError } from "../Errors";

export interface OrchestrationEventStoreShape {
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;
}

export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("t3/persistence/Services/OrchestrationEventStore") {}
