// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { IsoDateTime, ProviderKind, TrimmedNonEmptyString } from "@ellul.ai/types";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors";

export const ProjectionSandboxPinnedModel = Schema.Struct({
  provider: ProviderKind,
  modelSlug: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type ProjectionSandboxPinnedModel = typeof ProjectionSandboxPinnedModel.Type;

export const DeleteProjectionSandboxPinnedModelInput = Schema.Struct({
  provider: ProviderKind,
});
export type DeleteProjectionSandboxPinnedModelInput =
  typeof DeleteProjectionSandboxPinnedModelInput.Type;

export interface ProjectionSandboxPinnedModelRepositoryShape {
  readonly upsert: (
    row: ProjectionSandboxPinnedModel,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionSandboxPinnedModel>,
    ProjectionRepositoryError
  >;
  readonly deleteByProvider: (
    input: DeleteProjectionSandboxPinnedModelInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionSandboxPinnedModelRepository extends Context.Service<
  ProjectionSandboxPinnedModelRepository,
  ProjectionSandboxPinnedModelRepositoryShape
>()("ellul/persistence/Services/ProjectionSandbox/ProjectionSandboxPinnedModelRepository") {}
