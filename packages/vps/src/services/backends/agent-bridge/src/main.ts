// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Agent Bridge entry point. Orchestrates:
//  - ApplicationLayer (engine + reactors + persistence + adapters bridge)
//  - internal-http (shield ↔ bridge RPC over HTTP)
//  - ws-rpc transport (browser ↔ bridge orchestration commands)
//  - MCP endpoint, integrations loader, zeroclaw reconciliation (ellul-only)

// Shield bootstrap: set service name BEFORE any import path that might call
// callShieldInternal (integration-loader, mcp-gateway, internal-http gate
// routes). Without this, shield-client can't find the right token file and
// every internal call silently 401s.
import { setShieldServiceName } from "@vps/shared/shield-client";
setShieldServiceName("agent-bridge");

// Greenfield Claude OAT credential subsystem (see
// packages/vps/src/services/shared/claude-oat-protocol.ts):
//
//   - Sovereign-shield owns the OAT at /etc/ellul/shield-data/claude-oat.json
//     (root:shield 640, AES-256-GCM at rest with HKDF-derived per-VPS key).
//   - Bridge mints and redeems single-use issuance tokens in-process,
//     passes the OAT via env to ellul-claude-ns which enters the namespace.
//   - Heuristic invalidation (text-matching of stream output) is FORBIDDEN
//     and CI-lint enforced. Only shield's 10s probe loop verifying directly
//     against Anthropic moves credential state.
//
// We deliberately do NOT bootstrap a per-bridge DBus session bus or
// gnome-keyring-daemon. An earlier iteration did, to support claude's
// libsecret-backed OAuth path — but that opens org.freedesktop.secrets
// on /run/user/$uid/bus, which is reachable from inside per-project
// namespaces (ns-mount.c does not tmpfs-overlay /run/user). Any agent
// could then read or write keyring entries — a real regression on the
// existing isolation guarantee.

import * as http from "http";
import { Effect, Exit, Scope } from "effect";

import { initCodeMode } from "./composition/CodeModeInit";
import { makeApplicationRuntime } from "./composition/ApplicationLayer";
import { PORT } from "./config";
import { attachInternalHttp } from "./internal-http";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { loadIntegrations } from "./application/mcp-tool/IntegrationLoader";
import { mcpProviderRegistry } from "./application/mcp-providers";
import { startMcpEndpoint, stopMcpEndpoint } from "./application/mcp-tool/McpEndpoint";
import { reconcileProjects } from "./application/reconciliation/ZeroclawAgent";
import { startNamespaceLifecycle, stopNamespaceLifecycle } from "./application/namespace/NamespaceLifecycle";
import { applyMemoryDiscipline } from "./application/memory/MemoryDiscipline";
import { sweepOrphanedAgentProcesses } from "./application/namespace/OrphanSweeper";
import { startZenModelRefresh, stopZenModelRefresh } from "./application/reconciliation/ZenModels";
import { startWsRpcServer } from "./transport";
import { logEvent, serializeError } from "./shared/event-log";
import { getClaudeOatBridgeModule } from "./credentials/claude-oat/public";
import { makeRuntimeServices } from "./composition/runtime-control/RuntimeControlLayer";
import { makeBridgeBroadcast } from "./application/bridge-glue/Broadcast";
import { makeBridgePoolManager } from "./application/bridge-glue/PoolBridge";

// Top-level safety net for unhandled async failures. Without these, a single
// thrown rejection inside any reactor silently aborts the process under Node 20+.
process.on("unhandledRejection", (reason: unknown) => {
  logEvent("process.unhandledRejection", {
    reason: String(reason),
    stack: (reason as { stack?: string } | null)?.stack,
  });
});
process.on("uncaughtException", (err: Error) => {
  logEvent("process.uncaughtException", { err: err.message, stack: err.stack });
  process.exit(1);
});

const startedAt = Date.now();
let installedLifecycleHooks = false;
let shuttingDown = false;

