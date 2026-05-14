// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Sits above OpenCodeServerPool and pre-creates `client.session.create`
// calls so thread-acquire skips the heaviest synchronous step. Keyed by
// (project, runtimeMode) because session.create's `permission` is
// runtime-mode-specific. warmDepth is sourced from
// computeAdapterPoolProfile. Crash of the underlying server invalidates
// every parked entry for that project; the next claim falls through to
// a fresh create.

import {
  Cause,
  Context,
  Effect,
  Layer,
  Scope,
  Semaphore,
  Exit,
} from "effect";
import { logEvent } from "../../shared/event-log";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeServerProcess,
} from "./runtime";
import {
  OpenCodeServerPool,
  type CrashCallback,
  type OpenCodeServerPoolAcquireResult,
} from "./server-pool";

/** SDK shape; narrowed to "at least id" so the adapter can consume `.title`/etc. */
export type OpenCodeSdkSessionData = {
  readonly id: string;
} & Record<string, unknown>;

export interface WarmOpenCodeSession {
  readonly project: string;
  readonly runtimeMode: string;
  readonly sessionId: string;
  readonly sdkSession: OpenCodeSdkSessionData;
  readonly url: string;
  readonly generation: number;
  readonly createdAt: number;
}

export interface WarmSessionAcquireInput {
  readonly project: string;
  readonly runtimeMode: string;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly threadSessionId: string;
  readonly onCrash: CrashCallback;
  /** Pure function — we may call it once at warm-create and never again. */
  readonly buildPermission: () => unknown;
}

export interface WarmSessionAcquireResult {
  readonly session: WarmOpenCodeSession;
  readonly fromWarmPool: boolean;
}

export interface WarmSessionPoolShape {
  /** Pop a warm session if available, otherwise fall through to direct create. */
  readonly acquire: (
    input: WarmSessionAcquireInput,
  ) => Effect.Effect<WarmSessionAcquireResult, OpenCodeRuntimeError>;

  /** Top up to warmDepth. Idempotent. */
  readonly topUp: (input: {
    readonly project: string;
    readonly runtimeMode: string;
    readonly binaryPath: string;
    readonly cwd: string;
    readonly buildPermission: () => unknown;
    readonly warmDepth: number;
  }) => Effect.Effect<{ readonly created: number; readonly skipped: number }, never>;

  /** Drop every parked entry for project. Server pool refs released elsewhere. */
  readonly invalidateProject: (project: string) => Effect.Effect<number, never>;

  readonly listSessions: Effect.Effect<ReadonlyArray<WarmOpenCodeSession>, never>;
}

export class WarmSessionPool extends Context.Service<
  WarmSessionPool,
  WarmSessionPoolShape
>()("ellul/adapters/WarmSessionPool") {}

interface WarmEntry {
  readonly project: string;
  readonly runtimeMode: string;
  readonly sessionId: string;
  readonly sdkSession: OpenCodeSdkSessionData;
  readonly url: string;
  readonly generation: number;
  readonly createdAt: number;
  /** OpenCodeServerPool sessionId we used to acquire — released on crash. */
  readonly poolSessionId: string;
}

const WARM_EVENT = (op: string, fields: Record<string, unknown>): void => {
  logEvent(`opencode.warmSession.${op}`, fields);
};

const keyFor = (project: string, runtimeMode: string): string =>
  `${project}::${runtimeMode}`;

