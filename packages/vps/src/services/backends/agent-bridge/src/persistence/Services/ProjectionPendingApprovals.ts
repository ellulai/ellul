// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/persistence/Services/ProjectionPendingApprovals.ts

import {
  ApprovalRequestId,
  IsoDateTime,
  ProjectionPendingApprovalDecision,
  ProjectionPendingApprovalStatus,
  ThreadId,
  TurnId,
} from "@ellul.ai/types";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors";

export const ProjectionPendingApproval = Schema.Struct({
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  status: ProjectionPendingApprovalStatus,
  decision: ProjectionPendingApprovalDecision,
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionPendingApproval = typeof ProjectionPendingApproval.Type;

export const ListProjectionPendingApprovalsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionPendingApprovalsInput = typeof ListProjectionPendingApprovalsInput.Type;

export const GetProjectionPendingApprovalInput = Schema.Struct({
  requestId: ApprovalRequestId,
});
export type GetProjectionPendingApprovalInput = typeof GetProjectionPendingApprovalInput.Type;

export const DeleteProjectionPendingApprovalInput = Schema.Struct({
  requestId: ApprovalRequestId,
});
export type DeleteProjectionPendingApprovalInput = typeof DeleteProjectionPendingApprovalInput.Type;

export interface ProjectionPendingApprovalRepositoryShape {
  readonly upsert: (
    row: ProjectionPendingApproval,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionPendingApprovalsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionPendingApproval>, ProjectionRepositoryError>;
  readonly getByRequestId: (
    input: GetProjectionPendingApprovalInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingApproval>, ProjectionRepositoryError>;
  readonly deleteByRequestId: (
    input: DeleteProjectionPendingApprovalInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionPendingApprovalRepository extends Context.Service<
  ProjectionPendingApprovalRepository,
  ProjectionPendingApprovalRepositoryShape
>()("t3/persistence/Services/ProjectionPendingApprovals/ProjectionPendingApprovalRepository") {}
