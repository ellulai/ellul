// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Services/ProjectionPipeline.ts

import type { OrchestrationEvent } from "@ellul.ai/types";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors";

export interface OrchestrationProjectionPipelineShape {
  readonly bootstrap: Effect.Effect<void, ProjectionRepositoryError>;
  readonly projectEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class OrchestrationProjectionPipeline extends Context.Service<
  OrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineShape
>()("t3/orchestration/Services/ProjectionPipeline/OrchestrationProjectionPipeline") {}
