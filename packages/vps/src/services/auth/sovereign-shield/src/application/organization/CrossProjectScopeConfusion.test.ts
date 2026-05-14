// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tests the pure cross-project scope-confusion helpers — the authoritative
 * enforcement that structurally blocks agents in sandbox A from requesting
 * gates or invoking sandbox-scoped tools that target `.shared/<B>/`
 * content. Any such grant would apply to A's data, not B's, so the popup
 * would be pure noise (at best) or a social-engineering vector (at worst).
 */

import { describe, it, expect } from 'vitest';
import { parseSandboxId, type SandboxId } from '@ellul.ai/types';
import {
  matchScopeConfusionInReason,
  extractSharedPathHintsFromJson,
  enrichReasonWithHints,
  isSandboxScopedCapability,
  SCOPE_CHECK_ENABLED,
} from '@vps/shared/cross-project-scope';

const B: SandboxId = parseSandboxId('sbx-bbbbbbb');
const C: SandboxId = parseSandboxId('sbx-ccccccc');
const SHARED = [B, C];

describe('matchScopeConfusionInReason', () => {
  it('returns null when there are no shared sandboxes', () => {
    expect(matchScopeConfusionInReason([], 'need db access for sbx-bbbbbbb'))
      .toBeNull();
  });

  it('returns null when reason is empty', () => {
    expect(matchScopeConfusionInReason(SHARED, '')).toBeNull();
  });

  // ── Pattern 1: .shared/<slug> ──
  it('matches `.shared/<slug>/` path reference', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'read .shared/sbx-bbbbbbb/src/app.ts');
    expect(hit).toEqual({ sharedSandbox: B, matchedToken: '.shared/sbx-bbbbbbb' });
  });

  it('matches `.shared/<slug>` without trailing slash', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'inspecting .shared/sbx-ccccccc files');
    expect(hit).toEqual({ sharedSandbox: C, matchedToken: '.shared/sbx-ccccccc' });
  });

  it('does NOT match a .shared path pointing to a sandbox we do NOT have access to', () => {
    expect(matchScopeConfusionInReason(SHARED, 'reading .shared/sbx-zzzzzzz/file'))
      .toBeNull();
  });

  // ── Pattern 2: /projects/<sbx-xxxxxxx> absolute path ──
  it('matches `/projects/<sbx-xxxxxxx>/…` absolute path', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'stat /home/dev/projects/sbx-bbbbbbb/app.ts');
    expect(hit).toEqual({ sharedSandbox: B, matchedToken: '/projects/sbx-bbbbbbb' });
  });

  it('matches `/projects/<slug>` at end of string', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'cd /home/coder/projects/sbx-ccccccc');
    expect(hit).toEqual({ sharedSandbox: C, matchedToken: '/projects/sbx-ccccccc' });
  });

  it('does NOT match `/projects/<slug>` when slug is not shared', () => {
    expect(matchScopeConfusionInReason(SHARED, 'cd /home/dev/projects/sbx-9999999'))
      .toBeNull();
  });

  it('does NOT match `/projects/<slug>` when slug has extra trailing chars', () => {
    // sbx-bbbbbbbXYZ should not match — strict 7-char slug shape.
    expect(matchScopeConfusionInReason(SHARED, 'cd /home/dev/projects/sbx-bbbbbbbxyz'))
      .toBeNull();
  });

  // ── Pattern 3: bare slug ──
  it('matches bare slug appearing as a standalone token', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'to read env vars from sbx-bbbbbbb');
    expect(hit).toEqual({ sharedSandbox: B, matchedToken: 'sbx-bbbbbbb' });
  });

  it('matches bare slug at end of string', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'querying sbx-bbbbbbb');
    expect(hit).toEqual({ sharedSandbox: B, matchedToken: 'sbx-bbbbbbb' });
  });

  it('does NOT match slug as substring of an unrelated identifier', () => {
    expect(matchScopeConfusionInReason(SHARED, 'something mysbx-bbbbbbbsuffix something'))
      .toBeNull();
  });

  it('does NOT match when reason is about THIS sandbox only', () => {
    expect(matchScopeConfusionInReason(SHARED, 'need db_read to query users table'))
      .toBeNull();
  });

  it('prefers `.shared/` match over bare-slug fallback', () => {
    const hit = matchScopeConfusionInReason(
      SHARED,
      'see .shared/sbx-bbbbbbb/app.ts and sbx-ccccccc references',
    );
    expect(hit).toEqual({ sharedSandbox: B, matchedToken: '.shared/sbx-bbbbbbb' });
  });

  it('prefers `/projects/` absolute match over bare-slug fallback', () => {
    const hit = matchScopeConfusionInReason(
      SHARED,
      'see /home/dev/projects/sbx-bbbbbbb and sbx-ccccccc',
    );
    expect(hit).toEqual({ sharedSandbox: B, matchedToken: '/projects/sbx-bbbbbbb' });
  });

  it('matches case-insensitively on bare slug', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'inspect SBX-BBBBBBB database');
    expect(hit).toEqual({ sharedSandbox: B, matchedToken: B });
  });
});

