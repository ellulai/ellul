// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.
//
// ZeroClaw provider adapter.
// Platform tool instructions injected via runtime.sendOnSession's systemPrompt.
//
// Each chat thread acquires one ref on the project's pooled daemon
// (`ZeroClawDaemonPool.acquire`). The daemon is shared across all
// threads in the same project — opening 5 chats in the same sandbox
// keeps exactly one `zeroclaw daemon` process alive, not five.
//
// Per-turn flow:
//   1. sendTurn opens a fresh WebSocket against the cached daemon
//      handle via `runtime.sendOnSession`. The handle was acquired
//      in startSession and stays valid for the session's lifetime
//      (the pool guarantees the daemon outlives every active ref).
//   2. Daemon-emitted `{type:"error", message}` chunks flow through
//      the chunk callback as `{type:"error"}` and are surfaced as
//      structured `runtime.error` events with class:"provider_error".
//      No more "Something went wrong processing your request." —
//      that catch-all string was the literal artifact users saw when
//      the upstream LLM proxy 500'd.
//   3. Daemon process crashes (oom, panic, SIGKILL) trigger the pool's
//      crash watcher → adapter's `onCrash` callback → `emitUnexpectedExit`
//      with `recoverable: true`. The user sees a structured error
//      and a "session.exited" event; reopening the chat respawns a
//      fresh daemon (generation N+1).

import { randomUUID } from "node:crypto";

import {
  EventId,
  type ProviderAdapterShape,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
  sandboxIdFromCwd,
  type ToolLifecycleItemType,
} from "@ellul.ai/types";
import { Context, Effect, Exit, Layer, Queue, Ref, Scope, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../errors";
import { buildSystemInstructions } from "../../shared/platform-instructions";
import { ZeroClawRuntime, type ZeroClawAgentChunk, type ZeroClawDaemonProcess } from "./runtime";
import { ZeroClawDaemonPool, type ZeroClawCrashCallback } from "./server-pool";

const PROVIDER = "zeroclaw" as const;

export interface ZeroClawAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "zeroclaw";
}

export class ZeroClawAdapter extends Context.Service<ZeroClawAdapter, ZeroClawAdapterShape>()(
  "ellul/adapters/ZeroClawAdapter",
) {}

interface ZeroClawTurnState {
  readonly turnId: TurnId;
  readonly assistantItemId: RuntimeItemId;
  readonly reasoningItemId: RuntimeItemId;
  readonly toolItems: Map<string, RuntimeItemId>;
  reasoningEmitted: boolean;
  finalState: "completed" | "failed" | "interrupted" | "cancelled" | undefined;
  errorMessage: string | undefined;
}

interface ZeroClawSessionContext {
  session: ProviderSession;
  readonly project: string;
  /** Cached pool acquire result; valid until daemon crash. */
  daemon: ZeroClawDaemonProcess;
  /** Session id used for pool refCount + crash callback registry. */
  readonly poolSessionId: string;
  activeTurn: ZeroClawTurnState | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

const nowIso = (): string => new Date().toISOString();

function buildEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "raw"
> {
  return {
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.raw !== undefined
      ? { raw: { source: "zeroclaw.ws.v1", payload: input.raw } }
      : {}),
  };
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const n = toolName.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("command") || n.includes("exec") || n === "run")
    return "command_execution";
  if (
    n.includes("edit") ||
    n.includes("write") ||
    n.includes("patch") ||
    n.includes("apply") ||
    n.includes("create_file") ||
    n.includes("delete")
  )
    return "file_change";
  if (n.includes("web") || n.includes("fetch") || n.includes("search")) return "web_search";
  if (n.includes("mcp")) return "mcp_tool_call";
  if (n.includes("image") || n.includes("vision")) return "image_view";
  if (n.includes("agent") || n.includes("task") || n.includes("subtask"))
    return "collab_agent_tool_call";
  return "dynamic_tool_call";
}

function resolveProjectFromCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const fromHelper = sandboxIdFromCwd(cwd);
  if (fromHelper) return fromHelper;
  const segments = cwd.split("/").filter((s) => s.length > 0);
  return segments.at(-1) ?? null;
}

