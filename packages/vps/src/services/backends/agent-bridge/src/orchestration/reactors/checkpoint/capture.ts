// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/CheckpointReactor.ts

import {
  EventId,
  IsoDateTime,
  MessageId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@ellul.ai/types";
import { Effect } from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../../checkpointing/Diffs";
import type { CheckpointStoreShape } from "../../../checkpointing/Services/CheckpointStore";
import { checkpointRefForThreadTurn } from "../../../checkpointing/Utils";
import type { OrchestrationEngineShape } from "../../Services/OrchestrationEngine";
import type { RuntimeReceiptBusShape } from "../../Services/RuntimeReceiptBus";
import {
  checkpointStatusFromRuntime,
  nonNegInt,
  sameId,
  serverCommandId,
  toTurnId,
  type ActivityDispatchers,
  type CwdHelpers,
} from "./helpers";

export interface CaptureHelpersInput {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly checkpointStore: CheckpointStoreShape;
  readonly receiptBus: RuntimeReceiptBusShape;
  readonly activity: ActivityDispatchers;
  readonly cwd: CwdHelpers;
}

export const makeCaptureHelpers = (deps: CaptureHelpersInput) => {
  const {
    orchestrationEngine,
    checkpointStore,
    receiptBus,
    activity,
    cwd: cwdHelpers,
  } = deps;

  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: IsoDateTime;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: nonNegInt(file.additions),
            deletions: nonNegInt(file.deletions),
          })),
        ),
        Effect.tapError((error) =>
          activity.appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(
            Effect.as(
              [] as ReadonlyArray<{
                readonly path: string;
                readonly kind: "modified";
                readonly additions: ReturnType<typeof nonNegInt>;
                readonly deletions: ReturnType<typeof nonNegInt>;
              }>,
            ),
          ),
        ),
      );

    const assistantMessageId =
      input.assistantMessageId ??
      [...input.thread.messages]
        .reverse()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: nonNegInt(input.turnCount),
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: nonNegInt(input.turnCount),
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: nonNegInt(input.turnCount),
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) return;

      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.threadId);
      if (!thread) return;

      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) return;

      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const checkpointCwd = yield* cwdHelpers.resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects: readModel.projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) return;

      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status: checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const captureCheckpointFromPlaceholder = Effect.fn("captureCheckpointFromPlaceholder")(
    function* (event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>) {
      const { threadId, turnId, checkpointTurnCount, status } = event.payload;

      if (status !== "missing") return;

      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      if (!thread) {
        yield* Effect.logWarning(
          "checkpoint capture from placeholder skipped: thread not found",
          { threadId },
        );
        return;
      }

      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        yield* Effect.logDebug(
          "checkpoint capture from placeholder skipped: real checkpoint already exists",
          { threadId, turnId },
        );
        return;
      }

      const checkpointCwd = yield* cwdHelpers.resolveCheckpointCwd({
        threadId,
        thread,
        projects: readModel.projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) return;

      yield* captureAndDispatchCheckpoint({
        threadId,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: checkpointTurnCount,
        status: "ready",
        assistantMessageId: event.payload.assistantMessageId ?? undefined,
        createdAt: event.payload.completedAt,
      });
    },
  );

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) return;

      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.threadId);
      if (!thread) return;

      const checkpointCwd = yield* cwdHelpers.resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects: readModel.projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) return;

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) return;

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: nonNegInt(currentTurnCount),
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) return;

    const checkpointCwd = yield* cwdHelpers.resolveCheckpointCwd({
      threadId,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) return;

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) return;

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: nonNegInt(currentTurnCount),
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  return {
    captureAndDispatchCheckpoint,
    captureCheckpointFromTurnCompletion,
    captureCheckpointFromPlaceholder,
    ensurePreTurnBaselineFromTurnStart,
    ensurePreTurnBaselineFromDomainTurnStart,
  };
};

export type CaptureHelpers = ReturnType<typeof makeCaptureHelpers>;
