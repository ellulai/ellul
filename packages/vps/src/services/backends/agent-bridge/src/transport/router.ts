// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/ws.ts

import {
  ClientOrchestrationCommand,
  ELLUL_WS_METHODS,
  EllulRefreshProviderInput,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationSubscribeThreadInput,
  type EllulGetProvidersResult,
  type EllulProvidersStreamItem,
  type OrchestrationEvent,
  type OrchestrationReplayEventsResult,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
} from "@ellul.ai/types";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { clamp } from "effect/Number";

import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver";
import { ServerConfig } from "../shared/config";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths";
import { enrichOrchestrationEvents, isThreadDetailEvent, toShellStreamEvent } from "./enrichment";
import { handleDispatchCommand } from "./handlers/dispatch-command";
import { handleGetZenModels } from "./handlers/get-zen-models";
import { ProviderRegistry } from "../shared/ProviderRegistry";

type EnvelopeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | RepositoryIdentityResolver
  | FileSystem.FileSystem
  | Path.Path
  | ProviderRegistry
  | ServerConfig
  | WorkspacePaths;

export type UnaryHandler = (payload: unknown) => Effect.Effect<unknown, unknown, EnvelopeServices>;
export type StreamHandler = (
  payload: unknown,
) => Effect.Effect<Stream.Stream<unknown, unknown>, unknown, EnvelopeServices>;

export interface RouterEntry {
  readonly kind: "unary" | "stream";
  readonly handler: UnaryHandler | StreamHandler;
}

class OrchestrationDecodeError extends Schema.TaggedErrorClass<OrchestrationDecodeError>()(
  "OrchestrationDecodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const decodeInput = <S extends Schema.Top>(
  schema: S,
  payload: unknown,
  errorMessage: string,
): Effect.Effect<S["Type"], OrchestrationDecodeError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(payload).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationDecodeError({
          message: errorMessage,
          cause,
        }),
    ),
  );

const unaryDispatchCommand: UnaryHandler = (payload) =>
  decodeInput(ClientOrchestrationCommand, payload, "Invalid dispatch command payload").pipe(
    Effect.flatMap((command) => handleDispatchCommand(command)),
  );

const unaryGetTurnDiff: UnaryHandler = (payload) =>
  Effect.gen(function* () {
    const input = yield* decodeInput(
      OrchestrationGetTurnDiffInput,
      payload,
      "Invalid getTurnDiff input",
    );
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    return yield* checkpointDiffQuery.getTurnDiff(input);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetTurnDiffError({
          message: "Failed to load turn diff",
          cause,
        }),
    ),
  );

const unaryGetFullThreadDiff: UnaryHandler = (payload) =>
  Effect.gen(function* () {
    const input = yield* decodeInput(
      OrchestrationGetFullThreadDiffInput,
      payload,
      "Invalid getFullThreadDiff input",
    );
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    return yield* checkpointDiffQuery.getFullThreadDiff(input);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetFullThreadDiffError({
          message: "Failed to load full thread diff",
          cause,
        }),
    ),
  );

const unaryReplayEvents: UnaryHandler = (payload) =>
  Effect.gen(function* () {
    const input = yield* decodeInput(
      OrchestrationReplayEventsInput,
      payload,
      "Invalid replayEvents input",
    );
    const orchestrationEngine = yield* OrchestrationEngineService;
    const events = yield* Stream.runCollect(
      orchestrationEngine.readEvents(
        clamp(input.fromSequenceExclusive, {
          maximum: Number.MAX_SAFE_INTEGER,
          minimum: 0,
        }),
      ),
    ).pipe(Effect.map((chunk) => Array.from(chunk) as ReadonlyArray<OrchestrationEvent>));
    return (yield* enrichOrchestrationEvents(events)) as OrchestrationReplayEventsResult;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationReplayEventsError({
          message: "Failed to replay orchestration events",
          cause,
        }),
    ),
  );

const streamSubscribeShell: StreamHandler = (_payload) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load orchestration shell snapshot",
            cause,
          }),
      ),
    );

    const liveStream: Stream.Stream<OrchestrationShellStreamItem, never, ProjectionSnapshotQuery> =
      orchestrationEngine.streamDomainEvents.pipe(
        Stream.mapEffect(toShellStreamEvent),
        Stream.flatMap((event) =>
          Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
        ),
      );

    return Stream.concat(
      Stream.make({ kind: "snapshot" as const, snapshot }) as Stream.Stream<
        OrchestrationShellStreamItem
      >,
      liveStream,
    ) as unknown as Stream.Stream<unknown, unknown>;
  });

