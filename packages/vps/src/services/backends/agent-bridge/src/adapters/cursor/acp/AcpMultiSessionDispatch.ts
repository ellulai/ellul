// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Multi-session dispatch layer for AcpProjectRuntime.
//
// AcpProjectRuntime registers ONE handler per ACP method on the shared
// AcpClient. Each handler delegates to the dispatch functions in this
// module, which look up the correct per-session state and route the
// request/notification.
//
// Routing rules:
//   - session/update      → by `params.sessionId`
//   - session/request_permission → by `params.sessionId`
//   - cursor extension methods (cursor/ask_question, cursor/create_plan,
//     cursor/update_todos) → by `params.toolCallId` → sessionId map
//     populated from `tool_call` session updates
//
// This module is the genuinely-novel part of the per-project pool: the
// security boundary for per-session isolation lives here. Extracted as a
// separate module so tests can drive dispatch directly with synthetic
// SessionState objects, without faking the entire AcpClient transport.

import { Effect, Queue, Ref, Stream } from "effect";

import * as EffectAcpErrors from "../../vendor/t3code/effect-acp/errors";
import type * as EffectAcpSchema from "../../vendor/t3code/effect-acp/schema";
import {
  extractModelConfigId,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel";

export interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

export interface SessionState {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly configOptionsRef: Ref.Ref<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly eventQueue: Queue.Queue<AcpParsedSessionEvent>;
  readonly closed: Ref.Ref<boolean>;
  permissionHandler:
    | ((
        params: EffectAcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>)
    | undefined;
  readonly extRequestHandlers: Map<
    string,
    (params: unknown) => Effect.Effect<unknown, EffectAcpErrors.AcpError>
  >;
  readonly extNotificationHandlers: Map<
    string,
    (params: unknown) => Effect.Effect<void, EffectAcpErrors.AcpError>
  >;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const sessionConfigOptionsFromSetup = (
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => response?.configOptions ?? [];

export const configOptionCurrentValueMatches = (
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean => {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
};

const updateModeState = (
  modeState: AcpSessionModeState,
  nextModeId: string,
): AcpSessionModeState => {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? { ...modeState, currentModeId: normalized }
    : modeState;
};

const shouldEmitToolCallUpdate = (
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): boolean => {
  if (next.status === "completed" || next.status === "failed") {
    return true;
  }
  if (!next.detail) {
    return false;
  }
  return previous === undefined || previous.title !== next.title || previous.detail !== next.detail;
};

const assistantItemId = (sessionId: string, segmentIndex: number) =>
  `assistant:${sessionId}:segment:${segmentIndex}`;

export const ensureActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
  sessionId,
}: {
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
}): Effect.Effect<string> =>
  Ref.modify<AcpAssistantSegmentState, { itemId: string; startedEvent?: AcpParsedSessionEvent }>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      const itemId = assistantItemId(sessionId, current.nextSegmentIndex);
      return [
        {
          itemId,
          startedEvent: {
            _tag: "AssistantItemStarted",
            itemId,
          },
        },
        {
          nextSegmentIndex: current.nextSegmentIndex + 1,
          activeItemId: itemId,
        },
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      result.startedEvent
        ? Queue.offer(queue, result.startedEvent).pipe(Effect.as(result.itemId))
        : Effect.succeed(result.itemId),
    ),
  );

export const closeActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
}: {
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}): Effect.Effect<void> =>
  Ref.modify(assistantSegmentRef, (current) => {
    if (!current.activeItemId) {
      return [undefined, current] as const;
    }
    return [
      {
        _tag: "AssistantItemCompleted" as const,
        itemId: current.activeItemId,
      } satisfies AcpParsedSessionEvent,
      { nextSegmentIndex: current.nextSegmentIndex } satisfies AcpAssistantSegmentState,
    ] as const;
  }).pipe(Effect.flatMap((event) => (event ? Queue.offer(queue, event) : Effect.void)));

