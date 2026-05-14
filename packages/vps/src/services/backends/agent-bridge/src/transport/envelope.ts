// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { Schema } from "effect";
import { TrimmedNonEmptyString } from "@ellul.ai/types";

export const RpcEnvelopeId = Schema.String.pipe(Schema.brand("RpcEnvelopeId"));
export type RpcEnvelopeId = typeof RpcEnvelopeId.Type;

export const RpcCancelMethod = "_cancel" as const;

export const RpcRequest = Schema.Struct({
  id: RpcEnvelopeId,
  method: TrimmedNonEmptyString,
  payload: Schema.Unknown,
});
export type RpcRequest = typeof RpcRequest.Type;

export const RpcCancelRequest = Schema.Struct({
  id: RpcEnvelopeId,
  method: Schema.Literal(RpcCancelMethod),
});
export type RpcCancelRequest = typeof RpcCancelRequest.Type;

export const RpcErrorShape = Schema.Struct({
  tag: TrimmedNonEmptyString,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
});
export type RpcErrorShape = typeof RpcErrorShape.Type;

export const RpcSuccess = Schema.Struct({
  id: RpcEnvelopeId,
  ok: Schema.Literal(true),
  result: Schema.Unknown,
});
export type RpcSuccess = typeof RpcSuccess.Type;

export const RpcFailure = Schema.Struct({
  id: RpcEnvelopeId,
  ok: Schema.Literal(false),
  error: RpcErrorShape,
});
export type RpcFailure = typeof RpcFailure.Type;

export const RpcStreamNext = Schema.Struct({
  id: RpcEnvelopeId,
  stream: Schema.Literal("next"),
  item: Schema.Unknown,
});
export type RpcStreamNext = typeof RpcStreamNext.Type;

export const RpcStreamComplete = Schema.Struct({
  id: RpcEnvelopeId,
  stream: Schema.Literal("complete"),
});
export type RpcStreamComplete = typeof RpcStreamComplete.Type;

export const RpcStreamError = Schema.Struct({
  id: RpcEnvelopeId,
  stream: Schema.Literal("error"),
  error: RpcErrorShape,
});
export type RpcStreamError = typeof RpcStreamError.Type;

export const RpcServerFrame = Schema.Union([
  RpcSuccess,
  RpcFailure,
  RpcStreamNext,
  RpcStreamComplete,
  RpcStreamError,
]);
export type RpcServerFrame = typeof RpcServerFrame.Type;

export function rpcSuccess(id: RpcEnvelopeId, result: unknown): RpcSuccess {
  return { id, ok: true, result };
}

export function rpcFailure(id: RpcEnvelopeId, error: RpcErrorShape): RpcFailure {
  return { id, ok: false, error };
}

export function rpcStreamNext(id: RpcEnvelopeId, item: unknown): RpcStreamNext {
  return { id, stream: "next", item };
}

export function rpcStreamComplete(id: RpcEnvelopeId): RpcStreamComplete {
  return { id, stream: "complete" };
}

export function rpcStreamError(id: RpcEnvelopeId, error: RpcErrorShape): RpcStreamError {
  return { id, stream: "error", error };
}

export function errorShapeFromDefect(tag: string, message: string, cause?: unknown): RpcErrorShape {
  return cause === undefined
    ? { tag, message }
    : { tag, message, cause };
}
