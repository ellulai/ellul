// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Kill-switch test for `ELLUL_CROSS_PROJECT_SCOPE_CHECK`.
 *
 * The flag is read at module load. These tests prove that every
 * documented way of disabling the check actually produces
 * `SCOPE_CHECK_ENABLED === false`, and that unexpected values leave the
 * check enabled (fail-safe default).
 *
 * Uses `vi.resetModules()` + `vi.stubEnv()` to re-import the module with
 * a different env state, since the constant is captured at load time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

async function loadWithEnv(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (value === undefined) {
    vi.unstubAllEnvs();
  } else {
    vi.stubEnv('ELLUL_CROSS_PROJECT_SCOPE_CHECK', value);
  }
  const mod = await import('@vps/shared/cross-project-scope');
  return mod.SCOPE_CHECK_ENABLED;
}

describe('ELLUL_CROSS_PROJECT_SCOPE_CHECK kill switch', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('unset → enabled (fail-safe default)', async () => {
    expect(await loadWithEnv(undefined)).toBe(true);
  });

  it('empty string → enabled', async () => {
    expect(await loadWithEnv('')).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO'])(
    '%s → disabled',
    async (val) => {
      expect(await loadWithEnv(val)).toBe(false);
    },
  );

  it.each(['1', 'true', 'on', 'yes', 'enabled', 'anything-else'])(
    '%s → enabled (unrecognised values default to enabled)',
    async (val) => {
      expect(await loadWithEnv(val)).toBe(true);
    },
  );

  it('leading/trailing whitespace around "0" still disables', async () => {
    expect(await loadWithEnv('  0  ')).toBe(false);
  });
});

describe('matcher behaviour when flag is disabled', () => {
  // The matcher itself is ALWAYS pure — the flag is consumed at the
  // CALLERS (bridge's mcp-gateway, shield's routes), not inside the
  // matcher. This test documents that invariant: the matcher is honest
  // about what it sees even when the flag is off; callers decide whether
  // to act on the result.
  it('matcher still returns a hit even when flag is disabled — flag gating is at caller level', async () => {
    vi.resetModules();
    vi.stubEnv('ELLUL_CROSS_PROJECT_SCOPE_CHECK', '0');
    const { SCOPE_CHECK_ENABLED, matchScopeConfusionInReason } = await import('@vps/shared/cross-project-scope');
    const { parseSandboxId } = await import('@ellul.ai/types');
    expect(SCOPE_CHECK_ENABLED).toBe(false);
    const B = parseSandboxId('sbx-bbbbbbb');
    const hit = matchScopeConfusionInReason([B], 'read .shared/sbx-bbbbbbb/x');
    // Pure function: always returns the match. Callers MUST gate on SCOPE_CHECK_ENABLED.
    expect(hit?.sharedSandbox).toBe(B);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
