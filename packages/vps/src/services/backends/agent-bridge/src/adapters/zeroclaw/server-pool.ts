// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Per-project ZeroClaw daemon pool.
//
// Holds at most one `zeroclaw daemon` process per project namespace.
// Multiple chat threads in the same project share the daemon and each
// turn opens its own short-lived WebSocket against the daemon's
// `/ws/chat` endpoint. Replaces the previous regression where every
// respawn leaked the predecessor: `spawnOne` removed the in-memory
// pool entry but never killed the OS process, so port 18800 stayed
// bound and every new spawn looped on EADDRINUSE for hours.
//
// Architecture mirrors `../opencode/server-pool.ts` exactly:
//   - Per-project Semaphore mutex (lazy create, atomic init under JS
//     single-threaded execution).
//   - Per-entry forked Scope so closing the scope kills only this
//     daemon, not the layer or sibling entries.
//   - Crash watcher fiber attached to each entry's exit code; on
//     unexpected exit, fires every registered onCrash callback under
//     the project mutex, drops the entry, releases the port.
//   - Idle reaper (`sweepIdle`) called from the namespace-lifecycle
//     reconciler tick; evicts entries with refCount=0 past the TTL.
//   - Layer finalizer sweeps every live entry on bridge shutdown.
//
// Security invariants preserved:
//   - Daemon spawns through `ZeroClawRuntime.startDaemon` which sets
//     `ELLUL_NS_PROJECT` so the namespace spawner wraps the command
//     in `sudo ellul-agent-namespace enter <project>`. Outer seccomp
//     + AppArmor + iptables egress allowlist still apply.
//   - acquire() asserts the requested project matches `sandboxIdFromCwd(cwd)`
//     so a caller can never wire a project-A daemon to a project-B cwd.
//   - Pool state is keyed by project. Each entry only ever references
//     its own project's daemon — no cross-project bleed.
//
// Observability: every lifecycle step emits a JSONL event under the
// `zeroclaw.daemonPool.*` prefix to /var/log/ellul/agent-bridge-events.jsonl,
// mirroring the opencode pool shape so dashboards / alerts can be
// written once and apply to either adapter.

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
import { getNamespaceIp, getNsVethIp } from "../../application/namespace/NamespaceSpawn";

import {
  probeChannelReadiness,
  sidecarExpectsChannels,
  ZeroClawRuntime,
  ZeroClawRuntimeError,
  zeroClawRuntimeErrorDetail,
  ZEROCLAW_PORT_BASE,
  ZEROCLAW_PORT_MAX,
  type ZeroClawDaemonProcess,
} from "./runtime";

// Crash callbacks are short human-readable reasons; the adapter
// forwards them into a `runtime.error` event with class:"transport_error".
// Returning Effect<void, never> so a misbehaving callback can never
// propagate a fault out of the pool.
export type ZeroClawCrashCallback = (
  reason: string,
) => Effect.Effect<void, never>;

export interface ZeroClawDaemonPoolEntrySummary {
  readonly project: string;
  readonly url: string;
  readonly port: number;
  readonly pid: number | null;
  readonly refCount: number;
  readonly sessionCount: number;
  readonly idleSince: number | null;
  readonly spawnedAt: number;
  readonly generation: number;
  readonly hasChannels: boolean;
}

export interface ZeroClawDaemonPoolAcquireResult {
  /**
   * The daemon handle to use for `runtime.sendOnSession()`. Stays
   * valid until the next crash event — the adapter receives a crash
   * callback BEFORE this handle becomes stale, so a session that
   * keeps the cached handle is still safe (it'll either succeed
   * against the live daemon or get fail-fast on connect).
   */
  readonly daemon: ZeroClawDaemonProcess;
  readonly generation: number;
  readonly pid: number | null;
}

export interface ZeroClawDaemonPoolShape {
  readonly acquire: (input: {
    readonly project: string;
    readonly cwd: string;
    readonly sessionId: string;
    readonly onCrash: ZeroClawCrashCallback;
  }) => Effect.Effect<ZeroClawDaemonPoolAcquireResult, ZeroClawRuntimeError>;

  readonly release: (input: {
    readonly project: string;
    readonly sessionId: string;
  }) => Effect.Effect<void, never>;

  readonly sweepIdle: (
    maxIdleMs: number,
  ) => Effect.Effect<{ readonly evicted: number; readonly retained: number }, never>;

  readonly listEntries: Effect.Effect<
    ReadonlyArray<ZeroClawDaemonPoolEntrySummary>,
    never
  >;

