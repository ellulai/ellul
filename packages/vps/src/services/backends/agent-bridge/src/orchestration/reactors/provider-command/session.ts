// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/ProviderCommandReactor.ts

import {
  EventId,
  ProviderKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationSession,
  type ProviderSession,
  type ThreadId,
  type TurnId,
} from "@ellul.ai/types";
import { Effect, Equal, Schema } from "effect";

import type { ProviderServiceShape } from "../../../adapters/provider-service";
import { debugLog as debugLogBase } from "./helpers";

const debugLog = (msg: string): void => debugLogBase(msg, "[session]");
import { resolveThreadWorkspaceCwd } from "../../../checkpointing/Utils";
import { resolveActiveAppPath } from "@vps/shared/app-workspace";
import type { OrchestrationEngineShape } from "../../Services/OrchestrationEngine";
import {
  mapProviderSessionStatusToOrchestrationStatus,
  serverCommandId,
  toNonEmptyProviderInput,
} from "./helpers";

export const makeSessionHelpers = (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly threadModelSelections: Map<string, ModelSelection>;
}) => {
  const { orchestrationEngine, providerService, threadModelSelections } = input;

  const appendProviderFailureActivity = (args: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: args.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: args.kind,
        summary: args.summary,
        payload: {
          detail: args.detail,
          ...(args.requestId ? { requestId: args.requestId } : {}),
        },
        turnId: args.turnId,
        createdAt: args.createdAt,
      },
      createdAt: args.createdAt,
    });

  const setThreadSession = (args: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: args.threadId,
      session: args.session,
      createdAt: args.createdAt,
    });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (args: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(args.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }
    yield* setThreadSession({
      threadId: args.threadId,
      session: {
        ...session,
        status: session.status === "stopped" ? "stopped" : "ready",
        activeTurnId: null,
        lastError: args.detail,
        updatedAt: args.createdAt,
      },
      createdAt: args.createdAt,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
    },
  ) {
    debugLog(`ensureSessionForThread ENTER thread=${threadId}`);
    const readModel = yield* orchestrationEngine.getReadModel();
    debugLog(`ensureSessionForThread got readModel thread=${threadId}`);
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      debugLog(`ensureSessionForThread NO-THREAD thread=${threadId}`);
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }
    debugLog(`ensureSessionForThread found thread, currentProvider=${thread.session?.providerName ?? "none"}`);

    const desiredRuntimeMode = thread.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      thread.session?.providerName,
    )
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const preferredProvider: ProviderKind =
      requestedModelSelection?.provider ?? currentProvider ?? thread.modelSelection.provider;
    const providerChanged =
      currentProvider !== undefined && preferredProvider !== currentProvider;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const rawCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    const baseCwd = (() => {
      if (!rawCwd) return rawCwd;
      try {
        return resolveActiveAppPath(rawCwd) ?? rawCwd;
      } catch {
        return rawCwd;
      }
    })();
    const effectiveCwd = baseCwd && thread.viewScope ? `${baseCwd}/${thread.viewScope}` : baseCwd;

    const resolveActiveSession = (tid: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === tid)));

    const startProviderSession = (startInput?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      Effect.gen(function* () {
        debugLog(`startProviderSession ENTER thread=${threadId} provider=${preferredProvider} model=${JSON.stringify(desiredModelSelection)}`);
        const result = yield* providerService.startSession(threadId, {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          modelSelection: desiredModelSelection,
          ...(startInput?.resumeCursor !== undefined
            ? { resumeCursor: startInput.resumeCursor }
            : {}),
          runtimeMode: desiredRuntimeMode,
        });
        debugLog(`startProviderSession RESOLVED thread=${threadId} sessionStatus=${result.status}`);
        return result;
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status: mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    debugLog(`ensureSessionForThread resolving active session thread=${threadId}`);
    const activeSession = yield* resolveActiveSession(threadId);
    debugLog(`ensureSessionForThread activeSession=${activeSession ? activeSession.threadId : "none"} threadSessionStatus=${thread.session?.status ?? "none"}`);
    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      debugLog(`ensureSessionForThread RESTART path thread=${threadId}`);
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        currentProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange &&
        !providerChanged
      ) {
        return existingSessionThreadId;
      }

      if (providerChanged) {
        yield* Effect.logInfo("provider command reactor switching provider", {
          threadId,
          previousProvider: currentProvider,
          nextProvider: preferredProvider,
        });
        yield* providerService.stopSession({ threadId });
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: currentProvider ?? null,
            runtimeMode: thread.session?.runtimeMode ?? desiredRuntimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
      }

      const resumeCursor =
        shouldRestartForModelChange || providerChanged
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: preferredProvider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        providerChanged,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    debugLog(`ensureSessionForThread NEW path (no existing) thread=${threadId}`);
    const startedSession = yield* startProviderSession(undefined);
    debugLog(`ensureSessionForThread binding new session thread=${threadId}`);
    yield* bindSessionToThread(startedSession);
    debugLog(`ensureSessionForThread bound session, returning thread=${threadId}`);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (args: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    debugLog(`buildSendTurnRequestForThread ENTER thread=${args.threadId}`);
    const thread = yield* resolveThread(args.threadId);
    if (!thread) {
      debugLog(`buildSendTurnRequestForThread NO-THREAD thread=${args.threadId}`);
      return yield* Effect.die(
        new Error(`Thread '${args.threadId}' was not found in read model.`),
      );
    }
    debugLog(`buildSendTurnRequestForThread calling ensureSessionForThread thread=${args.threadId}`);
    yield* ensureSessionForThread(
      args.threadId,
      args.createdAt,
      args.modelSelection !== undefined ? { modelSelection: args.modelSelection } : {},
    );
    debugLog(`buildSendTurnRequestForThread ensureSessionForThread done thread=${args.threadId}`);
    if (args.modelSelection !== undefined) {
      threadModelSelections.set(args.threadId, args.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(args.messageText);
    const normalizedAttachments = args.attachments ?? [];
    debugLog(`buildSendTurnRequestForThread listing sessions thread=${args.threadId}`);
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) =>
          sessions.find((session) => session.threadId === args.threadId),
        ),
      );
    debugLog(`buildSendTurnRequestForThread activeSession=${activeSession ? activeSession.provider : "none"} thread=${args.threadId}`);
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    debugLog(`buildSendTurnRequestForThread building request, returning thread=${args.threadId}`);
    const requestedModelSelection =
      args.modelSelection ?? threadModelSelections.get(args.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && args.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : args.modelSelection;

    return {
      threadId: args.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(args.interactionMode !== undefined ? { interactionMode: args.interactionMode } : {}),
    };
  });

  return {
    appendProviderFailureActivity,
    setThreadSession,
    resolveThread,
    setThreadSessionErrorOnTurnStartFailure,
    ensureSessionForThread,
    buildSendTurnRequestForThread,
  };
};

export type SessionHelpers = ReturnType<typeof makeSessionHelpers>;
