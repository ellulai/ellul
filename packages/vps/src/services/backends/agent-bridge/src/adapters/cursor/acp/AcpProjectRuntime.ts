// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Multi-session ACP runtime for one cursor-agent subprocess.
//
// Owns ONE cursor-agent process per project namespace. ACP's session/new
// is in the baseline MUST set, so cursor-agent natively supports
// multiple sessions on one stdio transport — this runtime exposes that
// as `newSession({...})` returning a per-session `AcpSessionHandle`.
//
// All multi-session dispatch lives in `AcpMultiSessionDispatch.ts` —
// extracting it keeps the security-critical routing logic (per-session
// queue, per-session permission handler, toolCallId → sessionId) pure
// and unit-testable. This file just wires the dispatch functions into
// the AcpClient's protocol callbacks and owns the spawn lifecycle.
//
// Single-session legacy use cases (the host probe in
// cursor/provider.ts) continue to use the existing AcpSessionRuntime —
// that stays untouched. AcpProjectRuntime exists specifically for the
// per-project pool.

import {
  Effect,
  Exit,
  Queue,
  Ref,
  Scope,
  Semaphore,
  Stream,
  Context,
  Layer,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpClient from "../../vendor/t3code/effect-acp/client";
import * as EffectAcpErrors from "../../vendor/t3code/effect-acp/errors";
import type * as EffectAcpSchema from "../../vendor/t3code/effect-acp/schema";
import type * as EffectAcpProtocol from "../../vendor/t3code/effect-acp/protocol";

import {
  decodeExtNotificationRegistration,
  decodeExtRequestRegistration,
} from "../../vendor/t3code/effect-acp/_internal/shared";
import {
  collectSessionConfigOptionValues,
  findSessionConfigOption,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
} from "./AcpRuntimeModel";
import type {
  AcpSessionRequestLogEvent,
  AcpSpawnInput,
} from "./AcpSessionRuntime";
import {
  closeActiveAssistantSegment,
  closeSessionInState,
  configOptionCurrentValueMatches,
  dispatchRequestPermission,
  dispatchSessionUpdate,
  dispatchUnknownExtNotification,
  dispatchUnknownExtRequest,
  makeSessionStateSync,
  sessionConfigOptionsFromSetup,
  sessionEventStream,
  type SessionState,
} from "./AcpMultiSessionDispatch";

export type { AcpSessionRequestLogEvent } from "./AcpSessionRuntime";

export interface AcpProjectRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId: string;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
}

export interface AcpNewSessionInput {
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
}

export interface AcpSessionHandle {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
  // Per-session handler registration. Same JSONRPC surface as AcpClient,
  // but scoped to this session — the runtime dispatches by sessionId
  // (request_permission) or toolCallId (cursor/* ext methods).
  readonly handleRequestPermission: EffectAcpClient.AcpClientShape["handleRequestPermission"];
  readonly handleExtRequest: EffectAcpClient.AcpClientShape["handleExtRequest"];
  readonly handleExtNotification: EffectAcpClient.AcpClientShape["handleExtNotification"];
  readonly getEvents: () => Stream.Stream<AcpParsedSessionEvent, never>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly close: Effect.Effect<void, never>;
}

export interface AcpProjectRuntimeShape {
  readonly initialize: Effect.Effect<EffectAcpSchema.InitializeResponse, EffectAcpErrors.AcpError>;
  readonly newSession: (
    input: AcpNewSessionInput,
  ) => Effect.Effect<AcpSessionHandle, EffectAcpErrors.AcpError>;
  readonly closeSession: (sessionId: string) => Effect.Effect<void, never>;
  readonly listSessions: Effect.Effect<ReadonlyArray<string>, never>;
  readonly exitCode: Effect.Effect<number, never>;
  readonly pid: number | null;
}

export class AcpProjectRuntime extends Context.Service<
  AcpProjectRuntime,
  AcpProjectRuntimeShape
