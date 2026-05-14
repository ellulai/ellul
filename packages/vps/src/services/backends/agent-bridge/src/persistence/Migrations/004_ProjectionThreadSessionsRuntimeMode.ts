// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — adds the runtime_mode
// column to projection_thread_sessions (pingdotgg/t3code@b0b7b38 has it in
// the upstream ProjectionThreadSession schema; omitted from the collapsed
// 003-projections because thread-sessions repo was deferred in C.2 and
// landed in C.3).

import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access'
  `;
});
