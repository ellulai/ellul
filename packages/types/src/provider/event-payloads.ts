// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Schema } from "effect";
// Payload schemas for each ProviderRuntimeEvent variant.
import {
  NonNegativeInt,
  ProviderItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  TrimmedNonEmptyString,
} from "../ids";
import {
  CanonicalItemType,
  CanonicalRequestType,
  RuntimeContentStreamKind,
  RuntimeErrorClass,
  RuntimeItemStatus,
  RuntimePlanStepStatus,
  RuntimeSessionExitKind,
  RuntimeSessionState,
  RuntimeThreadState,
  RuntimeTurnState,
} from "./canonical";
import { ThreadTokenUsageSnapshot } from "./token-usage";
import { UserInputQuestion } from "./user-input";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

export const RuntimeEventRawSource = Schema.Union([
  Schema.Literal("codex.app-server.notification"),
  Schema.Literal("codex.app-server.request"),
  Schema.Literal("codex.eventmsg"),
  Schema.Literal("claude.sdk.message"),
  Schema.Literal("claude.sdk.permission"),
  Schema.Literal("codex.sdk.thread-event"),
  Schema.Literal("opencode.sdk.event"),
  Schema.Literal("acp.jsonrpc"),
  Schema.TemplateLiteral(["acp.", Schema.String, ".extension"]),
  Schema.Literal("zeroclaw.ws.v1"),
]);
export type RuntimeEventRawSource = typeof RuntimeEventRawSource.Type;

export const RuntimeEventRaw = Schema.Struct({
  source: RuntimeEventRawSource,
  method: Schema.optional(TrimmedNonEmptyString),
  messageType: Schema.optional(TrimmedNonEmptyString),
  payload: Schema.Unknown,
});
export type RuntimeEventRaw = typeof RuntimeEventRaw.Type;

export const ProviderRequestId = TrimmedNonEmptyString;
export type ProviderRequestId = typeof ProviderRequestId.Type;

export const ProviderRefs = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(ProviderRequestId),
});
export type ProviderRefs = typeof ProviderRefs.Type;

export const SessionStartedPayload = Schema.Struct({
  message: Schema.optional(TrimmedNonEmptyString),
  resume: Schema.optional(Schema.Unknown),
});
export type SessionStartedPayload = typeof SessionStartedPayload.Type;

export const SessionConfiguredPayload = Schema.Struct({
  config: UnknownRecord,
});
export type SessionConfiguredPayload = typeof SessionConfiguredPayload.Type;

export const SessionStateChangedPayload = Schema.Struct({
  state: RuntimeSessionState,
  reason: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(Schema.Unknown),
});
export type SessionStateChangedPayload = typeof SessionStateChangedPayload.Type;

export const SessionExitedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyString),
  recoverable: Schema.optional(Schema.Boolean),
  exitKind: Schema.optional(RuntimeSessionExitKind),
});
export type SessionExitedPayload = typeof SessionExitedPayload.Type;

export const ThreadStartedPayload = Schema.Struct({
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadStartedPayload = typeof ThreadStartedPayload.Type;

export const ThreadStateChangedPayload = Schema.Struct({
  state: RuntimeThreadState,
  detail: Schema.optional(Schema.Unknown),
});
export type ThreadStateChangedPayload = typeof ThreadStateChangedPayload.Type;

export const ThreadMetadataUpdatedPayload = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString),
  metadata: Schema.optional(UnknownRecord),
});
export type ThreadMetadataUpdatedPayload = typeof ThreadMetadataUpdatedPayload.Type;

export const ThreadTokenUsageUpdatedPayload = Schema.Struct({
  usage: ThreadTokenUsageSnapshot,
});
export type ThreadTokenUsageUpdatedPayload = typeof ThreadTokenUsageUpdatedPayload.Type;

