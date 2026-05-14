// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Effect, Layer, ManagedRuntime, Path, Scope } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { ClaudeAdapter, ClaudeAdapterLive, ClaudeLiteAdapterLive } from "./claude";
import { CodexAdapter, CodexAdapterLive } from "./codex";
import {
  OpenCodeAdapter,
  OpenCodeAdapterLive,
  OpenCodeRuntimeLive,
  OpenCodeServerPool,
  OpenCodeServerPoolLive,
  WarmSessionPool,
  WarmSessionPoolLive,
  type OpenCodeServerPoolShape,
  type WarmSessionPoolShape,
} from "./opencode";
import {
  CursorAdapter,
  CursorAdapterLive,
  CursorAcpServerPool,
  CursorAcpServerPoolLive,
  CursorAcpRuntimeFactoryLive,
  type CursorAcpServerPoolShape,
} from "./cursor";
import {
  ZeroClawAdapter,
  ZeroClawAdapterLive,
  ZeroClawRuntimeLive,
  ZeroClawDaemonPool,
  ZeroClawDaemonPoolLive,
  type ZeroClawDaemonPoolShape,
} from "./zeroclaw";
import { makeProviderAdapterRegistry } from "./registry";
import {
  makeProviderSessionDirectoryInMemory,
  type ProviderSessionDirectoryShape,
} from "./session-directory";
import { makeProviderSessionDirectoryVaultBacked } from "./session-directory-vault";
import { makeProviderService, type ProviderServiceShape } from "./provider-service";
import type { ProviderAdapterError } from "./errors";
import type { ProviderAdapterShape } from "@ellul.ai/types";
import {
  defaultServerConfig,
  ServerConfig,
} from "../shared/config";
import { NamespaceChildProcessSpawnerLive } from "../shared/namespace-spawner";
import {
  makeStaticServerSettings,
  ServerSettingsService,
} from "../shared/serverSettings";

export interface AdapterRuntime {
  readonly service: ProviderServiceShape;
  readonly directory: ProviderSessionDirectoryShape;
  readonly adapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
  readonly opencodeServerPool: OpenCodeServerPoolShape;
  readonly opencodeWarmPool: WarmSessionPoolShape;
  readonly cursorAcpServerPool: CursorAcpServerPoolShape;
  readonly zeroclawDaemonPool: ZeroClawDaemonPoolShape;
}

let instance: AdapterRuntime | null = null;
type AdapterRuntimeServices =
  | ClaudeAdapter
  | CodexAdapter
  | OpenCodeAdapter
  | OpenCodeServerPool
  | WarmSessionPool
  | CursorAdapter
  | CursorAcpServerPool
  | ZeroClawAdapter
  | ZeroClawDaemonPool;
let managedRuntime: ManagedRuntime.ManagedRuntime<AdapterRuntimeServices, never> | null = null;

const AdapterPlatformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  Path.layer,
  NamespaceChildProcessSpawnerLive.pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(Path.layer),
  ),
  Layer.effect(ServerConfig, Effect.succeed(defaultServerConfig)),
  Layer.effect(ServerSettingsService, Effect.succeed(makeStaticServerSettings())),
);

