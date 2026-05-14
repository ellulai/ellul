// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Canonical security scope — `SandboxId`.
 *
 * All security surfaces (secrets, gate permissions, vault, cross-project
 * grants, database roles, policies, audit events) scope on the sandbox slug.
 * The sandbox is the only hard containment boundary (Linux mount + PID
 * namespace, UID, iptables). Per-app or per-package scopes are runtime /
 * navigation concepts — they are NOT security boundaries.
 *
 * This module is the single source of truth. Every layer (UI, HTTP route,
 * service, database) MUST import from here. Do not re-introduce inline regex,
 * normalization, or validation anywhere else.
 *
 * Invariants enforced here:
 *   I1. The only legal scope is a sandbox slug matching /^sbx-[a-z0-9]{7}$/.
 *   I2. `SandboxId` is a branded nominal type — raw strings cannot be assigned
 *       to `SandboxId` without going through a parser. This lifts forgotten
 *       validation from runtime bug to compile error.
 *   I3. Coercion from a nested path (`sbx-xyz/my-app`) is explicit via
 *       `sandboxIdFromPath` — implicit `.split('/')[0]` sprinkled across the
 *       codebase is forbidden.
 *   I4. Errors are typed (`InvalidSandboxIdError`, `ScopeMismatchError`) with
 *       stable `code` discriminators suitable for API error responses.
 */

import { z } from "zod";

// ── Pattern ──────────────────────────────────────────────────────────────────

/**
 * The canonical sandbox slug pattern. `sbx-` prefix + 7 lowercase
 * alphanumeric characters. Fixed-length for path safety (no traversal),
 * dense enough for ~78 billion unique slugs.
 *
 * Keep this regex in sync with:
 *   - `packages/vps/src/shell/helpers/agent-namespace/validation.sh` (SSoT
 *     on the VPS shell side).
 *   - Database CHECK constraints (see `sandboxes` table migration).
 */
export const SANDBOX_ID_RE = /^sbx-[a-z0-9]{7}$/;

// ── Brand ────────────────────────────────────────────────────────────────────

declare const __sandboxBrand: unique symbol;

/**
 * A validated sandbox slug.
 *
 * `SandboxId` is assignable to `string` (it IS a string at runtime), but a
 * raw `string` is NOT assignable to `SandboxId`. The only way to obtain one
 * is to call a parser defined in this module — which guarantees the value
 * has been checked against `SANDBOX_ID_RE`.
 *
 * Consequence: if a function parameter is typed `SandboxId`, TypeScript will
 * refuse to compile any call site that passes an unvalidated string. Missing
 * validation becomes a compile error, not a runtime bug.
 */
export type SandboxId = string & { readonly [__sandboxBrand]: true };

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when an input fails to parse as a `SandboxId`. Exposes a stable
 * `code` for API error responses and a safe `input` snapshot (truncated)
 * for logs — never leak full untrusted input verbatim.
 */
export class InvalidSandboxIdError extends Error {
  readonly code = "INVALID_SANDBOX_ID" as const;
  /** Truncated, safe-to-log representation of the failing input. */
  readonly safeInput: string;

  constructor(input: unknown, reason: string) {
    super(`Invalid sandbox id: ${reason}`);
    this.name = "InvalidSandboxIdError";
    this.safeInput = safeStringify(input);
  }
}

/**
 * Thrown when the scope bound to the caller's authenticated session does
 * not match the scope specified in the request. Prevents an authenticated
 * agent for sandbox A from issuing a request targeting sandbox B.
 */
export class ScopeMismatchError extends Error {
  readonly code = "SCOPE_MISMATCH" as const;

  constructor(
    readonly sessionScope: SandboxId,
    readonly requestedScope: SandboxId,
  ) {
    super(
      `Session bound to ${sessionScope} cannot act on ${requestedScope}`,
    );
    this.name = "ScopeMismatchError";
  }
}

function safeStringify(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 64);
  if (input === null) return "null";
  if (input === undefined) return "undefined";
  try {
    return JSON.stringify(input).slice(0, 64);
  } catch {
    return `[${typeof input}]`;
  }
}

// ── Predicates & parsers ─────────────────────────────────────────────────────

/**
 * Type guard — narrows `unknown` to `SandboxId` without throwing. Use for
 * conditional logic; use `parseSandboxId` when you need the value.
 */
export function isSandboxId(input: unknown): input is SandboxId {
  return typeof input === "string" && SANDBOX_ID_RE.test(input);
}

/**
 * Parse a value as a `SandboxId`. Throws `InvalidSandboxIdError` on failure.
 * Use at every system boundary (HTTP route, WebSocket message, DB row read
 * of untrusted data, etc.).
 */
