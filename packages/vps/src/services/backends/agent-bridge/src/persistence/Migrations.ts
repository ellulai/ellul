// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/persistence/Migrations.ts

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import Migration0001 from "./Migrations/001_OrchestrationEvents";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts";
import Migration0003 from "./Migrations/003_Projections";
import Migration0004 from "./Migrations/004_ProjectionThreadSessionsRuntimeMode";
import Migration0005 from "./Migrations/005_ProjectionThreadsViewScope";
import Migration0006 from "./Migrations/006_CheckpointDiffBlobs";
import Migration0007 from "./Migrations/007_ProjectionSandbox";

export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "Projections", Migration0003],
  [4, "ProjectionThreadSessionsRuntimeMode", Migration0004],
  [5, "ProjectionThreadsViewScope", Migration0005],
  [6, "CheckpointDiffBlobs", Migration0006],
  [7, "ProjectionSandbox", Migration0007],
] as const;

export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  yield* Effect.log(
    toMigrationInclusive === undefined
      ? "Running all migrations..."
      : `Running migrations 1 through ${toMigrationInclusive}...`,
  );
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  yield* Effect.log("Migrations ran successfully").pipe(
    Effect.annotateLogs({ migrations: executedMigrations.map(([id, name]) => `${id}_${name}`) }),
  );
  return executedMigrations;
});

export const MigrationsLive = Layer.effectDiscard(runMigrations());
