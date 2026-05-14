// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors";
import {
  DeleteProjectionSandboxPinnedModelInput,
  ProjectionSandboxPinnedModel,
  ProjectionSandboxPinnedModelRepository,
  type ProjectionSandboxPinnedModelRepositoryShape,
} from "../Services/ProjectionSandbox";

const makeProjectionSandboxPinnedModelRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionSandboxPinnedModel,
    execute: (row) =>
      sql`
        INSERT INTO projection_sandbox_pinned_models (
          provider,
          model_slug,
          updated_at
        )
        VALUES (
          ${row.provider},
          ${row.modelSlug},
          ${row.updatedAt}
        )
        ON CONFLICT (provider)
        DO UPDATE SET
          model_slug = excluded.model_slug,
          updated_at = excluded.updated_at
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSandboxPinnedModel,
    execute: () =>
      sql`
        SELECT
          provider,
          model_slug AS "modelSlug",
          updated_at AS "updatedAt"
        FROM projection_sandbox_pinned_models
        ORDER BY provider ASC
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteProjectionSandboxPinnedModelInput,
    execute: ({ provider }) =>
      sql`
        DELETE FROM projection_sandbox_pinned_models
        WHERE provider = ${provider}
      `,
  });

  const upsert: ProjectionSandboxPinnedModelRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSandboxPinnedModelRepository.upsert:query")),
    );

  const listAll: ProjectionSandboxPinnedModelRepositoryShape["listAll"] = () =>
    listAllRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSandboxPinnedModelRepository.listAll:query")),
    );

  const deleteByProvider: ProjectionSandboxPinnedModelRepositoryShape["deleteByProvider"] = (
    input,
  ) =>
    deleteRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionSandboxPinnedModelRepository.deleteByProvider:query"),
      ),
    );

  return {
    upsert,
    listAll,
    deleteByProvider,
  } satisfies ProjectionSandboxPinnedModelRepositoryShape;
});

export const ProjectionSandboxPinnedModelRepositoryLive = Layer.effect(
  ProjectionSandboxPinnedModelRepository,
  makeProjectionSandboxPinnedModelRepository,
);
