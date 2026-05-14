// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { Layer } from "effect";

import { ORCHESTRATION_DB_PATH } from "../config";
import { layer as sqliteLayer } from "../persistence/NodeSqliteClient";
import { MigrationsLive } from "../persistence/Migrations";

export const SqliteClientLive = sqliteLayer({ filename: ORCHESTRATION_DB_PATH });

export const PersistenceLayerLive = Layer.mergeAll(
  SqliteClientLive,
  MigrationsLive.pipe(Layer.provide(SqliteClientLive)),
);