export const ThreadRealtimeStartedPayload = Schema.Struct({
  realtimeSessionId: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadRealtimeStartedPayload = typeof ThreadRealtimeStartedPayload.Type;

export const ThreadRealtimeItemAddedPayload = Schema.Struct({ item: Schema.Unknown });
export type ThreadRealtimeItemAddedPayload = typeof ThreadRealtimeItemAddedPayload.Type;

export const ThreadRealtimeAudioDeltaPayload = Schema.Struct({ audio: Schema.Unknown });
export type ThreadRealtimeAudioDeltaPayload = typeof ThreadRealtimeAudioDeltaPayload.Type;

export const ThreadRealtimeErrorPayload = Schema.Struct({ message: TrimmedNonEmptyString });
export type ThreadRealtimeErrorPayload = typeof ThreadRealtimeErrorPayload.Type;

export const ThreadRealtimeClosedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadRealtimeClosedPayload = typeof ThreadRealtimeClosedPayload.Type;

export const TurnStartedPayload = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
});
export type TurnStartedPayload = typeof TurnStartedPayload.Type;

export const TurnCompletedPayload = Schema.Struct({
  state: RuntimeTurnState,
  stopReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  usage: Schema.optional(Schema.Unknown),
  modelUsage: Schema.optional(UnknownRecord),
  totalCostUsd: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(TrimmedNonEmptyString),
});
export type TurnCompletedPayload = typeof TurnCompletedPayload.Type;

export const TurnAbortedPayload = Schema.Struct({ reason: TrimmedNonEmptyString });
export type TurnAbortedPayload = typeof TurnAbortedPayload.Type;

export const RuntimePlanStep = Schema.Struct({
  step: TrimmedNonEmptyString,
  status: RuntimePlanStepStatus,
});
export type RuntimePlanStep = typeof RuntimePlanStep.Type;

export const TurnPlanUpdatedPayload = Schema.Struct({
  explanation: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  plan: Schema.Array(RuntimePlanStep),
});
export type TurnPlanUpdatedPayload = typeof TurnPlanUpdatedPayload.Type;

export const TurnProposedDeltaPayload = Schema.Struct({ delta: Schema.String });
export type TurnProposedDeltaPayload = typeof TurnProposedDeltaPayload.Type;

export const TurnProposedCompletedPayload = Schema.Struct({
  planMarkdown: TrimmedNonEmptyString,
});
export type TurnProposedCompletedPayload = typeof TurnProposedCompletedPayload.Type;

export const TurnDiffUpdatedPayload = Schema.Struct({ unifiedDiff: Schema.String });
export type TurnDiffUpdatedPayload = typeof TurnDiffUpdatedPayload.Type;

export const ItemLifecyclePayload = Schema.Struct({
  itemType: CanonicalItemType,
  status: Schema.optional(RuntimeItemStatus),
  title: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  data: Schema.optional(Schema.Unknown),
});
export type ItemLifecyclePayload = typeof ItemLifecyclePayload.Type;

export const ContentDeltaPayload = Schema.Struct({
  streamKind: RuntimeContentStreamKind,
  delta: Schema.String,
  contentIndex: Schema.optional(Schema.Int),
  summaryIndex: Schema.optional(Schema.Int),
});
export type ContentDeltaPayload = typeof ContentDeltaPayload.Type;

export const RequestOpenedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  detail: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Unknown),
});
export type RequestOpenedPayload = typeof RequestOpenedPayload.Type;

export const RequestResolvedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  decision: Schema.optional(TrimmedNonEmptyString),
  resolution: Schema.optional(Schema.Unknown),
});
export type RequestResolvedPayload = typeof RequestResolvedPayload.Type;

export const UserInputRequestedPayload = Schema.Struct({
  questions: Schema.Array(UserInputQuestion),
});
export type UserInputRequestedPayload = typeof UserInputRequestedPayload.Type;

export const UserInputResolvedPayload = Schema.Struct({ answers: UnknownRecord });
export type UserInputResolvedPayload = typeof UserInputResolvedPayload.Type;

export const TaskStartedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: Schema.optional(TrimmedNonEmptyString),
  taskType: Schema.optional(TrimmedNonEmptyString),
});
export type TaskStartedPayload = typeof TaskStartedPayload.Type;

