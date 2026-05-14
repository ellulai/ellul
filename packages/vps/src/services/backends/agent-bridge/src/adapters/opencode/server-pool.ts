// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Per-project OpenCode server pool.
//
// Holds at most one `opencode serve` process per project namespace at a time.
// Multiple chat threads in the same project share the server and multiplex
// via opencode's own session.create — exactly the model opencode was built
// for. Replaces the previous regression where every thread spawned its own
// ~240 MB Bun-backed server inside the namespace, hitting agent-bridge's
// cgroup ceiling at 2-3 active threads and SIGABRTing the next startup.
//
// Lifecycle:
//   - acquire(project, sessionId): returns the project's server URL.
//     Spawns one if missing, increments refCount, registers a per-session
//     crash callback. Race-safe — concurrent acquires for the same project
//     spawn exactly one server.
//   - release(project, sessionId): decrements refCount; when refCount drops
//     to 0 the entry is marked idle (NOT killed). Idle reaper sweeps it
//     after the configured TTL.
//   - sweepIdle(maxIdleMs): closes scopes for entries idle past the TTL.
//   - The pool's own scope (the layer scope) owns every entry scope, so
//     bridge shutdown closes everything. Per-entry scopes own the spawn —
//     closing the scope kills the server cleanly.
//
// Crash handling:
//   - A fiber attached to each entry's scope watches `child.exitCode`.
//     When the process exits while still pooled, we drive the crash
//     path: fire every registered crash callback (each session-specific),
//     close the scope, drop the entry. The next acquire for the project
//     respawns from scratch.
//
// Security invariants preserved:
//   - Server still spawns through `openCodeRuntime.startOpenCodeServerProcess`
//     which sets `ELLUL_NS_PROJECT=<project>` so the namespace spawner
//     wraps the command in `sudo ellul-agent-namespace enter <project>`.
//     Outer seccomp + AppArmor + iptables egress allowlist still apply.
//   - acquire() asserts `sandboxIdFromCwd(cwd) === project` so a caller
//     can never wire a project-A server to a project-B cwd.
//   - The pool's mutable state is keyed by project. Each entry only ever
//     references its own project's server — no cross-project bleed.
//
// Observability: each lifecycle step emits a JSONL event under the
// `opencode.serverPool.*` prefix to /var/log/ellul/agent-bridge-events.jsonl,
// mirroring the existing `opencode.spawn.*` shape.

import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Predicate as P,
  Scope,
  Semaphore,
} from "effect";
import { sandboxIdFromCwd } from "@ellul.ai/types";

import { logEvent } from "../../shared/event-log";
import {
  NAMESPACE_ADAPTER_ENV,
  NAMESPACE_FORWARD_ENV,
  NAMESPACE_PROJECT_ENV,
  NAMESPACE_SCOPE_ID_ENV,
  NAMESPACE_SOFT_HINT_MB_ENV,
} from "../../shared/namespace-spawner";
import { computeWorkloadSliceBudget } from "@vps/shared/memory-budget";
import * as os from "node:os";

const POOL_SOFT_HINT_MB = computeWorkloadSliceBudget(Math.max(512, Math.round(os.totalmem() / (1024 * 1024)))).perSandboxSoftHintMB;
import { getNsVethIp } from "../../application/namespace/NamespaceSpawn";
import { getMcpRelayInfo } from "../../application/reconciliation/ZeroclawAgent";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  type OpenCodeServerProcess,
} from "./runtime";

// Crash reasons are short human-readable strings; the adapter forwards
// them into a runtime.error event. Returning Effect<void, never> so a
// misbehaving callback can never propagate.
// Build OPENCODE_CONFIG_CONTENT with MCP relay info so the pooled server
// picks up the platform tools. Returns empty object if relay isn't ready.
function buildOpenCodeMcpConfig(project: string): Record<string, string> {
  const info = getMcpRelayInfo(project);
  if (!info) return {};
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      mcp: {
        'ellul-platform': {
          type: 'local',
          command: [info.relayBin],
          environment: {
            ELLUL_MCP_URL: info.mcpUrl,
            ELLUL_MCP_TOKEN: info.token,
            ELLUL_MCP_PROJECT: info.projectName,
          },
          enabled: true,
        },
      },
    }),
    [NAMESPACE_FORWARD_ENV]: "OPENCODE_CONFIG_CONTENT",
  };
}

