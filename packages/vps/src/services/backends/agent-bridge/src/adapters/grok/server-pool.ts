// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Per-project Grok ACP runtime pool.
//
// Holds at most one `grok agent stdio` process per project namespace.
// Multiple chat threads share one process via ACP's session/new.
// Mirrors cursor/server-pool.ts — see that file for full lifecycle docs.

import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Scope,
  Semaphore,
  Predicate as P,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { sandboxIdFromCwd } from "@ellul.ai/types";
import * as EffectAcpErrors from "../vendor/t3code/effect-acp/errors";

import { logEvent } from "../../shared/event-log";
import {
  NAMESPACE_ADAPTER_ENV,
  NAMESPACE_PROJECT_ENV,
  NAMESPACE_SCOPE_ID_ENV,
  NAMESPACE_SOFT_HINT_MB_ENV,
} from "../../shared/namespace-spawner";
import { computeWorkloadSliceBudget } from "@vps/shared/memory-budget";
import * as os from "node:os";

const GROK_POOL_SOFT_HINT_MB = computeWorkloadSliceBudget(Math.max(512, Math.round(os.totalmem() / (1024 * 1024)))).perSandboxSoftHintMB;
let grokPoolGen = 0;
import type { GrokSettings } from "../../shared/serverSettings";
import {
  AcpProjectRuntime,
  type AcpProjectRuntimeOptions,
  type AcpProjectRuntimeShape,
  type AcpSessionRequestLogEvent,
} from "../cursor/acp/AcpProjectRuntime";
import { buildGrokAcpSpawnInput } from "./acp/GrokAcpSupport";

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

export type GrokCrashCallback = (reason: string) => Effect.Effect<void, never>;

export interface GrokAcpServerPoolEntrySummary {
  readonly project: string;
  readonly pid: number | null;
  readonly refCount: number;
  readonly sessionCount: number;
  readonly idleSince: number | null;
  readonly spawnedAt: number;
  readonly generation: number;
}

export interface GrokAcpServerPoolAcquireResult {
  readonly runtime: AcpProjectRuntimeShape;
  readonly generation: number;
  readonly pid: number | null;
}

export interface GrokAcpServerPoolAcquireInput {
  readonly project: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly clientInfo: AcpProjectRuntimeOptions["clientInfo"];
  readonly clientCapabilities?: AcpProjectRuntimeOptions["clientCapabilities"];
  readonly requestLogger?: AcpProjectRuntimeOptions["requestLogger"];
  readonly protocolLogging?: AcpProjectRuntimeOptions["protocolLogging"];
  readonly onCrash: GrokCrashCallback;
}

export interface GrokAcpServerPoolShape {
  readonly acquire: (
    input: GrokAcpServerPoolAcquireInput,
  ) => Effect.Effect<GrokAcpServerPoolAcquireResult, EffectAcpErrors.AcpError>;
  readonly release: (input: {
    readonly project: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, never>;
  readonly sweepIdle: (
    maxIdleMs: number,
  ) => Effect.Effect<{ readonly evicted: number; readonly retained: number }, never>;
  readonly listEntries: Effect.Effect<ReadonlyArray<GrokAcpServerPoolEntrySummary>, never>;
}

export class GrokAcpServerPool extends Context.Service<
  GrokAcpServerPool,
  GrokAcpServerPoolShape
>()("ellul/adapters/grok/GrokAcpServerPool") {}

export interface GrokAcpRuntimeFactoryShape {
  readonly spawnProjectRuntime: (input: {
    readonly project: string;
    readonly cwd: string;
    readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
    readonly clientInfo: AcpProjectRuntimeOptions["clientInfo"];
    readonly clientCapabilities?: AcpProjectRuntimeOptions["clientCapabilities"];
    readonly requestLogger?: AcpProjectRuntimeOptions["requestLogger"];
    readonly protocolLogging?: AcpProjectRuntimeOptions["protocolLogging"];
  }) => Effect.Effect<AcpProjectRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope>;
}

export class GrokAcpRuntimeFactory extends Context.Service<
  GrokAcpRuntimeFactory,
  GrokAcpRuntimeFactoryShape
>()("ellul/adapters/grok/GrokAcpRuntimeFactory") {}

const makeLiveGrokAcpRuntimeFactory = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return {
    spawnProjectRuntime: (input) => {
      const spawnInput = buildGrokAcpSpawnInput(input.grokSettings, input.cwd, {
        [NAMESPACE_PROJECT_ENV]: input.project,
        [NAMESPACE_ADAPTER_ENV]: "grok",
        [NAMESPACE_SCOPE_ID_ENV]: `g${++grokPoolGen}`,
        [NAMESPACE_SOFT_HINT_MB_ENV]: String(GROK_POOL_SOFT_HINT_MB),
      });
      const layerOptions: AcpProjectRuntimeOptions = {
        spawn: spawnInput,
        clientInfo: input.clientInfo,
        authMethodId: "xai.api_key",
        ...(input.clientCapabilities ? { clientCapabilities: input.clientCapabilities } : {}),
        ...(input.requestLogger ? { requestLogger: input.requestLogger } : {}),
        ...(input.protocolLogging ? { protocolLogging: input.protocolLogging } : {}),
      };
      return Layer.build(
        AcpProjectRuntime.layer(layerOptions).pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ).pipe(
        Effect.flatMap((ctx) =>
          Effect.service(AcpProjectRuntime).pipe(Effect.provide(ctx)),
        ),
      );
    },
  } satisfies GrokAcpRuntimeFactoryShape;
});

