// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type {
  ClientOrchestrationCommand,
  DispatchResult,
  EllulGetProvidersResult,
  EllulGetZenModelsResult,
  EllulProvidersStreamItem,
  EllulRefreshProviderInput,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationReplayEventsInput,
  OrchestrationReplayEventsResult,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "@ellul.ai/types";

declare const SESSION_POP:
  | { createSignedWebSocket: (url: string, protocols?: string | string[]) => WebSocket }
  | undefined;

export type WsRpcConnectionState = "connecting" | "open" | "closed";

export interface WsRpcError extends Error {
  readonly tag: string;
  readonly cause?: unknown;
}

export interface BridgeBroadcastEvent {
  readonly event: string;
  readonly [k: string]: unknown;
}

export interface WsRpcClient {
  readonly state: () => WsRpcConnectionState;
  readonly connected: Promise<void>;
  readonly onStateChange: (handler: (state: WsRpcConnectionState) => void) => () => void;
  readonly onBroadcast: (handler: (event: BridgeBroadcastEvent) => void) => () => void;
  dispatchCommand(input: ClientOrchestrationCommand): Promise<DispatchResult>;
  getTurnDiff(input: OrchestrationGetTurnDiffInput): Promise<OrchestrationGetTurnDiffResult>;
  getFullThreadDiff(
    input: OrchestrationGetFullThreadDiffInput,
  ): Promise<OrchestrationGetFullThreadDiffResult>;
  replayEvents(input: OrchestrationReplayEventsInput): Promise<OrchestrationReplayEventsResult>;
  subscribeThread(
    input: OrchestrationSubscribeThreadInput,
  ): AsyncIterable<OrchestrationThreadStreamItem>;
  subscribeShell(): AsyncIterable<OrchestrationShellStreamItem>;
  getZenModels(): Promise<EllulGetZenModelsResult>;
  getProviders(): Promise<EllulGetProvidersResult>;
  refreshProvider(input: EllulRefreshProviderInput): Promise<EllulGetProvidersResult>;
  subscribeProviders(): AsyncIterable<EllulProvidersStreamItem>;
  close(reason?: string): void;
}

export interface WsRpcClientOptions {
  readonly url: string;
}

const METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  getZenModels: "ellul.getZenModels",
  getProviders: "ellul.getProviders",
  refreshProvider: "ellul.refreshProvider",
  subscribeProviders: "ellul.subscribeProviders",
} as const;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: WsRpcError) => void;
}

interface StreamSink {
  next(item: unknown): void;
  complete(): void;
  error(err: WsRpcError): void;
  readonly cancel: () => void;
}

function makeError(tag: string, message: string, cause?: unknown): WsRpcError {
  const err = new Error(message) as WsRpcError & { tag: string; cause?: unknown };
  err.tag = tag;
  if (cause !== undefined) err.cause = cause;
  return err;
}

