// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/CheckpointReactor.ts

import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  TurnId,
  type OrchestrationEvent,
  type ProjectId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@ellul.ai/types";
import { Effect, Option } from "effect";

import type { ProviderServiceShape } from "../../../adapters/provider-service";
import { resolveThreadWorkspaceCwd } from "../../../checkpointing/Utils";
import { isGitRepository } from "../../../git/Utils";
import type { OrchestrationEngineShape } from "../../Services/OrchestrationEngine";

export type ReactorInput =
  | { readonly source: "runtime"; readonly event: ProviderRuntimeEvent }
  | { readonly source: "domain"; readonly event: OrchestrationEvent };

export function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

export function sameId(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return left === right;
}

export function checkpointStatusFromRuntime(
  status: string | undefined,
): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

export const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

export type NonNegInt = typeof NonNegativeInt.Type;
export const nonNegInt = (value: number): NonNegInt => NonNegativeInt.make(Math.max(0, value));

export const makeActivityDispatchers = (orchestrationEngine: OrchestrationEngineShape) => {
  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: IsoDateTime;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: {
          turnCount: input.turnCount,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: IsoDateTime;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.capture.failed",
        summary: "Checkpoint capture failed",
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  return { appendRevertFailureActivity, appendCaptureFailureActivity };
};

export type ActivityDispatchers = ReturnType<typeof makeActivityDispatchers>;

export const makeCwdHelpers = (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
}) => {
  const { orchestrationEngine, providerService } = input;

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);

    const sessions = yield* providerService.listSessions();

    const findSessionWithCwd = (
      session: (typeof sessions)[number] | undefined,
    ): Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }> => {
      if (!session?.cwd) return Option.none();
      return Option.some({ threadId: session.threadId, cwd: session.cwd });
    };

    if (thread) {
      const projectedSession = sessions.find((session) => session.threadId === thread.id);
      const fromProjected = findSessionWithCwd(projectedSession);
      if (Option.isSome(fromProjected)) return fromProjected;
    }

    return Option.none<{ readonly threadId: ThreadId; readonly cwd: string }>();
  });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (args: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }) {
    const fromSession = yield* resolveSessionRuntimeForThread(args.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: args.thread,
      projects: args.projects,
    });

    const cwd = args.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) return undefined;
    if (!isGitWorkspace(cwd)) return undefined;
    return cwd;
  });

  return { resolveSessionRuntimeForThread, resolveCheckpointCwd, isGitWorkspace };
};

export type CwdHelpers = ReturnType<typeof makeCwdHelpers>;