export const GrokAcpRuntimeFactoryLive = Layer.effect(
  GrokAcpRuntimeFactory,
  makeLiveGrokAcpRuntimeFactory,
);

interface ProjectAcpEntry {
  readonly project: string;
  readonly runtime: AcpProjectRuntimeShape;
  readonly scope: Scope.Closeable;
  readonly spawnedAt: number;
  readonly generation: number;
  readonly sessionCallbacks: Map<string, GrokCrashCallback>;
  refCount: number;
  idleSince: number | null;
  closed: boolean;
}

const POOL_EVENT = (operation: string, fields: Record<string, unknown>): void => {
  logEvent(`grok.serverPool.${operation}`, fields);
};

const ensureAcpError = (cause: unknown): EffectAcpErrors.AcpError => {
  if (
    P.isTagged(cause, "AcpRequestError") ||
    P.isTagged(cause, "AcpSpawnError") ||
    P.isTagged(cause, "AcpProcessExitedError") ||
    P.isTagged(cause, "AcpProtocolParseError") ||
    P.isTagged(cause, "AcpTransportError")
  ) {
    return cause as EffectAcpErrors.AcpError;
  }
  return new EffectAcpErrors.AcpTransportError({
    detail:
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "Unknown grok pool error",
    cause,
  });
};

