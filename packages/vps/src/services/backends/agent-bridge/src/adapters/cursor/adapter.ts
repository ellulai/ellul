// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. —
// ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/provider/Layers/CursorAdapter.ts

import * as nodePath from "node:path";

import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  type CursorModelOptions,
  EventId,
  type ProviderAdapterShape,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
  sandboxIdFromCwd,
} from "@ellul.ai/types";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
  Ref,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
  Context,
} from "effect";
import type * as EffectAcpSchema from "../vendor/t3code/effect-acp/schema";

import { resolveAttachmentPath } from "../../shared/attachmentStore";
import { ServerConfig } from "../../shared/config";
import { ServerSettingsService } from "../../shared/serverSettings";
import { setupNamespace } from "../../application/namespace/NamespaceSpawn";
import { refreshProjectContext, getMcpRelayInfo } from "../../application/reconciliation/ZeroclawAgent";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../errors";
import { acpPermissionOutcome, mapAcpToAdapterError } from "./acp/AcpAdapterSupport";
import { type AcpSessionHandle } from "./acp/AcpProjectRuntime";
import { CursorAcpServerPool, type CursorCrashCallback } from "./server-pool";
import { CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES } from "./provider";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./acp/AcpCoreRuntimeEvents";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "./acp/AcpRuntimeModel";
import { makeAcpNativeLoggers } from "./acp/AcpNativeLogging";
import { applyCursorAcpModelSelection } from "./acp/CursorAcpSupport";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "./acp/CursorAcpExtension";
import { resolveCursorAcpBaseModelId } from "./provider";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../event-logger";

const PROVIDER = "cursor" as const;
const CURSOR_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export interface CursorAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "cursor";
}

export class CursorAdapter extends Context.Service<CursorAdapter, CursorAdapterShape>()(
  "ellul/adapters/CursorAdapter",
) {}