export type CrashCallback = (reason: string) => Effect.Effect<void, never>;

export interface OpenCodeServerPoolEntrySummary {
  readonly project: string;
  readonly url: string;
  readonly pid: number | null;
  readonly refCount: number;
  readonly sessionCount: number;
  readonly idleSince: number | null;
  readonly spawnedAt: number;
  readonly generation: number;
}

export interface OpenCodeServerPoolAcquireResult {
  readonly url: string;
  readonly generation: number;
  readonly pid: number | null;
}

export interface OpenCodeServerPoolShape {
  /**
   * Acquire (or spawn) a project server. Increments the entry's refCount
   * and registers `onCrash` against `sessionId`. Concurrent acquires for
   * the same project block on a per-project mutex so exactly one server
   * is spawned regardless of contention.
   */
  readonly acquire: (input: {
    readonly project: string;
    readonly binaryPath: string;
    readonly cwd: string;
    readonly sessionId: string;
    readonly onCrash: CrashCallback;
  }) => Effect.Effect<OpenCodeServerPoolAcquireResult, OpenCodeRuntimeError>;

  /**
   * Release a session's hold on the project server. When refCount drops to
   * 0 the entry is marked idle (`idleSince = now`) but the process keeps
   * running until `sweepIdle` evicts it. This avoids respawn churn for
   * users opening/closing threads in quick succession.
   */
  readonly release: (input: {
    readonly project: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, never>;

  /**
   * Evict entries with refCount === 0 whose idleSince is older than
   * `maxIdleMs`. Returns counts for telemetry.
   */
  readonly sweepIdle: (
    maxIdleMs: number,
  ) => Effect.Effect<{ readonly evicted: number; readonly retained: number }, never>;

  /**
   * Snapshot of currently pooled entries. Read-only — for /health and
   * tests.
   */
  readonly listEntries: Effect.Effect<ReadonlyArray<OpenCodeServerPoolEntrySummary>, never>;
}

export class OpenCodeServerPool extends Context.Service<
  OpenCodeServerPool,
  OpenCodeServerPoolShape
>()("ellul/adapters/OpenCodeServerPool") {}

interface ProjectServerEntry {
  readonly project: string;
  readonly url: string;
  readonly pid: number | null;
  readonly server: OpenCodeServerProcess;
  readonly scope: Scope.Closeable;
  readonly spawnedAt: number;
  readonly generation: number;
  readonly sessionCallbacks: Map<string, CrashCallback>;
  refCount: number;
  idleSince: number | null;
  closed: boolean;
}

const POOL_EVENT = (operation: string, fields: Record<string, unknown>): void => {
  logEvent(`opencode.serverPool.${operation}`, fields);
};

const DEFAULT_HOSTNAME = "0.0.0.0";

const makeOpenCodeServerPool = Effect.gen(function* () {
  const openCodeRuntime = yield* OpenCodeRuntime;
  // The pool's own scope — granted by Layer.effect at construction time.
  // Each spawned entry forks a child scope from this so layer shutdown
  // closes every server cleanly.
  const poolScope = yield* Scope.Scope;
  const entries = new Map<string, ProjectServerEntry>();
  // Monotonic per-project generation counter. Survives crash/evict so a
  // respawn after a crash gets generation N+1, distinguishing "spawn 1
  // crashed and we replaced it" from "we are reusing spawn 1" in event
  // logs and tests.
  const generationByProject = new Map<string, number>();

  // Per-project mutex. Lazily created. The init step is synchronous
  // (Map.get / Map.set / Semaphore.makeUnsafe) and therefore atomic under
  // JS single-threaded execution — no other fiber can interleave the
  // get-or-create step.
  const projectMutexes = new Map<string, Semaphore.Semaphore>();
  const mutexFor = (project: string): Semaphore.Semaphore => {
    const existing = projectMutexes.get(project);
    if (existing) return existing;
    const fresh = Semaphore.makeUnsafe(1);
    projectMutexes.set(project, fresh);
    return fresh;
  };

  // Layer finalizer: sweep every live entry on shutdown so a graceful
  // bridge restart doesn't strand opencode serves.
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
              pid: entry.pid,
              uptimeMs: Date.now() - entry.spawnedAt,
              sessionCount: entry.sessionCallbacks.size,
            });
            yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
          }).pipe(Effect.ignoreCause({ log: false })),
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  // Internal: tear an entry down and notify every active session. The
  // critical section lives behind the per-project mutex so we don't
  // race acquire / release / sweepIdle. Returns the number of crash
  // callbacks fired (for tests / telemetry).
  const tearDownEntryLocked = (
    entry: ProjectServerEntry,
    reason: string,
    operation: "crash" | "evict" | "shutdown",
  ): Effect.Effect<number, never> =>
    Effect.gen(function* () {
      if (entry.closed) return 0;
      entry.closed = true;
      const callbacks = [...entry.sessionCallbacks.values()];
      entry.sessionCallbacks.clear();
      // Drop from registry BEFORE firing callbacks so a callback that
      // re-acquires lands a fresh server.
      if (entries.get(entry.project) === entry) entries.delete(entry.project);
      POOL_EVENT(operation, {
        project: entry.project,
        generation: entry.generation,
        pid: entry.pid,
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
    readonly binaryPath: string;
    readonly cwd: string;
    readonly generation: number;
  }): Effect.Effect<ProjectServerEntry, OpenCodeRuntimeError> =>
    Effect.gen(function* () {
      // Each entry lives in its own forked scope so we can close exactly
      // this server without disturbing the layer or sibling entries.
      const childScope = yield* Scope.fork(poolScope);
      POOL_EVENT("spawn.begin", {
        project: input.project,
        generation: input.generation,
        binaryPath: input.binaryPath,
      });
      const startedAt = Date.now();
      const startedExit = yield* Effect.exit(
        openCodeRuntime
          .startOpenCodeServerProcess({
            binaryPath: input.binaryPath,
            hostname: DEFAULT_HOSTNAME,
            additionalEnv: {
              [NAMESPACE_PROJECT_ENV]: input.project,
              [NAMESPACE_ADAPTER_ENV]: "opencode",
              [NAMESPACE_SCOPE_ID_ENV]: `g${input.generation}`,
              [NAMESPACE_SOFT_HINT_MB_ENV]: String(POOL_SOFT_HINT_MB),
              ...buildOpenCodeMcpConfig(input.project),
            },
          })
          .pipe(Effect.provideService(Scope.Scope, childScope)),
      );
      if (Exit.isFailure(startedExit)) {
        yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
        const cause = Cause.squash(startedExit.cause);
        const detail = openCodeRuntimeErrorDetail(cause);
        POOL_EVENT("spawn.fail", {
          project: input.project,
          generation: input.generation,
          durationMs: Date.now() - startedAt,
          detail,
        });
        if (P.hasProperty(cause, "_tag") && cause._tag === "OpenCodeRuntimeError") {
          return yield* Effect.fail(cause as OpenCodeRuntimeError);
        }
        return yield* Effect.fail(
          new OpenCodeRuntimeError({
            operation: "serverPool.spawn",
            detail,
            cause,
          }),
        );
      }

      const server = startedExit.value;
      const nsIp = getNsVethIp(input.project);
      const url = nsIp ? server.url.replace(/\/\/[^/:]+/, `//${nsIp}`) : server.url;

      const entry: ProjectServerEntry = {
        project: input.project,
        url,
        pid: server.pid,
        server,
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
        pid: entry.pid,
        url: entry.url,
        durationMs: Date.now() - startedAt,
      });
      return entry;
    });

  // Hook the spawn's exitCode into the entry lifecycle. The fiber lives
  // inside the entry scope, so closing the scope (idle eviction or layer
  // shutdown) interrupts the watcher cleanly without firing the crash
  // path (closed flag prevents re-entry).
  const startExitWatcher = (entry: ProjectServerEntry): Effect.Effect<void, never> =>
    entry.server.exitCode
      .pipe(
        Effect.flatMap((code) =>
          Effect.suspend(() => {
            if (entry.closed) return Effect.void;
            const reason = `OpenCode server exited unexpectedly (project=${entry.project}, code=${code}).`;
            return mutexFor(entry.project).withPermit(
              tearDownEntryLocked(entry, reason, "crash").pipe(Effect.asVoid),
            );
          }),
        ),
        Effect.ignore,
        Effect.forkIn(entry.scope),
        Effect.asVoid,
      );

  const acquire: OpenCodeServerPoolShape["acquire"] = (input) =>
    Effect.gen(function* () {
      // Defense-in-depth: cwd's sandbox segment must equal the requested
      // project. A caller wiring a project-A cwd into a project-B server
      // would route opencode at a directory that doesn't exist in the
      // project-B namespace anyway, but we fail loudly here so the bug
      // can't slip past unit tests.
      let cwdProject: string;
      try {
        cwdProject = sandboxIdFromCwd(input.cwd);
      } catch (cause) {
        return yield* Effect.fail(
          new OpenCodeRuntimeError({
            operation: "serverPool.acquire",
            detail: `cwd ${input.cwd} does not contain a sandbox id (project=${input.project}).`,
            cause,
          }),
        );
      }
      if (cwdProject !== input.project) {
        return yield* Effect.fail(
          new OpenCodeRuntimeError({
            operation: "serverPool.acquire",
            detail: `Project mismatch: cwd resolves to ${cwdProject}, requested ${input.project}.`,
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
              pid: existing.pid,
              uptimeMs: Date.now() - existing.spawnedAt,
            });
            return {
              url: existing.url,
              generation: existing.generation,
              pid: existing.pid,
            } satisfies OpenCodeServerPoolAcquireResult;
          }

          const generation = (generationByProject.get(input.project) ?? 0) + 1;
          generationByProject.set(input.project, generation);
          const entry = yield* spawnEntry({
            project: input.project,
            binaryPath: input.binaryPath,
            cwd: input.cwd,
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
            pid: entry.pid,
            url: entry.url,
            kind: "fresh",
          });
          return {
            url: entry.url,
            generation: entry.generation,
            pid: entry.pid,
          } satisfies OpenCodeServerPoolAcquireResult;
        }),
      );
    });

  // release runs lock-free on purpose. JS single-threaded execution makes
  // the Map.get + counter mutation atomic without a mutex, AND skipping
  // the per-project mutex is what prevents the crash-callback path from
  // deadlocking on it: the crash watcher holds the project mutex while
  // firing every registered onCrash callback. The adapter's onCrash
  // callback chains into emitUnexpectedExit → releasePoolEntry →
  // pool.release. If release re-took the same mutex, that whole chain
  // would block forever waiting for a permit the parent fiber owns.
  // (Effect's Semaphore is not reentrant.) See server-pool.test.ts
  // "crash callback calling release must not deadlock".
  const release: OpenCodeServerPoolShape["release"] = (input) =>
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
        pid: entry.pid,
        had,
      });
    });

  const sweepIdle: OpenCodeServerPoolShape["sweepIdle"] = (maxIdleMs) =>
    Effect.gen(function* () {
      const now = Date.now();
      // Snapshot under no lock first; we re-check under each project's
      // lock when actually evicting. Sweep can race with acquire; the
      // `closed` flag and refCount recheck make it safe.
      const candidates = [...entries.values()].filter(
        (entry) => !entry.closed && entry.refCount === 0 && entry.idleSince !== null,
      );
      let evicted = 0;
      let retained = entries.size - candidates.length;
      for (const candidate of candidates) {
        const closedFiredCount = yield* mutexFor(candidate.project).withPermit(
          Effect.gen(function* () {
            // Re-read under the lock — a parallel acquire may have just
            // bumped refCount or replaced the entry.
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

  const listEntries: OpenCodeServerPoolShape["listEntries"] = Effect.sync(() =>
    [...entries.values()].map((entry) => ({
      project: entry.project,
      url: entry.url,
      pid: entry.pid,
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
  } satisfies OpenCodeServerPoolShape;
});

export const OpenCodeServerPoolLive = Layer.effect(OpenCodeServerPool, makeOpenCodeServerPool);
