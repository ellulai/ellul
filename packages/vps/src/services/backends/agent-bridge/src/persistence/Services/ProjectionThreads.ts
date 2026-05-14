// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/persistence/Services/ProjectionThreads.ts

import {
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@ellul.ai/types";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  viewScope: Schema.NullOr(Schema.String),
  latestTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  hasActionableProposedPlan: NonNegativeInt,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type;

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type;

export interface ProjectionThreadRepositoryShape {
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;
  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadRepository extends Context.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("t3/persistence/Services/ProjectionThreads/ProjectionThreadRepository") {}
