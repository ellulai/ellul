// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Policy constants — shared across the shield/bridge boundary.
 *
 * These are *policy* values, not implementation details: they encode
 * the SLOs and security guarantees the subsystem promises. Changing one
 * of these constants is a deliberate design decision that should be
 * reviewed against the threat model in
 * docs/v2/security/14-claude-oat-credentials.md.
 */

/** OAT token shape. Anthropic-issued, ~108 chars. */
export const OAT_TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{60,200}$/;

/** Issuance token TTL. Long enough to spawn claude, short enough to limit replay. */
export const ISSUANCE_TOKEN_TTL_MS = 60_000;

/** Probe interval — every 10s shield verifies the active credential. */
export const PROBE_INTERVAL_MS = 10_000;

/** Probe HTTP timeout. Network slowness ≠ auth failure. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Quorum window — how many failures within this window trigger revoke. */
export const QUORUM_FAILURE_THRESHOLD = 3;
export const QUORUM_WINDOW_MS = 90_000;

/** Backoff after rate-limit (429). Linear: 30s, 60s, 120s, 300s capped. */
export const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

/** Anthropic API base URL — used by shield's probe loop. */
export const ANTHROPIC_API_BASE = "https://api.anthropic.com";

/** Probe model — cheapest Claude model, smallest possible request. */
export const PROBE_MODEL = "claude-haiku-4-5";

/** Anthropic API version header. */
export const ANTHROPIC_API_VERSION = "2023-06-01";
