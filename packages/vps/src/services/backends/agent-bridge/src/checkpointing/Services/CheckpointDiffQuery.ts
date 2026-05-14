// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/checkpointing/Services/CheckpointDiffQuery.ts

import type {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from "@ellul.ai/types";
import { Context } from "effect";
import type { Effect } from "effect";

import type { CheckpointServiceError } from "../Errors";

export interface CheckpointDiffQueryShape {
  readonly getTurnDiff: (
    input: OrchestrationGetTurnDiffInput,
  ) => Effect.Effect<OrchestrationGetTurnDiffResult, CheckpointServiceError>;

  readonly getFullThreadDiff: (
    input: OrchestrationGetFullThreadDiffInput,
  ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
}

export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  CheckpointDiffQueryShape
>()("ellul/checkpointing/Services/CheckpointDiffQuery") {}
