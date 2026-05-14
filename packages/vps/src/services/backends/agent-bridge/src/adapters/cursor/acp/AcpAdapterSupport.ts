// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. —
// ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/provider/acp/AcpAdapterSupport.ts

import {
  type ProviderApprovalDecision,
  type ProviderKind,
  type ThreadId,
} from "@ellul.ai/types";
import { Schema } from "effect";
import * as EffectAcpErrors from "../../vendor/t3code/effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../../errors";

export function mapAcpToAdapterError(
  provider: ProviderKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (Schema.is(EffectAcpErrors.AcpProcessExitedError)(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (Schema.is(EffectAcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
