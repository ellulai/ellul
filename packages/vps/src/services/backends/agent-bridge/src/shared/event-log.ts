// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Structured JSONL event log for the agent bridge. One JSON record per line,
// synchronous writes, schema: { ts, pid, event, ...context }. Survives crashes
// because every record is flushed before the call returns.

import * as fs from "fs";
import * as path from "path";

const LOG_DIR = "/var/log/ellul";
const PRIMARY_PATH = path.join(LOG_DIR, "agent-bridge-events.jsonl");
const FALLBACK_PATH = path.join(process.env.TMPDIR || "/tmp", "agent-bridge-events.jsonl");

let resolvedPath: string | null = null;
let lastFailureLogged = 0;

function resolveLogPath(): string {
  if (resolvedPath) return resolvedPath;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.accessSync(LOG_DIR, fs.constants.W_OK);
    fs.appendFileSync(PRIMARY_PATH, "");
    resolvedPath = PRIMARY_PATH;
  } catch {
    resolvedPath = FALLBACK_PATH;
  }
  return resolvedPath;
}

export function logEvent(event: string, context?: Record<string, unknown>): void {
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...(context || {}),
  };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, pid: record.pid, event, _serializeError: true });
  }
  try {
    fs.appendFileSync(resolveLogPath(), line + "\n");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (resolvedPath === PRIMARY_PATH && (code === "EACCES" || code === "EPERM")) {
      resolvedPath = FALLBACK_PATH;
      try {
        fs.appendFileSync(FALLBACK_PATH, line + "\n");
        return;
      } catch { /* fall through to rate-limited stderr */ }
    }
    const now = Date.now();
    if (now - lastFailureLogged > 60_000) {
      lastFailureLogged = now;
      try {
        process.stderr.write(`[event-log] write failed: ${(err as Error).message}\n`);
      } catch { /* stderr may be EPIPE */ }
    }
  }
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const stack = err.stack ? err.stack.split("\n").slice(0, 12).join("\n") : undefined;
    return {
      errorName: err.name,
      errorMessage: err.message,
      ...(stack ? { errorStack: stack } : {}),
      ...((err as NodeJS.ErrnoException).code !== undefined
        ? { errorCode: (err as NodeJS.ErrnoException).code }
        : {}),
    };
  }
  if (typeof err === "string") return { errorMessage: err };
  try {
    return { errorMessage: JSON.stringify(err) };
  } catch {
    return { errorMessage: String(err) };
  }
}

export function tailToString(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString("utf8");
  const elided = buf.length - maxBytes;
  return `…[+${elided} earlier bytes] ${buf.subarray(buf.length - maxBytes).toString("utf8")}`;
}