export const TaskProgressPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: TrimmedNonEmptyString,
  summary: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(Schema.Unknown),
  lastToolName: Schema.optional(TrimmedNonEmptyString),
});
export type TaskProgressPayload = typeof TaskProgressPayload.Type;

export const TaskCompletedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  summary: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(Schema.Unknown),
});
export type TaskCompletedPayload = typeof TaskCompletedPayload.Type;

export const HookStartedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyString,
  hookName: TrimmedNonEmptyString,
  hookEvent: TrimmedNonEmptyString,
});
export type HookStartedPayload = typeof HookStartedPayload.Type;

export const HookProgressPayload = Schema.Struct({
  hookId: TrimmedNonEmptyString,
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
});
export type HookProgressPayload = typeof HookProgressPayload.Type;

export const HookCompletedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyString,
  outcome: Schema.Literals(["success", "error", "cancelled"]),
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Int),
});
export type HookCompletedPayload = typeof HookCompletedPayload.Type;

export const ToolProgressPayload = Schema.Struct({
  toolUseId: Schema.optional(TrimmedNonEmptyString),
  toolName: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  elapsedSeconds: Schema.optional(Schema.Number),
});
export type ToolProgressPayload = typeof ToolProgressPayload.Type;

export const ToolSummaryPayload = Schema.Struct({
  summary: TrimmedNonEmptyString,
  precedingToolUseIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type ToolSummaryPayload = typeof ToolSummaryPayload.Type;

export const AuthStatusPayload = Schema.Struct({
  isAuthenticating: Schema.optional(Schema.Boolean),
  output: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type AuthStatusPayload = typeof AuthStatusPayload.Type;

export const AccountUpdatedPayload = Schema.Struct({ account: Schema.Unknown });
export type AccountUpdatedPayload = typeof AccountUpdatedPayload.Type;

export const AccountRateLimitsUpdatedPayload = Schema.Struct({ rateLimits: Schema.Unknown });
export type AccountRateLimitsUpdatedPayload = typeof AccountRateLimitsUpdatedPayload.Type;

export const McpStatusUpdatedPayload = Schema.Struct({ status: Schema.Unknown });
export type McpStatusUpdatedPayload = typeof McpStatusUpdatedPayload.Type;

export const McpOauthCompletedPayload = Schema.Struct({
  success: Schema.Boolean,
  name: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type McpOauthCompletedPayload = typeof McpOauthCompletedPayload.Type;

export const ModelReroutedPayload = Schema.Struct({
  fromModel: TrimmedNonEmptyString,
  toModel: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type ModelReroutedPayload = typeof ModelReroutedPayload.Type;

export const ConfigWarningPayload = Schema.Struct({
  summary: TrimmedNonEmptyString,
  details: Schema.optional(TrimmedNonEmptyString),
  path: Schema.optional(TrimmedNonEmptyString),
  range: Schema.optional(Schema.Unknown),
});
export type ConfigWarningPayload = typeof ConfigWarningPayload.Type;

export const DeprecationNoticePayload = Schema.Struct({
  summary: TrimmedNonEmptyString,
  details: Schema.optional(TrimmedNonEmptyString),
});
export type DeprecationNoticePayload = typeof DeprecationNoticePayload.Type;

export const FilesPersistedPayload = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      filename: TrimmedNonEmptyString,
      fileId: TrimmedNonEmptyString,
    }),
  ),
  failed: Schema.optional(
    Schema.Array(
      Schema.Struct({
        filename: TrimmedNonEmptyString,
        error: TrimmedNonEmptyString,
      }),
    ),
  ),
});
export type FilesPersistedPayload = typeof FilesPersistedPayload.Type;

export const RuntimeWarningPayload = Schema.Struct({
  message: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeWarningPayload = typeof RuntimeWarningPayload.Type;

export const RuntimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyString,
  class: Schema.optional(RuntimeErrorClass),
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeErrorPayload = typeof RuntimeErrorPayload.Type;

export const RequestId = RuntimeRequestId;