const streamSubscribeThread: StreamHandler = (payload) =>
  Effect.gen(function* () {
    const input = yield* decodeInput(
      OrchestrationSubscribeThreadInput,
      payload,
      "Invalid subscribeThread input",
    );
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const [threadDetail, snapshotSequence] = yield* Effect.all([
      projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: `Failed to load thread ${input.threadId}`,
              cause,
            }),
        ),
      ),
      orchestrationEngine
        .getReadModel()
        .pipe(Effect.map((readModel) => readModel.snapshotSequence)),
    ]);

    if (Option.isNone(threadDetail)) {
      return yield* new OrchestrationGetSnapshotError({
        message: `Thread ${input.threadId} was not found`,
        cause: input.threadId,
      });
    }

    const liveStream: Stream.Stream<OrchestrationThreadStreamItem> =
      orchestrationEngine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.aggregateKind === "thread" &&
            event.aggregateId === input.threadId &&
            isThreadDetailEvent(event),
        ),
        Stream.map((event) => ({
          kind: "event" as const,
          event,
        })),
      );

    return Stream.concat(
      Stream.make({
        kind: "snapshot" as const,
        snapshot: {
          snapshotSequence,
          thread: threadDetail.value,
        },
      }),
      liveStream,
    ) as Stream.Stream<unknown, unknown>;
  });

const unaryGetZenModels: UnaryHandler = () => handleGetZenModels();

const unaryGetProviders: UnaryHandler = () =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const providers = yield* registry.getProviders;
    return { providers } satisfies EllulGetProvidersResult;
  });

const unaryRefreshProvider: UnaryHandler = (payload) =>
  decodeInput(EllulRefreshProviderInput, payload, "Invalid refresh provider payload").pipe(
    Effect.flatMap(({ provider }) =>
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        const providers = yield* registry.refresh(provider);
        return { providers } satisfies EllulGetProvidersResult;
      }),
    ),
  );

const streamSubscribeProviders: StreamHandler = () =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const initial = yield* registry.getProviders;
    const initialStream: Stream.Stream<EllulProvidersStreamItem, never> = Stream.make({
      kind: "snapshot" as const,
      providers: initial,
    });
    const liveStream: Stream.Stream<EllulProvidersStreamItem, never> = registry.streamChanges.pipe(
      Stream.map(
        (providers) =>
          ({ kind: "snapshot" as const, providers }) satisfies EllulProvidersStreamItem,
      ),
    );
    return Stream.concat(initialStream, liveStream) as Stream.Stream<unknown, unknown>;
  });

export const ORCHESTRATION_RPC_ROUTER: Record<string, RouterEntry> = {
  [ORCHESTRATION_WS_METHODS.dispatchCommand]: {
    kind: "unary",
    handler: unaryDispatchCommand,
  },
  [ORCHESTRATION_WS_METHODS.getTurnDiff]: {
    kind: "unary",
    handler: unaryGetTurnDiff,
  },
  [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: {
    kind: "unary",
    handler: unaryGetFullThreadDiff,
  },
  [ORCHESTRATION_WS_METHODS.replayEvents]: {
    kind: "unary",
    handler: unaryReplayEvents,
  },
  [ORCHESTRATION_WS_METHODS.subscribeShell]: {
    kind: "stream",
    handler: streamSubscribeShell,
  },
  [ORCHESTRATION_WS_METHODS.subscribeThread]: {
    kind: "stream",
    handler: streamSubscribeThread,
  },
  [ELLUL_WS_METHODS.getZenModels]: {
    kind: "unary",
    handler: unaryGetZenModels,
  },
  [ELLUL_WS_METHODS.getProviders]: {
    kind: "unary",
    handler: unaryGetProviders,
  },
  [ELLUL_WS_METHODS.refreshProvider]: {
    kind: "unary",
    handler: unaryRefreshProvider,
  },
  [ELLUL_WS_METHODS.subscribeProviders]: {
    kind: "stream",
    handler: streamSubscribeProviders,
  },
};
