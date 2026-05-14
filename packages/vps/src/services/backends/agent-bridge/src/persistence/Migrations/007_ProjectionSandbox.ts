// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_sandbox_pinned_models (
      provider TEXT PRIMARY KEY,
      model_slug TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
