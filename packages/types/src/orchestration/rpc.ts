// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 packages/contracts/src/orchestration.ts

import { Option, Schema, SchemaIssue, Struct } from "effect";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "../ids";
import { ProviderKind } from "../provider/kind";
import { ServerProvider } from "../provider/server-provider";
import { ClientOrchestrationCommand } from "./command";
import { OrchestrationEvent } from "./event";
import { OrchestrationShellStreamItem } from "./shell";
import { OrchestrationThreadDetailSnapshot } from "./thread";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
} as const;

// ellul-only WS RPC namespace — methods with no upstream equivalent. Keep
// the `ellul.` prefix so this surface stays visibly separate from the ported
// orchestration.* methods during quarterly upstream sync.
export const ELLUL_WS_METHODS = {
  getZenModels: "ellul.getZenModels",
  getProviders: "ellul.getProviders",
  refreshProvider: "ellul.refreshProvider",
  subscribeProviders: "ellul.subscribeProviders",
  submitApiKey: "ellul.submitApiKey",
  revokeAuth: "ellul.revokeAuth",
} as const;

export const EllulZenModel = Schema.Struct({
  id: Schema.String,
  openCodeId: Schema.String,
});
export type EllulZenModel = typeof EllulZenModel.Type;

export const EllulGetZenModelsResult = Schema.Struct({
  models: Schema.Array(EllulZenModel),
});
export type EllulGetZenModelsResult = typeof EllulGetZenModelsResult.Type;

export const EllulGetProvidersResult = Schema.Struct({
  providers: Schema.Array(ServerProvider),
});
export type EllulGetProvidersResult = typeof EllulGetProvidersResult.Type;

export const EllulRefreshProviderInput = Schema.Struct({
  provider: Schema.optional(ProviderKind),
});
export type EllulRefreshProviderInput = typeof EllulRefreshProviderInput.Type;

export const EllulProvidersStreamItem = Schema.Struct({
  kind: Schema.Literal("snapshot"),
  providers: Schema.Array(ServerProvider),
});
export type EllulProvidersStreamItem = typeof EllulProvidersStreamItem.Type;

// BYOK provider auth (api-key, tenant /ws). `provider` is a ProviderKind (agent);
// the bridge maps it to the underlying LLM key. `credentials` carries the field(s)
// advertised by getProviders (v1: { apiKey }).
export const EllulSubmitApiKeyInput = Schema.Struct({
  provider: ProviderKind,
  credentials: Schema.Record(Schema.String, Schema.String),
});
export type EllulSubmitApiKeyInput = typeof EllulSubmitApiKeyInput.Type;

export const EllulRevokeAuthInput = Schema.Struct({
  provider: ProviderKind,
});
export type EllulRevokeAuthInput = typeof EllulRevokeAuthInput.Type;

export class EllulProviderAuthError extends Schema.TaggedErrorClass<EllulProviderAuthError>()(
  "EllulProviderAuthError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({ threadId: ThreadId }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

export const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationRpcSchemas = {
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: Schema.Struct({}),
    output: OrchestrationShellStreamItem,
  },
} as const;

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationReplayEventsError extends Schema.TaggedErrorClass<OrchestrationReplayEventsError>()(
  "OrchestrationReplayEventsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
