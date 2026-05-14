// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Services/OrchestrationEngine.ts

import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@ellul.ai/types";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

import type { OrchestrationEventStoreError } from "../../persistence/Errors";
import type { OrchestrationDispatchError } from "../Errors";

export interface OrchestrationEngineShape {
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
