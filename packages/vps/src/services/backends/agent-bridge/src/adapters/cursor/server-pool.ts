// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Per-project Cursor ACP runtime pool.
//
// Holds at most one cursor-agent process per project namespace at a time.
// Multiple chat threads in the same project share the cursor-agent and
// multiplex via ACP's session/new — the model cursor-agent was built for
// (session/new is in the baseline MUST set per the ACP spec). Replaces the
// previous regression where every thread spawned its own cursor-agent
// inside the namespace, racing with opencode for cgroup memory and
// SIGABRTing the next process startup once the bridge cgroup ceiling
// was hit.
//
// Lifecycle:
//   - acquire(project, sessionId): returns the project's AcpProjectRuntime.
//     Spawns one if missing, increments refCount, registers a per-session
//     crash callback. Race-safe — concurrent acquires for the same
//     project spawn exactly one cursor-agent.
//   - release(project, sessionId): decrements refCount; when refCount
//     drops to 0 the entry is marked idle (NOT killed). Idle reaper
//     sweeps it after the configured TTL.
//   - sweepIdle(maxIdleMs): closes scopes for entries idle past the TTL.
//   - The pool's own scope (the layer scope) owns every entry scope, so
//     bridge shutdown closes everything cleanly.
//
// Crash handling:
//   - A fiber attached to each entry's scope watches `runtime.exitCode`.
//     When the cursor-agent exits while still pooled, we drive the crash
//     path: fire every registered crash callback (each session-specific),
//     close the scope, drop the entry. The next acquire respawns from
//     scratch.
//
// Security invariants preserved (mirrors opencode pool):
//   - Spawn still routes through the namespace spawner. The pool sets
//     `ELLUL_NS_PROJECT=<project>` so the NamespaceChildProcessSpawner
//     wraps the command in `sudo ellul-agent-namespace enter <project>`.
//     Outer seccomp + AppArmor + iptables egress allowlist still apply.
//   - acquire() asserts `sandboxIdFromCwd(cwd) === project` — a caller
//     can never wire a project-A cwd into a project-B runtime.
//   - The pool's mutable state is keyed by project. Each entry only ever
//     references its own project's runtime — no cross-project bleed.
//
// Observability: every lifecycle step emits a JSONL event under the
// `cursor.serverPool.*` prefix to /var/log/ellul/agent-bridge-events.jsonl,
// mirroring the opencode pool's shape.

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

const CURSOR_POOL_SOFT_HINT_MB = computeWorkloadSliceBudget(Math.max(512, Math.round(os.totalmem() / (1024 * 1024)))).perSandboxSoftHintMB;
let cursorPoolGen = 0;
import type { CursorSettings } from "../../shared/serverSettings";
import {
  AcpProjectRuntime,
  type AcpProjectRuntimeOptions,
  type AcpProjectRuntimeShape,
  type AcpSessionRequestLogEvent,
} from "./acp/AcpProjectRuntime";
import { buildCursorAcpSpawnInput } from "./acp/CursorAcpSupport";

type CursorAcpRuntimeCursorSettings = Pick<CursorSettings, "apiEndpoint" | "binaryPath">;

// Crash reasons are short human-readable strings; the adapter forwards
// them into a runtime.error event. Returning Effect<void, never> so a
// misbehaving callback can never propagate.
export type CursorCrashCallback = (reason: string) => Effect.Effect<void, never>;

export interface CursorAcpServerPoolEntrySummary {
  readonly project: string;
  readonly pid: number | null;
  readonly refCount: number;
  readonly sessionCount: number;
  readonly idleSince: number | null;
  readonly spawnedAt: number;
  readonly generation: number;
}

export interface CursorAcpServerPoolAcquireResult {
  readonly runtime: AcpProjectRuntimeShape;
  readonly generation: number;
  readonly pid: number | null;
}

export interface CursorAcpServerPoolAcquireInput {
  readonly project: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
  readonly clientInfo: AcpProjectRuntimeOptions["clientInfo"];
  readonly clientCapabilities?: AcpProjectRuntimeOptions["clientCapabilities"];
  readonly requestLogger?: AcpProjectRuntimeOptions["requestLogger"];
  readonly protocolLogging?: AcpProjectRuntimeOptions["protocolLogging"];
  readonly onCrash: CursorCrashCallback;
}

