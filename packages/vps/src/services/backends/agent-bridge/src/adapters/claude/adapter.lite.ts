// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Spawns `ellul-claude-ns -p` per conversation (not per turn);
// hot-window keeps the process alive briefly between turns. Bypasses
// the namespace spawner because the ns wrapper enters the namespace
// itself — wrapping again would re-run unshare(2) and trip seccomp.

import {
  spawn as nodeSpawn,
  type ChildProcess as NodeChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildSystemInstructions } from "../../shared/platform-instructions";
import {
  Cause,
  Effect,
  Layer,
  Queue,
  Random,
  Stream,
} from "effect";
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ProviderItemId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  sandboxIdFromCwd,
} from "@ellul.ai/types";
import { ClaudeAdapter, type ClaudeAdapterShape } from "./adapter.sdk";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../errors";
import {
  ServerSettingsService,
  type ClaudeAgentSettings,
} from "../../shared/serverSettings";
import { ServerConfig } from "../../shared/config";
import { logEvent, serializeError } from "../../shared/event-log";
import { claudeLaunchTrace } from "../../../../../shared/claude-launch-trace";
import { mintLaunchEnv } from "./launch-env";
import { readClaudeResumeState } from "./shared/session-store";
import {
  applyEffortPrefix,
  buildClaudeArgs,
  formatStreamJsonUserMessage,
  type BuiltClaudeArgs,
} from "./shared/args";
import {
  flushClaudeStreamOnAbort,
  newClaudeStreamState,
  parseClaudeStreamLine,
  resetClaudeStreamTurn,
  type ClaudeBlockParserDeps,
  type ClaudeStreamState,
  type ParsedClaudeEvent,
} from "./shared/block-parser";

const PROVIDER = "claudeAgent" as const;

const SIGTERM_GRACE_MS = 5_000;

interface ActiveTurn {
  readonly id: TurnId;
  readonly items: Map<string, unknown>;
  interrupted: boolean;
  readonly startedAt: number;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
}

export interface HotProcessState {
  readonly process: NodeChildProcess;
  readonly parserState: ClaudeStreamState;
  stdoutBuffer: string;
  readonly stderrChunks: Array<string>;
  currentTurn: ActiveTurn | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  readonly spawnedAt: number;
  readonly detach: () => void;
}

interface ClaudeLiteSessionContext {
  session: ProviderSession;
  readonly projectId: string;
  readonly cwd: string;
  sessionId: string;
  hot: HotProcessState | null;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  hasPersistedSession: boolean;
  lastAssistantUuid: string | undefined;
  stopped: boolean;
}

export interface ClaudeLiteAdapterLiveOptions {
  readonly binaryPathOverride?: string;
  readonly spawnOverride?: (input: {
    readonly binary: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  }) => NodeChildProcess;
  /** 0 disables hot reuse. */
  readonly hotWindowMs?: number;
}

