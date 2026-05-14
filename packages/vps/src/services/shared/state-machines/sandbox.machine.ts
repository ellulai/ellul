// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Sandbox state machine. Per sandbox (sbx-XXXXXXX). Lives in agent-bridge.
// Spec: docs/v2/architecture/resource-v2/01-state-machines.md#sandbox

import type { MachineDef } from "./lib";
import { Machine } from "./lib";

export type SandboxState =
  | "not_provisioned"
  | "provisioning"
  | "warm"
  | "cold"
  | "hibernated"
  | "reaping";

export interface SandboxCtx {
  /** Whether the per-sandbox transient slice is live (ellul-ns-<sandbox>.slice). */
  sliceLive: boolean;
  /** Whether the namespace anchor PID file exists and the anchor is alive. */
  namespaceLive: boolean;
  /** Number of warm pool scopes attached. Decremented on reap. */
  warmPoolScopes: number;
  /** Number of warm threads (non-archived) holding scopes. */
  warmThreads: number;
  /** Last error code (typed; matches a runbook). */
  lastError: string | null;
}

export type SandboxEvent =
  | { type: "create" }
  | { type: "provisioning_done" }
  | { type: "provisioning_failed"; error: string }
  | { type: "thread_attached" }
  | { type: "thread_detached" }
  | { type: "pool_scope_attached" }
  | { type: "pool_scope_reaped" }
  | { type: "idle_reap_due" }
  | { type: "reap_done" }
  | { type: "vps_hibernate" }
  | { type: "vps_wake" }
  | { type: "access" };

export const SANDBOX_STATES: readonly SandboxState[] = [
  "not_provisioned",
  "provisioning",
  "warm",
  "cold",
  "hibernated",
  "reaping",
];

export const sandboxInitialCtx: SandboxCtx = {
  sliceLive: false,
  namespaceLive: false,
  warmPoolScopes: 0,
  warmThreads: 0,
  lastError: null,
};

export const sandboxMachineDef: MachineDef<SandboxState, SandboxEvent, SandboxCtx> = {
  id: "sandbox",
  initial: "not_provisioned",
  transitions: [
    { from: "not_provisioned", event: "create", to: "provisioning" },

    {
      from: "provisioning",
      event: "provisioning_done",
      to: "warm",
      effect: (ctx) => ({ ...ctx, sliceLive: true, namespaceLive: true, lastError: null }),
    },
    {
      from: "provisioning",
      event: "provisioning_failed",
      to: "not_provisioned",
      effect: (ctx, e) => ({ ...ctx, lastError: e.error }),
    },

    {
      from: "warm",
      event: "thread_attached",
      to: "warm",
      effect: (ctx) => ({ ...ctx, warmThreads: ctx.warmThreads + 1 }),
    },
    {
      from: "warm",
      event: "thread_detached",
      to: "warm",
      effect: (ctx) => ({ ...ctx, warmThreads: Math.max(0, ctx.warmThreads - 1) }),
    },
    {
      from: "warm",
      event: "pool_scope_attached",
      to: "warm",
      effect: (ctx) => ({ ...ctx, warmPoolScopes: ctx.warmPoolScopes + 1 }),
    },
    {
      from: "warm",
      event: "pool_scope_reaped",
      to: "warm",
      effect: (ctx) => ({ ...ctx, warmPoolScopes: Math.max(0, ctx.warmPoolScopes - 1) }),
    },

    {
      from: "warm",
      event: "idle_reap_due",
      to: "reaping",
      // Only reap when nothing is attached.
      guard: (ctx) => ctx.warmThreads === 0 && ctx.warmPoolScopes === 0,
    },

    {
      from: "reaping",
      event: "reap_done",
      to: "cold",
      effect: (ctx) => ({ ...ctx, sliceLive: false, namespaceLive: false }),
    },

    { from: "cold", event: "access", to: "provisioning" },

    // VPS-level transitions wipe sandbox state.
    { from: "*", event: "vps_hibernate", to: "hibernated", effect: hibernateEffect },
    { from: "hibernated", event: "vps_wake", to: "cold", effect: hibernateEffect },
  ],
  invariants: [
    {
      name: "warm_has_live_resources",
      predicate: (state, ctx) => state !== "warm" || (ctx.sliceLive && ctx.namespaceLive),
    },
    {
      name: "cold_has_no_resources",
      predicate: (state, ctx) => state !== "cold" || (!ctx.sliceLive && !ctx.namespaceLive),
    },
    {
      name: "not_provisioned_has_no_resources",
      predicate: (state, ctx) =>
        state !== "not_provisioned" || (!ctx.sliceLive && !ctx.namespaceLive),
    },
    {
      name: "reap_only_when_empty",
      predicate: (state, ctx) =>
        state !== "reaping" || (ctx.warmThreads === 0 && ctx.warmPoolScopes === 0),
    },
    {
      name: "hibernated_has_no_live_resources",
      predicate: (state, ctx) =>
        state !== "hibernated" || (!ctx.sliceLive && !ctx.namespaceLive),
    },
    {
      name: "scope_count_non_negative",
      predicate: (_state, ctx) => ctx.warmPoolScopes >= 0 && ctx.warmThreads >= 0,
    },
  ],
};

function hibernateEffect(ctx: SandboxCtx): SandboxCtx {
  return { ...ctx, sliceLive: false, namespaceLive: false, warmPoolScopes: 0, warmThreads: 0 };
}

export function makeSandboxMachine(initialCtx: SandboxCtx = sandboxInitialCtx): Machine<SandboxState, SandboxEvent, SandboxCtx> {
  return new Machine(sandboxMachineDef, { ...initialCtx });
}