const makeWarmSessionPool = Effect.gen(function* () {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const serverPool = yield* OpenCodeServerPool;

  // FIFO so the oldest pre-create is claimed first — minimises opencode-side
  // TTL eviction races.
  const parked = new Map<string, WarmEntry[]>();

  // Per-key mutex serialises concurrent acquires + top-ups for the same key.
  const mutexes = new Map<string, Semaphore.Semaphore>();
  const mutexFor = (key: string): Semaphore.Semaphore => {
    const existing = mutexes.get(key);
    if (existing) return existing;
    const fresh = Semaphore.makeUnsafe(1);
    mutexes.set(key, fresh);
    return fresh;
  };

  // Background top-ups fork into the layer scope so bridge shutdown
  // cancels in-flight pre-creates.
  const layerScope = yield* Scope.Scope;

  const dropParked = (key: string, sessionId: string): void => {
    const queue = parked.get(key);
    if (!queue) return;
    const idx = queue.findIndex((e) => e.sessionId === sessionId);
    if (idx < 0) return;
    queue.splice(idx, 1);
    if (queue.length === 0) parked.delete(key);
    WARM_EVENT("dropped", { project: queue[0]?.project ?? "n/a", sessionId, key });
  };

  const createOneWarm = (input: {
    readonly project: string;
    readonly runtimeMode: string;
    readonly binaryPath: string;
    readonly cwd: string;
    readonly buildPermission: () => unknown;
  }): Effect.Effect<WarmEntry | null, never> =>
    Effect.gen(function* () {
      // Server-pool ref ownership: warm holds it until claimed (claimer
      // takes over) or crashed (we release).
      const poolSessionId = `warm-${input.project}-${input.runtimeMode}-${crypto.randomUUID().slice(0, 8)}`;
      const acquireExit = yield* Effect.exit(
        serverPool.acquire({
          project: input.project,
          binaryPath: input.binaryPath,
          cwd: input.cwd,
          sessionId: poolSessionId,
          onCrash: (reason) =>
            Effect.sync(() => {
              dropParked(keyFor(input.project, input.runtimeMode), poolSessionId);
              WARM_EVENT("crashWhileWarm", {
                project: input.project,
                runtimeMode: input.runtimeMode,
                poolSessionId,
                reason,
              });
            }),
        }),
      );
      if (Exit.isFailure(acquireExit)) {
        WARM_EVENT("createFail.acquire", {
          project: input.project,
          runtimeMode: input.runtimeMode,
          cause: Cause.pretty(acquireExit.cause),
        });
        return null;
      }
      const handle: OpenCodeServerPoolAcquireResult = acquireExit.value;

      const client = openCodeRuntime.createOpenCodeSdkClient({
        baseUrl: handle.url,
        directory: input.cwd,
      });

      const sessionExit = yield* Effect.exit(
        Effect.tryPromise({
          // session.create has no abort signal in the SDK; opencode bounds it.
          try: () =>
            (
              client.session.create as (args: {
                readonly title: string;
                readonly permission: unknown;
              }) => Promise<{ readonly data: OpenCodeSdkSessionData | undefined }>
            )({
              title: `ellul warm ${input.project}/${input.runtimeMode}`,
              permission: input.buildPermission(),
            }),
          catch: (cause) => cause,
        }),
      );
      if (Exit.isFailure(sessionExit)) {
        yield* serverPool.release({ project: input.project, sessionId: poolSessionId });
        WARM_EVENT("createFail.session", {
          project: input.project,
          runtimeMode: input.runtimeMode,
          cause: Cause.pretty(sessionExit.cause),
        });
        return null;
      }
      const created = sessionExit.value;
      if (!created.data) {
        yield* serverPool.release({ project: input.project, sessionId: poolSessionId });
        WARM_EVENT("createFail.noData", {
          project: input.project,
          runtimeMode: input.runtimeMode,
        });
        return null;
      }

      const entry: WarmEntry = {
        project: input.project,
        runtimeMode: input.runtimeMode,
        sessionId: created.data.id,
        sdkSession: created.data,
        url: handle.url,
        generation: handle.generation,
        createdAt: Date.now(),
        poolSessionId,
      };
      WARM_EVENT("created", {
        project: entry.project,
        runtimeMode: entry.runtimeMode,
        sessionId: entry.sessionId,
        generation: entry.generation,
      });
      return entry;
    });

  const topUp: WarmSessionPoolShape["topUp"] = (input) =>
    Effect.gen(function* () {
      const key = keyFor(input.project, input.runtimeMode);
      return yield* mutexFor(key).withPermit(
        Effect.gen(function* () {
          const queue = parked.get(key) ?? [];
          const need = Math.max(0, input.warmDepth - queue.length);
          if (need === 0) {
            return { created: 0, skipped: queue.length };
          }
          let created = 0;
          for (let i = 0; i < need; i++) {
            const entry = yield* createOneWarm({
              project: input.project,
              runtimeMode: input.runtimeMode,
              binaryPath: input.binaryPath,
              cwd: input.cwd,
              buildPermission: input.buildPermission,
            });
            if (entry) {
              queue.push(entry);
              created += 1;
            }
          }
          if (queue.length > 0) parked.set(key, queue);
          else parked.delete(key);
          WARM_EVENT("topUp.done", {
            project: input.project,
            runtimeMode: input.runtimeMode,
            requested: need,
            created,
            depthAfter: queue.length,
          });
          return { created, skipped: queue.length - created };
        }),
      );
    });

  const acquire: WarmSessionPoolShape["acquire"] = (input) =>
    Effect.gen(function* () {
      const key = keyFor(input.project, input.runtimeMode);
      // Try the warm pool first under the key mutex.
      const popped = yield* mutexFor(key).withPermit(
        Effect.sync(() => {
          const queue = parked.get(key);
          if (!queue || queue.length === 0) return null;
          const entry = queue.shift()!;
          if (queue.length === 0) parked.delete(key);
          return entry;
        }),
      );
      if (popped) {
        // Re-acquire under threadSessionId so the pool's session-callback
        // map ends up keyed by the thread (release path uses that key).
        // pool.acquire is idempotent on an existing entry.
        const acquireExit = yield* Effect.exit(
          serverPool.acquire({
            project: input.project,
            binaryPath: input.binaryPath,
            cwd: input.cwd,
            sessionId: input.threadSessionId,
            onCrash: input.onCrash,
          }),
        );
        // Release the warm-creator's hold either way.
        yield* serverPool.release({
          project: input.project,
          sessionId: popped.poolSessionId,
        });
        if (Exit.isFailure(acquireExit)) {
          // Server died between pre-create and claim — fall through to cold path.
          WARM_EVENT("acquire.serverGoneFallback", {
            project: input.project,
            runtimeMode: input.runtimeMode,
            sessionId: popped.sessionId,
            cause: Cause.pretty(acquireExit.cause),
          });
        } else {
          const handle = acquireExit.value;
          WARM_EVENT("acquire.hit", {
            project: input.project,
            runtimeMode: input.runtimeMode,
            sessionId: popped.sessionId,
            generation: handle.generation,
          });
          // Background top-up. The reconciler raises depth on larger tiers;
          // 1 is the floor and a safe lower bound on every tier.
          yield* Effect.forkIn(
            topUp({
              project: input.project,
              runtimeMode: input.runtimeMode,
              binaryPath: input.binaryPath,
              cwd: input.cwd,
              buildPermission: input.buildPermission,
              warmDepth: 1,
            }),
            layerScope,
          );
          return {
            session: {
              project: popped.project,
              runtimeMode: popped.runtimeMode,
              sessionId: popped.sessionId,
              sdkSession: popped.sdkSession,
              url: handle.url,
              generation: handle.generation,
              createdAt: popped.createdAt,
            },
            fromWarmPool: true,
          } satisfies WarmSessionAcquireResult;
        }
      }

      // Cold path — direct session.create against the (acquired) server.
      WARM_EVENT("acquire.miss", {
        project: input.project,
        runtimeMode: input.runtimeMode,
      });
      const acquireExit = yield* Effect.exit(
        serverPool.acquire({
          project: input.project,
          binaryPath: input.binaryPath,
          cwd: input.cwd,
          sessionId: input.threadSessionId,
          onCrash: input.onCrash,
        }),
      );
      if (Exit.isFailure(acquireExit)) {
        const cause = Cause.squash(acquireExit.cause);
        if (cause instanceof OpenCodeRuntimeError) {
          return yield* Effect.fail(cause);
        }
        return yield* Effect.fail(
          new OpenCodeRuntimeError({
            operation: "warmSessionPool.acquire",
            detail: "server pool acquire failed during cold path",
            cause,
          }),
        );
      }
      const handle = acquireExit.value;
      const client = openCodeRuntime.createOpenCodeSdkClient({
        baseUrl: handle.url,
        directory: input.cwd,
      });
      const createdExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () =>
            (
              client.session.create as (args: {
                readonly title: string;
                readonly permission: unknown;
              }) => Promise<{ readonly data: OpenCodeSdkSessionData | undefined }>
            )({
              title: `ellul ${input.threadSessionId}`,
              permission: input.buildPermission(),
            }),
          catch: (c) => c,
        }),
      );
      if (Exit.isFailure(createdExit) || !createdExit.value.data) {
        yield* serverPool.release({
          project: input.project,
          sessionId: input.threadSessionId,
        });
        return yield* Effect.fail(
          new OpenCodeRuntimeError({
            operation: "warmSessionPool.coldCreate",
            detail: "session.create returned no payload",
          }),
        );
      }
      const data = createdExit.value.data;
      return {
        session: {
          project: input.project,
          runtimeMode: input.runtimeMode,
          sessionId: data.id,
          sdkSession: data,
          url: handle.url,
          generation: handle.generation,
          createdAt: Date.now(),
        },
        fromWarmPool: false,
      } satisfies WarmSessionAcquireResult;
    });

  const invalidateProject: WarmSessionPoolShape["invalidateProject"] = (project) =>
    Effect.sync(() => {
      let dropped = 0;
      for (const [key, queue] of [...parked.entries()]) {
        if (!key.startsWith(`${project}::`)) continue;
        dropped += queue.length;
        parked.delete(key);
      }
      if (dropped > 0) {
        WARM_EVENT("invalidated", { project, dropped });
      }
      return dropped;
    });

  const listSessions: WarmSessionPoolShape["listSessions"] = Effect.sync(() =>
    [...parked.values()].flat().map((e) => ({
      project: e.project,
      runtimeMode: e.runtimeMode,
      sessionId: e.sessionId,
      sdkSession: e.sdkSession,
      url: e.url,
      generation: e.generation,
      createdAt: e.createdAt,
    })),
  );

  return {
    acquire,
    topUp,
    invalidateProject,
    listSessions,
  } satisfies WarmSessionPoolShape;
});

export const WarmSessionPoolLive = Layer.effect(WarmSessionPool, makeWarmSessionPool);

/** Re-exported so callers reach for the warm pool's home for tier→depth. */
export { computeAdapterPoolProfile } from "@vps/shared/memory-budget";
