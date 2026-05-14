// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/ProviderCommandReactor.ts

import type { ModelSelection, ThreadId } from "@ellul.ai/types";
import { Cause, Effect, Option } from "effect";

import type { ProviderServiceShape } from "../../../adapters/provider-service";
import { debugLog } from "./helpers";
import { resolveThreadWorkspaceCwd } from "../../../checkpointing/Utils";
import type { ServerSettingsShape } from "../../../shared/serverSettings";
import type { TextGenerationShape } from "../../../text-generation";
import type { OrchestrationEngineShape } from "../../Services/OrchestrationEngine";
import {
  DEFAULT_RUNTIME_MODE,
  formatFailureDetail,
  isUnknownPendingApprovalRequestError,
  isUnknownPendingUserInputRequestError,
  serverCommandId,
  stalePendingRequestDetail,
  turnStartKeyForEvent,
  type ProviderIntentEvent,
} from "./helpers";
import type { SessionHelpers } from "./session";

const DEFAULT_THREAD_TITLE = "New thread";

const canReplaceThreadTitle = (currentTitle: string): boolean =>
  currentTitle.trim() === DEFAULT_THREAD_TITLE;

type HandledTurnStartKeysCache = {
  readonly has: (key: string) => Effect.Effect<boolean>;
};

export const makeEventHandlers = (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly serverSettingsService: ServerSettingsShape;
  readonly textGeneration: TextGenerationShape;
  readonly session: SessionHelpers;
  readonly threadModelSelections: Map<string, ModelSelection>;
  readonly handledTurnStartKeys: HandledTurnStartKeysCache;
}) => {
  const {
    orchestrationEngine,
    providerService,
    textGeneration,
    session,
    threadModelSelections,
    handledTurnStartKeys,
  } = input;

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (args: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
    }) {
      const thread = yield* session.resolveThread(args.threadId);
      if (!thread) return;
      const readModel = yield* orchestrationEngine.getReadModel();
      const project = readModel.projects.find((entry) => entry.id === thread.projectId);
      if (!project) return;
      const result = yield* textGeneration.generateThreadTitle({
        projectId: thread.projectId,
        cwd: args.cwd,
        message: args.messageText,
      });
      if (!result.title) return;
      const current = yield* session.resolveThread(args.threadId);
      if (!current || !canReplaceThreadTitle(current.title)) return;
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("thread-title-rename"),
        threadId: args.threadId,
        title: result.title,
      });
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    debugLog(`processTurnStartRequested ENTER thread=${event.payload.threadId} model=${JSON.stringify(event.payload.modelSelection ?? null)}`);
    const key = turnStartKeyForEvent(event);
    if (yield* handledTurnStartKeys.has(key)) {
      debugLog(`processTurnStartRequested SKIP already-handled thread=${event.payload.threadId}`);
      return;
    }

    const thread = yield* session.resolveThread(event.payload.threadId);
    if (!thread) {
      debugLog(`processTurnStartRequested NO-THREAD thread=${event.payload.threadId}`);
      return;
    }
    debugLog(`processTurnStartRequested resolved thread, calling buildSendTurnRequestForThread`);

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* session.appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn && canReplaceThreadTitle(thread.title)) {
      const readModel = yield* orchestrationEngine.getReadModel();
      const generationCwd = resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      });
      if (generationCwd) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          messageText: message.text,
        })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("thread title generation failed", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
            Effect.forkScoped,
          );
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      const fullCause = Cause.pretty(cause);
      const failReason = cause.reasons.find(Cause.isFailReason);
      const errTag =
        failReason?.error && typeof failReason.error === "object" && failReason.error !== null
          ? ((failReason.error as { _tag?: unknown })._tag ?? "(no _tag)")
          : "(no failReason)";
      debugLog(
        `handleTurnStartFailure thread=${event.payload.threadId} detail=${detail} errTag=${errTag} fullCause=${fullCause.slice(0, 1500)}`,
      );
      return session
        .setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          detail,
          createdAt: event.payload.createdAt,
        })
        .pipe(
          Effect.flatMap(() =>
            session.appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              detail,
              turnId: null,
              createdAt: event.payload.createdAt,
            }),
          ),
          Effect.asVoid,
        );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const sendTurnRequest = yield* session
      .buildSendTurnRequestForThread({
        threadId: event.payload.threadId,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        interactionMode: event.payload.interactionMode,
        createdAt: event.payload.createdAt,
      })
      .pipe(
        Effect.map(Option.some),
        Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
      );

    if (Option.isNone(sendTurnRequest)) {
      debugLog(`processTurnStartRequested sendTurnRequest=NONE (build failed) thread=${event.payload.threadId}`);
      return;
    }
    debugLog(`processTurnStartRequested sendTurnRequest=SOME, calling providerService.sendTurn`);

    yield* providerService
      .sendTurn(sendTurnRequest.value)
      .pipe(
        Effect.tap(() => Effect.sync(() => debugLog(`providerService.sendTurn RESOLVED thread=${event.payload.threadId}`))),
        Effect.catchCause(recoverTurnStartFailure),
        Effect.forkScoped,
      );
    debugLog(`processTurnStartRequested EXIT (forked sendTurn) thread=${event.payload.threadId}`);
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* session.resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* session.appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
    ) {
      const thread = yield* session.resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* session.appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.approval.respond.failed",
          summary: "Provider approval response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToRequest({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          decision: event.payload.decision,
        })
        .pipe(
          Effect.catchCause((cause) =>
            session.appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* session.resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* session.appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            session.appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* session.resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* session.setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processRuntimeModeSet = Effect.fn("processRuntimeModeSet")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.runtime-mode-set" }>,
  ) {
    const thread = yield* session.resolveThread(event.payload.threadId);
    if (!thread?.session || thread.session.status === "stopped") {
      return;
    }
    const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
    yield* session.ensureSessionForThread(
      event.payload.threadId,
      event.occurredAt,
      cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
    );
  });

  return {
    processTurnStartRequested,
    processTurnInterruptRequested,
    processApprovalResponseRequested,
    processUserInputResponseRequested,
    processSessionStopRequested,
    processRuntimeModeSet,
  };
};

export type EventHandlers = ReturnType<typeof makeEventHandlers>;
