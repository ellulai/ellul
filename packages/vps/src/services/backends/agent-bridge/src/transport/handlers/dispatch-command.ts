// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/ws.ts

import {
  CommandId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@ellul.ai/types";
import { Cause, Effect, FileSystem, Option, Path, Schema } from "effect";

import { normalizeDispatchCommand } from "../../orchestration/Normalizer";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import { ServerConfig } from "../../shared/config";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths";
import {
  sloAbort as sloAbortSpan,
  sloBegin as sloBeginSpan,
} from "../../application/slo/SloTelemetry";

type NormalizerServices =
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | WorkspacePaths;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
  Schema.is(OrchestrationDispatchCommandError)(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        cause,
      });

const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return Schema.is(OrchestrationDispatchCommandError)(error)
    ? error
    : new OrchestrationDispatchCommandError({
        message:
          error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
        cause,
      });
};

const dispatchBootstrapTurnStart = (
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
): Effect.Effect<
  { readonly sequence: number },
  OrchestrationDispatchCommandError,
  OrchestrationEngineService
> =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const bootstrap = command.bootstrap;
    const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
    let createdThread = false;

    const cleanupCreatedThread = () =>
      createdThread
        ? orchestrationEngine
            .dispatch({
              type: "thread.delete",
              commandId: serverCommandId("bootstrap-thread-delete"),
              threadId: command.threadId,
            })
            .pipe(Effect.ignoreCause({ log: true }))
        : Effect.void;

    const bootstrapProgram = Effect.gen(function* () {
      if (bootstrap?.createThread) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: serverCommandId("bootstrap-thread-create"),
          threadId: command.threadId,
          projectId: bootstrap.createThread.projectId,
          title: bootstrap.createThread.title,
          modelSelection: bootstrap.createThread.modelSelection,
          runtimeMode: bootstrap.createThread.runtimeMode,
          interactionMode: bootstrap.createThread.interactionMode,
          branch: bootstrap.createThread.branch,
          worktreePath: bootstrap.createThread.worktreePath,
          viewScope: bootstrap.createThread.viewScope,
          createdAt: bootstrap.createThread.createdAt,
        });
        createdThread = true;
      }

      return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
    });

    return yield* bootstrapProgram.pipe(
      Effect.catchCause((cause) => {
        const dispatchError = toBootstrapDispatchCommandCauseError(cause);
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.fail(dispatchError);
        }
        return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
      }),
    );
  });

const dispatchNormalizedCommand = (
  normalizedCommand: OrchestrationCommand,
): Effect.Effect<
  { readonly sequence: number },
  OrchestrationDispatchCommandError,
  OrchestrationEngineService
> =>
  normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
    ? dispatchBootstrapTurnStart(normalizedCommand)
    : Effect.gen(function* () {
        const orchestrationEngine = yield* OrchestrationEngineService;
        return yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
          ),
        );
      });

export const handleDispatchCommand = (
  command: ClientOrchestrationCommand,
): Effect.Effect<
  { readonly sequence: number },
  OrchestrationDispatchCommandError,
  OrchestrationEngineService | ProjectionSnapshotQuery | NormalizerServices
> =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const normalizedCommand = yield* normalizeDispatchCommand(command);

    // SLO span begin. Closed by the projector when the corresponding
    // event lands. Keyed by threadId.
    if (normalizedCommand.type === "thread.create") {
      sloBeginSpan("thread-create", normalizedCommand.threadId, {
        commandId: normalizedCommand.commandId,
        projectId: normalizedCommand.projectId,
      });
    } else if (normalizedCommand.type === "thread.turn.start") {
      sloBeginSpan("first-byte", normalizedCommand.threadId, {
        commandId: normalizedCommand.commandId,
      });
    }

    const shouldStopSessionAfterArchive =
      normalizedCommand.type === "thread.archive"
        ? yield* projectionSnapshotQuery
            .getThreadShellById(normalizedCommand.threadId)
            .pipe(
              Effect.map(
                Option.match({
                  onNone: () => false,
                  onSome: (thread) =>
                    thread.session !== null && thread.session.status !== "stopped",
                }),
              ),
              Effect.catch(() => Effect.succeed(false)),
            )
        : false;

    const result = yield* dispatchNormalizedCommand(normalizedCommand);

    if (normalizedCommand.type === "thread.archive" && shouldStopSessionAfterArchive) {
      yield* Effect.gen(function* () {
        const stopCommand = yield* normalizeDispatchCommand({
          type: "thread.session.stop",
          commandId: CommandId.make(
            `session-stop-for-archive:${normalizedCommand.commandId}`,
          ),
          threadId: normalizedCommand.threadId,
          createdAt: new Date().toISOString(),
        });
        yield* dispatchNormalizedCommand(stopCommand);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to stop provider session during archive", {
            threadId: normalizedCommand.threadId,
            cause,
          }),
        ),
      );
    }

    return result;
  }).pipe(
    Effect.tapError((err) => {
      // SLO cleanup on failure. sloAbort is a no-op for keys never begun.
      const threadId =
        "threadId" in (command as { threadId?: string })
          ? (command as { threadId: string }).threadId
          : null;
      if (threadId) {
        sloAbortSpan("thread-create", threadId, "dispatch-error");
        sloAbortSpan("first-byte", threadId, "dispatch-error");
      }
      return Effect.sync(() => {
        // err is unused here — already logged by the outer mapError
        void err;
      });
    }),
    Effect.mapError((cause) =>
      Schema.is(OrchestrationDispatchCommandError)(cause)
        ? cause
        : new OrchestrationDispatchCommandError({
            message: "Failed to dispatch orchestration command",
            cause,
          }),
    ),
  );
