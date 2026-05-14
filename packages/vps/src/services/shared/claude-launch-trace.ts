// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Single trace log used by every component that touches the Claude
// auth+spawn chain (bridge, launcher, ns wrapper). One traceId per spawn
// flows via ELLUL_CLAUDE_TRACE_ID; grep one ID across the file to see the
// whole flow. Format: JSONL — one JSON object per line, structured
// {ts, component, tr, phase, ...kv}. Logrotate config at
// `/etc/logrotate.d/ellul-claude-launch` rotates daily, keeps 14 days.

import { appendFileSync } from "node:fs";

export const CLAUDE_LAUNCH_TRACE_PATH = "/var/log/ellul/claude-launch.log";
export const CLAUDE_LAUNCH_TRACE_ENV = "ELLUL_CLAUDE_TRACE_ID";

export type TraceComponent = "bridge" | "launcher" | "claude-ns";

export type TraceValue = string | number | boolean | null | undefined;

function formatLine(
  component: TraceComponent,
  traceId: string,
  phase: string,
  kv: Record<string, TraceValue>,
): string {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    component,
    tr: traceId,
    phase,
  };
  for (const [k, v] of Object.entries(kv)) {
    if (v === undefined) continue;
    record[k] = v;
  }
  return JSON.stringify(record) + "\n";
}

export function claudeLaunchTrace(
  component: TraceComponent,
  traceId: string,
  phase: string,
  kv: Record<string, TraceValue> = {},
): void {
  const line = formatLine(component, traceId, phase, kv);
  try {
    process.stderr.write(line);
  } catch {
    // Best effort.
  }
  try {
    appendFileSync(CLAUDE_LAUNCH_TRACE_PATH, line);
  } catch {
    // Trace path may not be writable in tests / sandboxes.
  }
}
