// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  TrimmedNonEmptyString,
  type OrchestrationThreadActivity,
  type OrchestrationThreadActivityTone,
  type ThreadId,
} from "@ellul.ai/types";
import { Effect } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";

export interface AppendActivityInput {
  readonly threadId: ThreadId;
  readonly tone: OrchestrationThreadActivityTone;
  readonly kind: string;
  readonly summary: string;
  readonly payload?: unknown;
}

export const appendActivity = (input: AppendActivityInput) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const now = IsoDateTime.make(new Date().toISOString());
    const activity: OrchestrationThreadActivity = {
      id: EventId.make(crypto.randomUUID()),
      tone: input.tone,
      kind: TrimmedNonEmptyString.make(input.kind),
      summary: TrimmedNonEmptyString.make(input.summary),
      payload: input.payload ?? null,
      turnId: null,
      createdAt: now,
    };
    return yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:activity:${crypto.randomUUID()}`),
      threadId: input.threadId,
      activity,
      createdAt: now,
    });
  });

export interface StartContinuationTurnInput {
  readonly threadId: ThreadId;
  readonly text: string;
}

export const startContinuationTurn = (input: StartContinuationTurnInput) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const now = IsoDateTime.make(new Date().toISOString());
    return yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:continue:${crypto.randomUUID()}`),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(crypto.randomUUID()),
        role: "user",
        text: input.text,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now,
    });
  });
