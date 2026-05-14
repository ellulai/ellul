// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { IncomingMessage, Server as HttpServer } from "http";
import type { Socket } from "net";

import { Cause, Effect, Exit, Fiber, ManagedRuntime, Schema, Stream } from "effect";
import * as WsLib from "ws";

import {
  RpcRequest,
  errorShapeFromDefect,
  rpcFailure,
  rpcStreamComplete,
  rpcStreamError,
  rpcStreamNext,
  rpcSuccess,
  type RpcEnvelopeId,
  type RpcErrorShape,
  type RpcServerFrame,
} from "./envelope";
import { gatePopChallenge, gateWsUpgrade } from "./auth-middleware";
import { ORCHESTRATION_RPC_ROUTER, type RouterEntry } from "./router";
import {
  registerSessionConnection,
  unregisterSessionConnection,
} from "../internal-http/session-registry";

const LOG_PREFIX = "[ws-rpc]";
const POP_CHALLENGE_INTERVAL_MS = 5 * 60 * 1000;
const POP_MAX_HOSTILE_FAILURES = 3;

export interface WsRpcServerDeps<R = never, E = never> {
  readonly httpServer: HttpServer;
  readonly runtime: ManagedRuntime.ManagedRuntime<R, E>;
  readonly path?: string;
}

