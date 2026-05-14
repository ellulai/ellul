// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/ws.ts

import {
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  ThreadId,
} from "@ellul.ai/types";
import { Effect, Option } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver";

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

export const enrichProjectEvent = (
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationEvent, never, RepositoryIdentityResolver | OrchestrationEngineService> =>
  Effect.gen(function* () {
    const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
    const orchestrationEngine = yield* OrchestrationEngineService;
    switch (event.type) {
      case "project.created":
        return yield* repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
          Effect.map((repositoryIdentity) => ({
            ...event,
            payload: {
              ...event.payload,
              repositoryIdentity,
            },
          })),
        );
      case "project.meta-updated": {
        const workspaceRoot =
          event.payload.workspaceRoot ??
          (yield* orchestrationEngine.getReadModel()).projects.find(
            (project) => project.id === event.payload.projectId,
          )?.workspaceRoot ??
          null;
        if (workspaceRoot === null) {
          return event;
        }
        const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
        return {
          ...event,
          payload: {
            ...event.payload,
            repositoryIdentity,
          },
        } satisfies OrchestrationEvent;
      }
      default:
        return event;
    }
  });

export const enrichOrchestrationEvents = (
  events: ReadonlyArray<OrchestrationEvent>,
): Effect.Effect<
  ReadonlyArray<OrchestrationEvent>,
  never,
  RepositoryIdentityResolver | OrchestrationEngineService
> => Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

export const toShellStreamEvent = (
  event: OrchestrationEvent,
): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, ProjectionSnapshotQuery> =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
        return yield* projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
          Effect.map((project) =>
            Option.map(project, (nextProject) => ({
              kind: "project-upserted" as const,
              sequence: event.sequence,
              project: nextProject,
            })),
          ),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
      case "project.deleted":
        return Option.some({
          kind: "project-removed" as const,
          sequence: event.sequence,
          projectId: event.payload.projectId,
        });
      case "thread.deleted":
        return Option.some({
          kind: "thread-removed" as const,
          sequence: event.sequence,
          threadId: event.payload.threadId,
        });
      default:
        if (event.aggregateKind !== "thread") {
          return Option.none();
        }
        return yield* projectionSnapshotQuery
          .getThreadShellById(ThreadId.make(event.aggregateId))
          .pipe(
            Effect.map((thread) =>
              Option.map(thread, (nextThread) => ({
                kind: "thread-upserted" as const,
                sequence: event.sequence,
                thread: nextThread,
              })),
            ),
            Effect.catch(() => Effect.succeed(Option.none())),
          );
    }
  });
