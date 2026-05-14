// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// event-log.ts — read + assert helpers for the daemon's structured JSONL
// event log. Used by harness.ts and adversarial.ts.

import * as fs from "node:fs";

export const EVENT_LOG_PATH = "/var/log/ellul/agent-bridge-events.jsonl";

export interface EventRecord {
  ts: string;
  pid: number;
  event: string;
  [k: string]: unknown;
}

/** Read every event whose ts >= sinceMs. Throws if the log is missing. */
export function readEventsSince(sinceMs: number): EventRecord[] {
  const raw = fs.readFileSync(EVENT_LOG_PATH, "utf8");
  const out: EventRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let rec: EventRecord;
    try {
      rec = JSON.parse(line) as EventRecord;
    } catch {
      throw new Error(`event-log: malformed line: ${line.slice(0, 120)}`);
    }
    const t = Date.parse(rec.ts);
    if (Number.isFinite(t) && t >= sinceMs) out.push(rec);
  }
  return out;
}

/**
 * Assert at least one event matches the predicate. Dumps recent events to
 * stderr on failure to make CI logs diagnosable. Returns the matched event.
 */
export function expectEvent(
  events: ReadonlyArray<EventRecord>,
  match: (e: EventRecord) => boolean,
  description: string,
): EventRecord {
  for (const e of events) {
    if (match(e)) return e;
  }
  process.stderr.write(
    `\n[expectEvent FAIL] ${description}\nrecent events:\n` +
      events.map((e) => JSON.stringify(e)).join("\n") +
      "\n",
  );
  throw new Error(`expected event: ${description}`);
}

/**
 * Assert NO event matches the predicate. Mirror of expectEvent for "this
 * tag must not appear" guarantees.
 */
export function expectNoEvent(
  events: ReadonlyArray<EventRecord>,
  match: (e: EventRecord) => boolean,
  description: string,
): void {
  for (const e of events) {
    if (match(e)) {
      process.stderr.write(
        `\n[expectNoEvent FAIL] ${description}\nmatched: ${JSON.stringify(e)}\n`,
      );
      throw new Error(`unexpected event: ${description}`);
    }
  }
}

/** Events whose `event` tag starts with this prefix. */
export function nsdEvents(events: ReadonlyArray<EventRecord>): EventRecord[] {
  return events.filter((e) => typeof e.event === "string" && e.event.startsWith("nsd."));
}
