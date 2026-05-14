// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Pure exec-plan logic for the launcher.
 *
 * Given the inherited environment + a freshly-redeemed OAT, produces the
 * exact env block to pass to execve. No I/O. No side effects. Trivially
 * unit-testable.
 *
 * Hardening rules embodied here:
 *   - Drop CLAUDE_OAT_ISSUANCE_TOKEN (single-use, no longer needed).
 *   - Drop any pre-existing CLAUDE_CODE_OAUTH_TOKEN (defensive — only
 *     the freshly-redeemed value should reach claude).
 *   - Drop ANTHROPIC_API_KEY (defense: don't let stale BYOK auth
 *     override OAT and confuse claude-code's auth-resolution order).
 *   - Set CLAUDE_CODE_OAUTH_TOKEN = the redeemed OAT.
 */

const FORBIDDEN_INHERITED_KEYS = new Set([
  "CLAUDE_OAT_ISSUANCE_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
]);

export function buildExecEnv(
  inherited: NodeJS.ProcessEnv,
  oat: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(inherited)) {
    if (FORBIDDEN_INHERITED_KEYS.has(k)) continue;
    if (typeof v === "string") env[k] = v;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = oat;
  return env;
}

/** Format check for the issuance token — 32 hex chars (128-bit UUID). */
const ISSUANCE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
export function isValidIssuanceToken(value: string | undefined): boolean {
  return typeof value === "string" && ISSUANCE_TOKEN_PATTERN.test(value);
}
