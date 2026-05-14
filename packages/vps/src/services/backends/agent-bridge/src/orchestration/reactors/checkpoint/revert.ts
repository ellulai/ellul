// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/CheckpointReactor.ts

import { IsoDateTime, type OrchestrationEvent } from "@ellul.ai/types";
import { Effect, Option } from "effect";

import type { ProviderServiceShape } from "../../../adapters/provider-service";
import type { CheckpointStoreShape } from "../../../checkpointing/Services/CheckpointStore";
import { checkpointRefForThreadTurn } from "../../../checkpointing/Utils";
import type { OrchestrationEngineShape } from "../../Services/OrchestrationEngine";
import { serverCommandId, type ActivityDispatchers, type CwdHelpers } from "./helpers";

export interface RevertHelpersInput {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly checkpointStore: CheckpointStoreShape;
  readonly activity: ActivityDispatchers;
  readonly cwd: CwdHelpers;
}

export const makeRevertHelpers = (deps: RevertHelpersInput) => {
  const {
    orchestrationEngine,
    providerService,
    checkpointStore,
    activity,
    cwd: cwdHelpers,
  } = deps;

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = IsoDateTime.make(new Date().toISOString());

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    if (!thread) {
      yield* activity
        .appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "Thread was not found in read model.",
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* cwdHelpers.resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* activity
        .appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "No active provider session with workspace cwd is bound to this thread.",
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!cwdHelpers.isGitWorkspace(sessionRuntime.value.cwd)) {
      yield* activity
        .appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "Checkpoints are unavailable because this project is not a git repository.",
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* activity
        .appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* activity
        .appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
      return;
    }

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: sessionRuntime.value.cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: event.payload.turnCount === 0,
    });
    if (!restored) {
      yield* activity
        .appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
      return;
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackThread(sessionRuntime.value.threadId, rolledBackTurns);
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          activity.appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  return { handleRevertRequested };
};

export type RevertHelpers = ReturnType<typeof makeRevertHelpers>;
