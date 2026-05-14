// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/ProviderCommandReactor.ts

import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type RuntimeMode,
} from "@ellul.ai/types";
import { Cause, Duration, Schema } from "effect";

import {
  ProviderAdapterRequestError,
  type ProviderServiceError,
} from "../../../adapters/errors";

export { debugLog, DEBUG_LOG_PATH } from "../../../shared/debug-log";

export type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

export function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

export const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

export const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

export const HANDLED_TURN_START_KEY_MAX = 10_000;
export const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return Schema.is(ProviderAdapterRequestError)(failReason?.error) ? failReason.error : undefined;
}

export function isUnknownPendingApprovalRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

export function isUnknownPendingUserInputRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

export function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

export function formatFailureDetail(cause: Cause.Cause<unknown>): string {
  const failReason = cause.reasons.find(Cause.isFailReason);
  const providerError = Schema.is(ProviderAdapterRequestError)(failReason?.error)
    ? failReason.error
    : undefined;
  if (providerError) {
    return providerError.detail;
  }
  return Cause.pretty(cause);
}