export function parseSandboxId(input: unknown): SandboxId {
  if (typeof input !== "string") {
    throw new InvalidSandboxIdError(input, "not a string");
  }
  if (!SANDBOX_ID_RE.test(input)) {
    throw new InvalidSandboxIdError(input, "does not match /^sbx-[a-z0-9]{7}$/");
  }
  return input as SandboxId;
}

/**
 * Non-throwing variant of `parseSandboxId`. Returns `null` on failure.
 * Prefer `parseSandboxId` at trust boundaries so failures are logged; use
 * `tryParseSandboxId` only when the caller handles the null explicitly.
 */
export function tryParseSandboxId(input: unknown): SandboxId | null {
  return isSandboxId(input) ? input : null;
}

/**
 * Assert that an already-`string`-typed value is a `SandboxId`. Narrows the
 * compile-time type in place. Throws on failure.
 */
export function assertSandboxId(input: string): asserts input is SandboxId {
  if (!SANDBOX_ID_RE.test(input)) {
    throw new InvalidSandboxIdError(input, "does not match /^sbx-[a-z0-9]{7}$/");
  }
}

/**
 * Coerce a nested filesystem path (e.g. `sbx-xyz/my-app`,
 * `sbx-xyz/my-turbo/packages/web`) to its enclosing `SandboxId`.
 *
 * Strict by design — the sandbox id MUST be the head segment.
 * `../sbx-xyz`, `/sbx-xyz`, `foo/sbx-xyz` all reject. For absolute
 * cwds where the slug is nested under a known parent (e.g.
 * `/home/dev/projects/sbx-xyz/my-app`), use `sandboxIdFromCwd`
 * which scans for the slug anywhere in the path.
 *
 * Throws `InvalidSandboxIdError` if the head segment is not a valid slug.
 */
export function sandboxIdFromPath(input: unknown): SandboxId {
  if (typeof input !== "string") {
    throw new InvalidSandboxIdError(input, "not a string");
  }
  const head = input.split("/", 1)[0] ?? "";
  return parseSandboxId(head);
}

/**
 * Pattern matching a sandbox slug embedded anywhere inside a path —
 * preceded by `/` or start-of-string and followed by `/` or end-of-string.
 * Internal to `sandboxIdFromCwd`; do not export. Centralised here so
 * "look for the sandbox somewhere in this cwd" never gets re-spelled by
 * callers (which is how the layout drift between `/home/dev/sbx-xyz` and
 * `/home/dev/projects/sbx-xyz` produced four separate adapter regressions).
 */
const SANDBOX_ID_IN_PATH_RE = /(?:^|\/)(sbx-[a-z0-9]{7})(?:\/|$)/;

/**
 * Locate the `SandboxId` embedded somewhere inside an absolute or nested
 * path (e.g. `/home/dev/projects/sbx-xyz1234/my-app`,
 * `/home/coder/sbx-xyz1234`, `something/sbx-xyz1234/sub`). Use this when
 * the caller has a process cwd / project workspace path and the slug
 * may sit under a varying parent (`projects/`, tier-specific home, etc.)
 * — distinct from `sandboxIdFromPath`, which requires the slug to be the
 * head segment of a relative path.
 *
 * NOTE: this does NOT validate that the path is rooted at any particular
 * service home. Callers receiving untrusted paths (HTTP request bodies)
 * must validate the prefix separately to prevent scope-confusion.
 *
 * Throws `InvalidSandboxIdError` if no slug is present.
 */
export function sandboxIdFromCwd(input: unknown): SandboxId {
  if (typeof input !== "string") {
    throw new InvalidSandboxIdError(input, "not a string");
  }
  const match = input.match(SANDBOX_ID_IN_PATH_RE);
  if (!match) {
    throw new InvalidSandboxIdError(input, "no sandbox segment in path");
  }
  return parseSandboxId(match[1]!);
}

// ── Zod schema ───────────────────────────────────────────────────────────────

/**
 * Zod schema for use in HTTP route handlers, WebSocket message validators,
 * and any other zod-based parsing. Parses a raw `string` input and produces
 * a branded `SandboxId` output — `z.infer<typeof SandboxIdSchema>` is
 * `SandboxId`, matching the invariant that every validated scope is
 * nominally typed.
 *
 * Usage:
 *   const body = z.object({ sandboxId: SandboxIdSchema }).parse(input);
 *   // body.sandboxId is typed `SandboxId`, safe to pass to security
 *   // services whose parameters are declared as `SandboxId`.
 */
export const SandboxIdSchema = z
  .string()
  .regex(SANDBOX_ID_RE, "must match /^sbx-[a-z0-9]{7}$/")
  .transform((s): SandboxId => s as SandboxId);
