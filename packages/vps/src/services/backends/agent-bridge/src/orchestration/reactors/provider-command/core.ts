// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/ProviderCommandReactor.ts

import type { ModelSelection, OrchestrationEvent } from "@ellul.ai/types";
import { Cache, Cause, Effect, Layer, Option, Stream } from "effect";

import { ProviderService } from "../../../adapters/provider-service";
import { debugLog } from "./helpers";
import { makeDrainableWorker } from "../../../shared/DrainableWorker";
import { ServerSettingsService } from "../../../shared/serverSettings";
import { TextGeneration } from "../../../text-generation";
import { OrchestrationEngineService } from "../../Services/OrchestrationEngine";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../../Services/ProviderCommandReactor";
import { makeEventHandlers } from "./handlers";
import {
  HANDLED_TURN_START_KEY_MAX,
  HANDLED_TURN_START_KEY_TTL,
  type ProviderIntentEvent,
} from "./helpers";
import { makeSessionHelpers } from "./session";

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const serverSettingsService = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;

  const handledTurnStartKeysCache = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const handledTurnStartKeys = {
    has: (key: string) =>
      Cache.getOption(handledTurnStartKeysCache, key).pipe(
        Effect.flatMap((cached) =>
          Cache.set(handledTurnStartKeysCache, key, true).pipe(
            Effect.as(Option.isSome(cached)),
          ),
        ),
      ),
  };

  const threadModelSelections = new Map<string, ModelSelection>();
  const session = makeSessionHelpers({
    orchestrationEngine,
    providerService,
    threadModelSelections,
  });
  const handlers = makeEventHandlers({
    orchestrationEngine,
    providerService,
    serverSettingsService,
    textGeneration,
    session,
    threadModelSelections,
    handledTurnStartKeys,
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    debugLog(`processDomainEvent ENTER type=${event.type} thread=${event.payload.threadId}`);
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    switch (event.type) {
      case "thread.runtime-mode-set":
        yield* handlers.processRuntimeModeSet(event);
        return;
      case "thread.turn-start-requested":
        yield* handlers.processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* handlers.processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* handlers.processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* handlers.processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* handlers.processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    debugLog(`ProviderCommandReactor.start() invoked`);
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      debugLog(`stream got event type=${event.type}`);
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        debugLog(`enqueueing event ${event.type}`);
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
    debugLog(`ProviderCommandReactor stream subscription started`);
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