export interface CursorAcpServerPoolShape {
  readonly acquire: (
    input: CursorAcpServerPoolAcquireInput,
  ) => Effect.Effect<CursorAcpServerPoolAcquireResult, EffectAcpErrors.AcpError>;
  readonly release: (input: {
    readonly project: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, never>;
  readonly sweepIdle: (
    maxIdleMs: number,
  ) => Effect.Effect<{ readonly evicted: number; readonly retained: number }, never>;
  readonly listEntries: Effect.Effect<ReadonlyArray<CursorAcpServerPoolEntrySummary>, never>;
}

export class CursorAcpServerPool extends Context.Service<
  CursorAcpServerPool,
  CursorAcpServerPoolShape
>()("ellul/adapters/cursor/CursorAcpServerPool") {}

// Test-injectable factory so unit tests can stub the cursor-agent spawn
// without ever reaching the real binary. Live impl wires
// `AcpProjectRuntime.layer({...})` plus the cursor-specific spawn config
// (binary path, optional `-e <apiEndpoint>`, ELLUL_NS_PROJECT env). Tests
// substitute a stub that returns a fake AcpProjectRuntimeShape with
// controllable exitCode and newSession.
export interface CursorAcpRuntimeFactoryShape {
  readonly spawnProjectRuntime: (input: {
    readonly project: string;
    readonly cwd: string;
    readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
    readonly clientInfo: AcpProjectRuntimeOptions["clientInfo"];
    readonly clientCapabilities?: AcpProjectRuntimeOptions["clientCapabilities"];
    readonly requestLogger?: AcpProjectRuntimeOptions["requestLogger"];
    readonly protocolLogging?: AcpProjectRuntimeOptions["protocolLogging"];
  }) => Effect.Effect<AcpProjectRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope>;
}

export class CursorAcpRuntimeFactory extends Context.Service<
  CursorAcpRuntimeFactory,
  CursorAcpRuntimeFactoryShape
>()("ellul/adapters/cursor/CursorAcpRuntimeFactory") {}

const makeLiveCursorAcpRuntimeFactory = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return {
    spawnProjectRuntime: (input) => {
      const spawnInput = buildCursorAcpSpawnInput(input.cursorSettings, input.cwd, {
        [NAMESPACE_PROJECT_ENV]: input.project,
        [NAMESPACE_ADAPTER_ENV]: "cursor",
        [NAMESPACE_SCOPE_ID_ENV]: `g${++cursorPoolGen}`,
        [NAMESPACE_SOFT_HINT_MB_ENV]: String(CURSOR_POOL_SOFT_HINT_MB),
      });
      const layerOptions: AcpProjectRuntimeOptions = {
        spawn: spawnInput,
        clientInfo: input.clientInfo,
        authMethodId: "cursor_login",
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
  } satisfies CursorAcpRuntimeFactoryShape;
});

export const CursorAcpRuntimeFactoryLive = Layer.effect(
  CursorAcpRuntimeFactory,
  makeLiveCursorAcpRuntimeFactory,
);

interface ProjectAcpEntry {
  readonly project: string;
  readonly runtime: AcpProjectRuntimeShape;
  readonly scope: Scope.Closeable;
  readonly spawnedAt: number;
  readonly generation: number;
  readonly sessionCallbacks: Map<string, CursorCrashCallback>;
  refCount: number;
  idleSince: number | null;
  closed: boolean;
}

const POOL_EVENT = (operation: string, fields: Record<string, unknown>): void => {
  logEvent(`cursor.serverPool.${operation}`, fields);
};

// Convert any thrown cause into an AcpError so the pool's effect type
// stays clean. Wraps anything that isn't already an AcpError into a
// generic AcpTransportError so callers see a single error union.
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
          : "Unknown cursor pool error",
    cause,
  });
};