// Both Layers provide the same `ClaudeAdapter` tag; the setting is
// read once at boot, so changing it requires a bridge restart.
const ClaudeAdapterRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const claudeSettings = yield* settings.getSettings.pipe(
      Effect.map((s) => s.providers.claudeAgent),
      Effect.orElseSucceed(() => ({ runtimeMode: "pro" as const })),
    );
    return claudeSettings.runtimeMode === "lite"
      ? ClaudeLiteAdapterLive
      : ClaudeAdapterLive;
  }),
).pipe(Layer.provide(AdapterPlatformLayer));
const CodexAdapterRuntimeLayer = CodexAdapterLive.pipe(Layer.provide(AdapterPlatformLayer));
// Pool depends on OpenCodeRuntime; the adapter depends on both pool and
// runtime. Keep them composed here so the Layer scope owns the spawned
// servers — bridge shutdown closes the layer scope which kills every
// pooled `opencode serve`.
//
// `provideMerge` (vs. plain `provide`) re-exposes the pool from the
// merged layer so the AdapterRuntime can call sweepIdle from the
// namespace lifecycle reconciler tick.
const OpenCodeAdapterRuntimeLayer = OpenCodeAdapterLive.pipe(
  // WarmSessionPoolLive sits BETWEEN the adapter and the server pool —
  // depends on (OpenCodeRuntime + OpenCodeServerPool), exposes WarmSessionPool.
  // provideMerge re-exposes both pools so AdapterRuntime can sweep idle
  // entries (server pool) and surface warm-pool stats (warm pool).
  Layer.provideMerge(WarmSessionPoolLive),
  Layer.provideMerge(OpenCodeServerPoolLive),
  Layer.provide(OpenCodeRuntimeLive),
  Layer.provide(AdapterPlatformLayer),
);
// Cursor pool mirrors the opencode shape: per-project AcpProjectRuntime
// wrapping one cursor-agent process, multiple ACP sessions multiplexed
// onto it via session/new. provideMerge re-exposes the pool so
// AdapterRuntime can sweep idle entries from the lifecycle reconciler.
const CursorAdapterRuntimeLayer = CursorAdapterLive.pipe(
  Layer.provideMerge(CursorAcpServerPoolLive),
  Layer.provide(CursorAcpRuntimeFactoryLive),
  Layer.provide(AdapterPlatformLayer),
);
// ZeroClaw mirrors the opencode/cursor pool architecture: per-project
// `zeroclaw daemon` process, multiple chat threads share one daemon
// via the pool. `provideMerge` re-exposes the pool so AdapterRuntime
// can call sweepIdle from the namespace lifecycle reconciler tick,
// matching how opencode/cursor are wired.
const ZeroClawAdapterRuntimeLayer = ZeroClawAdapterLive.pipe(
  Layer.provideMerge(ZeroClawDaemonPoolLive),
  Layer.provide(ZeroClawRuntimeLive),
  Layer.provide(AdapterPlatformLayer),
);

const AdapterCompositeLayer = Layer.mergeAll(
  ClaudeAdapterRuntimeLayer,
  CodexAdapterRuntimeLayer,
  OpenCodeAdapterRuntimeLayer,
  CursorAdapterRuntimeLayer,
  ZeroClawAdapterRuntimeLayer,
);

/**
 * Run the OpenCode server pool's idle reaper.
 *
 * Safe to call before {@link getAdapterRuntime} has resolved — returns
 * `{ evicted: 0, retained: 0 }` while the runtime is still booting. Used
 * by the namespace-lifecycle reconciler tick so the same scheduler that
 * pre-warms namespaces also evicts idle opencode serves.
 */
export async function sweepOpenCodeIdleServers(
  maxIdleMs: number,
): Promise<{ readonly evicted: number; readonly retained: number }> {
  if (!instance || !managedRuntime) return { evicted: 0, retained: 0 };
  return managedRuntime.runPromise(instance.opencodeServerPool.sweepIdle(maxIdleMs));
}

/**
 * Run the Cursor ACP server pool's idle reaper.
 *
 * Same lifecycle hook as {@link sweepOpenCodeIdleServers}: called from
 * the namespace-lifecycle reconciler tick so per-project cursor-agent
 * processes get reaped after the configured TTL.
 */
export async function sweepCursorIdleAgents(
  maxIdleMs: number,
): Promise<{ readonly evicted: number; readonly retained: number }> {
  if (!instance || !managedRuntime) return { evicted: 0, retained: 0 };
  return managedRuntime.runPromise(instance.cursorAcpServerPool.sweepIdle(maxIdleMs));
}

/**
 * Run the ZeroClaw daemon pool's idle reaper. Same lifecycle hook as
 * the opencode/cursor variants: called from the namespace-lifecycle
 * reconciler tick so per-project `zeroclaw daemon` processes get
 * reaped after the configured TTL (10 min).
 */
