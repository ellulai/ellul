// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Pool scope state machine. Per (sandbox, adapter). Lives in agent-bridge
// pool managers (opencode, cursor, codex). Spec:
// docs/v2/architecture/resource-v2/01-state-machines.md#pool-scope

import type { MachineDef } from "./lib";
import { Machine } from "./lib";

export type PoolScopeState = "cold" | "spawning" | "warm" | "inferring" | "reaping";

export interface PoolScopeCtx {
  /** Number of active sessions referencing this scope. */
  refCount: number;
  /** Number of in-flight inference calls within the scope. */
  inflight: number;
  /** Wall-clock ms of last refCount-becomes-zero. 0 if never. */
  idleSince: number;
  /** Last error code. */
  lastError: string | null;
  /** Process pid of the daemon. null if not running. */
  processPid: number | null;
}

export type PoolScopeEvent =
  | { type: "acquire" }
  | { type: "spawn_done"; processPid: number }
  | { type: "release" }
  | { type: "session_send_start" }
  | { type: "session_send_complete" }
  | { type: "idle_reap_due" }
  | { type: "reap_done" }
  | { type: "process_died"; error: string };

export const POOL_SCOPE_STATES: readonly PoolScopeState[] = [
  "cold",
  "spawning",
  "warm",
  "inferring",
  "reaping",
];

export const poolScopeInitialCtx: PoolScopeCtx = {
  refCount: 0,
  inflight: 0,
  idleSince: 0,
  lastError: null,
  processPid: null,
};

export const poolScopeMachineDef: MachineDef<PoolScopeState, PoolScopeEvent, PoolScopeCtx> = {
  id: "pool_scope",
  initial: "cold",
  transitions: [
    {
      from: "cold",
      event: "acquire",
      to: "spawning",
      effect: (ctx) => ({ ...ctx, refCount: ctx.refCount + 1 }),
    },

    {
      from: "spawning",
      event: "spawn_done",
      to: "warm",
      effect: (ctx, e) => ({ ...ctx, processPid: e.processPid }),
    },

    {
      from: "warm",
      event: "acquire",
      to: "warm",
      effect: (ctx) => ({ ...ctx, refCount: ctx.refCount + 1, idleSince: 0 }),
    },
    {
      from: "inferring",
      event: "acquire",
      to: "inferring",
      effect: (ctx) => ({ ...ctx, refCount: ctx.refCount + 1 }),
    },

    {
      from: "warm",
      event: "release",
      to: "warm",
      effect: (ctx) => ({
        ...ctx,
        refCount: Math.max(0, ctx.refCount - 1),
        idleSince: ctx.refCount - 1 <= 0 ? Date.now() : 0,
      }),
    },
    {
      from: "inferring",
      event: "release",
      to: "inferring",
      effect: (ctx) => ({ ...ctx, refCount: Math.max(0, ctx.refCount - 1) }),
    },

    {
      from: "warm",
      event: "session_send_start",
      to: "inferring",
      effect: (ctx) => ({ ...ctx, inflight: ctx.inflight + 1, idleSince: 0 }),
    },
    {
      from: "inferring",
      event: "session_send_start",
      to: "inferring",
      effect: (ctx) => ({ ...ctx, inflight: ctx.inflight + 1 }),
    },

    {
      from: "inferring",
      event: "session_send_complete",
      to: "inferring",
      guard: (ctx) => ctx.inflight - 1 > 0,
      effect: (ctx) => ({ ...ctx, inflight: ctx.inflight - 1 }),
    },
    {
      from: "inferring",
      event: "session_send_complete",
      to: "warm",
      guard: (ctx) => ctx.inflight - 1 <= 0,
      effect: (ctx) => ({
        ...ctx,
        inflight: 0,
        idleSince: ctx.refCount === 0 ? Date.now() : 0,
      }),
    },

    {
      from: "warm",
      event: "idle_reap_due",
      to: "reaping",
      guard: (ctx) => ctx.refCount === 0 && ctx.inflight === 0,
    },

    {
      from: "reaping",
      event: "reap_done",
      to: "cold",
      effect: (ctx) => ({ ...ctx, processPid: null, idleSince: 0, inflight: 0 }),
    },

    // Process death is allowed from any state where the daemon is supposed to be running.
    {
      from: "warm",
      event: "process_died",
      to: "cold",
      effect: processDiedEffect,
    },
    {
      from: "inferring",
      event: "process_died",
      to: "cold",
      effect: processDiedEffect,
    },
    {
      from: "spawning",
      event: "process_died",
      to: "cold",
      effect: processDiedEffect,
    },
    {
      from: "reaping",
      event: "process_died",
      to: "cold",
      effect: processDiedEffect,
    },
  ],
  invariants: [
    {
      name: "warm_has_pid",
      predicate: (state, ctx) => state !== "warm" || ctx.processPid !== null,
    },
    {
      name: "inferring_has_pid_and_inflight",
      predicate: (state, ctx) => state !== "inferring" || (ctx.processPid !== null && ctx.inflight > 0),
    },
    {
      name: "cold_has_no_pid",
      predicate: (state, ctx) => state !== "cold" || ctx.processPid === null,
    },
    {
      name: "refcount_non_negative",
      predicate: (_state, ctx) => ctx.refCount >= 0,
    },
    {
      name: "inflight_non_negative",
      predicate: (_state, ctx) => ctx.inflight >= 0,
    },
    {
      name: "warm_inflight_zero",
      predicate: (state, ctx) => state !== "warm" || ctx.inflight === 0,
    },
    {
      name: "reap_only_when_idle",
      predicate: (state, ctx) => state !== "reaping" || (ctx.refCount === 0 && ctx.inflight === 0),
    },
  ],
};

function processDiedEffect(ctx: PoolScopeCtx, e: PoolScopeEvent): PoolScopeCtx {
  return {
    ...ctx,
    processPid: null,
    inflight: 0,
    refCount: 0,
    idleSince: 0,
    lastError: e.type === "process_died" ? e.error : ctx.lastError,
  };
}

export function makePoolScopeMachine(initialCtx: PoolScopeCtx = poolScopeInitialCtx): Machine<PoolScopeState, PoolScopeEvent, PoolScopeCtx> {
  return new Machine(poolScopeMachineDef, { ...initialCtx });
}
