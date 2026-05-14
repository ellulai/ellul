// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Thread state machine. Per (sandbox, threadId). Lives in agent-bridge.
// Spec: docs/v2/architecture/resource-v2/01-state-machines.md#thread

import type { MachineDef } from "./lib";
import { Machine } from "./lib";

export type ThreadState =
  | "cold"
  | "warming"
  | "warm"
  | "sending"
  | "queued"
  | "error_recoverable"
  | "error_terminal"
  | "archived";

export interface ThreadCtx {
  /** Pool scope reference (opaque). Required when state ∈ {warm, sending, queued}. */
  poolScopeRef: string | null;
  /** Active turn id. Required when state = sending. */
  activeTurnId: string | null;
  /** Last error code (typed; matches a runbook). */
  lastError: string | null;
  /** Last queue position (>=0 when state = queued). */
  queuePosition: number;
  /** Last archive timestamp (ms since epoch); 0 if never archived. */
  archivedAt: number;
}

export type ThreadEvent =
  | { type: "open" }
  | { type: "warm_done"; poolScopeRef: string }
  | { type: "send_request"; turnId: string; queueAccepts: boolean; queuePosition: number }
  | { type: "send_complete" }
  | { type: "send_fail_recoverable"; error: string }
  | { type: "send_fail_terminal"; error: string }
  | { type: "recover" }
  | { type: "queue_dequeue"; turnId: string }
  | { type: "pool_scope_lost" }
  | { type: "archive" }
  | { type: "unarchive" };

export const THREAD_STATES: readonly ThreadState[] = [
  "cold",
  "warming",
  "warm",
  "sending",
  "queued",
  "error_recoverable",
  "error_terminal",
  "archived",
];

export const threadInitialCtx: ThreadCtx = {
  poolScopeRef: null,
  activeTurnId: null,
  lastError: null,
  queuePosition: -1,
  archivedAt: 0,
};

export const threadMachineDef: MachineDef<ThreadState, ThreadEvent, ThreadCtx> = {
  id: "thread",
  initial: "cold",
  transitions: [
    { from: "cold", event: "open", to: "warming" },

    {
      from: "warming",
      event: "warm_done",
      to: "warm",
      effect: (ctx, e) => ({ ...ctx, poolScopeRef: e.poolScopeRef }),
    },

    {
      from: "warm",
      event: "send_request",
      to: "sending",
      guard: (_ctx, e) => e.queueAccepts === true,
      effect: (ctx, e) => ({ ...ctx, activeTurnId: e.turnId, queuePosition: -1 }),
    },
    {
      from: "warm",
      event: "send_request",
      to: "queued",
      guard: (_ctx, e) => e.queueAccepts === false,
      effect: (ctx, e) => ({
        ...ctx,
        activeTurnId: e.turnId,
        queuePosition: Math.max(0, e.queuePosition),
      }),
    },

    {
      from: "queued",
      event: "queue_dequeue",
      to: "sending",
      guard: (ctx, e) => ctx.activeTurnId === e.turnId,
      effect: (ctx) => ({ ...ctx, queuePosition: -1 }),
    },

    {
      from: "sending",
      event: "send_complete",
      to: "warm",
      effect: (ctx) => ({ ...ctx, activeTurnId: null }),
    },
    {
      from: "sending",
      event: "send_fail_recoverable",
      to: "error_recoverable",
      effect: (ctx, e) => ({ ...ctx, activeTurnId: null, lastError: e.error }),
    },
    {
      from: "sending",
      event: "send_fail_terminal",
      to: "error_terminal",
      effect: (ctx, e) => ({ ...ctx, activeTurnId: null, lastError: e.error }),
    },

    { from: "error_recoverable", event: "recover", to: "warm", effect: (ctx) => ({ ...ctx, lastError: null }) },

    // Pool scope can vanish at any active state. Re-warm on next access.
    { from: "warm", event: "pool_scope_lost", to: "warming", effect: dropPoolScope },
    { from: "sending", event: "pool_scope_lost", to: "warming", effect: dropPoolScope },
    { from: "queued", event: "pool_scope_lost", to: "warming", effect: dropPoolScope },
    { from: "error_recoverable", event: "pool_scope_lost", to: "warming", effect: dropPoolScope },

    // Archive may be requested from any non-archived state.
    { from: "*", event: "archive", to: "archived", effect: archiveEffect },
    { from: "archived", event: "unarchive", to: "cold", effect: () => ({ ...threadInitialCtx }) },
  ],
  invariants: [
    {
      // Hard invariant from the brief: "a thread in `sending` state always has
      // a live inference scope reference." Property-tested.
      name: "sending_has_live_scope",
      predicate: (state, ctx) =>
        state !== "sending" || (ctx.poolScopeRef !== null && ctx.activeTurnId !== null),
    },
    {
      name: "warm_has_scope",
      predicate: (state, ctx) => state !== "warm" || ctx.poolScopeRef !== null,
    },
    {
      name: "cold_has_no_scope",
      predicate: (state, ctx) => state !== "cold" || (ctx.poolScopeRef === null && ctx.activeTurnId === null),
    },
    {
      name: "archived_has_no_scope_or_turn",
      predicate: (state, ctx) =>
        state !== "archived" ||
        (ctx.poolScopeRef === null && ctx.activeTurnId === null && ctx.archivedAt > 0),
    },
    {
      name: "queued_has_position_and_turn",
      predicate: (state, ctx) => state !== "queued" || (ctx.queuePosition >= 0 && ctx.activeTurnId !== null),
    },
    {
      name: "errored_has_typed_code",
      predicate: (state, ctx) =>
        (state !== "error_recoverable" && state !== "error_terminal") || (ctx.lastError !== null && ctx.lastError.length > 0),
    },
  ],
};

function dropPoolScope(ctx: ThreadCtx): ThreadCtx {
  return { ...ctx, poolScopeRef: null, activeTurnId: null };
}

function archiveEffect(ctx: ThreadCtx): ThreadCtx {
  return { ...ctx, poolScopeRef: null, activeTurnId: null, queuePosition: -1, archivedAt: Date.now() };
}

export function makeThreadMachine(initialCtx: ThreadCtx = threadInitialCtx): Machine<ThreadState, ThreadEvent, ThreadCtx> {
  return new Machine(threadMachineDef, { ...initialCtx });
}
