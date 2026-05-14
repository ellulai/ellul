// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
// Ellul-only schema addition — no upstream counterpart. The chat sidebar
// filters threads by the sub-directory the user was in when the thread
// opened; view_scope preserves that label on the thread row.

import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN view_scope TEXT
  `;
});
