// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Schema } from "effect";
import { EventId, IsoDateTime, NonNegativeInt, TrimmedNonEmptyString, TurnId } from "../ids";

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

// Ellul-only activity kinds — shield gates (deploy, git push, env/logs/db)
// and self-heal flows. Upstream has no equivalent concept; see
// docs/v2/operations/04-runbooks/upstream-sync.md deviations for rationale.
export const ELLUL_ACTIVITY_KINDS = {
  deployRequested: "deploy.requested",
  deployApproved: "deploy.approved",
  deployDenied: "deploy.denied",
  deployProgress: "deploy.progress",
  deployResult: "deploy.result",
  gitPushRequested: "gitPush.requested",
  gitPushApproved: "gitPush.approved",
  gitPushDenied: "gitPush.denied",
  gitPushProgress: "gitPush.progress",
  gitPushResult: "gitPush.result",
  gateRequested: "gate.requested",
  gateGranted: "gate.granted",
  gateDenied: "gate.denied",
  previewError: "previewError.reported",
  openapiMissing: "openapiMissing.reported",
  exposureAlert: "exposure.alerted",
} as const;
export type EllulActivityKind =
  (typeof ELLUL_ACTIVITY_KINDS)[keyof typeof ELLUL_ACTIVITY_KINDS];