function installLifecycleHooks(): void {
  if (installedLifecycleHooks) return;
  installedLifecycleHooks = true;

  process.on("beforeExit", (code) => {
    logEvent("bridge.beforeExit", { code, uptimeMs: Date.now() - startedAt });
  });
  process.on("exit", (code) => {
    logEvent("bridge.exit", { code, uptimeMs: Date.now() - startedAt, shuttingDown });
  });
  // The bridge orchestrates many concurrent CLI sessions; a single botched
  // promise must not recycle the whole process. These handlers log and let
  // the event loop keep running.
  process.on("uncaughtException", (err, origin) => {
    // The Claude Agent SDK's [Symbol.dispose] writes a final control
    // message to its child's stdin during cleanup. When the child has
    // already exited (typical for the periodic provider probe — it
    // calls initializationResult, then aborts), the stdin write fails
    // async with EPIPE. The SDK doesn't attach an error listener so the
    // EPIPE bubbles up here. It's not fatal — the session is being torn
    // down anyway — so demote it to a quieter event tag instead of
    // logging as a generic uncaughtException.
    const errCode = (err as NodeJS.ErrnoException).code;
    const stack = err.stack ?? "";
    if (
      errCode === "EPIPE" &&
      // Heuristic: the SDK's transport.write call site in the bundled
      // claude-agent-sdk module. We match the writeGeneric chain plus
      // the Promise wrapper that the SDK's Symbol.dispose installs.
      /afterWriteDispatched/.test(stack) &&
      /writeOrBuffer/.test(stack)
    ) {
      logEvent("bridge.sdkEpipe.swallowed", {
        origin,
        errorMessage: err.message,
        ...(serializeError(err).errorStack
          ? { errorStack: (serializeError(err).errorStack as string).split("\n").slice(0, 4).join("\n") }
          : {}),
      });
      return;
    }
    logEvent("bridge.uncaughtException", { origin, ...serializeError(err) });
    try {
      process.stderr.write(`[Bridge] Uncaught exception (${origin}): ${err.message}\n`);
    } catch { /* stderr may be EPIPE */ }
  });
  process.on("unhandledRejection", (reason, promise) => {
    logEvent("bridge.unhandledRejection", {
      ...serializeError(reason),
      promise: typeof promise === "object" ? "Promise" : String(typeof promise),
    });
    try {
      const message = reason instanceof Error ? reason.message : String(reason);
      process.stderr.write(`[Bridge] Unhandled rejection: ${message}\n`);
    } catch { /* stderr may be EPIPE */ }
  });
  process.on("warning", (warning) => {
    logEvent("bridge.warning", {
      name: warning.name,
      message: warning.message,
      ...(warning.stack
        ? { stack: warning.stack.split("\n").slice(0, 8).join("\n") }
        : {}),
    });
  });
}