export async function sweepZeroClawIdleDaemons(
  maxIdleMs: number,
): Promise<{ readonly evicted: number; readonly retained: number }> {
  if (!instance || !managedRuntime) return { evicted: 0, retained: 0 };
  return managedRuntime.runPromise(instance.zeroclawDaemonPool.sweepIdle(maxIdleMs));
}

export interface PoolEntrySummary {
  readonly project: string;
  readonly refCount: number;
  readonly sessionCount: number;
  readonly idleSince: number | null;
  readonly spawnedAt: number;
}

export async function listOpenCodePoolEntries(): Promise<ReadonlyArray<PoolEntrySummary>> {
  if (!instance || !managedRuntime) return [];
  return managedRuntime.runPromise(instance.opencodeServerPool.listEntries);
}

export async function listCursorAcpPoolEntries(): Promise<ReadonlyArray<PoolEntrySummary>> {
  if (!instance || !managedRuntime) return [];
  const entries = await managedRuntime.runPromise(instance.cursorAcpServerPool.listEntries);
  return entries.map((e) => ({
    project: e.project,
    refCount: e.refCount,
    sessionCount: e.sessionCount,
    idleSince: e.idleSince,
    spawnedAt: e.spawnedAt,
  }));
}

export async function listZeroClawPoolEntries(): Promise<ReadonlyArray<PoolEntrySummary>> {
  if (!instance || !managedRuntime) return [];
  const entries = await managedRuntime.runPromise(instance.zeroclawDaemonPool.listEntries);
  return entries.map((e) => ({
    project: e.project,
    refCount: e.refCount,
    sessionCount: e.sessionCount,
    idleSince: e.idleSince,
    spawnedAt: e.spawnedAt,
  }));
}

/**
 * Pre-warm a ZeroClaw daemon for a project. Acquire+immediately-release
 * — the daemon spawns (if not already alive), refCount drops to 0,
 * and idleSince starts counting. The next user-driven acquire on this
 * project gets a warm daemon (zero spawn latency).
 *
 * Replaces legacy `daemon.ensureDaemonRunning(project)`. Errors are
 * not propagated to the caller (this is fire-and-forget) but ARE
 * logged with classification so a misbehaving namespace / missing
 * binary / spawn-budget exhaustion shows up in
 * /var/log/ellul/agent-bridge-events.jsonl rather than silently
 * leaving the daemon unspawned.
 */
export async function prewarmZeroClawDaemon(input: {
  readonly project: string;
  readonly cwd: string;
}): Promise<void> {
  if (!instance || !managedRuntime) return;
  const sessionId = `__prewarm__${input.project}__${Date.now()}`;
  try {
    await managedRuntime.runPromise(
      instance.zeroclawDaemonPool.acquire({
        project: input.project,
        cwd: input.cwd,
        sessionId,
        // Pre-warm refs don't care about crashes — the next user
        // acquire will respawn if needed.
        onCrash: () => Effect.void,
      }),
    );
    await managedRuntime.runPromise(
      instance.zeroclawDaemonPool.release({
        project: input.project,
        sessionId,
      }),
    );
  } catch (err) {
    // Structured event so an operator can spot pre-warm failures
    // without parsing systemd journal. NOT thrown — pre-warm is
    // advisory; the user's first message will retry on demand.
    const { logEvent, serializeError } = await import(
      "../shared/event-log"
    );
    logEvent("zeroclaw.prewarm.fail", {
      project: input.project,
      cwd: input.cwd,
      ...serializeError(err),
    });
  }
}

/**
 * Snapshot of currently pooled ZeroClaw daemons, mapped into the
 * legacy `ZeroClawDaemonHealthEntry` shape consumed by watchdog
 * (/api/internal/daemon-health). Kept compatible with the daemon.ts
 * version so existing telemetry consumers don't need to migrate.
 */
export async function getZeroClawDaemonHealth(): Promise<
  ReadonlyArray<{
    readonly project: string;
    readonly port: number;
    readonly hostAddress: string;
    readonly pid: number | null;
    readonly ready: boolean;
    readonly hasChannels: boolean;
    readonly lastActivity: number;
    readonly idleMs: number;
  }>