describe('extractSharedPathHintsFromJson', () => {
  it('returns empty array on null/undefined/empty', () => {
    expect(extractSharedPathHintsFromJson(null)).toEqual([]);
    expect(extractSharedPathHintsFromJson(undefined)).toEqual([]);
    expect(extractSharedPathHintsFromJson('')).toEqual([]);
  });

  it('extracts a `.shared/<slug>` path from a string arg', () => {
    expect(extractSharedPathHintsFromJson('read .shared/sbx-bbbbbbb/file.ts'))
      .toEqual(['.shared/sbx-bbbbbbb']);
  });

  it('extracts a `.shared/<slug>` path from a nested object arg', () => {
    const args = { cwd: '/home/dev/projects/sbx-aaaaaaa', path: '.shared/sbx-bbbbbbb/app.ts' };
    expect(extractSharedPathHintsFromJson(args))
      .toEqual(expect.arrayContaining(['.shared/sbx-bbbbbbb']));
  });

  it('extracts `/projects/<slug>` absolute path from args', () => {
    const args = { sql: "SELECT * FROM users WHERE dump='/home/dev/projects/sbx-bbbbbbb/data.csv'" };
    const hints = extractSharedPathHintsFromJson(args);
    expect(hints).toContain('/projects/sbx-bbbbbbb');
  });

  it('deduplicates repeated references', () => {
    const args = {
      a: '.shared/sbx-bbbbbbb/x',
      b: '.shared/sbx-bbbbbbb/y',
      c: '.shared/sbx-bbbbbbb/z',
    };
    const hints = extractSharedPathHintsFromJson(args);
    // All three values yield the same `.shared/sbx-bbbbbbb` token when
    // matched without the trailing segment, so dedup keeps one.
    expect(hints.filter((h) => h === '.shared/sbx-bbbbbbb')).toHaveLength(1);
  });

  it('caps extraction at 5 hints to bound reason-field growth', () => {
    const args = Array.from({ length: 20 }, (_, i) => `.shared/sbx-${String(i).padStart(7, 'a')}`);
    const hints = extractSharedPathHintsFromJson(args);
    expect(hints.length).toBeLessThanOrEqual(5);
  });

  it('does NOT return arbitrary arg contents (only matched substrings)', () => {
    const args = { api_key: 'sk-SECRET-do-not-leak', path: '.shared/sbx-bbbbbbb/config.ts' };
    const hints = extractSharedPathHintsFromJson(args);
    const joined = hints.join('|');
    expect(joined).not.toContain('sk-SECRET');
    expect(joined).not.toContain('api_key');
    expect(hints).toContain('.shared/sbx-bbbbbbb');
  });

  it('handles circular refs without throwing', () => {
    const args: Record<string, unknown> = { a: 1 };
    args.self = args;
    expect(() => extractSharedPathHintsFromJson(args)).not.toThrow();
    // JSON.stringify throws on circular; we return [] on throw.
    expect(extractSharedPathHintsFromJson(args)).toEqual([]);
  });
});

