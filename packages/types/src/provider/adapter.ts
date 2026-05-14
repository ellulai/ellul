// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { Effect, Stream } from "effect";
import type { ApprovalRequestId, ThreadId, TurnId } from "../ids";
import type { ProviderApprovalDecision } from "./approval";
import type { ProviderKind } from "./kind";
import type { ProviderRuntimeEvent } from "./runtime-event";
import type {
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "./session";
import type { ProviderUserInputAnswers } from "./user-input";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export interface ProviderAdapterCapabilities {
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;

  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  readonly stopAll: () => Effect.Effect<void, TError>;

  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