  /**
   * Operator-initiated tear-down. Closes the entry regardless of
   * refCount (in-flight sessions are notified via their crash
   * callback with the supplied reason). Next acquire respawns
   * with generation N+1.
   *
   * Use cases: post-config-change restarts (e.g. WhatsApp QR
   * re-pair from file-api), manual recovery of a wedged daemon.
   * Returns the number of crash callbacks fired.
   */
  readonly forceEvict: (input: {
    readonly project: string;
    readonly reason: string;
  }) => Effect.Effect<number, never>;
}

export class ZeroClawDaemonPool extends Context.Service<
  ZeroClawDaemonPool,
  ZeroClawDaemonPoolShape
>()("ellul/adapters/ZeroClawDaemonPool") {}

interface PoolEntry {
  readonly project: string;
  readonly daemon: ZeroClawDaemonProcess;
  readonly scope: Scope.Closeable;
  readonly spawnedAt: number;
  readonly generation: number;
  readonly port: number;
  readonly sessionCallbacks: Map<string, ZeroClawCrashCallback>;
  refCount: number;
  idleSince: number | null;
  closed: boolean;
  hasChannels: boolean;
}

const POOL_EVENT = (operation: string, fields: Record<string, unknown>): void => {
  logEvent(`zeroclaw.daemonPool.${operation}`, fields);
};

const CHANNEL_READINESS_RETRIES = 3;
const CHANNEL_READINESS_BACKOFF_MS = 5_000;

