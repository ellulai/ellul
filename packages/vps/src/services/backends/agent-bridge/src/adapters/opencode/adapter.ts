// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/provider/Layers/OpenCodeAdapter.ts

import { randomUUID } from "node:crypto";

import { debugLog as debugLogBase } from "../../shared/debug-log";

const debugLog = (msg: string): void => debugLogBase(msg, "[opencode-adapter]");

import {
  EventId,
  type ProviderAdapterShape,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
  sandboxIdFromCwd,
} from "@ellul.ai/types";
import { Cause, Context, Effect, Exit, Layer, Queue, Ref, Scope, Stream } from "effect";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";

import { resolveAttachmentPath } from "../../shared/attachmentStore";
import { ServerConfig } from "../../shared/config";
import { ServerSettingsService } from "../../shared/serverSettings";
import { NAMESPACE_PROJECT_ENV } from "../../shared/namespace-spawner";
import { setupNamespace } from "../../application/namespace/NamespaceSpawn";
import { refreshProjectContext } from "../../application/reconciliation/ZeroclawAgent";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../event-logger";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../errors";
import { detectVersionSignal, emitVersionSignal } from "../../shared/adapterVersionDetector";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
} from "./runtime";
import {
  OPENCODE_DEFAULT_MODE_SYSTEM,
  OPENCODE_PLAN_MODE_SYSTEM,
} from "./developer-instructions";
import { OpenCodeServerPool, type CrashCallback } from "./server-pool";
import { WarmSessionPool } from "./warm-session-pool";

const PROVIDER = "opencode" as const;
const OPENCODE_RESUME_VERSION = 1;

function parseOpenCodeResume(raw: unknown): { sessionId: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const cursor = raw as Record<string, unknown>;
  if (cursor.schemaVersion !== OPENCODE_RESUME_VERSION) return undefined;
  if (typeof cursor.sessionId !== "string" || !cursor.sessionId.trim()) return undefined;
  return { sessionId: cursor.sessionId.trim() };
}

export interface OpenCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
}

export class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "ellul/adapters/OpenCodeAdapter",
) {}

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly directory: string;
  readonly openCodeSessionId: string;
  // Identifies this session inside the project's server pool entry.
  // Distinct from openCodeSessionId because release() must work even if
  // session.create races against pool teardown (we register before the
  // SDK call). Use threadId-bound UUID minted at startSession time.
  readonly poolSessionId: string;
  // The project owning the pooled server. null for an externally
  // configured serverUrl — those bypass the pool entirely.
  readonly project: string | null;
  // Server generation at acquire time. Bumps on respawn-after-crash so
  // tests and event logs can distinguish a crash-then-recover from a
  // multiplexed reuse.
  readonly poolGeneration: number;
  readonly external: boolean;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  // Fallback for session.idle when session.status:idle already cleared
  // activeTurnId (opencode 1.14 fires both back-to-back).
  lastActiveTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

export interface OpenCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function nowIso(): string {
  return new Date().toISOString();
}

const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError => {
  const detail = OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause);
  let displayDetail = detail;
  if (typeof detail === "string") {
    const vs = detectVersionSignal("opencode", detail, undefined);
    if (vs) {
      emitVersionSignal(vs).catch(() => {});
      displayDetail = "OpenCode needs an update — your server is updating automatically. Please retry in ~30 seconds.";
    }
  }
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: displayDetail,
    cause,
  });
};

function buildEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
> {
  return {
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: "opencode.sdk.event",
            payload: input.raw,
          },
        }
      : {}),
  };
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  // Ref.getUnsafe is atomic; keeps this callable from both sync helpers and Effect bodies.
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  })) as ReadonlyArray<UserInputQuestion>;
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function suffixPrefixOverlap(text: string, delta: string): number {
  const maxLength = Math.min(text.length, delta.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(delta.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta));
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit,
  };
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

