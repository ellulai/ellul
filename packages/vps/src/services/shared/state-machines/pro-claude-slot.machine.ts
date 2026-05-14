// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Pro Claude slot state machine. Per slot (1..N where N is the tier cap).
// Lives in agent-bridge ProClaudeSlotManager.
// Spec: docs/v2/architecture/resource-v2/01-state-machines.md#pro-claude-slot
// Detail:  docs/v2/architecture/resource-v2/06-pro-claude-slots.md

import type { MachineDef } from "./lib";
import { Machine } from "./lib";

export type ProClaudeSlotState =
  | "empty"
  | "warming"
  | "warm"
  | "active"
  | "evicting"
  | "evicted";

export interface ProClaudeSlotCtx {
  /** Bound thread (current). null if empty/evicted. */
  threadId: string | null;
  /** Pid of the live Claude SDK process. null if no live process. */
  processPid: number | null;
  /** Resume token currently loaded into the process. null if not loaded. */
  resumeToken: string | null;
  /** Thread requesting eviction-for-switch (set during evicting → next bind). */
  nextThreadId: string | null;
  /** Wall-clock ms of last successful turn complete. 0 if never. */
  lastUseAt: number;
  /** Last error code (typed; matches a runbook). */
  lastError: string | null;
}

export type ProClaudeSlotEvent =
  | { type: "bind"; threadId: string; resumeToken: string | null }
  | { type: "hydrate_done"; processPid: number }
  | { type: "send_start" }
  | { type: "send_complete" }
  | { type: "evict_start"; nextThreadId: string | null }
  | { type: "evict_done" }
  | { type: "reset" }
  | { type: "process_died"; error: string };

export const PRO_CLAUDE_SLOT_STATES: readonly ProClaudeSlotState[] = [
  "empty",
  "warming",
  "warm",
  "active",
  "evicting",
  "evicted",
];

export const proClaudeSlotInitialCtx: ProClaudeSlotCtx = {
  threadId: null,
  processPid: null,
  resumeToken: null,
  nextThreadId: null,
  lastUseAt: 0,
  lastError: null,
};

export const proClaudeSlotMachineDef: MachineDef<ProClaudeSlotState, ProClaudeSlotEvent, ProClaudeSlotCtx> = {
  id: "pro_claude_slot",
  initial: "empty",
  transitions: [
    {
      from: "empty",
      event: "bind",
      to: "warming",
      effect: (ctx, e) => ({ ...ctx, threadId: e.threadId, resumeToken: e.resumeToken, lastError: null }),
    },

    {
      from: "warming",
      event: "hydrate_done",
      to: "warm",
      effect: (ctx, e) => ({ ...ctx, processPid: e.processPid }),
    },

    { from: "warm", event: "send_start", to: "active" },
    {
      from: "active",
      event: "send_complete",
      to: "warm",
      effect: (ctx) => ({ ...ctx, lastUseAt: Date.now() }),
    },

    // Eviction may be requested from warm (idle) or active (in flight). When
    // active, the policy enforced at the manager level is "wait for
    // send_complete first" — the machine accepts evict_start on active too,
    // but the manager won't fire it until send_complete. The machine's job
    // is to model the kernel reality, not policy.
    {
      from: "warm",
      event: "evict_start",
      to: "evicting",
      effect: (ctx, e) => ({ ...ctx, nextThreadId: e.nextThreadId }),
    },
    {
      from: "active",
      event: "evict_start",
      to: "evicting",
      effect: (ctx, e) => ({ ...ctx, nextThreadId: e.nextThreadId }),
    },

    {
      from: "evicting",
      event: "evict_done",
      to: "evicted",
      effect: (ctx) => ({ ...ctx, processPid: null, threadId: null, resumeToken: null }),
    },

    {
      from: "evicted",
      event: "reset",
      to: "empty",
      effect: () => ({ ...proClaudeSlotInitialCtx }),
    },

    // Process can die at any state where there is supposed to be a process.
    {
      from: "warm",
      event: "process_died",
      to: "evicted",
      effect: processDiedEffect,
    },
    {
      from: "active",
      event: "process_died",
      to: "evicted",
      effect: processDiedEffect,
    },
    {
      from: "warming",
      event: "process_died",
      to: "evicted",
      effect: processDiedEffect,
    },
    {
      from: "evicting",
      event: "process_died",
      to: "evicted",
      effect: processDiedEffect,
    },
  ],
  invariants: [
    {
      name: "warm_has_thread_and_pid",
      predicate: (state, ctx) => state !== "warm" || (ctx.threadId !== null && ctx.processPid !== null),
    },
    {
      name: "active_has_thread_and_pid",
      predicate: (state, ctx) => state !== "active" || (ctx.threadId !== null && ctx.processPid !== null),
    },
    {
      name: "warming_has_thread",
      predicate: (state, ctx) => state !== "warming" || ctx.threadId !== null,
    },
    {
      name: "empty_has_no_thread_or_pid",
      predicate: (state, ctx) => state !== "empty" || (ctx.threadId === null && ctx.processPid === null),
    },
    {
      name: "evicted_has_no_pid",
      predicate: (state, ctx) => state !== "evicted" || ctx.processPid === null,
    },
  ],
};

function processDiedEffect(ctx: ProClaudeSlotCtx, e: ProClaudeSlotEvent): ProClaudeSlotCtx {
  return {
    ...ctx,
    processPid: null,
    threadId: null,
    resumeToken: null,
    nextThreadId: null,
    lastError: e.type === "process_died" ? e.error : ctx.lastError,
  };
}

export function makeProClaudeSlotMachine(
  initialCtx: ProClaudeSlotCtx = proClaudeSlotInitialCtx,
): Machine<ProClaudeSlotState, ProClaudeSlotEvent, ProClaudeSlotCtx> {
  return new Machine(proClaudeSlotMachineDef, { ...initialCtx });
}
