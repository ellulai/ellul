// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Services/CheckpointReactor.ts

import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface CheckpointReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class CheckpointReactor extends Context.Service<CheckpointReactor, CheckpointReactorShape>()(
  "t3/orchestration/Services/CheckpointReactor",
) {}