export function makeOpenCodeAdapterLive(options?: OpenCodeAdapterLiveOptions) {
  return Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverPool = yield* OpenCodeServerPool;
      const warmSessionPool = yield* WarmSessionPool;

      const releasePoolEntry = (context: OpenCodeSessionContext): Effect.Effect<void, never> => {
        if (context.external || context.project === null) return Effect.void;
        return serverPool.release({
          project: context.project,
          sessionId: context.poolSessionId,
        });
      };

      const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
        context: OpenCodeSessionContext,
      ) {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }

        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.ignore({ log: true }));

        // Release before closing the local scope — the pool may keep the
        // server warm for the next thread; closing the scope first is fine
        // (it owns no spawn) but releasing first keeps the event log
        // ordered.
        yield* releasePoolEntry(context);

        yield* Scope.close(context.sessionScope, Exit.void);
      });
      const nativeEventLogger =
        options?.nativeEventLogger ??
        (options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
              stream: "native",
            })
          : undefined);
      const managedNativeEventLogger =
        options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, OpenCodeSessionContext>();

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
          if (managedNativeEventLogger !== undefined) {
            yield* managedNativeEventLogger.close();
          }
        }),
      );

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
      const writeNativeEvent = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
      const writeNativeEventBestEffort = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

      const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
        context: OpenCodeSessionContext,
        message: string,
        options?: { readonly recoverable?: boolean },
      ) {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        const recoverable = options?.recoverable ?? false;
        const turnId = context.activeTurnId;
        sessions.delete(context.session.threadId);
        yield* emit({
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "runtime.error",
          payload: {
            message,
            class: "transport_error",
          },
        }).pipe(Effect.ignore);
        yield* emit({
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "session.exited",
          payload: {
            reason: message,
            recoverable,
            exitKind: "error",
          },
        }).pipe(Effect.ignore);
        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.ignore({ log: true }));
        // Pool may have already removed the entry on its own crash path;
        // release is a no-op in that case.
        yield* releasePoolEntry(context);
        yield* Scope.close(context.sessionScope, Exit.void);
      });

      const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
        context: OpenCodeSessionContext,
        part: Part,
        turnId: TurnId | undefined,
        raw: unknown,
      ) {
        const text = textFromPart(part);
        if (text === undefined) {
          return;
        }
        const previousText = context.emittedTextByPartId.get(part.id);
        const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
        context.emittedTextByPartId.set(part.id, latestText);
        if (latestText !== text) {
          context.partById.set(
            part.id,
            (part.type === "text" || part.type === "reasoning"
              ? { ...part, text: latestText }
              : part) satisfies Part,
          );
        }
        if (deltaToEmit.length > 0) {
          yield* emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
              createdAt:
                part.type === "text" || part.type === "reasoning"
                  ? isoFromEpochMs(part.time?.start)
                  : undefined,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: resolveTextStreamKind(part),
              delta: deltaToEmit,
            },
          });
        }

        if (
          part.type === "text" &&
          part.time?.end !== undefined &&
          !context.completedAssistantPartIds.has(part.id)
        ) {
          context.completedAssistantPartIds.add(part.id);
          yield* emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
              createdAt: isoFromEpochMs(part.time.end),
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(latestText.length > 0 ? { detail: latestText } : {}),
            },
          });
        }
      });

      const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
        context: OpenCodeSessionContext,
        event: OpenCodeSubscribedEvent,
      ) {
        const payloadSessionId =
          "properties" in event
            ? (event.properties as { sessionID?: unknown }).sessionID
            : undefined;
        debugLog(
          `handleSubscribedEvent type=${event.type} payloadSession=${String(payloadSessionId)} ourSession=${context.openCodeSessionId}`,
        );
        if (payloadSessionId !== context.openCodeSessionId) {
          return;
        }

        const turnId = context.activeTurnId;
        yield* writeNativeEventBestEffort(context.session.threadId, {
          observedAt: nowIso(),
          event: {
            provider: PROVIDER,
            threadId: context.session.threadId,
            providerThreadId: context.openCodeSessionId,
            type: event.type,
            ...(turnId ? { turnId } : {}),
            payload: event,
          },
        });

        switch (event.type) {
          case "message.updated": {
            context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
            if (event.properties.info.role === "assistant") {
              for (const part of context.partById.values()) {
                if (part.messageID !== event.properties.info.id) {
                  continue;
                }
                yield* emitAssistantTextDelta(context, part, turnId, event);
              }
            }
            break;
          }

          case "message.removed": {
            context.messageRoleById.delete(event.properties.messageID);
            break;
          }

          case "message.part.delta": {
            const existingPart = context.partById.get(event.properties.partID);
            if (!existingPart) {
              break;
            }
            const role = messageRoleForPart(context, existingPart);
            if (role !== "assistant") {
              break;
            }
            const streamKind = resolveTextStreamKind(existingPart);
            const delta = event.properties.delta;
            if (delta.length === 0) {
              break;
            }
            const previousText =
              context.emittedTextByPartId.get(event.properties.partID) ??
              textFromPart(existingPart) ??
              "";
            const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
            if (deltaToEmit.length === 0) {
              break;
            }
            context.emittedTextByPartId.set(event.properties.partID, nextText);
            if (existingPart.type === "text" || existingPart.type === "reasoning") {
              context.partById.set(event.properties.partID, {
                ...existingPart,
                text: nextText,
              });
            }
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.partID,
                raw: event,
              }),
              type: "content.delta",
              payload: {
                streamKind,
                delta: deltaToEmit,
              },
            });
            break;
          }

          case "message.part.updated": {
            const part = event.properties.part;
            context.partById.set(part.id, part);
            const messageRole = messageRoleForPart(context, part);

            if (messageRole === "assistant") {
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }

            if (part.type === "tool") {
              const itemType = toToolLifecycleItemType(part.tool);
              const title =
                part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
              const detail = detailFromToolPart(part);
              const payload = {
                itemType,
                ...(part.state.status === "error"
                  ? { status: "failed" as const }
                  : part.state.status === "completed"
                    ? { status: "completed" as const }
                    : { status: "inProgress" as const }),
                ...(title ? { title } : {}),
                ...(detail ? { detail } : {}),
                data: {
                  tool: part.tool,
                  state: part.state,
                },
              };
              const runtimeEvent: ProviderRuntimeEvent = {
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: part.callID,
                  createdAt: toolStateCreatedAt(part),
                  raw: event,
                }),
                type:
                  part.state.status === "pending"
                    ? "item.started"
                    : part.state.status === "completed" || part.state.status === "error"
                      ? "item.completed"
                      : "item.updated",
                payload,
              } as ProviderRuntimeEvent;
              appendTurnItem(context, turnId, part);
              yield* emit(runtimeEvent);
            }
            break;
          }

          case "permission.asked": {
            context.pendingPermissions.set(event.properties.id, event.properties);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.id,
                raw: event,
              }),
              type: "request.opened",
              payload: {
                requestType: mapPermissionToRequestType(event.properties.permission),
                detail:
                  event.properties.patterns.length > 0
                    ? event.properties.patterns.join("\n")
                    : event.properties.permission,
                args: event.properties.metadata,
              },
            });
            break;
          }

          case "permission.replied": {
            context.pendingPermissions.delete(event.properties.requestID);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "request.resolved",
              payload: {
                requestType: "unknown",
                decision: mapPermissionDecision(event.properties.reply),
              },
            });
            break;
          }

          case "question.asked": {
            context.pendingQuestions.set(event.properties.id, event.properties);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.id,
                raw: event,
              }),
              type: "user-input.requested",
              payload: {
                questions: normalizeQuestionRequest(event.properties),
              },
            });
            break;
          }

          case "question.replied": {
            const request = context.pendingQuestions.get(event.properties.requestID);
            context.pendingQuestions.delete(event.properties.requestID);
            const answers = Object.fromEntries(
              (request?.questions ?? []).map((question, index) => [
                openCodeQuestionId(index, question),
                event.properties.answers[index]?.join(", ") ?? "",
              ]),
            );
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "user-input.resolved",
              payload: { answers },
            });
            break;
          }

          case "question.rejected": {
            context.pendingQuestions.delete(event.properties.requestID);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId: event.properties.requestID,
                raw: event,
              }),
              type: "user-input.resolved",
              payload: { answers: {} },
            });
            break;
          }

          case "session.status": {
            debugLog(
              `session.status statusType=${event.properties.status.type} turnId=${turnId ?? "none"} lastActiveTurnId=${context.lastActiveTurnId ?? "none"}`,
            );

            if (event.properties.status.type === "busy") {
              updateProviderSession(context, { status: "running", activeTurnId: turnId });
            }

            if (event.properties.status.type === "retry") {
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                type: "runtime.warning",
                payload: {
                  message: event.properties.status.message,
                  detail: event.properties.status,
                },
              });
              break;
            }

            // session.status:idle fires between tool calls (intermediate)
            // AND at the end of the turn. We must NOT emit turn.completed
            // here — intermediate idles would prematurely finalize the turn
            // and clear activeTurnId, leaving the final idle without a
            // turnId. session.idle is the reliable end-of-turn signal.
            if (event.properties.status.type === "idle") {
              updateProviderSession(context, { status: "ready" });
            }
            break;
          }

          // session.idle is the definitive end-of-turn signal. It fires
          // once after all tool calls complete, unlike session.status:idle
          // which fires between every tool call cycle.
          case "session.idle": {
            const closingTurnId = turnId ?? context.lastActiveTurnId;
            debugLog(
              `session.idle closingTurnId=${closingTurnId ?? "none"} turnId=${turnId ?? "none"} lastActiveTurnId=${context.lastActiveTurnId ?? "none"}`,
            );
            if (closingTurnId) {
              context.activeTurnId = undefined;
              context.lastActiveTurnId = undefined;
              updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: closingTurnId,
                  raw: event,
                }),
                type: "turn.completed",
                payload: { state: "completed" },
              });
            }
            break;
          }

          case "session.error": {
            const message = sessionErrorMessage(event.properties.error);
            const closingTurnId = context.activeTurnId ?? context.lastActiveTurnId;

            // Emit before mutating state so a throw between the two
            // doesn't lose the turn-end signal. Effect.ignore on each emit
            // keeps one failure from suppressing the next.
            if (closingTurnId) {
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: closingTurnId,
                  raw: event,
                }),
                type: "turn.completed",
                payload: {
                  state: "failed",
                  errorMessage: message,
                },
              }).pipe(Effect.ignore);
            }
            yield* emit({
              ...buildEventBase({ threadId: context.session.threadId, raw: event }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: event.properties.error,
              },
            }).pipe(Effect.ignore);

            context.activeTurnId = undefined;
            context.lastActiveTurnId = undefined;
            updateProviderSession(
              context,
              {
                status: "error",
                lastError: message,
              },
              { clearActiveTurnId: true },
            );
            break;
          }

          default:
            break;
        }
      });

      const startEventPump = Effect.fn("startEventPump")(function* (
        context: OpenCodeSessionContext,
      ) {
        const eventsAbortController = new AbortController();
        yield* Scope.addFinalizer(
          context.sessionScope,
          Effect.sync(() => eventsAbortController.abort()),
        );

        yield* Effect.flatMap(
          runOpenCodeSdk("event.subscribe", () =>
            context.client.event.subscribe(undefined, {
              signal: eventsAbortController.signal,
            }),
          ),
          (subscription) =>
            Stream.fromAsyncIterable(
              subscription.stream,
              (cause) =>
                new OpenCodeRuntimeError({
                  operation: "event.subscribe",
                  detail: openCodeRuntimeErrorDetail(cause),
                  cause,
                }),
            ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
        ).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
                return;
              }
              if (Exit.isFailure(exit)) {
                yield* emitUnexpectedExit(
                  context,
                  openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
                );
              }
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );

        // Process exit is now observed by the OpenCodeServerPool; the
        // crash callback the adapter registered at acquire time fires
        // emitUnexpectedExit with recoverable=true. The legacy
        // per-session exitCode watcher would double-fire here, so it has
        // been removed.
      });

      const resolveNamespaceEnv = (
        threadId: ThreadId,
        cwd: string | undefined,
      ): Readonly<Record<string, string>> => {
        try {
          return { [NAMESPACE_PROJECT_ENV]: sandboxIdFromCwd(cwd) };
        } catch (cause) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `OpenCode startSession requires a sandbox-scoped cwd so the process enters its namespace. Received: ${cwd ?? "<none>"} (thread=${threadId})`,
            cause,
          });
        }
      };

      const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          debugLog(`startSession ENTER thread=${input.threadId} cwd=${input.cwd ?? "<none>"}`);
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to read OpenCode settings.",
                  cause,
                }),
            ),
          );
          const binaryPath = settings.providers.opencode.binaryPath;
          const serverUrl = settings.providers.opencode.serverUrl.trim();
          const serverPassword = settings.providers.opencode.serverPassword;
          const directory = input.cwd ?? serverConfig.cwd;
          const isExternal = serverUrl.length > 0;
          debugLog(`startSession got settings binaryPath=${binaryPath} dir=${directory} thread=${input.threadId} external=${isExternal}`);

          // External-server mode bypasses the pool entirely — there is no
          // process to manage on this host, so we just point the SDK
          // client at the configured URL. Pool acquire requires a
          // sandbox-scoped cwd (it spawns a server inside the project's
          // namespace); external mode has no such constraint.
          let project: string | null = null;
          if (!isExternal) {
            // ellul-only: validate cwd carries a sandbox segment so the
            // namespace wrapper has somewhere to enter. Same validation
            // as the legacy resolveNamespaceEnv helper.
            const additionalEnv = resolveNamespaceEnv(input.threadId, directory);
            project = additionalEnv[NAMESPACE_PROJECT_ENV] ?? null;
            if (project) {
              debugLog(`startSession calling setupNamespace ${project}`);
              yield* Effect.tryPromise({
                try: () => setupNamespace(project!),
                catch: (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Failed to set up namespace for ${project}.`,
                    cause,
                  }),
              });
              debugLog(`startSession setupNamespace done ${project}`);
              refreshProjectContext(directory);
            }
          }

          const existing = sessions.get(input.threadId);
          if (existing) {
            debugLog(`startSession stopping existing session thread=${input.threadId}`);
            yield* stopOpenCodeContext(existing);
            sessions.delete(input.threadId);
          }

          // The pool's per-session id. We register this BEFORE calling
          // session.create so that if the server crashes mid-create, the
          // pool's crash callback still finds a registered session and
          // can fire (a no-op since we haven't installed the context yet,
          // but the bookkeeping stays consistent).
          const poolSessionId = randomUUID();
          // Crash callback the pool will fire if the server dies while we
          // hold a ref. Captures threadId so it can find the live context
          // at fire time (the context isn't created until acquire+
          // session.create succeed).
          const onCrash: CrashCallback = (reason) =>
            Effect.suspend(() => {
              const ctx = sessions.get(input.threadId);
              if (!ctx) return Effect.void;
              return emitUnexpectedExit(ctx, reason, { recoverable: true }).pipe(
                Effect.asVoid,
              );
            });

          const resumeState = parseOpenCodeResume(input.resumeCursor);
          debugLog(
            `startSession resumeState=${resumeState ? `sessionId=${resumeState.sessionId}` : "none"} thread=${input.threadId}`,
          );

          const started = yield* Effect.gen(function* () {
            // Local scope for event subscription + abort controller. The
            // pool owns the spawn — closing this scope does NOT kill the
            // server (which is what we want for multiplexing).
            const sessionScope = yield* Scope.make();
            let acquiredFromPool = false;
            const startedExit = yield* Effect.exit(
              Effect.gen(function* () {
                let baseUrl: string;
                let poolGeneration = 0;
                if (isExternal) {
                  // BYOC server — bypass both pools, direct session.create.
                  baseUrl = serverUrl;
                  const client = openCodeRuntime.createOpenCodeSdkClient({
                    baseUrl,
                    directory,
                    ...(serverPassword ? { serverPassword } : {}),
                  });

                  // Try resuming an existing session on the external server.
                  if (resumeState) {
                    const existing = yield* runOpenCodeSdk("session.get", () =>
                      client.session.get({ sessionID: resumeState.sessionId }),
                    ).pipe(Effect.option);
                    if (existing._tag === "Some" && existing.value.data) {
                      debugLog(`startSession resumed external session=${resumeState.sessionId}`);
                      return {
                        sessionScope,
                        client,
                        openCodeSession: existing.value.data,
                        poolGeneration,
                        resumed: true,
                      };
                    }
                    debugLog(`startSession external resume miss, creating new`);
                  }

                  const openCodeSession = yield* runOpenCodeSdk("session.create", () =>
                    client.session.create({
                      title: `ellul ${input.threadId}`,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  if (!openCodeSession.data) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.create",
                      detail: "OpenCode session.create returned no session payload.",
                    });
                  }
                  return {
                    sessionScope,
                    client,
                    openCodeSession: openCodeSession.data,
                    poolGeneration,
                    resumed: false,
                  };
                }
                if (!project) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "startSession",
                    detail: "Internal: no project resolved for non-external opencode startSession.",
                  });
                }

                // Resume path: acquire only the server (not a warm session)
                // and try to reconnect to the previous OpenCode session.
                if (resumeState) {
                  debugLog(
                    `startSession resume: acquiring server for project=${project} thread=${input.threadId}`,
                  );
                  const serverAcquireExit = yield* Effect.exit(
                    serverPool.acquire({
                      project,
                      binaryPath,
                      cwd: directory,
                      sessionId: poolSessionId,
                      onCrash,
                    }),
                  );
                  if (Exit.isSuccess(serverAcquireExit)) {
                    acquiredFromPool = true;
                    const handle = serverAcquireExit.value;
                    baseUrl = handle.url;
                    poolGeneration = handle.generation;
                    const client = openCodeRuntime.createOpenCodeSdkClient({
                      baseUrl,
                      directory,
                    });
                    const existing = yield* runOpenCodeSdk("session.get", () =>
                      client.session.get({ sessionID: resumeState.sessionId }),
                    ).pipe(Effect.option);
                    if (existing._tag === "Some" && existing.value.data) {
                      debugLog(
                        `startSession resumed pooled session=${resumeState.sessionId} url=${baseUrl} thread=${input.threadId}`,
                      );
                      return {
                        sessionScope,
                        client,
                        openCodeSession: existing.value.data,
                        poolGeneration,
                        resumed: true,
                      };
                    }
                    debugLog(
                      `startSession resume miss session=${resumeState.sessionId}, releasing server ref and falling through to warm pool thread=${input.threadId}`,
                    );
                    yield* serverPool.release({ project, sessionId: poolSessionId });
                    acquiredFromPool = false;
                  } else {
                    debugLog(
                      `startSession resume: server acquire failed, falling through to warm pool thread=${input.threadId}`,
                    );
                  }
                }

                // Warm pool: pops a pre-created session if available,
                // otherwise acquires server + session.create internally.
                debugLog(
                  `startSession warmPool.acquire project=${project} thread=${input.threadId}`,
                );
                const warmAcquired = yield* warmSessionPool.acquire({
                  project,
                  runtimeMode: input.runtimeMode,
                  binaryPath,
                  cwd: directory,
                  threadSessionId: poolSessionId,
                  onCrash,
                  buildPermission: () => buildOpenCodePermissionRules(input.runtimeMode),
                });
                acquiredFromPool = true;
                baseUrl = warmAcquired.session.url;
                poolGeneration = warmAcquired.session.generation;
                debugLog(
                  `startSession warmPool.acquire returned url=${baseUrl} generation=${poolGeneration} fromWarm=${warmAcquired.fromWarmPool} thread=${input.threadId}`,
                );
                const client = openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl,
                  directory,
                });
                return {
                  sessionScope,
                  client,
                  openCodeSession: warmAcquired.session.sdkSession,
                  poolGeneration,
                  resumed: false,
                };
              }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
            );
            if (Exit.isFailure(startedExit)) {
              // Roll back: close local scope, release pool entry if we
              // acquired one before the failure.
              yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
              if (acquiredFromPool && project) {
                yield* serverPool.release({ project, sessionId: poolSessionId });
              }
              return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
            }
            return startedExit.value;
          });

          const raceWinner = sessions.get(input.threadId);
          if (raceWinner) {
            yield* runOpenCodeSdk("session.abort", () =>
              started.client.session.abort({ sessionID: started.openCodeSession.id }),
            ).pipe(Effect.ignore);
            yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
            // The losing acquire must release its pool ref.
            if (!isExternal && project) {
              yield* serverPool.release({ project, sessionId: poolSessionId });
            }
            return raceWinner.session;
          }

          const createdAt = nowIso();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: directory,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: OPENCODE_RESUME_VERSION,
              sessionId: started.openCodeSession.id,
            },
            createdAt,
            updatedAt: createdAt,
          };

          const context: OpenCodeSessionContext = {
            session,
            client: started.client,
            directory,
            openCodeSessionId: started.openCodeSession.id,
            poolSessionId,
            project,
            poolGeneration: started.poolGeneration,
            external: isExternal,
            pendingPermissions: new Map(),
            pendingQuestions: new Map(),
            partById: new Map(),
            emittedTextByPartId: new Map(),
            messageRoleById: new Map(),
            completedAssistantPartIds: new Set(),
            turns: [],
            activeTurnId: undefined,
            lastActiveTurnId: undefined,
            activeAgent: undefined,
            activeVariant: undefined,
            stopped: yield* Ref.make(false),
            sessionScope: started.sessionScope,
          };
          sessions.set(input.threadId, context);
          yield* startEventPump(context);

          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "session.started",
            payload: {
              message: "OpenCode session started",
            },
          });
          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "thread.started",
            payload: {
              providerThreadId: started.openCodeSession.id,
            },
          });

          return session;
        },
      );

      const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureSessionContext(sessions, input.threadId);
        const turnId = TurnId.make(`opencode-turn-${randomUUID()}`);
        const modelSelection =
          input.modelSelection ??
          (context.session.model
            ? { provider: PROVIDER, model: context.session.model }
            : undefined);
        const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode model selection must use the 'provider/model' format.",
          });
        }

        const text = input.input?.trim();
        const fileParts = toOpenCodeFileParts({
          attachments: input.attachments,
          resolveAttachmentPath: (attachment) =>
            resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
        });
        if ((!text || text.length === 0) && fileParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode turns require text input or at least one attachment.",
          });
        }

        const agent =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.options?.agent
            : undefined;
        const variant =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.options?.variant
            : undefined;

        const previousTurnId = context.activeTurnId;
        if (previousTurnId) {
          debugLog(
            `sendTurn auto-closing stale turn=${previousTurnId} before starting new turn=${turnId}`,
          );
          context.activeTurnId = undefined;
          context.lastActiveTurnId = undefined;
          updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          yield* emit({
            ...buildEventBase({ threadId: input.threadId, turnId: previousTurnId }),
            type: "turn.completed",
            payload: { state: "completed" },
          });
        }

        context.activeTurnId = turnId;
        context.lastActiveTurnId = turnId;
        context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
        context.activeVariant = variant;
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            model: modelSelection?.model ?? context.session.model,
          },
          { clearLastError: true },
        );

        yield* emit({
          ...buildEventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });

        const systemInstructions =
          input.interactionMode === "plan"
            ? OPENCODE_PLAN_MODE_SYSTEM()
            : OPENCODE_DEFAULT_MODE_SYSTEM();

        yield* runOpenCodeSdk("session.promptAsync", () =>
          context.client.session.promptAsync({
            sessionID: context.openCodeSessionId,
            model: parsedModel,
            system: systemInstructions,
            ...(context.activeAgent ? { agent: context.activeAgent } : {}),
            ...(context.activeVariant ? { variant: context.activeVariant } : {}),
            parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
          }),
        ).pipe(
          Effect.mapError(toRequestError),
          Effect.tapError((requestError) =>
            Effect.gen(function* () {
              context.activeTurnId = undefined;
              context.activeAgent = undefined;
              context.activeVariant = undefined;
              updateProviderSession(
                context,
                {
                  status: "ready",
                  model: modelSelection?.model ?? context.session.model,
                  lastError: requestError.detail,
                },
                { clearActiveTurnId: true },
              );
              yield* emit({
                ...buildEventBase({ threadId: input.threadId, turnId }),
                type: "turn.aborted",
                payload: {
                  reason: requestError.detail,
                },
              });
            }),
          ),
        );

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        };
      });

      const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, turnId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* runOpenCodeSdk("session.abort", () =>
            context.client.session.abort({ sessionID: context.openCodeSessionId }),
          ).pipe(Effect.mapError(toRequestError));
          if (turnId ?? context.activeTurnId) {
            yield* emit({
              ...buildEventBase({ threadId, turnId: turnId ?? context.activeTurnId }),
              type: "turn.aborted",
              payload: {
                reason: "Interrupted by user.",
              },
            });
          }
        },
      );

      const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
        "respondToRequest",
      )(function* (threadId, requestId, decision) {
        const context = ensureSessionContext(sessions, threadId);
        if (!context.pendingPermissions.has(requestId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.reply",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }

        yield* runOpenCodeSdk("permission.reply", () =>
          context.client.permission.reply({
            requestID: requestId,
            reply: toOpenCodePermissionReply(decision),
          }),
        ).pipe(Effect.mapError(toRequestError));
      });

      const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, requestId, answers) {
        const context = ensureSessionContext(sessions, threadId);
        const request = context.pendingQuestions.get(requestId);
        if (!request) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "question.reply",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        yield* runOpenCodeSdk("question.reply", () =>
          context.client.question.reply({
            requestID: requestId,
            answers: toOpenCodeQuestionAnswers(request, answers),
          }),
        ).pipe(Effect.mapError(toRequestError));
      });

      const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* stopOpenCodeContext(context);
          sessions.delete(threadId);
          yield* emit({
            ...buildEventBase({ threadId }),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: false,
              exitKind: "graceful",
            },
          });
        },
      );

      const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({ sessionID: context.openCodeSessionId }),
          ).pipe(Effect.mapError(toRequestError));

          const turns = (messages.data ?? [])
            .filter((entry) => entry.info.role === "assistant")
            .map((entry) => ({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            }));

          return {
            threadId,
            turns,
          };
        },
      );

      const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = ensureSessionContext(sessions, threadId);
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({ sessionID: context.openCodeSessionId }),
          ).pipe(Effect.mapError(toRequestError));

          const assistantMessages = (messages.data ?? []).filter(
            (entry) => entry.info.role === "assistant",
          );
          const targetIndex = assistantMessages.length - numTurns - 1;
          const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
          yield* runOpenCodeSdk("session.revert", () =>
            context.client.session.revert({
              sessionID: context.openCodeSessionId,
              ...(target ? { messageID: target.info.id } : {}),
            }),
          ).pipe(Effect.mapError(toRequestError));

          return yield* readThread(threadId);
        },
      );

      const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
            { concurrency: "unbounded", discard: true },
          );
        });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        stopAll,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } satisfies OpenCodeAdapterShape;
    }),
  );
}

export const OpenCodeAdapterLive = makeOpenCodeAdapterLive();
