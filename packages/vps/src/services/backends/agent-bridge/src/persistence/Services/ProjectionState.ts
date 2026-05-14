// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/persistence/Services/ProjectionState.ts

import { IsoDateTime, NonNegativeInt } from "@ellul.ai/types";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors";

export const ProjectionState = Schema.Struct({
  projector: Schema.String,
  lastAppliedSequence: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ProjectionState = typeof ProjectionState.Type;

export const GetProjectionStateInput = Schema.Struct({
  projector: Schema.String,
});
export type GetProjectionStateInput = typeof GetProjectionStateInput.Type;

export interface ProjectionStateRepositoryShape {
  readonly upsert: (row: ProjectionState) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByProjector: (
    input: GetProjectionStateInput,
  ) => Effect.Effect<Option.Option<ProjectionState>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionState>, ProjectionRepositoryError>;
  readonly minLastAppliedSequence: () => Effect.Effect<number | null, ProjectionRepositoryError>;
}

export class ProjectionStateRepository extends Context.Service<
  ProjectionStateRepository,
  ProjectionStateRepositoryShape
>()("t3/persistence/Services/ProjectionState/ProjectionStateRepository") {}
