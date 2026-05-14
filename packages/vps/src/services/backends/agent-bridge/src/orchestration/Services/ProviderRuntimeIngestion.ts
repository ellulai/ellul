// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts

import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ProviderRuntimeIngestionShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ProviderRuntimeIngestionService extends Context.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()("t3/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService") {}