const makeGrokAcpServerPool = Effect.gen(function* () {
  const factory = yield* GrokAcpRuntimeFactory;
  const poolScope = yield* Scope.Scope;
  const entries = new Map<string, ProjectAcpEntry>();
  const generationByProject = new Map<string, number>();

  const projectMutexes = new Map<string, Semaphore.Semaphore>();
  const mutexFor = (project: string): Semaphore.Semaphore => {
    const existing = projectMutexes.get(project);
    if (existing) return existing;
    const fresh = Semaphore.makeUnsafe(1);
    projectMutexes.set(project, fresh);
    return fresh;
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const liveEntries = [...entries.values()];
      entries.clear();
      yield* Effect.forEach(
        liveEntries,
        (entry) =>
          Effect.gen(function* () {
            if (entry.closed) return;
            entry.closed = true;
            POOL_EVENT("shutdown", {
              project: entry.project,
              generation: entry.generation,
              pid: entry.runtime.pid,
              uptimeMs: Date.now() - entry.spawnedAt,
              sessionCount: entry.sessionCallbacks.size,
            });
            yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
          }).pipe(Effect.ignoreCause({ log: false })),
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  const tearDownEntryLocked = (
    entry: ProjectAcpEntry,
    reason: string,
    operation: "crash" | "evict" | "shutdown",
  ): Effect.Effect<number, never> =>
    Effect.gen(function* () {
      if (entry.closed) return 0;
      entry.closed = true;
      const callbacks = [...entry.sessionCallbacks.values()];
      entry.sessionCallbacks.clear();
      if (entries.get(entry.project) === entry) entries.delete(entry.project);
      POOL_EVENT(operation, {
        project: entry.project,
        generation: entry.generation,
        pid: entry.runtime.pid,
        uptimeMs: Date.now() - entry.spawnedAt,
        sessionCount: callbacks.length,
        reason,
      });
      if (callbacks.length > 0) {
        yield* Effect.forEach(callbacks, (cb) => cb(reason).pipe(Effect.ignore), {
          concurrency: "unbounded",
          discard: true,
        });
      }
      yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
      return callbacks.length;
    });

  const spawnEntry = (input: {
    readonly project: string;
    readonly cwd: string;
    readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
    readonly clientInfo: AcpProjectRuntimeOptions["clientInfo"];
    readonly clientCapabilities?: AcpProjectRuntimeOptions["clientCapabilities"];
    readonly requestLogger?: AcpProjectRuntimeOptions["requestLogger"];
    readonly protocolLogging?: AcpProjectRuntimeOptions["protocolLogging"];
    readonly generation: number;
  }): Effect.Effect<ProjectAcpEntry, EffectAcpErrors.AcpError> =>
    Effect.gen(function* () {
      const childScope = yield* Scope.fork(poolScope);
      POOL_EVENT("spawn.begin", {
        project: input.project,
        generation: input.generation,
      });
      const startedAt = Date.now();
      const startedExit = yield* Effect.exit(
        factory
          .spawnProjectRuntime({
            project: input.project,
            cwd: input.cwd,
            grokSettings: input.grokSettings,
            clientInfo: input.clientInfo,
            ...(input.clientCapabilities ? { clientCapabilities: input.clientCapabilities } : {}),
            ...(input.requestLogger ? { requestLogger: input.requestLogger } : {}),
            ...(input.protocolLogging ? { protocolLogging: input.protocolLogging } : {}),
          })
          .pipe(Effect.provideService(Scope.Scope, childScope)),
      );
      if (Exit.isFailure(startedExit)) {
        yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
        const cause = Cause.squash(startedExit.cause);
        POOL_EVENT("spawn.fail", {
          project: input.project,
          generation: input.generation,
          durationMs: Date.now() - startedAt,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
        return yield* Effect.fail(ensureAcpError(cause));
      }

      const runtime = startedExit.value;
      const entry: ProjectAcpEntry = {
        project: input.project,
        runtime,
        scope: childScope,
        spawnedAt: startedAt,
        generation: input.generation,
        sessionCallbacks: new Map(),
        refCount: 0,
        idleSince: null,
        closed: false,
      };
      POOL_EVENT("spawn.success", {
        project: entry.project,
        generation: entry.generation,
        pid: runtime.pid,
        durationMs: Date.now() - startedAt,
      });
      return entry;
    });

  const startExitWatcher = (entry: ProjectAcpEntry): Effect.Effect<void, never> =>
    entry.runtime.exitCode
      .pipe(
        Effect.flatMap((code) =>
          Effect.suspend(() => {
            if (entry.closed) return Effect.void;
            const reason = `grok agent exited unexpectedly (project=${entry.project}, code=${code}).`;
            return mutexFor(entry.project).withPermit(
              tearDownEntryLocked(entry, reason, "crash").pipe(Effect.asVoid),
            );
          }),
        ),
        Effect.ignore,
        Effect.forkIn(entry.scope),
        Effect.asVoid,
      );

  const acquire: GrokAcpServerPoolShape["acquire"] = (input) =>
    Effect.gen(function* () {
      let cwdProject: string;
      try {
        cwdProject = sandboxIdFromCwd(input.cwd);
      } catch (cause) {
        return yield* Effect.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `grok pool acquire: cwd ${input.cwd} does not contain a sandbox id (project=${input.project}).`,
            data: { cause: String(cause) },
          }),
        );
      }
      if (cwdProject !== input.project) {
        return yield* Effect.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `grok pool acquire: project mismatch — cwd resolves to ${cwdProject}, requested ${input.project}.`,
          }),
        );
      }

      return yield* mutexFor(input.project).withPermit(
        Effect.gen(function* () {
          const existing = entries.get(input.project);
          if (existing && !existing.closed) {
            existing.refCount += 1;
            existing.idleSince = null;
            existing.sessionCallbacks.set(input.sessionId, input.onCrash);
            POOL_EVENT("reuse", {
              project: input.project,
              sessionId: input.sessionId,
              refCount: existing.refCount,
              sessionCount: existing.sessionCallbacks.size,
              generation: existing.generation,
              pid: existing.runtime.pid,
              uptimeMs: Date.now() - existing.spawnedAt,
            });
            return {
              runtime: existing.runtime,
              generation: existing.generation,
              pid: existing.runtime.pid,
            } satisfies GrokAcpServerPoolAcquireResult;
          }

          const generation = (generationByProject.get(input.project) ?? 0) + 1;
          generationByProject.set(input.project, generation);
          const entry = yield* spawnEntry({
            project: input.project,
            cwd: input.cwd,
            grokSettings: input.grokSettings,
            clientInfo: input.clientInfo,
            ...(input.clientCapabilities ? { clientCapabilities: input.clientCapabilities } : {}),
            ...(input.requestLogger ? { requestLogger: input.requestLogger } : {}),
            ...(input.protocolLogging ? { protocolLogging: input.protocolLogging } : {}),
            generation,
          });
          entry.refCount = 1;
          entry.sessionCallbacks.set(input.sessionId, input.onCrash);
          entries.set(input.project, entry);
          yield* startExitWatcher(entry);
          POOL_EVENT("acquire", {
            project: input.project,
            sessionId: input.sessionId,
            generation,
            pid: entry.runtime.pid,
            kind: "fresh",
          });
          return {
            runtime: entry.runtime,
            generation: entry.generation,
            pid: entry.runtime.pid,
          } satisfies GrokAcpServerPoolAcquireResult;
        }),
      );
    });

  const release: GrokAcpServerPoolShape["release"] = (input) =>
    Effect.sync(() => {
      const entry = entries.get(input.project);
      if (!entry || entry.closed) return;
      const had = entry.sessionCallbacks.delete(input.sessionId);
      if (had && entry.refCount > 0) entry.refCount -= 1;
      if (entry.refCount === 0 && entry.idleSince === null) {
        entry.idleSince = Date.now();
      }
      POOL_EVENT("release", {
        project: input.project,
        sessionId: input.sessionId,
        refCount: entry.refCount,
        sessionCount: entry.sessionCallbacks.size,
        idleSince: entry.idleSince,
        generation: entry.generation,
        pid: entry.runtime.pid,
        had,
      });
    });

  const sweepIdle: GrokAcpServerPoolShape["sweepIdle"] = (maxIdleMs) =>
    Effect.gen(function* () {
      const now = Date.now();
      const candidates = [...entries.values()].filter(
        (entry) => !entry.closed && entry.refCount === 0 && entry.idleSince !== null,
      );
      let evicted = 0;
      let retained = entries.size - candidates.length;
      for (const candidate of candidates) {
        const closedFiredCount = yield* mutexFor(candidate.project).withPermit(
          Effect.gen(function* () {
            const live = entries.get(candidate.project);
            if (!live || live !== candidate || live.closed) return -1;
            if (live.refCount > 0 || live.idleSince === null) return -1;
            if (now - live.idleSince < maxIdleMs) return -1;
            const reason = `idle for ${now - live.idleSince}ms`;
            yield* tearDownEntryLocked(live, reason, "evict");
            return 1;
          }),
        );
        if (closedFiredCount >= 0) {
          evicted += 1;
        } else {
          retained += 1;
        }
      }
      return { evicted, retained };
    });

  const listEntries: GrokAcpServerPoolShape["listEntries"] = Effect.sync(() =>
    [...entries.values()].map((entry) => ({
      project: entry.project,
      pid: entry.runtime.pid,
      refCount: entry.refCount,
      sessionCount: entry.sessionCallbacks.size,
      idleSince: entry.idleSince,
      spawnedAt: entry.spawnedAt,
      generation: entry.generation,
    })),
  );

  return {
    acquire,
    release,
    sweepIdle,
    listEntries,
  } satisfies GrokAcpServerPoolShape;
});

export const GrokAcpServerPoolLive = Layer.effect(
  GrokAcpServerPool,
  makeGrokAcpServerPool,
);

export type { AcpSessionRequestLogEvent };
