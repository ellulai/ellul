// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/persistence/Services/ProjectionCheckpoints.ts
// (tag + shape only; Live Layer lands with CheckpointReactor in a later phase).

import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadId,
  TurnId,
} from "@ellul.ai/types";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors";

export const ProjectionCheckpoint = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpoint = typeof ProjectionCheckpoint.Type;

export const ListProjectionCheckpointsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionCheckpointsByThreadInput =
  typeof ListProjectionCheckpointsByThreadInput.Type;

export const GetProjectionCheckpointByThreadAndTurnCountInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
export type GetProjectionCheckpointByThreadAndTurnCountInput =
  typeof GetProjectionCheckpointByThreadAndTurnCountInput.Type;

export const DeleteProjectionCheckpointsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionCheckpointsByThreadInput =
  typeof DeleteProjectionCheckpointsByThreadInput.Type;

export interface ProjectionCheckpointRepositoryShape {
  readonly upsert: (row: ProjectionCheckpoint) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionCheckpointsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCheckpoint>, ProjectionRepositoryError>;
  readonly getByThreadAndTurnCount: (
    input: GetProjectionCheckpointByThreadAndTurnCountInput,
  ) => Effect.Effect<Option.Option<ProjectionCheckpoint>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionCheckpointsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionCheckpointRepository extends Context.Service<
  ProjectionCheckpointRepository,
  ProjectionCheckpointRepositoryShape
>()("t3/persistence/Services/ProjectionCheckpoints/ProjectionCheckpointRepository") {}