export const ZeroClawAdapterLive = Layer.effect(
  ZeroClawAdapter,
  Effect.gen(function* () {
    const runtime = yield* ZeroClawRuntime;
    const pool = yield* ZeroClawDaemonPool;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ZeroClawSessionContext>();

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    const releasePoolEntry = (
      context: ZeroClawSessionContext,
    ): Effect.Effect<void, never> =>
      pool.release({
        project: context.project,
        sessionId: context.poolSessionId,
      });

    /**
     * Cleanup path used by both graceful stopSession and the crash
     * watcher's onCrash callback. Idempotent (guarded by `stopped`).
     */
    const emitUnexpectedExit = (
      context: ZeroClawSessionContext,
      message: string,
      options?: { readonly recoverable?: boolean },
    ): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(context.stopped, true)) return;
        const recoverable = options?.recoverable ?? false;
        const turnId = context.activeTurn?.turnId;
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
        // Pool may have already removed the entry on its own crash
        // path; release is a no-op in that case.
        yield* releasePoolEntry(context);
        yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(context.stopped, true)) return;
              yield* releasePoolEntry(context);
              yield* Scope.close(context.sessionScope, Exit.void).pipe(
                Effect.ignore,
              );
            }).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
      }),
    );

    const startSession: ZeroClawAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const threadId = input.threadId;
        const cwd = input.cwd ?? undefined;
        const project = resolveProjectFromCwd(cwd);
        if (!project) {
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Cannot derive ZeroClaw sandbox id from cwd '${cwd ?? "<missing>"}'.`,
            }),
          );
        }
        if (!cwd) {
          // Defensive: project derivation succeeded only if cwd is set
          // (sandboxIdFromCwd needs a path) but be explicit so the pool
          // contract holds.
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `ZeroClaw startSession requires a cwd.`,
            }),
          );
        }

        const existing = sessions.get(threadId);
        if (existing && !(yield* Ref.get(existing.stopped))) {
          return existing.session;
        }

        const stopped = yield* Ref.make(false);
        const sessionScope = yield* Scope.make();
        const poolSessionId = String(threadId);

        // Prepare the context BEFORE acquiring so the crash callback
        // can find the session it needs to tear down.
        const onCrash: ZeroClawCrashCallback = (reason) =>
          Effect.suspend(() => {
            const ctx = sessions.get(threadId);
            if (!ctx) return Effect.void;
            return emitUnexpectedExit(ctx, reason, { recoverable: true });
          });

        const acquired = yield* pool
          .acquire({
            project,
            cwd,
            sessionId: poolSessionId,
            onCrash,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: `ZeroClaw pool.acquire failed: ${cause.detail}`,
                  cause,
                }),
            ),
          );

        const createdAt = nowIso();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId,
          model: "default",
          ...(cwd ? { cwd } : {}),
          createdAt,
          updatedAt: createdAt,
        };

        sessions.set(threadId, {
          session,
          project,
          daemon: acquired.daemon,
          poolSessionId,
          activeTurn: undefined,
          stopped,
          sessionScope,
        });

        yield* emit({
          ...buildEventBase({ threadId }),
          type: "session.started",
          payload: {},
        });
        yield* emit({
          ...buildEventBase({ threadId }),
          type: "session.state.changed",
          payload: { state: "ready" },
        });

        return session;
      });

    const sendTurn: ZeroClawAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const threadId = input.threadId;
        const context = sessions.get(threadId);
        if (!context) {
          return yield* Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
          );
        }
        if (yield* Ref.get(context.stopped)) {
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Session is stopped.",
            }),
          );
        }
        const message = input.input?.trim();
        if (!message) {
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "ZeroClaw sendTurn requires a non-empty input.",
            }),
          );
        }

        const turnId = TurnId.make(randomUUID());
        const turnState: ZeroClawTurnState = {
          turnId,
          assistantItemId: RuntimeItemId.make(`${turnId}-assistant`),
          reasoningItemId: RuntimeItemId.make(`${turnId}-reasoning`),
          toolItems: new Map(),
          reasoningEmitted: false,
          finalState: undefined,
          errorMessage: undefined,
        };
        context.activeTurn = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: nowIso(),
        };

        yield* emit({
          ...buildEventBase({ threadId, turnId }),
          type: "turn.started",
          payload: { model: "default" },
        });
        yield* emit({
          ...buildEventBase({ threadId, turnId, itemId: turnState.assistantItemId }),
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress" },
        });

        const dispatchTurn = Effect.gen(function* () {
          yield* runtime
            .sendOnSession({
              daemon: context.daemon,
              threadId: String(threadId),
              message,
              systemPrompt: buildSystemInstructions("default"),
              onChunk: (chunk) => handleChunk(context, turnState, chunk),
            })
            .pipe(
              // Effect.catch is the public name in this version of
              // effect; collapses the typed error into a recovery
              // effect. Any leaked transport failure becomes an
              // `error` chunk so the same finalize path handles
              // transport + send + protocol failures uniformly.
              Effect.catch((err) =>
                Effect.sync(() => {
                  handleChunk(context, turnState, {
                    type: "error",
                    message: err.detail,
                  });
                  handleChunk(context, turnState, {
                    type: "status",
                    status: "idle",
                  });
                }),
              ),
            );
          yield* finalizeTurn(context, turnState);
        });
        yield* dispatchTurn.pipe(Effect.forkIn(context.sessionScope));

        return { threadId, turnId };
      });

    const handleChunk = (
      context: ZeroClawSessionContext,
      turn: ZeroClawTurnState,
      chunk: ZeroClawAgentChunk,
    ): void => {
      const threadId = context.session.threadId;
      switch (chunk.type) {
        case "text": {
          const delta = chunk.content ?? "";
          if (!delta) return;
          Effect.runSync(
            emit({
              ...buildEventBase({ threadId, turnId: turn.turnId, itemId: turn.assistantItemId }),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta },
            }),
          );
          return;
        }
        case "reasoning": {
          const delta = chunk.content ?? "";
          if (!delta) return;
          if (!turn.reasoningEmitted) {
            turn.reasoningEmitted = true;
            Effect.runSync(
              emit({
                ...buildEventBase({ threadId, turnId: turn.turnId, itemId: turn.reasoningItemId }),
                type: "item.started",
                payload: { itemType: "reasoning", status: "inProgress" },
              }),
            );
          }
          Effect.runSync(
            emit({
              ...buildEventBase({ threadId, turnId: turn.turnId, itemId: turn.reasoningItemId }),
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta },
            }),
          );
          return;
        }
        case "tool_use": {
          const toolName = chunk.tool ?? "unknown";
          const itemType = toToolLifecycleItemType(toolName);
          const sequence = turn.toolItems.size;
          const itemId = RuntimeItemId.make(`${turn.turnId}-tool-${sequence}-${toolName}`);
          turn.toolItems.set(`${toolName}#${sequence}`, itemId);
          Effect.runSync(
            emit({
              ...buildEventBase({ threadId, turnId: turn.turnId, itemId }),
              type: "item.started",
              payload: {
                itemType,
                status: "inProgress",
                title: toolName,
                ...(chunk.input !== undefined ? { data: { input: chunk.input } } : {}),
              },
            }),
          );
          return;
        }
        case "tool_result": {
          const toolName = chunk.tool ?? "unknown";
          // Resolve the most recent in-flight tool item for this name (LIFO).
          let itemId: RuntimeItemId | undefined;
          let key: string | undefined;
          for (const [k, id] of turn.toolItems) {
            if (k.startsWith(`${toolName}#`)) {
              itemId = id;
              key = k;
            }
          }
          if (!itemId) {
            const sequence = turn.toolItems.size;
            itemId = RuntimeItemId.make(`${turn.turnId}-tool-${sequence}-${toolName}`);
            turn.toolItems.set(`${toolName}#${sequence}`, itemId);
            Effect.runSync(
              emit({
                ...buildEventBase({ threadId, turnId: turn.turnId, itemId }),
                type: "item.started",
                payload: {
                  itemType: toToolLifecycleItemType(toolName),
                  status: "inProgress",
                  title: toolName,
                },
              }),
            );
          } else if (key) {
            turn.toolItems.delete(key);
          }

          const output = chunk.output ?? "";
          const succeeded = chunk.success !== false;
          Effect.runSync(
            emit({
              ...buildEventBase({ threadId, turnId: turn.turnId, itemId }),
              type: "item.completed",
              payload: {
                itemType: toToolLifecycleItemType(toolName),
                status: succeeded ? "completed" : "failed",
                title: toolName,
                ...(output ? { detail: output } : {}),
              },
            }),
          );
          return;
        }
        case "status":
          // status:thinking handled by turn.started; status:idle by finalizeTurn.
          return;
        case "error": {
          turn.finalState = "failed";
          turn.errorMessage = chunk.message?.trim().length
            ? chunk.message
            : "ZeroClaw daemon error";
          // Class is "provider_error" — distinct from transport errors,
          // which are surfaced via emitUnexpectedExit. Provider errors
          // are recoverable (retry the same turn or escalate to operator).
          Effect.runSync(
            emit({
              ...buildEventBase({ threadId, turnId: turn.turnId }),
              type: "runtime.error",
              payload: { message: turn.errorMessage, class: "provider_error" },
            }),
          );
          return;
        }
        case "file_edit": {
          if (!chunk.path) return;
          const itemId = RuntimeItemId.make(
            `${turn.turnId}-file-${turn.toolItems.size}-${chunk.path}`,
          );
          Effect.runSync(
            emit({
              ...buildEventBase({ threadId, turnId: turn.turnId, itemId }),
              type: "item.completed",
              payload: {
                itemType: "file_change",
                status: "completed",
                title: chunk.path,
                ...(chunk.diff ? { detail: chunk.diff } : {}),
                data: { path: chunk.path, ...(chunk.diff ? { diff: chunk.diff } : {}) },
              },
            }),
          );
          return;
        }
        default:
          return;
      }
    };

    const finalizeTurn = (
      context: ZeroClawSessionContext,
      turn: ZeroClawTurnState,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (turn.reasoningEmitted) {
          yield* emit({
            ...buildEventBase({ threadId, turnId: turn.turnId, itemId: turn.reasoningItemId }),
            type: "item.completed",
            payload: { itemType: "reasoning", status: "completed" },
          });
        }
        yield* emit({
          ...buildEventBase({ threadId, turnId: turn.turnId, itemId: turn.assistantItemId }),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: turn.finalState === "failed" ? "failed" : "completed",
          },
        });
        const finalState = turn.finalState ?? "completed";
        yield* emit({
          ...buildEventBase({ threadId, turnId: turn.turnId }),
          type: "turn.completed",
          payload: {
            state: finalState,
            ...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
          },
        });
        const nextSession = { ...context.session, status: "ready" as const, updatedAt: nowIso() };
        const mutable = nextSession as Record<string, unknown>;
        delete mutable.activeTurnId;
        context.session = nextSession;
        if (context.activeTurn?.turnId === turn.turnId) {
          context.activeTurn = undefined;
        }
      });

    const interruptTurn: ZeroClawAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
          );
        }
        const active = context.activeTurn;
        if (!active) return;
        if (turnId && turnId !== active.turnId) return;
        active.finalState = "interrupted";
        active.errorMessage = "User interrupted ZeroClaw turn";
        // NOTE: do NOT kill the daemon here — the daemon may still be
        // serving other threads on the same project. The next sendTurn
        // simply reuses the same daemon; the in-flight WebSocket dies
        // when its REQUEST_TIMEOUT_MS fires, which is fine.
        yield* emit({
          ...buildEventBase({ threadId, turnId: active.turnId }),
          type: "turn.aborted",
          payload: { reason: "user_interrupt" },
        });
      }).pipe(
        Effect.catchTag("ProviderAdapterSessionNotFoundError", (err) =>
          Effect.fail<ProviderAdapterError>(err),
        ),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: cause instanceof Error ? cause.message : "interruptTurn failed",
              cause,
            }),
        ),
      );

    const respondToRequest: ZeroClawAdapterShape["respondToRequest"] = () => Effect.void;
    const respondToUserInput: ZeroClawAdapterShape["respondToUserInput"] = () => Effect.void;

    const stopSession: ZeroClawAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        if (yield* Ref.getAndSet(context.stopped, true)) return;
        sessions.delete(threadId);
        // Release the pool ref BEFORE closing the local scope. The
        // daemon stays warm until refCount hits zero and the idle TTL
        // elapses — sweepIdle in the namespace-lifecycle reconciler
        // tick is what evicts it. This avoids respawn churn for users
        // opening / closing chats in quick succession.
        yield* releasePoolEntry(context);
        yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
        yield* emit({
          ...buildEventBase({ threadId }),
          type: "session.exited",
          payload: { reason: "stopped", recoverable: true, exitKind: "graceful" },
        });
      });

    const listSessions: ZeroClawAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => context.session));

    const hasSession: ZeroClawAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: ZeroClawAdapterShape["readThread"] = (threadId) =>
      Effect.succeed({ threadId, turns: [] });

    const rollbackThread: ZeroClawAdapterShape["rollbackThread"] = (threadId) =>
      Effect.succeed({ threadId, turns: [] });

    const stopAll: ZeroClawAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(context.stopped, true)) return;
              yield* releasePoolEntry(context);
              yield* Scope.close(context.sessionScope, Exit.void).pipe(
                Effect.ignore,
              );
            }).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
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
    } satisfies ZeroClawAdapterShape;
  }),
);