export function startWsRpcServer<R, E>(
  deps: WsRpcServerDeps<R, E>,
): () => Promise<void> {
  const path = deps.path ?? "/ws";
  const wss = new WsLib.WebSocketServer({ noServer: true });

  const upgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) return;

    void (async () => {
      const gate = await gateWsUpgrade(req);
      if (!gate.ok) {
        socket.write(`HTTP/1.1 ${gate.code} ${gate.reason}\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachConnection(ws, gate.sessionId, deps.runtime);
      });
    })();
  };

  deps.httpServer.on("upgrade", upgradeHandler);

  return async () => {
    deps.httpServer.off("upgrade", upgradeHandler);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };
}

function attachConnection<R, E>(
  ws: WsLib.WebSocket,
  sessionId: string,
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
): void {
  const activeStreams = new Map<string, Fiber.Fiber<unknown, unknown>>();
  let hostileFailures = 0;
  let popChallengeTimer: ReturnType<typeof setInterval> | null = null;
  let pendingChallenge: { nonce: string; sentAt: number } | null = null;

  registerSessionConnection(sessionId, ws);

  const sendFrame = (frame: RpcServerFrame) => {
    if (ws.readyState !== WsLib.WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      console.warn(LOG_PREFIX, "send failed:", (err as Error).message);
    }
  };

  const stopStream = (id: string) => {
    const fiber = activeStreams.get(id);
    if (!fiber) return;
    activeStreams.delete(id);
    runtime.runFork(Fiber.interrupt(fiber));
  };

  const scheduleChallenge = () => {
    const nonce = crypto.randomUUID();
    pendingChallenge = { nonce, sentAt: Date.now() };
    try {
      ws.send(JSON.stringify({ type: "pop_challenge", nonce }));
    } catch {}
  };

  popChallengeTimer = setInterval(scheduleChallenge, POP_CHALLENGE_INTERVAL_MS);
  if (popChallengeTimer.unref) popChallengeTimer.unref();

  ws.on("message", (raw) => {
    const text = raw.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (isPopResponse(parsed)) {
      void handlePopResponse(parsed);
      return;
    }
    void dispatchEnvelope(parsed);
  });

  ws.on("close", () => {
    if (popChallengeTimer) clearInterval(popChallengeTimer);
    for (const [, fiber] of activeStreams) {
      runtime.runFork(Fiber.interrupt(fiber));
    }
    activeStreams.clear();
    unregisterSessionConnection(sessionId, ws);
  });

  ws.on("error", (err) => {
    console.warn(LOG_PREFIX, "connection error:", err.message);
  });

  async function handlePopResponse(msg: {
    readonly nonce: string;
    readonly signature: string;
  }) {
    if (!pendingChallenge || pendingChallenge.nonce !== msg.nonce) return;
    const verdict = await gatePopChallenge(sessionId, msg.nonce, msg.signature);
    pendingChallenge = null;
    if (verdict.valid) {
      hostileFailures = 0;
      return;
    }
    if (!verdict.hostile) return;
    hostileFailures += 1;
    if (hostileFailures >= POP_MAX_HOSTILE_FAILURES) {
      ws.close(4003, "PoP challenge failed");
    }
  }

  async function dispatchEnvelope(raw: unknown) {
    if (isCancelEnvelope(raw)) {
      stopStream(raw.id);
      return;
    }
    const decoded = Schema.decodeUnknownSync(RpcRequest)(raw as RpcRequest);
    const id = decoded.id;
    const entry: RouterEntry | undefined = ORCHESTRATION_RPC_ROUTER[decoded.method];
    if (!entry) {
      sendFrame(
        rpcFailure(
          id,
          errorShapeFromDefect("method_not_found", `${decoded.method} is not implemented`),
        ),
      );
      return;
    }
    if (entry.kind === "unary") {
      await runUnary(id, entry.handler as (payload: unknown) => Effect.Effect<unknown, unknown>);
    } else {
      await runStream(
        id,
        entry.handler as (
          payload: unknown,
        ) => Effect.Effect<Stream.Stream<unknown, unknown>, unknown>,
        decoded.payload,
      );
    }

    async function runUnary(
      envelopeId: RpcEnvelopeId,
      handler: (payload: unknown) => Effect.Effect<unknown, unknown>,
    ) {
      const exit = await runtime.runPromiseExit(
        handler(decoded.payload) as Effect.Effect<unknown, unknown, never>,
      );
      if (Exit.isSuccess(exit)) {
        sendFrame(rpcSuccess(envelopeId, exit.value));
      } else {
        sendFrame(rpcFailure(envelopeId, toRpcError(exit.cause)));
      }
    }

    async function runStream(
      envelopeId: RpcEnvelopeId,
      handler: (payload: unknown) => Effect.Effect<Stream.Stream<unknown, unknown>, unknown>,
      payload: unknown,
    ) {
      const initialExit = await runtime.runPromiseExit(
        handler(payload) as Effect.Effect<Stream.Stream<unknown, unknown>, unknown, never>,
      );
      if (Exit.isFailure(initialExit)) {
        sendFrame(rpcStreamError(envelopeId, toRpcError(initialExit.cause)));
        return;
      }
      const stream = initialExit.value;
      const fiber = runtime.runFork(
        Stream.runForEach(stream, (item) =>
          Effect.sync(() => sendFrame(rpcStreamNext(envelopeId, item))),
        ).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Effect.sync(() => {
                activeStreams.delete(envelopeId);
                if (Cause.hasInterruptsOnly(cause)) return;
                sendFrame(rpcStreamError(envelopeId, toRpcError(cause)));
              }),
            onSuccess: () =>
              Effect.sync(() => {
                activeStreams.delete(envelopeId);
                sendFrame(rpcStreamComplete(envelopeId));
              }),
          }),
        ),
      );
      activeStreams.set(envelopeId, fiber);
    }
  }
}

function isCancelEnvelope(raw: unknown): raw is { readonly id: RpcEnvelopeId; readonly method: "_cancel" } {
  if (!raw || typeof raw !== "object") return false;
  const rec = raw as Record<string, unknown>;
  return typeof rec.id === "string" && rec.method === "_cancel";
}

function isPopResponse(raw: unknown): raw is { readonly nonce: string; readonly signature: string } {
  if (!raw || typeof raw !== "object") return false;
  const rec = raw as Record<string, unknown>;
  return rec.type === "pop_response" && typeof rec.nonce === "string" && typeof rec.signature === "string";
}

function toRpcError(cause: Cause.Cause<unknown>): RpcErrorShape {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error) {
    const tag = (squashed as { readonly _tag?: string })._tag ?? squashed.name;
    return errorShapeFromDefect(tag, squashed.message, Cause.pretty(cause));
  }
  return errorShapeFromDefect(
    "UnknownError",
    typeof squashed === "string" ? squashed : "unknown error",
    Cause.pretty(cause),
  );
}