export function createWsRpcClient(options: WsRpcClientOptions): WsRpcClient {
  const ws: WebSocket =
    typeof SESSION_POP !== "undefined" && SESSION_POP?.createSignedWebSocket
      ? SESSION_POP.createSignedWebSocket(options.url)
      : new WebSocket(options.url);

  let state: WsRpcConnectionState = "connecting";
  const stateHandlers = new Set<(state: WsRpcConnectionState) => void>();
  const broadcastHandlers = new Set<(event: BridgeBroadcastEvent) => void>();
  const pending = new Map<string, PendingRequest>();
  const streams = new Map<string, StreamSink>();
  let envelopeCounter = 0;

  let resolveConnected!: () => void;
  let rejectConnected!: (err: WsRpcError) => void;
  const connected = new Promise<void>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });

  const setState = (next: WsRpcConnectionState) => {
    if (state === next) return;
    state = next;
    for (const handler of stateHandlers) handler(next);
  };

  const send = (payload: unknown): void => {
    ws.send(JSON.stringify(payload));
  };

  const nextEnvelopeId = (): string => {
    envelopeCounter += 1;
    return `c${envelopeCounter}`;
  };

  const callUnary = <T>(method: string, payload: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextEnvelopeId();
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        send({ id, method, payload });
      } catch (err) {
        pending.delete(id);
        reject(makeError("SendFailed", (err as Error).message, err));
      }
    });

  const callStream = <T>(method: string, payload: unknown): AsyncIterable<T> => {
    const id = nextEnvelopeId();
    const queue: T[] = [];
    const waiters: Array<{
      resolve: (result: IteratorResult<T>) => void;
      reject: (err: WsRpcError) => void;
    }> = [];
    let closed = false;
    let settledError: WsRpcError | null = null;

    const emit = (value: T) => {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else queue.push(value);
    };

    const finish = (err: WsRpcError | null) => {
      if (closed) return;
      closed = true;
      settledError = err;
      streams.delete(id);
      for (const waiter of waiters.splice(0)) {
        if (err) waiter.reject(err);
        else waiter.resolve({ value: undefined, done: true });
      }
    };

    const cancel = () => {
      if (closed) return;
      finish(null);
      if (ws.readyState === WebSocket.OPEN) {
        try {
          send({ id, method: "_cancel" });
        } catch {}
      }
    };

    const sink: StreamSink = {
      next: (item) => emit(item as T),
      complete: () => finish(null),
      error: (err) => finish(err),
      cancel,
    };
    streams.set(id, sink);

    try {
      send({ id, method, payload });
    } catch (err) {
      finish(makeError("SendFailed", (err as Error).message, err));
    }

    const iterator: AsyncIterator<T> = {
      next: () =>
        new Promise<IteratorResult<T>>((resolve, reject) => {
          if (queue.length > 0) {
            resolve({ value: queue.shift() as T, done: false });
            return;
          }
          if (closed) {
            if (settledError) reject(settledError);
            else resolve({ value: undefined, done: true });
            return;
          }
          waiters.push({ resolve, reject });
        }),
      return: () => {
        cancel();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (err) => {
        cancel();
        return Promise.reject(err);
      },
    };

    return { [Symbol.asyncIterator]: () => iterator };
  };

  ws.addEventListener("open", () => {
    setState("open");
    resolveConnected();
  });

  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : String(event.data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const frame = parsed as Record<string, unknown>;
    if (frame.type === "pop_challenge") return;
    if (typeof frame.event === "string" && typeof frame.id !== "string") {
      for (const h of broadcastHandlers) {
        try { h(frame as BridgeBroadcastEvent); } catch { /* listener errors not fatal */ }
      }
      return;
    }
    if (typeof frame.id !== "string") return;
    const id = frame.id;
    if (frame.ok === true) {
      const req = pending.get(id);
      if (!req) return;
      pending.delete(id);
      req.resolve(frame.result);
      return;
    }
    if (frame.ok === false) {
      const req = pending.get(id);
      if (!req) return;
      pending.delete(id);
      const errFrame = frame.error as
        | { tag?: unknown; message?: unknown; cause?: unknown }
        | undefined;
      req.reject(
        makeError(
          typeof errFrame?.tag === "string" ? errFrame.tag : "UnknownError",
          typeof errFrame?.message === "string" ? errFrame.message : "unknown error",
          errFrame?.cause,
        ),
      );
      return;
    }
    if (frame.stream === "next") {
      streams.get(id)?.next(frame.item);
      return;
    }
    if (frame.stream === "complete") {
      streams.get(id)?.complete();
      return;
    }
    if (frame.stream === "error") {
      const errFrame = frame.error as
        | { tag?: unknown; message?: unknown; cause?: unknown }
        | undefined;
      streams
        .get(id)
        ?.error(
          makeError(
            typeof errFrame?.tag === "string" ? errFrame.tag : "StreamError",
            typeof errFrame?.message === "string" ? errFrame.message : "stream error",
            errFrame?.cause,
          ),
        );
    }
  });

  ws.addEventListener("close", (event) => {
    setState("closed");
    const err = makeError(
      "ConnectionClosed",
      `WebSocket closed (code ${event.code}${event.reason ? `, ${event.reason}` : ""})`,
    );
    rejectConnected(err);
    for (const [, req] of pending) req.reject(err);
    pending.clear();
    for (const [, sink] of streams) sink.error(err);
    streams.clear();
  });

  ws.addEventListener("error", () => {
    if (state === "connecting") {
      const err = makeError("ConnectionFailed", "WebSocket connection failed");
      rejectConnected(err);
    }
  });

  return {
    state: () => state,
    connected,
    onStateChange: (handler) => {
      stateHandlers.add(handler);
      handler(state);
      return () => {
        stateHandlers.delete(handler);
      };
    },
    onBroadcast: (handler) => {
      broadcastHandlers.add(handler);
      return () => {
        broadcastHandlers.delete(handler);
      };
    },
    dispatchCommand: (input) => callUnary<DispatchResult>(METHODS.dispatchCommand, input),
    getTurnDiff: (input) =>
      callUnary<OrchestrationGetTurnDiffResult>(METHODS.getTurnDiff, input),
    getFullThreadDiff: (input) =>
      callUnary<OrchestrationGetFullThreadDiffResult>(METHODS.getFullThreadDiff, input),
    replayEvents: (input) =>
      callUnary<OrchestrationReplayEventsResult>(METHODS.replayEvents, input),
    subscribeThread: (input) =>
      callStream<OrchestrationThreadStreamItem>(METHODS.subscribeThread, input),
    subscribeShell: () =>
      callStream<OrchestrationShellStreamItem>(METHODS.subscribeShell, {}),
    getZenModels: () => callUnary<EllulGetZenModelsResult>(METHODS.getZenModels, {}),
    getProviders: () => callUnary<EllulGetProvidersResult>(METHODS.getProviders, {}),
    refreshProvider: (input) =>
      callUnary<EllulGetProvidersResult>(METHODS.refreshProvider, input),
    subscribeProviders: () =>
      callStream<EllulProvidersStreamItem>(METHODS.subscribeProviders, {}),
    close: (reason) => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, reason);
      }
    },
  };
}
