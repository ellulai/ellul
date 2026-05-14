// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 packages/contracts/src/orchestration.ts

import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt } from "../ids";
import { OrchestrationProject } from "./project";
import { OrchestrationSandbox } from "./sandbox";
import { OrchestrationThread } from "./thread";

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  sandbox: OrchestrationSandbox,
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;
