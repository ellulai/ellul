// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type {
  ApprovalRequestId,
  ProviderAdapterCapabilities,
  ProviderAdapterShape,
  ProviderInterruptTurnInput,
  ProviderKind,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderThreadSnapshot,
  ProviderTurnStartResult,
  ThreadId,
} from "@ellul.ai/types";
import { Context, Effect, Option, PubSub, Scope, Stream } from "effect";
import {
  ProviderSessionNotFoundError,
  type ProviderAdapterError,
  type ProviderServiceError,
} from "./errors";
import { ProviderAdapterRegistry } from "./registry";
import { ProviderSessionDirectory } from "./session-directory";

export interface ProviderServiceShape {
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, ProviderServiceError>;

  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  readonly getCapabilities: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "ellul/adapters/ProviderService",
) {}

export const makeProviderService = (input: {
  readonly adapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
  readonly registry: import("./registry").ProviderAdapterRegistryShape;
  readonly directory: import("./session-directory").ProviderSessionDirectoryShape;
}): Effect.Effect<ProviderServiceShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { adapters, registry, directory } = input;

    // PubSub broadcast: Stream.mergeAll over Stream.fromQueue work-steals
    // between consumers, dropping events to whichever Stream.runForEach
    // takes them first.
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    yield* Effect.forEach(
      adapters,
      (adapter) =>
        Stream.runForEach(adapter.streamEvents, (event) =>
          PubSub.publish(runtimeEventPubSub, event),
        ).pipe(Effect.forkScoped),
      { discard: true },
    );

  const resolveThreadAdapter = (
    threadId: ThreadId,
  ): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderServiceError> =>
    Effect.gen(function* () {
      const provider = yield* directory.getProvider(threadId);
      if (Option.isNone(provider)) {
        return yield* Effect.fail(new ProviderSessionNotFoundError({ threadId }));
      }
      return yield* registry.getByProvider(provider.value);
    });

  return {
    startSession: (threadId, startInput) =>
      Effect.gen(function* () {
        const provider = startInput.provider;
        if (!provider) {
          return yield* Effect.fail(
            new ProviderSessionNotFoundError({
              threadId,
              cause: new Error("no provider specified in ProviderSessionStartInput"),
            }),
          );
        }
        const adapter = yield* registry.getByProvider(provider);
        const session = yield* adapter.startSession(startInput);
        yield* directory.upsert({ threadId, provider: session.provider, status: "starting" });
        return session;
      }),

    sendTurn: (turnInput) =>
      Effect.gen(function* () {
        const adapter = yield* resolveThreadAdapter(turnInput.threadId);
        return yield* adapter.sendTurn(turnInput);
      }),

    interruptTurn: (interruptInput) =>
      Effect.gen(function* () {
        const adapter = yield* resolveThreadAdapter(interruptInput.threadId);
        yield* adapter.interruptTurn(interruptInput.threadId, interruptInput.turnId);
      }),

    respondToRequest: (respondInput) =>
      Effect.gen(function* () {
        const adapter = yield* resolveThreadAdapter(respondInput.threadId);
        yield* adapter.respondToRequest(
          respondInput.threadId,
          respondInput.requestId,
          respondInput.decision,
        );
      }),

    respondToUserInput: (userInputRespond) =>
      Effect.gen(function* () {
        const adapter = yield* resolveThreadAdapter(userInputRespond.threadId);
        yield* adapter.respondToUserInput(
          userInputRespond.threadId,
          userInputRespond.requestId as ApprovalRequestId,
          userInputRespond.answers,
        );
      }),

    stopSession: (stopInput) =>
      Effect.gen(function* () {
        const adapter = yield* resolveThreadAdapter(stopInput.threadId);
        yield* adapter.stopSession(stopInput.threadId);
        yield* directory.remove(stopInput.threadId);
      }),

    rollbackThread: (threadId, numTurns) =>
      Effect.gen(function* () {
        const adapter = yield* resolveThreadAdapter(threadId);
        return yield* adapter.rollbackThread(threadId, numTurns);
      }),

    listSessions: () =>
      Effect.gen(function* () {
        const perAdapter = yield* Effect.forEach(adapters, (a) => a.listSessions(), {
          concurrency: "unbounded",
        });
        return perAdapter.flat();
      }),

    getCapabilities: (provider) =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(provider);
        return adapter.capabilities;
      }),

    get streamEvents(): Stream.Stream<ProviderRuntimeEvent> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});
