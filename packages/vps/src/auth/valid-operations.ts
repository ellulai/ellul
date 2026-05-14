// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * VALID_OPERATIONS — single source of truth for passkey-gated operations.
 *
 * Every layer that validates the `operation` field of a passkey
 * confirmation flow MUST import this list:
 *
 *   - apps/api/src/bridges/types.ts        (PasskeyOperation type)
 *   - apps/console/src/.../useServerMutations.ts (VpsAuthDialogState)
 *   - packages/vps/src/.../routes/confirm.routes.ts (server-side gate)
 *   - packages/vps/src/.../static/bridge-client.js  (client-side gate)
 *
 * The .js file can't import TS, so static.routes.ts substitutes the
 * placeholder __VALID_OPERATIONS__ at serve time with JSON.stringify
 * of this array. Adding an operation in one place and forgetting the
 * others silently breaks the dashboard — that's how "update-mode" got
 * missed and burned an hour of debugging.
 *
 * Rules for adding an operation:
 *   1. Add the string to VALID_OPERATIONS below.
 *   2. Add a passkey dialog flow + mutation in useServerMutations.
 *   3. Handle the new op in the API route(s) via `tierAuth({operation: ...})`.
 *   4. Done — every consumer picks it up automatically.
 */

export const VALID_OPERATIONS = [
  "delete",
  "rebuild",
  "update",
  "update-mode",
  "rollback",
  "deployment",
  "change-tier",
  "cancel-downgrade",
  "settings",
] as const;

export type PasskeyOperation = (typeof VALID_OPERATIONS)[number];

/** Type guard — use this anywhere you need to validate a string at runtime. */
export function isPasskeyOperation(value: string): value is PasskeyOperation {
  return (VALID_OPERATIONS as readonly string[]).includes(value);
}
