// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationAggregateKind,
  OrchestrationCommandReceiptStatus,
  ProjectId,
  SandboxAggregateId,
  ThreadId,
} from "@ellul.ai/types";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, SandboxAggregateId]),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: OrchestrationCommandReceiptStatus,
  error: Schema.NullOr(Schema.String),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

export interface OrchestrationCommandReceiptRepositoryShape {
  readonly upsert: (
    receipt: OrchestrationCommandReceipt,
  ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;
  readonly getByCommandId: (
    input: GetByCommandIdInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationCommandReceipt>,
    OrchestrationCommandReceiptRepositoryError
  >;
}

export class OrchestrationCommandReceiptRepository extends Context.Service<
  OrchestrationCommandReceiptRepository,
  OrchestrationCommandReceiptRepositoryShape
>()("t3/persistence/Services/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository") {}
