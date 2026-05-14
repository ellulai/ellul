// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Structured Output — centralized output with --json mode awareness.
 *
 * JSON mode: all output goes to stdout as {"ok":true/false, "data"/"error": ...}
 * Human mode: progress/errors to stderr, success data via success() is no-op
 *   (commands print their own human text to stderr).
 *
 * Exit codes:
 *   0 = success
 *   1 = usage error (missing flag, bad arg, unknown command)
 *   2 = auth error (not logged in, expired, 401/403)
 *   3 = network/server error (proxy down, VPS unreachable, 5xx)
 *   4 = conflict (already init'd with different name, already bound)
 */

export const EXIT = {
  SUCCESS: 0,
  USAGE: 1,
  AUTH: 2,
  NETWORK: 3,
  CONFLICT: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/**
 * Emit success result. In JSON mode, writes envelope to stdout.
 * In human mode, this is a no-op — commands handle their own human output.
 */
export function success(data: Record<string, unknown>): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
  }
}

/**
 * Emit error and exit. In JSON mode, writes envelope to stdout.
 * In human mode, writes [tag] message to stderr.
 */
export function fail(
  code: ExitCode,
  tag: string,
  message: string,
  hint?: string,
): never {
  if (jsonMode) {
    const error: Record<string, string> = {
      code: exitCodeToErrorCode(code),
      message,
    };
    if (hint) error.hint = hint;
    process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
  } else {
    process.stderr.write(`[${tag}] ${message}\n`);
    if (hint) process.stderr.write(`[${tag}] ${hint}\n`);
  }
  process.exit(code);
}

/**
 * Emit progress info. In JSON mode, suppressed. In human mode, writes to stderr.
 */
export function info(tag: string, message: string): void {
  if (!jsonMode) {
    process.stderr.write(`[${tag}] ${message}\n`);
  }
}

/**
 * Emit status line (indented with symbol). In JSON mode, suppressed.
 */
export function status(symbol: string, message: string): void {
  if (!jsonMode) {
    process.stderr.write(`  ${symbol} ${message}\n`);
  }
}

function exitCodeToErrorCode(code: ExitCode): string {
  switch (code) {
    case EXIT.SUCCESS: return 'OK';
    case EXIT.USAGE: return 'USAGE_ERROR';
    case EXIT.AUTH: return 'AUTH_ERROR';
    case EXIT.NETWORK: return 'NETWORK_ERROR';
    case EXIT.CONFLICT: return 'CONFLICT';
    default: return 'UNKNOWN_ERROR';
  }
}
