// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/persistence/Services/ProjectionProjects.ts

import { IsoDateTime, ModelSelection, ProjectId, ProjectScript } from "@ellul.ai/types";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors";

export const ProjectionProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProject = typeof ProjectionProject.Type;

export const GetProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type GetProjectionProjectInput = typeof GetProjectionProjectInput.Type;

export const DeleteProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteProjectionProjectInput = typeof DeleteProjectionProjectInput.Type;

export interface ProjectionProjectRepositoryShape {
  readonly upsert: (row: ProjectionProject) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionProjectInput,
  ) => Effect.Effect<Option.Option<ProjectionProject>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionProject>,
    ProjectionRepositoryError
  >;
  readonly deleteById: (
    input: DeleteProjectionProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionProjectRepository extends Context.Service<
  ProjectionProjectRepository,
  ProjectionProjectRepositoryShape
>()("t3/persistence/Services/ProjectionProjects/ProjectionProjectRepository") {}