async function main(): Promise<void> {
  logEvent("bridge.start", {
    nodeVersion: process.version,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    cwd: process.cwd(),
    nodeOptions: process.env.NODE_OPTIONS || null,
    port: PORT,
    arch: process.arch,
    platform: process.platform,
  });

  // Reap any agent SDK subprocesses left behind by a dead predecessor
  // bridge — opencode serves, claude SDK helpers, codex App Server,
  // cursor-agent ACP. systemd's `KillMode=process` keeps the anchors and
  // sessions alive across graceful restarts, but a hard kill (OOM, panic,
  // SIGKILL, manual `kill -9`) leaves these reparented to PID 1 and
  // running indefinitely. After a few restart cycles a 2 GB box has 7+
  // opencode serves at ~150 MB each plus stale claude/cursor binaries,
  // and OOM-kills critical services. The sweep runs once at startup,
  // before any session can be created, so anything matching the
  // allowlist with PPID=1 is provably an orphan.
  try {
    sweepOrphanedAgentProcesses();
  } catch (err) {
    logEvent("orphan.sweep.unhandled", serializeError(err));
  }

  // Socket activation handshake — when systemd starts us via a paired
  // .socket unit it passes the listening FD as fd=3 and sets LISTEN_PID
  // to our pid. We inherit that FD instead of binding fresh so a service
  // restart hands the socket from old to new bridge with no "connection
  // refused" gap. Falls back to direct bind when run standalone.
  function getInheritedListenFd(): number | null {
    if (process.env.LISTEN_PID && Number(process.env.LISTEN_PID) !== process.pid) return null;
    if (process.env.LISTEN_FDS && Number(process.env.LISTEN_FDS) >= 1) return 3;
    return null;
  }
  function sdNotify(...args: string[]): void {
    if (!process.env.NOTIFY_SOCKET) return;
    try {
      const cp = require("node:child_process") as typeof import("node:child_process");
      cp.spawn("systemd-notify", args, { stdio: "ignore", detached: true }).unref();
    } catch { /* best effort */ }
  }
  function sdNotifyReady(): void { sdNotify("--ready", "--status=accepting connections"); }
  function sdNotifyStopping(): void { sdNotify("--stopping", "--status=draining"); }

  const httpServer = http.createServer();
  // Must exceed Caddy's reverse_proxy pool idle (~30s) — see commit e06c1eb1.
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 70_000;
  httpServer.on("error", (err) => {
    logEvent("bridge.httpServerError", serializeError(err));
    try {
      process.stderr.write(`[Bridge] HTTP server error: ${(err as Error).message}\n`);
    } catch { /* EPIPE */ }
  });
  httpServer.on("clientError", (err, socket) => {
    logEvent("bridge.httpClientError", serializeError(err));
    try { socket.destroy(); } catch { /* socket already gone */ }
  });

  const runtime = makeApplicationRuntime();

  runtime.runFork(
    Effect.gen(function* () {
      const reactor = yield* OrchestrationReactor;
      const reactorScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));
      yield* reactor.start().pipe(Scope.provide(reactorScope));
      yield* Effect.never;
    }).pipe(Effect.scoped),
  );

  let services = null as null | ReturnType<typeof makeRuntimeServices>;
  try {
    services = makeRuntimeServices({
      broadcast: makeBridgeBroadcast(httpServer),
      poolManager: makeBridgePoolManager(),
    });
    logEvent("bridge.runtime.init", {
      workloadMaxMB: services.budget.workloadMaxMB,
      perSandboxSoftHintMB: services.budget.perSandboxSoftHintMB,
      proClaudeSlotSoftHintMB: services.budget.proClaudeSlotSoftHintMB,
    });
  } catch (err) {
    logEvent("bridge.runtime.initError", serializeError(err));
  }

  const detachHttp = attachInternalHttp({ httpServer, runtime, services: services ?? undefined });
  const stopWsRpc = startWsRpcServer({ httpServer, runtime });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      httpServer.off("error", onError);
      const inheritedFd = getInheritedListenFd();
      if (inheritedFd !== null) {
        console.log(`[Bridge] Listening on inherited fd=${inheritedFd}`);
        logEvent("bridge.listening", { port: PORT, source: "systemd-fd", fd: inheritedFd });
      } else {
        console.log(`[Bridge] Running on http://127.0.0.1:${PORT}`);
        logEvent("bridge.listening", { port: PORT, source: "tcp-bind" });
      }
      sdNotifyReady();
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    const inheritedFd = getInheritedListenFd();
    if (inheritedFd !== null) {
      httpServer.listen({ fd: inheritedFd });
    } else {
      httpServer.listen(PORT, "127.0.0.1");
    }
  });

  reconcileProjects().catch((err) => {
    logEvent("bridge.reconcileError", serializeError(err));
    console.error("[Bridge] Agent reconciliation error:", (err as Error).message);
  });

  // Greenfield Claude OAT credential bounded context — first reference
  // here builds the singleton; adapter and auth-routes reach the same
  // instance via getClaudeOatBridgeModule(). Side effect: kicks off the
  // one-shot migration from ~/.claude.json:primaryApiKey. Idempotent —
  // subsequent restarts see no primaryApiKey and no-op.
  getClaudeOatBridgeModule()
    .runMigration()
    .catch((err) => {
      logEvent("bridge.claudeOatMigrationError", serializeError(err));
    });

  // Pin adapter binaries before the reconciler fires its --version probes.
  applyMemoryDiscipline().catch((err) => {
    logEvent("bridge.memoryDisciplineError", serializeError(err));
  });

  startNamespaceLifecycle();

  Promise.all([loadIntegrations(), mcpProviderRegistry.connectAll()])
    .then(() => initCodeMode())
    .then(() => startMcpEndpoint())
    .then(() => startZenModelRefresh())
    .catch((err) => {
      logEvent("bridge.integrationLoadError", serializeError(err));
      console.error("[Bridge] Integration loading error:", (err as Error).message);
    });

  // Heartbeat narrows the window of "what was happening just before death"
  // when the bridge restarts unexpectedly. unref so it doesn't block exit.
  const heartbeatTimer = setInterval(() => {
    const mem = process.memoryUsage();
    logEvent("bridge.heartbeat", {
      uptimeMs: Date.now() - startedAt,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      externalMb: Math.round(mem.external / 1024 / 1024),
    });
  }, 30_000);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent("bridge.shutdown.begin", { signal });
    console.log(`[Bridge] ${signal}: shutting down`);
    sdNotifyStopping();
    clearInterval(heartbeatTimer);
    stopNamespaceLifecycle();
    stopZenModelRefresh();
    if (services) {
      try { await services.drain.drain(`signal_${signal}`); }
      catch (err) { logEvent("bridge.shutdown.drainError", serializeError(err)); }
      try { await services.stop(); }
      catch (err) { logEvent("bridge.shutdown.runtimeStopError", serializeError(err)); }
    }
    detachHttp();
    await stopWsRpc();
    await stopMcpEndpoint().catch((err) =>
      logEvent("bridge.shutdown.mcpStopError", serializeError(err)),
    );
    httpServer.close();
    await runtime.dispose().catch((err) =>
      logEvent("bridge.shutdown.runtimeDisposeError", serializeError(err)),
    );
    logEvent("bridge.shutdown.end", { signal });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Install handlers before main() so synchronous module-init throws are caught.
installLifecycleHooks();

main().catch((err) => {
  logEvent("bridge.fatalStartupError", serializeError(err));
  console.error("[Bridge] Fatal startup error:", err);
  process.exit(1);
});
