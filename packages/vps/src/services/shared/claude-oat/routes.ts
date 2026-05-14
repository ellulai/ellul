// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Shield's HTTP route paths for the Claude OAT credential subsystem.
 *
 * Defining the paths here (not inline in route handlers) keeps shield's
 * router and bridge's client in lockstep — a typo in either fails type
 * checking, not at runtime.
 */

export const CLAUDE_OAT_ROUTES = {
  /** User pasted token in workbench login modal. Body: SaveRequest. */
  save: "/api/internal/claude-oat/save",
  /** UI status query. Returns SafePeekResponse — never the token itself. */
  peek: "/api/internal/claude-oat/peek",
  /** Bridge requests a one-time issuance token before spawning claude. */
  issue: "/api/internal/claude-oat/issue",
  /** Launcher redeems an issuance token for the actual OAT. Single-use. */
  redeem: "/api/internal/claude-oat/redeem",
  /** Bridge reports an upstream 401. Audit-only — does NOT mutate state. */
  report401: "/api/internal/claude-oat/report-401",
  /** User clicked logout. Moves state to revoked, clears token. */
  revoke: "/api/internal/claude-oat/revoke",
} as const;

/** Path-prefix used by middleware ACL. All claude-oat endpoints share it. */
export const CLAUDE_OAT_ROUTE_PREFIX = "/api/internal/claude-oat/";