> {
  if (!instance || !managedRuntime) return [];
  const summaries = await managedRuntime.runPromise(
    instance.zeroclawDaemonPool.listEntries,
  );
  const now = Date.now();
  return summaries.map((s) => ({
    project: s.project,
    port: s.port,
    hostAddress: (() => {
      try {
        return new URL(s.url).hostname;
      } catch {
        return "127.0.0.1";
      }
    })(),
    pid: s.pid,
    // Active (refCount > 0) OR warm-but-not-yet-idle (idleSince null) →
    // ready=true. Past TTL with no callers → ready=false (the watchdog
    // probe should treat that as a candidate for eviction). The legacy
    // shape was binary: pid alive ⇒ ready, but the pool's lifecycle is
    // richer, and watchdog only ever inspected `daemons.length` so a
    // refined ready flag is forward-compatible.
    ready: s.refCount > 0 || s.idleSince === null,
    hasChannels: s.hasChannels,
    lastActivity: s.idleSince ?? s.spawnedAt,
    idleMs: s.idleSince ? now - s.idleSince : 0,
  }));
}

/**
 * Force a project's ZeroClaw daemon to respawn. Tears down the
 * current entry regardless of refCount; in-flight sessions get the
 * crash callback with the supplied reason and surface a recoverable
 * runtime.error to the user. Next acquire spawns a fresh daemon at
 * generation N+1.
 *
 * Use cases: post-config-change restarts (file-api WhatsApp QR
 * re-pair), operator-initiated recovery via /api/internal/daemon-restart.
 */
export async function forceRestartZeroClawDaemon(input: {
  readonly project: string;
  readonly reason?: string;
}): Promise<void> {
  if (!instance || !managedRuntime) return;
  await managedRuntime.runPromise(
    instance.zeroclawDaemonPool.forceEvict({
      project: input.project,
      reason: input.reason ?? "operator-initiated restart",
    }),
  );
}

export async function getAdapterRuntime(): Promise<AdapterRuntime> {
  if (instance) return instance;

  // ManagedRuntime keeps the layer scope open; runPromise on a fresh
  // setup would close it and shut down each adapter's runtimeEvents queue.
  managedRuntime = ManagedRuntime.make(AdapterCompositeLayer);

  const longLivedScope = Effect.runSync(Scope.make());
  instance = await managedRuntime.runPromise(
    Effect.gen(function* () {
      // resource-v2: vault-backed directory checkpoints every binding to
      // <vault>/sessions/<threadId>/<turn>.json so bridge restarts don't lose
      // sessions. Falls back to in-memory if vault path is unwritable.
      const directory = process.env.ELLUL_DISABLE_SESSION_VAULT === "1"
        ? yield* makeProviderSessionDirectoryInMemory()
        : yield* makeProviderSessionDirectoryVaultBacked();
      const claudeAdapter = yield* ClaudeAdapter;
      const codexAdapter = yield* CodexAdapter;
      const opencodeAdapter = yield* OpenCodeAdapter;
      const opencodeServerPool = yield* OpenCodeServerPool;
      const opencodeWarmPool = yield* WarmSessionPool;
      const cursorAdapter = yield* CursorAdapter;
      const cursorAcpServerPool = yield* CursorAcpServerPool;
      const zeroclawAdapter = yield* ZeroClawAdapter;
      const zeroclawDaemonPool = yield* ZeroClawDaemonPool;
      const adapters = [
        claudeAdapter,
        codexAdapter,
        opencodeAdapter,
        cursorAdapter,
        zeroclawAdapter,
      ];
      const registry = makeProviderAdapterRegistry({ adapters });
      const service = yield* makeProviderService({ adapters, registry, directory }).pipe(
        Effect.provideService(Scope.Scope, longLivedScope),
      );
      return {
        service,
        directory,
        adapters,
        opencodeServerPool,
        opencodeWarmPool,
        cursorAcpServerPool,
        zeroclawDaemonPool,
      } satisfies AdapterRuntime;
    }),
  );

  return instance;
}
