// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Services/OrchestrationReactor.ts

import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface OrchestrationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class OrchestrationReactor extends Context.Service<
  OrchestrationReactor,
  OrchestrationReactorShape
>()("t3/orchestration/Services/OrchestrationReactor") {}
