// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Schema } from "effect";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "../ids";
import { ProviderKind } from "./kind";
import { ProviderRequestKind } from "./interaction";

export const ProviderEventKind = Schema.Literals(["notification", "request", "session", "error"]);
export type ProviderEventKind = typeof ProviderEventKind.Type;

export const ProviderEvent = Schema.Struct({
  id: EventId,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  kind: ProviderEventKind,
  method: Schema.String,
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  payload: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
  textDelta: Schema.optional(Schema.String),
});
export type ProviderEvent = typeof ProviderEvent.Type;