const makeZeroClawDaemonPool = Effect.gen(function* () {
  const runtime = yield* ZeroClawRuntime;
  const poolScope = yield* Scope.Scope;

  const entries = new Map<string, PoolEntry>();
  // Monotonic per-project generation counter. Survives crash/evict so
  // a respawn after a crash gets generation N+1 — distinguishing
  // "spawn 1 crashed and we replaced it" from "we are reusing spawn 1"
  // in event logs and tests.
  const generationByProject = new Map<string, number>();

  const projectMutexes = new Map<string, Semaphore.Semaphore>();
  const mutexFor = (project: string): Semaphore.Semaphore => {
    const existing = projectMutexes.get(project);
    if (existing) return existing;
    const fresh = Semaphore.makeUnsafe(1);
    projectMutexes.set(project, fresh);
    return fresh;
  };

  // Port allocator. Pool owns the port universe — entries return
  // their port to the free set on scope close (registered as a
  // finalizer at spawn time).
  const usedPorts = new Set<number>();
  const allocatePort = (): number => {
    for (let port = ZEROCLAW_PORT_BASE; port <= ZEROCLAW_PORT_MAX; port++) {
      if (!usedPorts.has(port)) {
        usedPorts.add(port);
        return port;
      }
    }
    throw new Error(
      `No available ports for ZeroClaw daemon in [${ZEROCLAW_PORT_BASE}, ${ZEROCLAW_PORT_MAX}]`,
    );
  };
  const releasePort = (port: number): void => {
    usedPorts.delete(port);
  };

  // Layer finalizer: sweep every live entry on shutdown so a graceful
  // bridge restart doesn't strand zeroclaw daemons.
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
              pid: entry.daemon.pid,
              port: entry.port,
              uptimeMs: Date.now() - entry.spawnedAt,
              sessionCount: entry.sessionCallbacks.size,
            });
            yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
          }).pipe(Effect.ignoreCause({ log: false })),
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  // Tear an entry down and notify every active session. Caller MUST
  // hold the per-project mutex. Returns the number of crash callbacks
  // fired (for tests / telemetry).
  const tearDownEntryLocked = (
    entry: PoolEntry,
    reason: string,
    operation: "crash" | "evict" | "shutdown",
  ): Effect.Effect<number, never> =>
    Effect.gen(function* () {
      if (entry.closed) return 0;
      entry.closed = true;
      const callbacks = [...entry.sessionCallbacks.values()];
      entry.sessionCallbacks.clear();
      // Drop from registry BEFORE firing callbacks so a callback that
      // re-acquires lands a fresh daemon.
      if (entries.get(entry.project) === entry) entries.delete(entry.project);
      POOL_EVENT(operation, {
        project: entry.project,
        generation: entry.generation,
        pid: entry.daemon.pid,
        port: entry.port,
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

  // Spawn one entry. Allocates a port, calls runtime.startDaemon on
  // a forked scope, registers a port-release finalizer on that scope.
  // Channel-readiness retry: when the sidecar declares channels for
  // this project but the spawned daemon reports none after /health
  // probe, close the entry and retry the spawn (boot-time race in
  // the channel broker). Up to CHANNEL_READINESS_RETRIES.
  const spawnEntry = (input: {
    readonly project: string;
    readonly cwd: string;
    readonly generation: number;
  }): Effect.Effect<PoolEntry, ZeroClawRuntimeError> =>
    Effect.gen(function* () {
      const channelsExpected = sidecarExpectsChannels(input.project);

      for (let attempt = 0; attempt <= CHANNEL_READINESS_RETRIES; attempt++) {
        if (attempt > 0) {
          yield* Effect.sleep(`${CHANNEL_READINESS_BACKOFF_MS * attempt} millis`);
        }
        const childScope = yield* Scope.fork(poolScope);
        const port = allocatePort();
        // Register port-release as a finalizer on the entry scope so
        // killing the entry returns its port even if we forget to.
        yield* Scope.addFinalizer(
          childScope,
          Effect.sync(() => releasePort(port)),
        );

        const nsIp = getNamespaceIp(input.project);
        const hostAddress = getNsVethIp(input.project) || nsIp || "127.0.0.1";
        const bindAddress = nsIp || "127.0.0.1";

        POOL_EVENT("spawn.begin", {
          project: input.project,
          generation: input.generation,
          attempt,
          port,
          bindAddress,
          hostAddress,
        });
        const startedAt = Date.now();

        const startedExit = yield* Effect.exit(
          runtime
            .startDaemon({
              project: input.project,
              cwd: input.cwd,
              port,
              hostAddress,
              bindAddress,
              generation: input.generation,
            })
            .pipe(Effect.provideService(Scope.Scope, childScope)),
        );

        if (Exit.isFailure(startedExit)) {
          yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
          const cause = Cause.squash(startedExit.cause);
          const detail = zeroClawRuntimeErrorDetail(cause);
          POOL_EVENT("spawn.fail", {
            project: input.project,
            generation: input.generation,
            attempt,
            port,
            durationMs: Date.now() - startedAt,
            detail,
          });
          if (P.hasProperty(cause, "_tag") && cause._tag === ZeroClawRuntimeError.name) {
            return yield* Effect.fail(cause as ZeroClawRuntimeError);
          }
          return yield* Effect.fail(
            new ZeroClawRuntimeError({
              operation: "serverPool.spawn",
              detail,
              cause,
            }),
          );
        }

        const daemon = startedExit.value;
        let hasChannels = false;
        if (channelsExpected) {
          // Probe the daemon to see if its channel components came up.
          hasChannels = yield* Effect.promise(() => probeChannelReadiness(daemon.url));
          if (!hasChannels && attempt < CHANNEL_READINESS_RETRIES) {
            POOL_EVENT("spawn.channelRetry", {
              project: input.project,
              generation: input.generation,
              attempt,
              port,
            });
            yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
            continue;
          }
        }

        const entry: PoolEntry = {
          project: input.project,
          daemon,
          scope: childScope,
          spawnedAt: startedAt,
          generation: input.generation,
          port,
          sessionCallbacks: new Map(),
          refCount: 0,
          idleSince: null,
          closed: false,
          hasChannels,
        };
        POOL_EVENT("spawn.success", {
          project: entry.project,
          generation: entry.generation,
          attempt,
          pid: entry.daemon.pid,
          port: entry.port,
          url: entry.daemon.url,
          hasChannels: entry.hasChannels,
          channelsExpected,
          durationMs: Date.now() - startedAt,
        });
        return entry;
      }

      // The retry loop only reaches here when channelsExpected=true
      // AND every attempt up to CHANNEL_READINESS_RETRIES produced a
      // daemon without channels. Surface as a typed error rather than
      // silently returning a degraded entry — the channel broker is
      // a hard requirement of the user's project config when the
      // sidecar declared accounts.
      return yield* Effect.fail(
        new ZeroClawRuntimeError({
          operation: "serverPool.spawn",
          detail: `Channel readiness retries exhausted for ${input.project} (sidecar declared channels but daemon /health reported none after ${CHANNEL_READINESS_RETRIES + 1} attempts).`,
        }),
      );
    });

  // Hook the spawn's exitCode into the entry lifecycle. The fiber
  // lives inside the entry scope, so closing the scope (idle eviction
  // or layer shutdown) interrupts the watcher cleanly without firing
  // the crash path (closed flag prevents re-entry).
  const startExitWatcher = (entry: PoolEntry): Effect.Effect<void, never> =>
    entry.daemon.exitCode
      .pipe(
        Effect.flatMap((code) =>
          Effect.suspend(() => {
            if (entry.closed) return Effect.void;
            const reason = `ZeroClaw daemon exited unexpectedly (project=${entry.project}, code=${String(code)}, port=${entry.port}).`;
            return mutexFor(entry.project).withPermit(
              tearDownEntryLocked(entry, reason, "crash").pipe(Effect.asVoid),
            );
          }),
        ),
        Effect.ignore,
        Effect.forkIn(entry.scope),
        Effect.asVoid,
      );

  const acquire: ZeroClawDaemonPoolShape["acquire"] = (input) =>
    Effect.gen(function* () {
      // Defense-in-depth: the cwd's sandbox segment must equal the
      // requested project. A caller wiring a project-A cwd into a
      // project-B daemon would be running zeroclaw on a workspace
      // that doesn't exist in project-B's namespace anyway, but we
      // fail loudly here so the bug can't slip past unit tests.
      let cwdProject: string;
      try {
        cwdProject = sandboxIdFromCwd(input.cwd);
      } catch (cause) {
        return yield* Effect.fail(
          new ZeroClawRuntimeError({
            operation: "serverPool.acquire",
            detail: `cwd ${input.cwd} does not contain a sandbox id (project=${input.project}).`,
            cause,
          }),
        );
      }
      if (cwdProject !== input.project) {
        return yield* Effect.fail(
          new ZeroClawRuntimeError({
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
              pid: existing.daemon.pid,
              uptimeMs: Date.now() - existing.spawnedAt,
            });
            return {
              daemon: existing.daemon,
              generation: existing.generation,
              pid: existing.daemon.pid,
            } satisfies ZeroClawDaemonPoolAcquireResult;
          }

          const generation = (generationByProject.get(input.project) ?? 0) + 1;
          generationByProject.set(input.project, generation);
          const entry = yield* spawnEntry({
            project: input.project,
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
            pid: entry.daemon.pid,
            port: entry.port,
            url: entry.daemon.url,
            kind: "fresh",
          });
          return {
            daemon: entry.daemon,
            generation: entry.generation,
            pid: entry.daemon.pid,
          } satisfies ZeroClawDaemonPoolAcquireResult;
        }),
      );
    });

  // release runs lock-free on purpose. JS single-threaded execution
  // makes the Map.get + counter mutation atomic without a mutex, AND
  // skipping the per-project mutex is what prevents the crash callback
  // path from deadlocking on it: the crash watcher holds the project
  // mutex while firing every registered onCrash callback, and the
  // adapter's onCrash chains into emitUnexpectedExit → releasePoolEntry
  // → pool.release. If release re-took the same mutex, that whole
  // chain would block forever waiting for a permit the parent fiber
  // owns. (Effect's Semaphore is not reentrant.)
  const release: ZeroClawDaemonPoolShape["release"] = (input) =>
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
        pid: entry.daemon.pid,
        port: entry.port,
        had,
      });
    });

  const sweepIdle: ZeroClawDaemonPoolShape["sweepIdle"] = (maxIdleMs) =>
    Effect.gen(function* () {
      const now = Date.now();
      // Snapshot under no lock first; we re-check under each project's
      // lock when actually evicting. Sweep can race with acquire; the
      // `closed` flag and refCount recheck make it safe.
      const candidates = [...entries.values()].filter(
        (entry) =>
          !entry.closed && entry.refCount === 0 && entry.idleSince !== null,
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

  const listEntries: ZeroClawDaemonPoolShape["listEntries"] = Effect.sync(() =>
    [...entries.values()].map((entry) => ({
      project: entry.project,
      url: entry.daemon.url,
      port: entry.port,
      pid: entry.daemon.pid,
      refCount: entry.refCount,
      sessionCount: entry.sessionCallbacks.size,
      idleSince: entry.idleSince,
      spawnedAt: entry.spawnedAt,
      generation: entry.generation,
      hasChannels: entry.hasChannels,
    })),
  );

  const forceEvict: ZeroClawDaemonPoolShape["forceEvict"] = (input) =>
    mutexFor(input.project).withPermit(
      Effect.gen(function* () {
        const live = entries.get(input.project);
        if (!live || live.closed) return 0;
        return yield* tearDownEntryLocked(live, input.reason, "evict");
      }),
    );

  return {
    acquire,
    release,
    sweepIdle,
    listEntries,
    forceEvict,
  } satisfies ZeroClawDaemonPoolShape;
});

export const ZeroClawDaemonPoolLive = Layer.effect(
  ZeroClawDaemonPool,
  makeZeroClawDaemonPool,
);
