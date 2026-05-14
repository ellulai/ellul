// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 packages/contracts/src/orchestration.ts

import { Effect, Schema } from "effect";
import { ChatAttachment } from "../chat/attachment";
import { OrchestrationMessageRole } from "../chat/message";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../ids";
import { ProviderApprovalDecision } from "../provider/approval";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInteractionMode,
  RuntimeMode,
} from "../provider/interaction";
import { ProviderUserInputAnswers } from "../provider/user-input";
import { ModelSelection } from "../model/selection";
import { OrchestrationThreadActivity } from "./activity";
import {
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
} from "./checkpoint";
import {
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
} from "./project";
import {
  OrchestrationProposedPlan,
  SourceProposedPlanReference,
} from "./proposed-plan";
import {
  SandboxAggregateId,
  SandboxModelPinnedPayload,
  SandboxModelUnpinnedPayload,
} from "./sandbox";
import { OrchestrationSession } from "./session";

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread", "sandbox"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;

export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);
export type OrchestrationActorKind = typeof OrchestrationActorKind.Type;

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  viewScope: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

export const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, SandboxAggregateId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

const ev = <const T extends string, P extends Schema.Top>(type: T, payload: P) =>
  Schema.Struct({ ...EventBaseFields, type: Schema.Literal(type), payload });

export const OrchestrationEvent = Schema.Union([
  ev("project.created", ProjectCreatedPayload),
  ev("project.meta-updated", ProjectMetaUpdatedPayload),
  ev("project.deleted", ProjectDeletedPayload),
  ev("thread.created", ThreadCreatedPayload),
  ev("thread.deleted", ThreadDeletedPayload),
  ev("thread.archived", ThreadArchivedPayload),
  ev("thread.unarchived", ThreadUnarchivedPayload),
  ev("thread.meta-updated", ThreadMetaUpdatedPayload),
  ev("thread.runtime-mode-set", ThreadRuntimeModeSetPayload),
  ev("thread.interaction-mode-set", ThreadInteractionModeSetPayload),
  ev("thread.message-sent", ThreadMessageSentPayload),
  ev("thread.turn-start-requested", ThreadTurnStartRequestedPayload),
  ev("thread.turn-interrupt-requested", ThreadTurnInterruptRequestedPayload),
  ev("thread.approval-response-requested", ThreadApprovalResponseRequestedPayload),
  ev("thread.user-input-response-requested", ThreadUserInputResponseRequestedPayload),
  ev("thread.checkpoint-revert-requested", ThreadCheckpointRevertRequestedPayload),
  ev("thread.reverted", ThreadRevertedPayload),
  ev("thread.session-stop-requested", ThreadSessionStopRequestedPayload),
  ev("thread.session-set", ThreadSessionSetPayload),
  ev("thread.proposed-plan-upserted", ThreadProposedPlanUpsertedPayload),
  ev("thread.turn-diff-completed", ThreadTurnDiffCompletedPayload),
  ev("thread.activity-appended", ThreadActivityAppendedPayload),
  ev("sandbox.model-pinned", SandboxModelPinnedPayload),
  ev("sandbox.model-unpinned", SandboxModelUnpinnedPayload),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "sandbox.model-pinned",
  "sandbox.model-unpinned",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;
