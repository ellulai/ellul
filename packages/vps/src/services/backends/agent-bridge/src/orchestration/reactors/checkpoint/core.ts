// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/CheckpointReactor.ts

import { IsoDateTime, type OrchestrationEvent, type ProviderRuntimeEvent } from "@ellul.ai/types";
import { Cause, Effect, Layer, Stream } from "effect";

import { ProviderService } from "../../../adapters/provider-service";
import { CheckpointStore } from "../../../checkpointing/Services/CheckpointStore";
import type { CheckpointStoreError } from "../../../checkpointing/Errors";
import { makeDrainableWorker } from "../../../shared/DrainableWorker";
import type { OrchestrationDispatchError } from "../../Errors";
import { OrchestrationEngineService } from "../../Services/OrchestrationEngine";
import { RuntimeReceiptBus } from "../../Services/RuntimeReceiptBus";
import {
  CheckpointReactor,
  type CheckpointReactorShape,
} from "../../Services/CheckpointReactor";
import { makeCaptureHelpers } from "./capture";
import { makeActivityDispatchers, makeCwdHelpers, toTurnId, type ReactorInput } from "./helpers";
import { makeRevertHelpers } from "./revert";

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;

  const activity = makeActivityDispatchers(orchestrationEngine);
  const cwd = makeCwdHelpers({ orchestrationEngine, providerService });
  const capture = makeCaptureHelpers({
    orchestrationEngine,
    checkpointStore,
    receiptBus,
    activity,
    cwd,
  });
  const revert = makeRevertHelpers({
    orchestrationEngine,
    providerService,
    checkpointStore,
    activity,
    cwd,
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* capture.ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* revert.handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          activity.appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: IsoDateTime.make(new Date().toISOString()),
          }),
        ),
      );
      return;
    }

    if (event.type === "thread.turn-diff-completed") {
      yield* capture.captureCheckpointFromPlaceholder(event).pipe(
        Effect.catch((error) =>
          activity
            .appendCaptureFailureActivity({
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              detail: error.message,
              createdAt: IsoDateTime.make(new Date().toISOString()),
            })
            .pipe(Effect.catch(() => Effect.void)),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "turn.started") {
      yield* capture.ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      yield* capture.captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          activity
            .appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt: IsoDateTime.make(new Date().toISOString()),
            })
            .pipe(Effect.catch(() => Effect.void)),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