const handleSessionUpdateForState = (input: {
  readonly state: SessionState;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { state, params } = input;
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(state.modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        yield* closeActiveAssistantSegment({
          queue: state.eventQueue,
          assistantSegmentRef: state.assistantSegmentRef,
        });
        const { previous, merged } = yield* Ref.modify(state.toolCallsRef, (current) => {
          const previous = current.get(event.toolCall.toolCallId);
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, nextToolCall);
          }
          return [{ previous, merged: nextToolCall }, next] as const;
        });
        if (!shouldEmitToolCallUpdate(previous, merged)) {
          continue;
        }
        yield* Queue.offer(state.eventQueue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.text.trim().length === 0) {
          const segmentState = yield* Ref.get(state.assistantSegmentRef);
          if (!segmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          queue: state.eventQueue,
          assistantSegmentRef: state.assistantSegmentRef,
          sessionId: params.sessionId,
        });
        yield* Queue.offer(state.eventQueue, {
          ...event,
          itemId,
        });
        continue;
      }
      yield* Queue.offer(state.eventQueue, event);
    }
  });

/**
 * Allocate per-session state synchronously. Called from
 * AcpProjectRuntime.newSession AFTER `acp.agent.createSession` returns
 * the sessionId — uses `Effect.runSync` to do the Ref/Queue allocation
 * with no yield boundaries, so an inbound session/update for this
 * sessionId CANNOT race with `sessions.set(sessionId, state)` in the
 * caller. (JS is single-threaded; no yield = no interleaving.)
 *
 * Returns a fully-initialized SessionState whose handler maps are
 * empty. The owning runtime / adapter populates the handlers
 * afterwards via `state.permissionHandler = ...`,
 * `state.extRequestHandlers.set(...)`, etc.
 */
export const makeSessionStateSync = (input: {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
}): SessionState =>
  Effect.runSync(
    Effect.gen(function* () {
      const eventQueue = yield* Queue.unbounded<AcpParsedSessionEvent>();
      const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(
        parseSessionModeState(input.sessionSetupResult),
      );
      const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
      const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({
        nextSegmentIndex: 0,
      });
      const configOptionsRef = yield* Ref.make<
        ReadonlyArray<EffectAcpSchema.SessionConfigOption>
      >(sessionConfigOptionsFromSetup(input.sessionSetupResult));
      const closed = yield* Ref.make(false);
      return {
        sessionId: input.sessionId,
        initializeResult: input.initializeResult,
        sessionSetupResult: input.sessionSetupResult,
        modelConfigId: extractModelConfigId(input.sessionSetupResult),
        modeStateRef,
        toolCallsRef,
        assistantSegmentRef,
        configOptionsRef,
        eventQueue,
        closed,
        permissionHandler: undefined,
        extRequestHandlers: new Map(),
        extNotificationHandlers: new Map(),
      } satisfies SessionState;
    }),
  );

/**
 * Dispatch a session/update notification to the right session's per-
 * session state. Notification carries `sessionId` directly. As a side
 * effect, populates `toolCallIdToSession` so subsequent cursor
 * extension methods (which carry `toolCallId` only) can be routed back
 * to the originating session.
 *
 * Notifications for unknown / closed sessions are silently dropped —
 * the upstream session/update buffer in EffectAcpClient already holds
 * notifications until our handler is registered, so the only way we
 * see an unknown sessionId here is a use-after-close, which is benign.
 */
export const dispatchSessionUpdate = (input: {
  readonly sessions: Map<string, SessionState>;
  readonly toolCallIdToSession: Map<string, string>;
  readonly notification: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sess = input.sessions.get(input.notification.sessionId);
    if (!sess || (yield* Ref.get(sess.closed))) return;

    const upd = input.notification.update;
    if (upd.sessionUpdate === "tool_call" || upd.sessionUpdate === "tool_call_update") {
      const tcId = (upd as { toolCallId?: unknown }).toolCallId;
      if (typeof tcId === "string" && tcId.length > 0) {
        input.toolCallIdToSession.set(tcId, input.notification.sessionId);
      }
    }

    yield* handleSessionUpdateForState({ state: sess, params: input.notification });
  });

/**
 * Dispatch a session/request_permission RPC by `params.sessionId` to
 * the matching session's registered permission handler. Fails the RPC
 * with a clear error when the session is unknown / closed / has no
 * handler yet — the agent will surface the error to the user rather
 * than hanging.
 */