describe('enrichReasonWithHints', () => {
  it('returns reason unchanged when hints empty', () => {
    expect(enrichReasonWithHints('Tool X requires Y gate', [])).toBe('Tool X requires Y gate');
  });

  it('appends hints as bracketed suffix', () => {
    const out = enrichReasonWithHints(
      'Tool db_query requires db_read gate',
      ['.shared/sbx-bbbbbbb', '/projects/sbx-bbbbbbb'],
    );
    expect(out).toBe(
      'Tool db_query requires db_read gate [tool args reference: .shared/sbx-bbbbbbb, /projects/sbx-bbbbbbb]',
    );
  });

  it('produces a reason that the matcher will flag', () => {
    const reason = enrichReasonWithHints(
      'Tool db_query requires db_read gate',
      ['.shared/sbx-bbbbbbb'],
    );
    const hit = matchScopeConfusionInReason(SHARED, reason);
    expect(hit).toEqual({ sharedSandbox: B, matchedToken: '.shared/sbx-bbbbbbb' });
  });
});

describe('isSandboxScopedCapability', () => {
  it.each([
    'database:read',
    'database:write',
    'database:migrate',
    'secrets:env_read',
    'secrets:env_inject',
    'secrets:vault_read',
    'deployment:git_read',
    'deployment:git_write',
    'deployment:deploy_trigger',
    'observability:logs_read',
    'observability:metrics_read',
  ])('flags %s as sandbox-scoped', (cap) => {
    expect(isSandboxScopedCapability(cap)).toBe(true);
  });

  it.each([
    'filesystem:read',
    'filesystem:write',
    'network:http_read',
    'execution:shell',
    'financial:wallet_read',
    // Not a real capability — ensures the default is false.
    'something:unknown',
    '',
  ])('does NOT flag %s as sandbox-scoped', (cap) => {
    expect(isSandboxScopedCapability(cap)).toBe(false);
  });
});

describe('SCOPE_CHECK_ENABLED', () => {
  // The flag is read at module load; we can't toggle it per-test, but we can
  // assert the default posture (the test runner doesn't set the env var).
  it('defaults to enabled when the env var is unset', () => {
    expect(SCOPE_CHECK_ENABLED).toBe(true);
  });
});

describe('L1 bridge-side tool-call denial — combined decision', () => {
  /**
   * Mirrors the decision in `mcp-gateway.callTool` and `tool-resolver.evaluatePolicy`:
   * deny IFF (capability is sandbox-scoped) AND (args contain shared-path hints).
   * This test proves realistic scenarios route to the correct outcome.
   */
  function shouldDenyAtBridge(capability: string, args: unknown): boolean {
    const hints = extractSharedPathHintsFromJson(args);
    return hints.length > 0 && isSandboxScopedCapability(capability);
  }

  it('DENIES db_query against .shared/<B>/schema.sql', () => {
    expect(shouldDenyAtBridge('database:read', { sql: 'read .shared/sbx-bbbbbbb/schema.sql' }))
      .toBe(true);
  });

  it('DENIES get_secret with path arg pointing to another sandbox', () => {
    expect(shouldDenyAtBridge('secrets:env_read', { key: 'API_KEY', path: '/home/dev/projects/sbx-bbbbbbb' }))
      .toBe(true);
  });

  it('DENIES deploy_trigger when the deploy dir is a shared snapshot', () => {
    expect(shouldDenyAtBridge('deployment:deploy_trigger', { cwd: '.shared/sbx-bbbbbbb' }))
      .toBe(true);
  });

  it('ALLOWS filesystem:read on .shared/* — that\'s the whole point of inspection', () => {
    expect(shouldDenyAtBridge('filesystem:read', { path: '.shared/sbx-bbbbbbb/app.ts' }))
      .toBe(false);
  });

  it('ALLOWS execution:shell cd into .shared/<B>/ (read-only ops are fine)', () => {
    expect(shouldDenyAtBridge('execution:shell', { cwd: '.shared/sbx-bbbbbbb', cmd: 'grep foo' }))
      .toBe(false);
  });

  it('ALLOWS sandbox-scoped tool calls WITHOUT cross-sandbox args', () => {
    expect(shouldDenyAtBridge('database:read', { sql: 'SELECT * FROM users' }))
      .toBe(false);
  });

  it('ALLOWS network:http_read — unrelated to sandbox filesystem', () => {
    expect(shouldDenyAtBridge('network:http_read', { url: 'https://api.example.com' }))
      .toBe(false);
  });
});
