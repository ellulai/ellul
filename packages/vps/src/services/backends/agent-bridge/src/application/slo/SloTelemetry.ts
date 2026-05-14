// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// SLO span begin/end. Two kinds:
//   thread-create — command receipt → thread.created projected
//   first-byte    — turn.start receipt → first activity-appended
// Each span emits one JSONL line; aggregation is API-side.

import { logEvent } from "../../shared/event-log";

interface OpenSpan {
  readonly kind: SloEventKind;
  readonly key: string;
  readonly startedAt: number;
  readonly attrs: Readonly<Record<string, unknown>>;
}

export type SloEventKind = "thread-create" | "first-byte";

// Capped to bound a runaway producer's memory growth.
const MAX_PENDING_SPANS = 1024;
const pending = new Map<string, OpenSpan>();

function spanKey(kind: SloEventKind, key: string): string {
  return `${kind}::${key}`;
}

export function sloBegin(
  kind: SloEventKind,
  key: string,
  attrs: Record<string, unknown> = {},
): void {
  if (pending.size >= MAX_PENDING_SPANS) {
    // Drop oldest (insertion order). Surface as event so the leak is observable.
    const oldest = pending.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      pending.delete(oldest);
      logEvent("slo.span.evicted", { droppedKey: oldest, reason: "max-pending" });
    }
  }
  pending.set(spanKey(kind, key), {
    kind,
    key,
    startedAt: Date.now(),
    attrs,
  });
}

export function sloEnd(
  kind: SloEventKind,
  key: string,
  extraAttrs: Record<string, unknown> = {},
): void {
  const k = spanKey(kind, key);
  const span = pending.get(k);
  if (!span) {
    // sloEnd without sloBegin — emit so the gap is observable, not silent.
    logEvent("slo.span.unmatched", { kind, key, ...extraAttrs });
    return;
  }
  pending.delete(k);
  const durationMs = Date.now() - span.startedAt;
  logEvent(`slo.${kind}.duration`, {
    key,
    durationMs,
    ...span.attrs,
    ...extraAttrs,
  });
}

export function sloAbort(kind: SloEventKind, key: string, reason: string): void {
  const k = spanKey(kind, key);
  const span = pending.get(k);
  if (!span) return;
  pending.delete(k);
  logEvent(`slo.${kind}.aborted`, {
    key,
    durationMs: Date.now() - span.startedAt,
    reason,
    ...span.attrs,
  });
}

/** Test/observability only. */
export function sloPendingCount(): number {
  return pending.size;
}