const makeCursorAcpServerPool = Effect.gen(function* () {
  const factory = yield* CursorAcpRuntimeFactory;
  // The pool's own scope — granted by Layer.effect at construction time.
  // Each spawned entry forks a child scope from this so layer shutdown
  // closes every cursor-agent cleanly.
  const poolScope = yield* Scope.Scope;
  const entries = new Map<string, ProjectAcpEntry>();
  // Monotonic per-project generation counter. Survives crash/evict so a
  // respawn after a crash gets generation N+1, distinguishing
  // "spawn 1 crashed and we replaced it" from "we are reusing spawn 1"
  // in event logs and tests.
  const generationByProject = new Map<string, number>();

  // Per-project mutex. Lazily created. The init step is synchronous
  // (Map.get / Map.set / Semaphore.makeUnsafe) and therefore atomic
  // under JS single-threaded execution — no other fiber can interleave
  // the get-or-create step.
  const projectMutexes = new Map<string, Semaphore.Semaphore>();
  const mutexFor = (project: string): Semaphore.Semaphore => {
    const existing = projectMutexes.get(project);
    if (existing) return existing;
    const fresh = Semaphore.makeUnsafe(1);
    projectMutexes.set(project, fresh);
    return fresh;
  };

  // Layer finalizer: sweep every live entry on shutdown so a graceful
  // bridge restart doesn't strand cursor-agent processes.
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
      // Drop from registry BEFORE firing callbacks so a callback that
      // re-acquires lands a fresh runtime.
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
    readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
    readonly clientInfo: AcpProjectRuntimeOptions["clientInfo"];
    readonly clientCapabilities?: AcpProjectRuntimeOptions["clientCapabilities"];
    readonly requestLogger?: AcpProjectRuntimeOptions["requestLogger"];
    readonly protocolLogging?: AcpProjectRuntimeOptions["protocolLogging"];
    readonly generation: number;
  }): Effect.Effect<ProjectAcpEntry, EffectAcpErrors.AcpError> =>
    Effect.gen(function* () {
      // Each entry lives in its own forked scope so we can close exactly
      // this runtime without disturbing the layer or sibling entries.
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
            cursorSettings: input.cursorSettings,
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

  // Hook the runtime's exitCode into the entry lifecycle. Lives inside
  // the entry scope so closing the scope (idle eviction or layer
  // shutdown) interrupts the watcher cleanly without firing the crash
  // path (closed flag prevents re-entry).
  const startExitWatcher = (entry: ProjectAcpEntry): Effect.Effect<void, never> =>
    entry.runtime.exitCode
      .pipe(
        Effect.flatMap((code) =>
          Effect.suspend(() => {
            if (entry.closed) return Effect.void;
            const reason = `cursor-agent exited unexpectedly (project=${entry.project}, code=${code}).`;
            return mutexFor(entry.project).withPermit(
              tearDownEntryLocked(entry, reason, "crash").pipe(Effect.asVoid),
            );
          }),
        ),
        Effect.ignore,
        Effect.forkIn(entry.scope),
        Effect.asVoid,
      );

  const acquire: CursorAcpServerPoolShape["acquire"] = (input) =>
    Effect.gen(function* () {
      // Defense-in-depth: cwd's sandbox segment must equal the requested
      // project. A caller wiring a project-A cwd into a project-B runtime
      // would route cursor-agent at a directory that doesn't exist in
      // the project-B namespace anyway, but we fail loudly here so the
      // bug can't slip past unit tests.
      let cwdProject: string;
      try {
        cwdProject = sandboxIdFromCwd(input.cwd);
      } catch (cause) {
        return yield* Effect.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `cursor pool acquire: cwd ${input.cwd} does not contain a sandbox id (project=${input.project}).`,
            data: { cause: String(cause) },
          }),
        );
      }
      if (cwdProject !== input.project) {
        return yield* Effect.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `cursor pool acquire: project mismatch — cwd resolves to ${cwdProject}, requested ${input.project}.`,
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
            } satisfies CursorAcpServerPoolAcquireResult;
          }

          const generation = (generationByProject.get(input.project) ?? 0) + 1;
          generationByProject.set(input.project, generation);
          const entry = yield* spawnEntry({
            project: input.project,
            cwd: input.cwd,
            cursorSettings: input.cursorSettings,
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
          } satisfies CursorAcpServerPoolAcquireResult;
        }),
      );
    });

  // release runs lock-free on purpose. JS single-threaded execution
  // makes the Map.get + counter mutation atomic without a mutex, AND
  // skipping the per-project mutex is what prevents the crash-callback
  // path from deadlocking on it: the crash watcher holds the project
  // mutex while firing every registered onCrash callback. The adapter's
  // onCrash callback chains into emitUnexpectedExit → releasePoolEntry
  // → pool.release. If release re-took the same mutex, that whole chain
  // would block forever waiting for a permit the parent fiber owns.
  // (Effect's Semaphore is not reentrant.) See server-pool.test.ts
  // "crash callback calling release must not deadlock".
  const release: CursorAcpServerPoolShape["release"] = (input) =>
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

  const sweepIdle: CursorAcpServerPoolShape["sweepIdle"] = (maxIdleMs) =>
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

  const listEntries: CursorAcpServerPoolShape["listEntries"] = Effect.sync(() =>
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
  } satisfies CursorAcpServerPoolShape;
});

export const CursorAcpServerPoolLive = Layer.effect(
  CursorAcpServerPool,
  makeCursorAcpServerPool,
);

// `AcpSessionRequestLogEvent` re-exported so adapters wiring the pool
// can build a request logger without importing AcpProjectRuntime
// directly.
export type { AcpSessionRequestLogEvent };
