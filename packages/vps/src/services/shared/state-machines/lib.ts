// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Hand-rolled state-machine framework. Under 200 LOC by design — explicit
// transition table, explicit invariants, deterministic, no dependencies.
// Used by the resource-v2 architecture (docs/v2/architecture/resource-v2/01-state-machines.md).

export type EventBase = { readonly type: string };

export type Transition<S extends string, E extends EventBase, Ctx> =
  E extends { type: infer T }
    ? T extends string
      ? {
          readonly from: S | "*";
          readonly event: T;
          readonly to: S;
          readonly guard?: (ctx: Ctx, event: Extract<E, { type: T }>) => boolean;
          readonly effect?: (ctx: Ctx, event: Extract<E, { type: T }>) => Ctx;
        }
      : never
    : never;

export interface Invariant<S extends string, Ctx> {
  readonly name: string;
  readonly predicate: (state: S, ctx: Ctx) => boolean;
}

export interface MachineDef<S extends string, E extends EventBase, Ctx> {
  readonly id: string;
  readonly initial: S;
  readonly transitions: ReadonlyArray<Transition<S, E, Ctx>>;
  readonly invariants?: ReadonlyArray<Invariant<S, Ctx>>;
}

export type SendResult<S extends string> =
  | { ok: true; from: S; to: S; effects: readonly string[] }
  | { ok: false; reason: "no_transition" | "guard_rejected"; current: S; event: string };

export interface TraceEntry<S extends string> {
  readonly state: S;
  readonly event: string;
  readonly at: number;
}

export class InvariantViolationError extends Error {
  constructor(
    public readonly machine: string,
    public readonly invariant: string,
    public readonly state: string,
    public readonly context: unknown,
    public readonly trace: ReadonlyArray<TraceEntry<string>>,
  ) {
    super(`invariant violated: ${machine}.${invariant} (state=${state})`);
    this.name = "InvariantViolationError";
  }
}

export class Machine<S extends string, E extends EventBase, Ctx> {
  private state: S;
  private ctx: Ctx;
  private history: Array<TraceEntry<S>>;

  constructor(private readonly def: MachineDef<S, E, Ctx>, initialCtx: Ctx) {
    this.state = def.initial;
    this.ctx = initialCtx;
    this.history = [{ state: this.state, event: "@@init", at: now() }];
    this.assertInvariants();
  }

  current(): S {
    return this.state;
  }

  context(): Readonly<Ctx> {
    return this.ctx;
  }

  trace(): ReadonlyArray<TraceEntry<S>> {
    return this.history;
  }

  /**
   * Apply an event. Walks the transition table in declaration order;
   * the first transition whose `from` matches and whose `guard` (if any)
   * accepts the event fires. If none match, returns `no_transition`. If
   * one matches `from`+`event` but its guard rejects, returns
   * `guard_rejected` (this distinction surfaces silent intent mismatches
   * in tests).
   */
  send(event: E): SendResult<S> {
    const candidates = this.def.transitions.filter(
      (t) => (t.from === this.state || t.from === "*") && t.event === event.type,
    );
    if (candidates.length === 0) {
      return { ok: false, reason: "no_transition", current: this.state, event: event.type };
    }
    let guardRejected = false;
    for (const t of candidates) {
      if (t.guard && !t.guard(this.ctx, event)) {
        guardRejected = true;
        continue;
      }
      const from = this.state;
      this.state = t.to;
      const effects: string[] = [];
      if (t.effect) {
        const next = t.effect(this.ctx, event);
        this.ctx = next;
        effects.push("effect");
      }
      this.history.push({ state: this.state, event: event.type, at: now() });
      this.assertInvariants();
      return { ok: true, from, to: this.state, effects };
    }
    return {
      ok: false,
      reason: guardRejected ? "guard_rejected" : "no_transition",
      current: this.state,
      event: event.type,
    };
  }

  /**
   * Try a sequence of events. Returns the last result. Stops at first
   * non-ok (does not throw).
   */
  sendAll(events: ReadonlyArray<E>): SendResult<S> {
    let last: SendResult<S> = { ok: true, from: this.state, to: this.state, effects: [] };
    for (const e of events) {
      const r = this.send(e);
      if (!r.ok) return r;
      last = r;
    }
    return last;
  }

  /** Snapshot the machine for serialization (e.g. checkpoint to vault). */
  snapshot(): { state: S; ctx: Ctx; history: ReadonlyArray<TraceEntry<S>> } {
    return { state: this.state, ctx: structuredClone(this.ctx), history: [...this.history] };
  }

  private assertInvariants(): void {
    const invs = this.def.invariants;
    if (!invs) return;
    for (const inv of invs) {
      let held: boolean;
      try {
        held = inv.predicate(this.state, this.ctx);
      } catch (err) {
        throw new InvariantViolationError(
          this.def.id,
          `${inv.name} (threw: ${(err as Error).message})`,
          this.state,
          this.ctx,
          this.history,
        );
      }
      if (!held) {
        throw new InvariantViolationError(this.def.id, inv.name, this.state, this.ctx, this.history);
      }
    }
  }
}

function now(): number {
  return Date.now();
}

/** Test helper: deterministic random event walker. Used by property tests. */
export function randomWalk<S extends string, E extends EventBase, Ctx>(
  machine: Machine<S, E, Ctx>,
  events: ReadonlyArray<E>,
  steps: number,
  seed: number,
): { trace: ReadonlyArray<TraceEntry<S>>; rejected: number } {
  let s = seed >>> 0;
  let rejected = 0;
  for (let i = 0; i < steps; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const e = events[s % events.length]!;
    const r = machine.send(e);
    if (!r.ok) rejected++;
  }
  return { trace: machine.trace(), rejected };
}