export interface CursorAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface CursorSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionHandle;
  // Project owning the pooled cursor-agent runtime. Pool entries are
  // keyed by project; release(project, poolSessionId) returns this
  // session's hold without dropping siblings in the same project.
  readonly project: string;
  // Per-thread token under which this session is registered against the
  // pool entry. Distinct from acp.sessionId because we register the
  // crash callback BEFORE session/new resolves, so the pool's per-
  // session map can route a crash even if session creation races.
  readonly poolSessionId: string;
  // Pool generation captured at acquire time. Bumps on respawn-after-
  // crash so event logs and tests can distinguish a recovered runtime
  // from a multiplexed reuse.
  readonly poolGeneration: number;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  readonly stopped: Ref.Ref<boolean>;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursorResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionHandle;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: CursorModelOptions | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("../vendor/t3code/effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyCursorAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        modelOptions: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

function makeCursorAdapter(options?: CursorAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettingsService = yield* ServerSettingsService;
    const serverPool = yield* CursorAcpServerPool;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, CursorSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.cursor.extension",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: CursorSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.cursor.extension",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || Ref.getUnsafe(ctx.stopped)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const releasePoolEntry = (ctx: CursorSessionContext): Effect.Effect<void, never> =>
      serverPool.release({
        project: ctx.project,
        sessionId: ctx.poolSessionId,
      });

    const stopSessionInternal = (ctx: CursorSessionContext) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(ctx.stopped, true)) return;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        // Close the per-session ACP handle: drains the event queue and
        // sends best-effort session/close on the agent. The pool's
        // cursor-agent process keeps running for sibling threads.
        yield* ctx.acp.close;
        // Release this thread's hold on the project's pool entry. Pool
        // marks the entry idle when refCount hits 0; sweepIdle reaps it
        // after the configured TTL.
        yield* releasePoolEntry(ctx);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    // Crash recovery path: fired by the pool when the project's cursor-
    // agent exits unexpectedly. Mirrors opencode's emitUnexpectedExit:
    // mark the session stopped, settle pendings, drop from the map,
    // emit runtime.error + session.exited{recoverable:true}, release
    // the pool ref, close the local scope.
    const emitUnexpectedExit = (
      ctx: CursorSessionContext,
      reason: string,
    ): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(ctx.stopped, true)) return;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "runtime.error",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          payload: {
            message: reason,
            class: "transport_error",
          },
        }).pipe(Effect.ignore);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          payload: {
            reason,
            recoverable: true,
            exitKind: "error",
          },
        }).pipe(Effect.ignore);
        // Pool already removed the entry on its crash path; release is
        // a no-op in that case but keeps the bookkeeping consistent.
        yield* releasePoolEntry(ctx);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      });

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = nodePath.resolve(input.cwd.trim());
          const cursorModelSelection =
            input.modelSelection?.provider === "cursor" ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !Ref.getUnsafe(existing.stopped)) {
            yield* stopSessionInternal(existing);
          }

          const cursorSettings = yield* serverSettingsService.getSettings.pipe(
            Effect.map((settings) => settings.providers.cursor),
            Effect.mapError(
              (error) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: error.message,
                  cause: error,
                }),
            ),
          );

          const sandboxId = yield* Effect.try({
            try: () => sandboxIdFromCwd(cwd),
            catch: (cause) =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Cursor startSession requires a sandbox-scoped cwd so the agent process enters its namespace. Received: ${input.cwd}`,
                cause,
              }),
          });

          // Pre-warm the namespace so cursor-agent has a place to enter.
          // Idempotent — if the lifecycle reconciler already warmed it,
          // setupNamespace returns instantly.
          yield* Effect.tryPromise({
            try: () => setupNamespace(sandboxId),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: `Failed to set up namespace for ${sandboxId}.`,
                cause,
              }),
          });
          refreshProjectContext(cwd);

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: CursorSessionContext;
          const stoppedRef = yield* Ref.make(false);

          const resumeSessionId = parseCursorResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          // Pre-mint the pool's per-session id so the crash callback
          // registered at acquire time can find this thread's context
          // even if newSession races with a crash. Generated synchronously
          // so the pool registers it before any potential exit watcher
          // fires.
          const poolSessionId = randomUUID();

          // Crash callback. The pool fires this when cursor-agent exits
          // unexpectedly. We chain into emitUnexpectedExit which emits
          // recoverable=true so the UI prompts a retry. Suspended so
          // the lookup runs when the crash actually happens, not at
          // registration time.
          const onCrash: CursorCrashCallback = (reason) =>
            Effect.suspend(() => {
              const liveCtx = sessions.get(input.threadId);
              if (!liveCtx) return Effect.void;
              return emitUnexpectedExit(liveCtx, reason);
            });

          // Acquire the project's pooled cursor-agent runtime. If a
          // sibling thread is already using this project, we get back
          // the same AcpProjectRuntime — multiplexed via session/new.
          const acquired = yield* serverPool
            .acquire({
              project: sandboxId,
              cwd,
              sessionId: poolSessionId,
              cursorSettings,
              clientInfo: { name: "ellul-agent-bridge", version: "0.1.0" },
              clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
              ...(acpNativeLoggers.requestLogger
                ? { requestLogger: acpNativeLoggers.requestLogger }
                : {}),
              ...(acpNativeLoggers.protocolLogging
                ? { protocolLogging: acpNativeLoggers.protocolLogging }
                : {}),
              onCrash,
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "cursor.pool.acquire", error),
              ),
            );

          // Build the per-session ACP handle on the shared runtime. The
          // handle owns this thread's session/new + per-session state;
          // the runtime's process is shared.
          const acpMcpServers: EffectAcpSchema.McpServer[] = (() => {
            const relay = getMcpRelayInfo(sandboxId);
            if (!relay) return [];
            return [{
              name: "ellul-platform",
              command: relay.relayBin,
              args: [] as string[],
              env: [
                { name: "ELLUL_MCP_URL", value: relay.mcpUrl },
                { name: "ELLUL_MCP_TOKEN", value: relay.token },
                { name: "ELLUL_MCP_PROJECT", value: relay.projectName },
              ],
            }];
          })();

          const acp: AcpSessionHandle = yield* acquired.runtime
            .newSession({
              cwd,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              mcpServers: acpMcpServers,
            })
            .pipe(
              // Roll back the pool acquire so a failed newSession doesn't
              // leave a dangling refCount.
              Effect.tapError(() =>
                serverPool.release({ project: sandboxId, sessionId: poolSessionId }),
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/new", error),
              ),
            );

          // Register per-session handlers AFTER newSession returned but
          // BEFORE we spin up the event pump. The runtime dispatches
          // session/request_permission and cursor/* ext methods through
          // these. cursor-agent doesn't fire any of these until prompt
          // time, so the registration happens well before any inbound
          // traffic.
          yield* acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
            Effect.gen(function* () {
              yield* logNative(
                input.threadId,
                "cursor/ask_question",
                params,
                "acp.cursor.extension",
              );
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const answers = yield* Deferred.make<ProviderUserInputAnswers>();
              pendingUserInputs.set(requestId, { answers });
              yield* offerRuntimeEvent({
                type: "user-input.requested",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: runtimeRequestId,
                payload: { questions: extractAskQuestions(params) },
                raw: {
                  source: "acp.cursor.extension",
                  method: "cursor/ask_question",
                  payload: params,
                },
              });
              const resolved = yield* Deferred.await(answers);
              pendingUserInputs.delete(requestId);
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: runtimeRequestId,
                payload: { answers: resolved },
              });
              return { answers: resolved };
            }),
          );
          yield* acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
            Effect.gen(function* () {
              yield* logNative(
                input.threadId,
                "cursor/create_plan",
                params,
                "acp.cursor.extension",
              );
              yield* offerRuntimeEvent({
                type: "turn.proposed.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                payload: { planMarkdown: extractPlanMarkdown(params) },
                raw: {
                  source: "acp.cursor.extension",
                  method: "cursor/create_plan",
                  payload: params,
                },
              });
              return { accepted: true } as const;
            }),
          );
          yield* acp.handleExtNotification(
            "cursor/update_todos",
            CursorUpdateTodosRequest,
            (params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "cursor/update_todos",
                  params,
                  "acp.cursor.extension",
                );
                if (ctx) {
                  yield* emitPlanUpdate(
                    ctx,
                    extractTodosAsPlan(params),
                    params,
                    "acp.cursor.extension",
                    "cursor/update_todos",
                  );
                }
              }),
          );
          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              yield* logNative(
                input.threadId,
                "session/request_permission",
                params,
                "acp.jsonrpc",
              );
              if (input.runtimeMode === "full-access") {
                const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                if (autoApprovedOptionId !== undefined) {
                  return {
                    outcome: {
                      outcome: "selected" as const,
                      optionId: autoApprovedOptionId,
                    },
                  };
                }
              }
              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              pendingApprovals.set(requestId, {
                decision,
                kind: permissionRequest.kind,
              });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision);
              pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              return {
                outcome:
                  resolved === "cancel"
                    ? ({ outcome: "cancelled" } as const)
                    : {
                        outcome: "selected" as const,
                        optionId: acpPermissionOutcome(resolved),
                      },
              };
            }),
          );

          const started = {
            sessionId: acp.sessionId,
            initializeResult: acp.initializeResult,
            sessionSetupResult: acp.sessionSetupResult,
            modelConfigId: acp.modelConfigId,
          };

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: cursorModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: cursorModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: CURSOR_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            project: sandboxId,
            poolSessionId,
            poolGeneration: acquired.generation,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            stopped: stoppedRef,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(Effect.forkChild);

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Cursor ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === "cursor" ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const resolvedModel = resolveCursorAcpBaseModelId(model);
        yield* applyRequestedSessionConfiguration({
          runtime: ctx.acp,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode: input.interactionMode,
          modelSelection:
            model === undefined
              ? undefined
              : {
                  model,
                  options: turnModelSelection?.options,
                },
          mapError: ({ cause, method }) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
        });
        ctx.activeTurnId = turnId;
        ctx.lastPlanFingerprint = undefined;
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: resolvedModel },
        });

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const result = yield* ctx.acp
          .prompt({
            prompt: promptParts,
          })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
          );

        ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          model: resolvedModel,
        };

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cursor/ask_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !Ref.getUnsafe(c.stopped);
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies CursorAdapterShape;
  });
}

export const CursorAdapterLive = Layer.effect(CursorAdapter, makeCursorAdapter());

export function makeCursorAdapterLive(opts?: CursorAdapterLiveOptions) {
  return Layer.effect(CursorAdapter, makeCursorAdapter(opts));
}