>()("ellul/adapters/cursor/AcpProjectRuntime") {
  static layer(
    options: AcpProjectRuntimeOptions,
  ): Layer.Layer<
    AcpProjectRuntime,
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    return Layer.effect(AcpProjectRuntime, makeAcpProjectRuntime(options));
  }
}

const makeAcpProjectRuntime = (
  options: AcpProjectRuntimeOptions,
): Effect.Effect<
  AcpProjectRuntimeShape,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;

    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    const initSemaphore = yield* Semaphore.make(1);
    let initializeResult: EffectAcpSchema.InitializeResponse | undefined;

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.tap((result) =>
              logRequest({ method, payload, status: "succeeded", result }),
            ),
            Effect.onError((cause) =>
              logRequest({ method, payload, status: "failed", cause }),
            ),
          ),
        ),
      );

    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.spawn.command, [...options.spawn.args], {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: { ...process.env, ...options.spawn.env } } : {}),
          shell: process.platform === "win32",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        ...(options.protocolLogging?.logIncoming !== undefined
          ? { logIncoming: options.protocolLogging.logIncoming }
          : {}),
        ...(options.protocolLogging?.logOutgoing !== undefined
          ? { logOutgoing: options.protocolLogging.logOutgoing }
          : {}),
        ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

    // ===== Wire global dispatchers =====
    // Each ACP method gets ONE registration on the AcpClient. The
    // registered handler delegates to the dispatch fn in
    // AcpMultiSessionDispatch.ts, which routes to the right session.
    yield* acp.handleSessionUpdate((notification) =>
      dispatchSessionUpdate({ sessions, toolCallIdToSession, notification }),
    );
    yield* acp.handleRequestPermission((params) =>
      dispatchRequestPermission({ sessions, params }),
    );
    yield* acp.handleUnknownExtRequest((method, params) =>
      dispatchUnknownExtRequest({ sessions, toolCallIdToSession, method, params }),
    );
    yield* acp.handleUnknownExtNotification((method, params) =>
      dispatchUnknownExtNotification({ sessions, toolCallIdToSession, method, params }),
    );

    // ===== Per-session helpers =====

    const validateConfigOptionValue = (
      state: SessionState,
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(
          yield* Ref.get(state.configOptionsRef),
          configId,
        );
        if (!configOption) return;
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") return;
          return yield* Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected boolean`,
              data: {
                configId: configOption.id,
                expectedType: "boolean",
                receivedValue: value,
              },
            }),
          );
        }
        if (typeof value !== "string") {
          return yield* Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected string`,
              data: {
                configId: configOption.id,
                expectedType: "string",
                receivedValue: value,
              },
            }),
          );
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) return;
        return yield* Effect.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
            data: {
              configId: configOption.id,
              allowedValues,
              receivedValue: value,
            },
          }),
        );
      });

    const setConfigOptionForSession = (
      state: SessionState,
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(state, configId, value).pipe(
        Effect.flatMap(() =>
          Ref.get(state.configOptionsRef).pipe(
            Effect.flatMap((configOptions) => {
              const existing = findSessionConfigOption(configOptions, configId);
              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions,
                } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
              }
              const requestPayload =
                typeof value === "boolean"
                  ? ({
                      sessionId: state.sessionId,
                      configId,
                      type: "boolean",
                      value,
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                  : ({
                      sessionId: state.sessionId,
                      configId,
                      value: String(value),
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
              return runLoggedRequest(
                "session/set_config_option",
                requestPayload,
                acp.agent.setSessionConfigOption(requestPayload),
              ).pipe(
                Effect.tap((response) =>
                  Ref.set(state.configOptionsRef, sessionConfigOptionsFromSetup(response)),
                ),
              );
            }),
          ),
        ),
      );

    const promptForSession = (
      state: SessionState,
      payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
    ): Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> => {
      const requestPayload = {
        sessionId: state.sessionId,
        ...payload,
      } satisfies EffectAcpSchema.PromptRequest;
      return closeActiveAssistantSegment({
        queue: state.eventQueue,
        assistantSegmentRef: state.assistantSegmentRef,
      }).pipe(
        Effect.andThen(
          runLoggedRequest("session/prompt", requestPayload, acp.agent.prompt(requestPayload)),
        ),
        Effect.tap(() =>
          closeActiveAssistantSegment({
            queue: state.eventQueue,
            assistantSegmentRef: state.assistantSegmentRef,
          }),
        ),
      );
    };

    const cancelForSession = (
      state: SessionState,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      acp.agent.cancel({ sessionId: state.sessionId });

    const setModeForSession = (
      state: SessionState,
      modeId: string,
    ): Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError> =>
      Ref.get(state.modeStateRef).pipe(
        Effect.flatMap((modeState) => {
          if (modeState?.currentModeId === modeId) {
            return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
          }
          return setConfigOptionForSession(state, "mode", modeId).pipe(
            Effect.tap(() =>
              Ref.update(state.modeStateRef, (current) =>
                current ? { ...current, currentModeId: modeId } : current,
              ),
            ),
            Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
          );
        }),
      );

    // ===== Initialization =====

    const initializeOnce = initSemaphore.withPermit(
      Effect.gen(function* () {
        if (initializeResult) return initializeResult;

        const initializeClientCapabilities: NonNullable<
          EffectAcpSchema.InitializeRequest["clientCapabilities"]
        > = {
          fs: {
            readTextFile: false,
            writeTextFile: false,
            ...options.clientCapabilities?.fs,
          },
          terminal: options.clientCapabilities?.terminal ?? false,
          ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
          ...(options.clientCapabilities?.elicitation
            ? { elicitation: options.clientCapabilities.elicitation }
            : {}),
          ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
        };

        const initPayload = {
          protocolVersion: 1,
          clientCapabilities: initializeClientCapabilities,
          clientInfo: options.clientInfo,
        } satisfies EffectAcpSchema.InitializeRequest;

        const result = yield* runLoggedRequest(
          "initialize",
          initPayload,
          acp.agent.initialize(initPayload),
        );

        const authPayload = {
          methodId: options.authMethodId,
        } satisfies EffectAcpSchema.AuthenticateRequest;
        yield* runLoggedRequest(
          "authenticate",
          authPayload,
          acp.agent.authenticate(authPayload),
        );

        initializeResult = result;
        return result;
      }),
    );

    // ===== newSession =====

    const closeSessionInternal = (sessionId: string): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        // Close per-session state in the dispatch maps first (drops
        // events, closes the queue, clears toolCallId routes).
        yield* closeSessionInState({ sessions, toolCallIdToSession, sessionId });
        // Best-effort session/close on the agent. Ignore errors — the
        // agent may already be gone, or the protocol may not support
        // session/close for this version.
        yield* runLoggedRequest(
          "session/close",
          { sessionId },
          acp.agent.closeSession({ sessionId }),
        ).pipe(Effect.ignore);
      });

    const newSession: AcpProjectRuntimeShape["newSession"] = (input) =>
      Effect.gen(function* () {
        const initResult = yield* initializeOnce;

        let sessionId: string;
        let sessionSetupResult:
          | EffectAcpSchema.LoadSessionResponse
          | EffectAcpSchema.NewSessionResponse
          | EffectAcpSchema.ResumeSessionResponse;

        const mcpServers = input.mcpServers ?? [];

        if (input.resumeSessionId) {
          const loadPayload = {
            sessionId: input.resumeSessionId,
            cwd: input.cwd,
            mcpServers,
          } satisfies EffectAcpSchema.LoadSessionRequest;
          const loadResult = yield* runLoggedRequest(
            "session/load",
            loadPayload,
            acp.agent.loadSession(loadPayload),
          ).pipe(Effect.exit);
          if (Exit.isSuccess(loadResult)) {
            sessionId = input.resumeSessionId;
            sessionSetupResult = loadResult.value;
          } else {
            const createPayload = {
              cwd: input.cwd,
              mcpServers,
            } satisfies EffectAcpSchema.NewSessionRequest;
            const created = yield* runLoggedRequest(
              "session/new",
              createPayload,
              acp.agent.createSession(createPayload),
            );
            sessionId = created.sessionId;
            sessionSetupResult = created;
          }
        } else {
          const createPayload = {
            cwd: input.cwd,
            mcpServers,
          } satisfies EffectAcpSchema.NewSessionRequest;
          const created = yield* runLoggedRequest(
            "session/new",
            createPayload,
            acp.agent.createSession(createPayload),
          );
          sessionId = created.sessionId;
          sessionSetupResult = created;
        }

        // Race-free state allocation: synchronous between the agent's
        // session/new response and registration in the sessions map.
        // Uses Effect.runSync internally so the Ref/Queue allocation
        // doesn't yield. JS single-threaded execution guarantees no
        // other fiber (including the AcpClient session-update handler)
        // can interleave between createSession resolving and the
        // sessions.set below.
        const state = makeSessionStateSync({
          sessionId,
          initializeResult: initResult,
          sessionSetupResult,
        });
        sessions.set(sessionId, state);

        const handleRequestPermission: EffectAcpClient.AcpClientShape["handleRequestPermission"] = (
          handler,
        ) =>
          Effect.sync(() => {
            state.permissionHandler = handler;
          });
        const handleExtRequest: EffectAcpClient.AcpClientShape["handleExtRequest"] = (
          method,
          payload,
          handler,
        ) =>
          Effect.sync(() => {
            state.extRequestHandlers.set(
              method,
              decodeExtRequestRegistration(method, payload, handler),
            );
          });
        const handleExtNotification: EffectAcpClient.AcpClientShape["handleExtNotification"] = (
          method,
          payload,
          handler,
        ) =>
          Effect.sync(() => {
            state.extNotificationHandlers.set(
              method,
              decodeExtNotificationRegistration(method, payload, handler),
            );
          });

        const handle: AcpSessionHandle = {
          sessionId,
          initializeResult: initResult,
          sessionSetupResult,
          modelConfigId: state.modelConfigId,
          handleRequestPermission,
          handleExtRequest,
          handleExtNotification,
          getEvents: () => sessionEventStream(state),
          getModeState: Ref.get(state.modeStateRef),
          getConfigOptions: Ref.get(state.configOptionsRef),
          prompt: (payload) => promptForSession(state, payload),
          cancel: cancelForSession(state),
          setMode: (modeId) => setModeForSession(state, modeId),
          setConfigOption: (configId, value) => setConfigOptionForSession(state, configId, value),
          setModel: (model) =>
            setConfigOptionForSession(state, state.modelConfigId ?? "model", model).pipe(
              Effect.asVoid,
            ),
          close: closeSessionInternal(sessionId),
        };
        return handle;
      });

    // Layer finalizer: shut down all per-session queues so subscribers
    // see an exit when the runtime tears down (pool eviction, bridge
    // shutdown).
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const live = [...sessions.values()];
        sessions.clear();
        toolCallIdToSession.clear();
        yield* Effect.forEach(
          live,
          (sess) =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(sess.closed, true)) return;
              yield* Queue.shutdown(sess.eventQueue);
            }),
          { concurrency: "unbounded", discard: true },
        );
      }),
    );

    return {
      initialize: initializeOnce,
      newSession,
      closeSession: closeSessionInternal,
      listSessions: Effect.sync(() => [...sessions.keys()]),
      exitCode: child.exitCode.pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => 0),
      ),
      pid: typeof child.pid === "number" ? child.pid : null,
    } satisfies AcpProjectRuntimeShape;
  });