const makeClaudeLiteAdapter = Effect.fn("makeClaudeLiteAdapter")(function* (
  options?: ClaudeLiteAdapterLiveOptions,
) {
  const serverSettingsService = yield* ServerSettingsService;
  const _serverConfig = yield* ServerConfig;

  const sessions = new Map<ThreadId, ClaudeLiteSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const initialSettings = yield* serverSettingsService.getSettings.pipe(
    Effect.orElseSucceed(() => null),
  );
  const hotWindowMs =
    options?.hotWindowMs ?? initialSettings?.providers.claudeAgent.lite.hotWindowMs ?? 30_000;

  const nowIso = (): string => new Date().toISOString();
  const newEventId = (): EventId => EventId.make(randomUUID());

  const emit = (event: ProviderRuntimeEvent): void => {
    Queue.offerUnsafe(runtimeEventQueue, event);
  };

  // ── Process spawning ─────────────────────────────────────────────

  const spawnClaudeProcess = (input: {
    readonly binaryPath: string;
    readonly argv: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  }): NodeChildProcess => {
    if (options?.spawnOverride) {
      return options.spawnOverride({
        binary: input.binaryPath,
        args: input.argv,
        env: input.env,
        cwd: input.cwd,
      });
    }
    // Detached so we can SIGKILL the whole launcher → ns → claude tree.
    return nodeSpawn(input.binaryPath, [...input.argv], {
      env: input.env,
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  };

  const killProcessTree = (
    proc: NodeChildProcess,
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ): void => {
    if (proc.pid === undefined || proc.killed) return;
    try {
      // Negative PID reaches the whole process group.
      process.kill(-proc.pid, signal);
    } catch (cause) {
      logEvent("claudeLite.process.killError", {
        pid: proc.pid,
        signal,
        ...serializeError(cause),
      });
    }
  };

  const emitParsedEvent = (
    parsed: ParsedClaudeEvent,
    context: ClaudeLiteSessionContext,
    turnId: TurnId,
    rawLine: string,
  ): void => {
    const eventId = newEventId();
    const createdAt = nowIso();
    const threadId = context.session.threadId;
    const raw = {
      source: "claude.sdk.message" as const,
      payload: rawLine,
    };

    switch (parsed.kind) {
      case "session.id": {
        context.sessionId = parsed.sessionId;
        context.session = {
          ...context.session,
          resumeCursor: {
            ...(parsed.sessionId ? { resume: parsed.sessionId } : {}),
            threadId,
            turnCount: context.turns.length,
          },
          updatedAt: nowIso(),
        };
        emit({
          type: "thread.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          raw,
          payload: { providerThreadId: parsed.sessionId },
        });
        return;
      }
      case "content.delta": {
        emit({
          type: "content.delta",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(parsed.itemId),
          raw,
          payload: {
            streamKind: parsed.streamKind,
            delta: parsed.delta,
            contentIndex: parsed.contentIndex,
          },
        });
        return;
      }
      case "item.started": {
        const itemId = RuntimeItemId.make(parsed.itemId);
        if (context.hot?.currentTurn) {
          context.hot.currentTurn.items.set(parsed.itemId, parsed);
        }
        emit({
          type: "item.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId,
          providerRefs: { providerItemId: ProviderItemId.make(parsed.toolUseId) },
          raw,
          payload: {
            itemType: parsed.itemType,
            status: "inProgress",
            title: parsed.title,
            detail: parsed.detail,
            data: {
              toolUseId: parsed.toolUseId,
              toolName: parsed.toolName,
              input: parsed.input,
            },
          },
        });
        return;
      }
      case "item.updated": {
        emit({
          type: "item.updated",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(parsed.itemId),
          providerRefs: { providerItemId: ProviderItemId.make(parsed.toolUseId) },
          raw,
          payload: {
            itemType: parsed.itemType,
            status: "inProgress",
            title: parsed.title,
            detail: parsed.detail,
            data: { toolUseId: parsed.toolUseId, input: parsed.input },
          },
        });
        return;
      }
      case "item.completed": {
        emit({
          type: "item.completed",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(parsed.itemId),
          providerRefs: { providerItemId: ProviderItemId.make(parsed.toolUseId) },
          raw,
          payload: {
            itemType: parsed.itemType,
            status: parsed.status,
            data: {
              toolUseId: parsed.toolUseId,
              output: parsed.output,
              isError: parsed.isError,
            },
          },
        });
        return;
      }
      case "turn.plan.updated": {
        emit({
          type: "turn.plan.updated",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          raw,
          payload: {
            plan: parsed.plan,
            ...(parsed.explanation !== undefined ? { explanation: parsed.explanation } : {}),
          },
        });
        return;
      }
      case "turn.proposed.completed": {
        emit({
          type: "turn.proposed.completed",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          raw,
          payload: { planMarkdown: parsed.planMarkdown },
        });
        return;
      }
      case "turn.completed": {
        emit({
          type: "turn.completed",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          raw,
          payload: {
            state: parsed.state,
            ...(parsed.errorMessage ? { errorMessage: parsed.errorMessage } : {}),
            ...(parsed.totalCostUsd !== null ? { totalCostUsd: parsed.totalCostUsd } : {}),
            ...(parsed.modelUsage ? { modelUsage: parsed.modelUsage } : {}),
          },
        });
        return;
      }
      case "runtime.warning": {
        emit({
          type: "runtime.warning",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          raw,
          payload: { message: parsed.message },
        });
        return;
      }
    }
  };

  const onTurnSettled = (
    hot: HotProcessState,
    context: ClaudeLiteSessionContext,
    turn: ActiveTurn,
    reason: "result" | "exit" | "interrupt",
  ): void => {
    if (turn !== hot.currentTurn) return;
    context.turns.push({
      id: turn.id,
      items: Array.from(turn.items.values()),
    });
    context.session = {
      ...context.session,
      activeTurnId: undefined,
      updatedAt: nowIso(),
    };
    context.hasPersistedSession = true;
    hot.currentTurn = null;

    // Block indices restart at 0 in the next turn — prevent dedupe carryover.
    resetClaudeStreamTurn(hot.parserState);

    logEvent("claudeLite.turn.complete", {
      threadId: context.session.threadId,
      turnId: turn.id,
      durationMs: Date.now() - turn.startedAt,
      reason,
    });

    turn.resolveSettled();

    if (reason === "result" && hotWindowMs > 0 && !context.stopped) {
      armKillTimer(hot, context);
      logEvent("claudeLite.hot.armed", {
        threadId: context.session.threadId,
        killAtMs: hotWindowMs,
      });
    }
  };

  const armKillTimer = (
    hot: HotProcessState,
    context: ClaudeLiteSessionContext,
  ): void => {
    if (hot.killTimer) clearTimeout(hot.killTimer);
    hot.killTimer = setTimeout(() => {
      logEvent("claudeLite.hot.fired", {
        threadId: context.session.threadId,
        lifetimeMs: Date.now() - hot.spawnedAt,
      });
      killProcessTree(hot.process, "SIGTERM");
    }, hotWindowMs);
  };

  const cancelKillTimer = (hot: HotProcessState): void => {
    if (hot.killTimer) {
      clearTimeout(hot.killTimer);
      hot.killTimer = null;
    }
  };

  const attachHot = (
    proc: NodeChildProcess,
    context: ClaudeLiteSessionContext,
  ): HotProcessState => {
    const parserDeps: ClaudeBlockParserDeps = { genItemId: () => randomUUID() };
    const hot: HotProcessState = {
      process: proc,
      parserState: newClaudeStreamState(),
      stdoutBuffer: "",
      stderrChunks: [],
      currentTurn: null,
      killTimer: null,
      spawnedAt: Date.now(),
      detach: () => {
        proc.stdout?.off("data", onData);
        proc.stderr?.off("data", onStderr);
        proc.off("exit", onExit);
      },
    };

    const dispatchLine = (line: string): void => {
      const turn = hot.currentTurn;
      if (!turn) {
        logEvent("claudeLite.stdout.strayLine", {
          threadId: context.session.threadId,
          linePreview: line.slice(0, 120),
        });
        return;
      }
      const events = parseClaudeStreamLine(hot.parserState, line, parserDeps);
      for (const parsed of events) {
        emitParsedEvent(parsed, context, turn.id, line);
        if (parsed.kind === "turn.completed") {
          onTurnSettled(hot, context, turn, "result");
        }
      }
    };

    const onData = (chunk: Buffer | string): void => {
      hot.stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl = hot.stdoutBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = hot.stdoutBuffer.slice(0, nl);
        hot.stdoutBuffer = hot.stdoutBuffer.slice(nl + 1);
        dispatchLine(line);
        nl = hot.stdoutBuffer.indexOf("\n");
      }
    };

    const onStderr = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      hot.stderrChunks.push(text.slice(0, 256));
      if (hot.stderrChunks.length > 20) hot.stderrChunks.shift();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cancelKillTimer(hot);
      if (hot.stdoutBuffer.trim()) dispatchLine(hot.stdoutBuffer);
      hot.stdoutBuffer = "";

      const turn = hot.currentTurn;
      if (turn) {
        const interrupted = turn.interrupted;
        const reason = interrupted
          ? "Process interrupted by user"
          : signal === "SIGTERM" || signal === "SIGKILL"
            ? `Process killed by ${signal}`
            : code !== null && code !== 0
              ? `Process exited with code ${code}`
              : "Process exited before result block";
        const synthetic = flushClaudeStreamOnAbort(reason);
        if (interrupted) synthetic.state = "interrupted";
        emitParsedEvent(synthetic, context, turn.id, "");
        onTurnSettled(hot, context, turn, interrupted ? "interrupt" : "exit");
      }

      hot.detach();
      if (context.hot === hot) {
        context.hot = null;
      }

      logEvent("claudeLite.process.exit", {
        threadId: context.session.threadId,
        pid: proc.pid ?? null,
        code,
        signal,
        lifetimeMs: Date.now() - hot.spawnedAt,
        stderrTail: hot.stderrChunks.slice(-3).join(""),
      });
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onStderr);
    proc.once("exit", onExit);

    return hot;
  };

  // ── Operations ────────────────────────────────────────────────────

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeLiteSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }),
      );
    }
    return Effect.succeed(context);
  };

  const startSession: ClaudeAdapterShape["startSession"] = (
    input: ProviderSessionStartInput,
  ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      if (!input.cwd) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "ClaudeLite startSession requires a sandbox-scoped cwd.",
        });
      }

      let sandboxId: string;
      try {
        sandboxId = sandboxIdFromCwd(input.cwd);
      } catch (cause) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `ClaudeLite startSession could not extract sandboxId from cwd: ${input.cwd}`,
          cause,
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing) {
        yield* Effect.logWarning("claudeLite.session.replacing", {
          threadId: input.threadId,
          status: existing.session.status,
        });
        yield* stopSessionInternal(existing, { emitExitEvent: false });
      }

      const startedAt = nowIso();
      const resumeState = readClaudeResumeState(input.resumeCursor);
      const sessionId = resumeState?.resume ?? (yield* Random.nextUUIDv4);

      const session: ProviderSession = {
        threadId: input.threadId,
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        ...(input.modelSelection?.provider === "claudeAgent" && input.modelSelection.model
          ? { model: input.modelSelection.model }
          : {}),
        resumeCursor: {
          threadId: input.threadId,
          ...(sessionId ? { resume: sessionId } : {}),
          ...(resumeState?.resumeSessionAt
            ? { resumeSessionAt: resumeState.resumeSessionAt }
            : {}),
          turnCount: resumeState?.turnCount ?? 0,
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: ClaudeLiteSessionContext = {
        session,
        projectId: sandboxId,
        cwd: input.cwd,
        sessionId,
        hot: null,
        turns: [],
        hasPersistedSession: !!resumeState?.resume,
        lastAssistantUuid: resumeState?.resumeSessionAt,
        stopped: false,
      };
      sessions.set(input.threadId, context);

      emit({
        type: "session.started",
        eventId: newEventId(),
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: startedAt,
        payload: {
          ...(resumeState?.resume ? { resume: { sessionId: resumeState.resume } } : {}),
        },
      });

      logEvent("claudeLite.session.start", {
        threadId: input.threadId,
        sessionId,
        projectId: sandboxId,
        cwd: input.cwd,
        hasResume: !!resumeState?.resume,
      });

      return session;
    });

  const spawnHot = Effect.fn("claudeLite.spawnHot")(function* (
    context: ClaudeLiteSessionContext,
    settings: ClaudeAgentSettings,
    built: BuiltClaudeArgs,
  ): Effect.fn.Return<HotProcessState, ProviderAdapterError> {
    const launchEnv = yield* Effect.promise(() =>
      mintLaunchEnv({
        threadId: context.session.threadId,
        projectId: context.projectId,
        settings,
        mode: "lite",
      }),
    );
    if (!launchEnv) {
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: context.session.threadId,
        detail:
          "Could not mint Claude OAT issuance token from sovereign-shield. " +
          "Either shield is unreachable or the credential subsystem is misconfigured.",
      });
    }

    claudeLaunchTrace("bridge", launchEnv.traceId, "spawn-attempt", {
      mode: "lite",
      launcherPath: launchEnv.launcherPath,
      argc: built.argv.length,
      cwd: context.cwd,
      threadId: context.session.threadId,
      projectId: context.projectId,
    });
    const spawnedAt = Date.now();
    let proc: NodeChildProcess;
    try {
      proc = spawnClaudeProcess({
        binaryPath: launchEnv.launcherPath,
        argv: built.argv,
        env: { ...launchEnv.env, ELLUL_NS_CWD: context.cwd },
        cwd: context.cwd,
      });
    } catch (cause) {
      claudeLaunchTrace("bridge", launchEnv.traceId, "spawn-throw", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: context.session.threadId,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    }
    claudeLaunchTrace("bridge", launchEnv.traceId, "spawn-pid", {
      pid: proc.pid ?? null,
    });
    let stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrTail = (stderrTail + text).slice(-2048);
    });
    proc.on("error", (cause) => {
      claudeLaunchTrace("bridge", launchEnv.traceId, "spawn-error-event", {
        error: cause.message,
        durationMs: Date.now() - spawnedAt,
      });
    });
    proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        try {
          require("node:fs").writeFileSync(
            `/var/log/ellul/claude-spawn-${launchEnv.traceId}.log`,
            `exit=${code} signal=${signal ?? "null"}\n--- STDERR TAIL (${stderrTail.length} bytes captured) ---\n${stderrTail}\n`,
            { mode: 0o644 },
          );
        } catch {
          // Best-effort.
        }
      }
      claudeLaunchTrace("bridge", launchEnv.traceId, "spawn-exit", {
        exitCode: code ?? null,
        signal: signal ?? null,
        durationMs: Date.now() - spawnedAt,
        stderrLen: stderrTail.length,
        dumpPath:
          code !== 0 && code !== null
            ? `/var/log/ellul/claude-spawn-${launchEnv.traceId}.log`
            : null,
      });
    });

    logEvent("claudeLite.spawn.cold", {
      threadId: context.session.threadId,
      sessionId: context.sessionId,
      pid: proc.pid ?? null,
      binaryPath: launchEnv.launcherPath,
      oatStateAtIssuance: launchEnv.oatStateAtIssuance,
      traceId: launchEnv.traceId,
    });

    return attachHot(proc, context);
  });

  const sendTurn: ClaudeAdapterShape["sendTurn"] = (
    input: ProviderSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (context.hot?.currentTurn) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail: `Turn already in progress for thread ${input.threadId}.`,
        });
      }

      const claudeSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.mapError(
          (e) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: e.message,
              cause: e,
            }),
        ),
        Effect.map((s) => s.providers.claudeAgent),
      );
      const effectiveSettings: ClaudeAgentSettings = options?.binaryPathOverride
        ? { ...claudeSettings, launcherPath: options.binaryPathOverride }
        : claudeSettings;
      const modelSelection =
        input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
      const mode = input.interactionMode === "plan" ? "plan" : "default" as const;
      const built = buildClaudeArgs({
        sessionId: context.sessionId,
        cwd: context.cwd,
        modelSelection,
        injectedPrimer: buildSystemInstructions(mode),
        continueFlag: context.hasPersistedSession,
        settings: claudeSettings,
      });

      let hot: HotProcessState;
      const isHotReuse =
        context.hot !== null &&
        !context.hot.process.killed &&
        context.hot.process.exitCode === null;
      if (isHotReuse && context.hot) {
        cancelKillTimer(context.hot);
        hot = context.hot;
        logEvent("claudeLite.spawn.hot.reuse", {
          threadId: input.threadId,
          hotAgeMs: Date.now() - hot.spawnedAt,
        });
      } else {
        hot = yield* spawnHot(context, effectiveSettings, built);
        context.hot = hot;
      }

      const turnId = TurnId.make(yield* Random.nextUUIDv4);
      const turnStartedAt = nowIso();
      const turnStartedAtMs = Date.now();

      let resolveSettled: () => void = () => {};
      const settled = new Promise<void>((res) => {
        resolveSettled = res;
      });
      const turn: ActiveTurn = {
        id: turnId,
        items: new Map(),
        interrupted: false,
        startedAt: turnStartedAtMs,
        settled,
        resolveSettled,
      };
      hot.currentTurn = turn;
      context.session = {
        ...context.session,
        activeTurnId: turnId,
        updatedAt: turnStartedAt,
      };

      emit({
        type: "turn.started",
        eventId: newEventId(),
        provider: PROVIDER,
        createdAt: turnStartedAt,
        threadId: input.threadId,
        turnId,
        payload: {
          ...(built.apiModelId ? { model: built.apiModelId } : {}),
        },
      });

      logEvent("claudeLite.turn.start", {
        threadId: input.threadId,
        turnId,
        isHotReuse,
      });

      const userText = applyEffortPrefix(input.input ?? "", modelSelection);
      const stdinLine = formatStreamJsonUserMessage({ text: userText });
      try {
        if (!hot.process.stdin?.writable) {
          throw new Error("hot process stdin is not writable");
        }
        hot.process.stdin.write(stdinLine + "\n");
      } catch (cause) {
        logEvent("claudeLite.stdin.writeError", {
          threadId: input.threadId,
          turnId,
          ...serializeError(cause),
        });
        hot.currentTurn = null;
        killProcessTree(hot.process, "SIGTERM");
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      }

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: context.session.resumeCursor,
      };
    });

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (
    threadId: ThreadId,
    _turnId?: TurnId,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      const turn = context?.hot?.currentTurn;
      if (!context || !context.hot || !turn) return;
      const proc = context.hot.process;
      turn.interrupted = true;
      killProcessTree(proc, "SIGTERM");
      // Escalate if SIGTERM didn't bring the process down within grace.
      setTimeout(() => {
        if (!proc.killed && proc.exitCode === null) killProcessTree(proc, "SIGKILL");
      }, SIGTERM_GRACE_MS);
      logEvent("claudeLite.turn.interrupt", {
        threadId,
        turnId: turn.id,
      });
    });

  const stopSessionInternal = (
    context: ClaudeLiteSessionContext,
    opts?: { readonly emitExitEvent?: boolean },
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;

      const hot = context.hot;
      if (hot) {
        cancelKillTimer(hot);
        const turn = hot.currentTurn;
        const settledPromise = turn?.settled;
        killProcessTree(hot.process, "SIGTERM");

        const escalation = setTimeout(() => {
          killProcessTree(hot.process, "SIGKILL");
        }, SIGTERM_GRACE_MS);
        try {
          yield* Effect.promise(() =>
            Promise.race([
              settledPromise ?? Promise.resolve(),
              new Promise<void>((res) => setTimeout(res, SIGTERM_GRACE_MS * 2)),
            ]),
          );
        } finally {
          clearTimeout(escalation);
        }
        context.hot = null;
      }

      context.session = {
        ...context.session,
        status: "closed",
        updatedAt: nowIso(),
      };

      if (opts?.emitExitEvent !== false) {
        emit({
          type: "session.exited",
          eventId: newEventId(),
          provider: PROVIDER,
          createdAt: nowIso(),
          threadId: context.session.threadId,
          payload: { reason: "Session stopped", exitKind: "graceful" },
        });
      }
      sessions.delete(context.session.threadId);

      logEvent("claudeLite.session.stop", {
        threadId: context.session.threadId,
        reason: opts?.emitExitEvent === false ? "replace" : "explicit",
      });
    });

  const stopSession: ClaudeAdapterShape["stopSession"] = (
    threadId: ThreadId,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) return;
      yield* stopSessionInternal(context).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("claudeLite.stopSession.cleanup-failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    });

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
    threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail: `Approval flow is not supported in Lite tier (thread ${threadId}).`,
      }),
    );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
    threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: `User-input flow is not supported in Lite tier (thread ${threadId}).`,
      }),
    );

  const listSessions: ClaudeAdapterShape["listSessions"] = (): Effect.Effect<
    ReadonlyArray<ProviderSession>
  > => Effect.sync(() => Array.from(sessions.values()).map((c) => c.session));

  const hasSession: ClaudeAdapterShape["hasSession"] = (
    threadId: ThreadId,
  ): Effect.Effect<boolean> => Effect.sync(() => sessions.has(threadId));

  const readThread: ClaudeAdapterShape["readThread"] = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      return {
        threadId: context.session.threadId,
        turns: context.turns.map((t) => ({ id: t.id, items: [...t.items] })),
      };
    });

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (
    threadId: ThreadId,
    numTurns: number,
  ) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      if (numTurns < 0 || !Number.isInteger(numTurns)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: `numTurns must be a non-negative integer, got ${numTurns}.`,
        });
      }
      // In-memory only; on-disk JSONL is reconciled by `--continue` next turn.
      const remaining = Math.max(0, context.turns.length - numTurns);
      context.turns.length = remaining;
      context.session = {
        ...context.session,
        updatedAt: nowIso(),
      };
      return {
        threadId: context.session.threadId,
        turns: context.turns.map((t) => ({ id: t.id, items: [...t.items] })),
      };
    });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      const list = Array.from(sessions.values());
      for (const ctx of list) {
        yield* stopSessionInternal(ctx).pipe(
          Effect.catchCause(() => Effect.void),
        );
      }
      yield* Queue.shutdown(runtimeEventQueue);
    });

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ClaudeAdapterShape;
});

export const ClaudeLiteAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeLiteAdapter());

export function makeClaudeLiteAdapterLive(options?: ClaudeLiteAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeLiteAdapter(options));
}