export const dispatchRequestPermission = (input: {
  readonly sessions: Map<string, SessionState>;
  readonly params: EffectAcpSchema.RequestPermissionRequest;
}): Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const sess = input.sessions.get(input.params.sessionId);
    if (!sess) {
      return yield* Effect.fail(
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Unknown session for request_permission: ${input.params.sessionId}`,
        ),
      );
    }
    if (yield* Ref.get(sess.closed)) {
      return yield* Effect.fail(
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Session ${input.params.sessionId} is closed`,
        ),
      );
    }
    if (!sess.permissionHandler) {
      return yield* Effect.fail(
        EffectAcpErrors.AcpRequestError.internalError(
          `No permission handler registered for session ${input.params.sessionId}`,
        ),
      );
    }
    return yield* sess.permissionHandler(input.params);
  });

/**
 * Dispatch a cursor extension request (cursor/ask_question,
 * cursor/create_plan, etc.) by `params.toolCallId` → sessionId. Fails
 * if the toolCallId is absent / unknown / points to a closed session,
 * or if the session has no handler registered for `method`.
 */
export const dispatchUnknownExtRequest = (input: {
  readonly sessions: Map<string, SessionState>;
  readonly toolCallIdToSession: Map<string, string>;
  readonly method: string;
  readonly params: unknown;
}): Effect.Effect<unknown, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const tcId =
      isRecord(input.params) &&
      typeof input.params.toolCallId === "string" &&
      input.params.toolCallId.length > 0
        ? input.params.toolCallId
        : undefined;
    if (!tcId) {
      return yield* Effect.fail(
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Ext request ${input.method} requires toolCallId for session routing`,
        ),
      );
    }
    const sessionId = input.toolCallIdToSession.get(tcId);
    if (!sessionId) {
      return yield* Effect.fail(
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Unknown toolCallId for ext request ${input.method}: ${tcId}`,
        ),
      );
    }
    const sess = input.sessions.get(sessionId);
    if (!sess || (yield* Ref.get(sess.closed))) {
      return yield* Effect.fail(
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Session ${sessionId} is closed (ext request ${input.method})`,
        ),
      );
    }
    const handler = sess.extRequestHandlers.get(input.method);
    if (!handler) {
      return yield* Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound(input.method));
    }
    return yield* handler(input.params);
  });

/**
 * Dispatch a cursor extension notification by toolCallId → sessionId.
 * Notifications for unknown toolCallId / closed session / unregistered
 * method are silently dropped (notifications can't fail in JSON-RPC).
 */
export const dispatchUnknownExtNotification = (input: {
  readonly sessions: Map<string, SessionState>;
  readonly toolCallIdToSession: Map<string, string>;
  readonly method: string;
  readonly params: unknown;
}): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const tcId =
      isRecord(input.params) &&
      typeof input.params.toolCallId === "string" &&
      input.params.toolCallId.length > 0
        ? input.params.toolCallId
        : undefined;
    if (!tcId) return;
    const sessionId = input.toolCallIdToSession.get(tcId);
    if (!sessionId) return;
    const sess = input.sessions.get(sessionId);
    if (!sess || (yield* Ref.get(sess.closed))) return;
    const handler = sess.extNotificationHandlers.get(input.method);
    if (handler) {
      yield* handler(input.params);
    }
  });

/**
 * Mark a session closed in-place. Drops it from the sessions map, drops
 * every toolCallIdToSession entry pointing to this session (so a stale
 * toolCallId can't route to it post-close), shuts down the event
 * queue. Idempotent: a second close is a no-op.
 *
 * Intentionally returns `Effect<void, never>` — close paths must not
 * propagate errors. Caller can issue a best-effort `agent.closeSession`
 * RPC separately.
 */
export const closeSessionInState = (input: {
  readonly sessions: Map<string, SessionState>;
  readonly toolCallIdToSession: Map<string, string>;
  readonly sessionId: string;
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const sess = input.sessions.get(input.sessionId);
    if (!sess) return;
    if (yield* Ref.getAndSet(sess.closed, true)) return;
    input.sessions.delete(input.sessionId);
    for (const [tcId, sId] of input.toolCallIdToSession) {
      if (sId === input.sessionId) input.toolCallIdToSession.delete(tcId);
    }
    yield* Queue.shutdown(sess.eventQueue);
  });

/**
 * Convenience: open a Stream over a session's event queue. Used by
 * AcpSessionHandle.getEvents().
 */
export const sessionEventStream = (
  state: SessionState,
): Stream.Stream<AcpParsedSessionEvent, never> => Stream.fromQueue(state.eventQueue);
