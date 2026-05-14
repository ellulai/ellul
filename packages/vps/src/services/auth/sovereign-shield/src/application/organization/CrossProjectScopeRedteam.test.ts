// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Red-team tests for the cross-project scope-confusion matcher.
 *
 * Documents known bypass attempts, current behaviour for each, and which
 * defense layer catches it (if any). Cases marked "gap" are intentionally
 * accepted — they would require semantic intent analysis to catch and are
 * out of scope for the string-based matcher. Each gap has a fallback
 * layer that still protects the user from the actual attack (the agent
 * can write anything in a reason, but if the tool call itself targets a
 * sandbox-scoped capability with shared-path args, L1 still denies it).
 *
 * If a test here starts failing after a code change: that's a behaviour
 * shift — either the matcher got stricter (good, update the assertion) or
 * a gap got closed (great, re-classify the test) or something regressed
 * (investigate).
 */

import { describe, it, expect } from 'vitest';
import { parseSandboxId, type SandboxId } from '@ellul.ai/types';
import {
  matchScopeConfusionInReason,
  extractSharedPathHintsFromJson,
  isSandboxScopedCapability,
} from '@vps/shared/cross-project-scope';

const B: SandboxId = parseSandboxId('sbx-bbbbbbb');
const C: SandboxId = parseSandboxId('sbx-ccccccc');
const SHARED = [B, C];

describe('red-team: reason-string bypass attempts', () => {
  it('CAUGHT: reason includes `.shared/<B>/...`', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'to query .shared/sbx-bbbbbbb/schema');
    expect(hit?.sharedSandbox).toBe(B);
  });

  it('CAUGHT: reason includes absolute path `/home/dev/projects/<B>`', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'need to read /home/dev/projects/sbx-bbbbbbb/data');
    expect(hit?.sharedSandbox).toBe(B);
  });

  it('CAUGHT: reason includes bare slug anywhere as a token', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'for sbx-bbbbbbb');
    expect(hit?.sharedSandbox).toBe(B);
  });

  it('GAP: reason avoids naming the shared sandbox at all', () => {
    // If the agent doesn't mention the shared sandbox, the reason matcher
    // has no signal. This is a fundamental limit of string-based matching.
    // Falls back to L1 (tool-args scanning) if the tool call targets a
    // sandbox-scoped capability.
    const hit = matchScopeConfusionInReason(SHARED, 'need db_read to query users');
    expect(hit).toBeNull();
  });

  it('GAP: reason uses indirect paraphrase ("the other sandbox")', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'to read data from the other sandbox');
    expect(hit).toBeNull();
  });

  it('CAUGHT: reason embeds slug inside a longer sentence with punctuation', () => {
    const hit = matchScopeConfusionInReason(SHARED, 'Compare our schema to sbx-bbbbbbb, then...');
    expect(hit?.sharedSandbox).toBe(B);
  });

  it('BLOCKED: slug-shaped substring of unrelated identifier does NOT false-match', () => {
    // Agent or app writes something like `sbx-bbbbbbbsuffix` or `foosbx-bbbbbbb`.
    // The word-boundary anchor prevents substring matches, so these benign
    // strings don't get denied.
    expect(matchScopeConfusionInReason(SHARED, 'mysbx-bbbbbbbsuffix identifier')).toBeNull();
    expect(matchScopeConfusionInReason(SHARED, 'foosbx-bbbbbbbbar thing')).toBeNull();
  });

  it('BLOCKED: non-shared slug of same shape is NOT denied', () => {
    // Valid slug shape but not in the reader's shared list — must not deny.
    expect(matchScopeConfusionInReason(SHARED, 'for sbx-zzzzzzz processing')).toBeNull();
  });

  it('CAUGHT: case variations on `.shared/` and slug', () => {
    expect(matchScopeConfusionInReason(SHARED, 'see .SHARED/SBX-BBBBBBB/x')?.sharedSandbox).toBe(B);
    expect(matchScopeConfusionInReason(SHARED, 'see .Shared/Sbx-Bbbbbbb/x')?.sharedSandbox).toBe(B);
  });

  it('CAUGHT: hyphens/quotes/punctuation adjacent to the slug do not break match', () => {
    expect(matchScopeConfusionInReason(SHARED, 'for "sbx-bbbbbbb"')?.sharedSandbox).toBe(B);
    expect(matchScopeConfusionInReason(SHARED, '(sbx-bbbbbbb)')?.sharedSandbox).toBe(B);
    expect(matchScopeConfusionInReason(SHARED, '[sbx-bbbbbbb]')?.sharedSandbox).toBe(B);
  });

  it('CAUGHT: markdown-style inline code around the slug', () => {
    expect(matchScopeConfusionInReason(SHARED, 'see `sbx-bbbbbbb` in the config')?.sharedSandbox).toBe(B);
  });

  it('GAP: obfuscated slug (separator injected) is NOT caught by matcher', () => {
    // `sbx- bbbbbbb` with a space, or `sbx-b b b b b b b`. Not matched.
    // A real agent would have to be actively evasive to write this; for
    // legitimate scope-confusion (accidental) this doesn't arise. L1
    // (args scanning) or the deny-outcome on the actual tool invocation
    // is the backstop.
    expect(matchScopeConfusionInReason(SHARED, 'for sbx -bbbbbbb data')).toBeNull();
    expect(matchScopeConfusionInReason(SHARED, 'for sbx - bbbbbbb data')).toBeNull();
  });

  it('GAP: slug written backwards or transposed is NOT caught', () => {
    // `bbbbbbb-xbs` — wrong order, no match.
    expect(matchScopeConfusionInReason(SHARED, 'for bbbbbbb-xbs data')).toBeNull();
  });
});

describe('red-team: tool-args bypass attempts', () => {
  it('CAUGHT: args contain `.shared/<B>/path`', () => {
    expect(extractSharedPathHintsFromJson({ path: '.shared/sbx-bbbbbbb/x' }))
      .toContain('.shared/sbx-bbbbbbb');
  });

  it('CAUGHT: args contain absolute `/projects/<B>`', () => {
    expect(extractSharedPathHintsFromJson({ cwd: '/home/dev/projects/sbx-bbbbbbb' }))
      .toContain('/projects/sbx-bbbbbbb');
  });

  it('CAUGHT: path buried inside a deeply nested object', () => {
    const args = { config: { source: { dir: '.shared/sbx-bbbbbbb/src' } } };
    expect(extractSharedPathHintsFromJson(args)).toContain('.shared/sbx-bbbbbbb');
  });

  it('CAUGHT: path appears inside an SQL literal in args', () => {
    const args = { sql: "COPY x FROM '/home/dev/projects/sbx-bbbbbbb/data.csv'" };
    expect(extractSharedPathHintsFromJson(args)).toContain('/projects/sbx-bbbbbbb');
  });

  it('CAUGHT: path appears as a comment inside code args', () => {
    const args = { code: "// check .shared/sbx-bbbbbbb/foo.ts\nconst x = 1;" };
    expect(extractSharedPathHintsFromJson(args)).toContain('.shared/sbx-bbbbbbb');
  });

  it('GAP: args URL-encoded (`%2Eshared%2Fsbx-bbbbbbb`) is NOT caught', () => {
    // Tool args with URL-encoded paths are a legitimate case for some
    // tools (HTTP requests). Detection would require decoding every arg,
    // which risks false positives. Not a real risk in practice —
    // sandbox-scoped tools (db/secrets/deploy) don't take URL-encoded
    // paths, so L1 still works; scope-confusion via this vector would
    // have to be in the agent's reason text, caught by L3.
    expect(extractSharedPathHintsFromJson({ url: '/%2Eshared%2Fsbx-bbbbbbb' }))
      .toEqual([]);
  });

  it('BLOCKED: cap at 5 hints prevents reason-field blowup', () => {
    const args: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      args[`k${i}`] = `.shared/sbx-${String(i).padStart(7, 'a')}`;
    }
    const hints = extractSharedPathHintsFromJson(args);
    expect(hints.length).toBeLessThanOrEqual(5);
  });

  it('BLOCKED: does not walk into arg values that only happen to contain the word "shared"', () => {
    expect(extractSharedPathHintsFromJson({ note: 'shared folder' })).toEqual([]);
    expect(extractSharedPathHintsFromJson({ note: 'sharing data' })).toEqual([]);
  });
});

describe('red-team: capability classification correctness', () => {
  it('BLOCKED: filesystem reads on .shared/* remain ALLOWED (inspection is the point)', () => {
    expect(isSandboxScopedCapability('filesystem:read')).toBe(false);
  });

  it('BLOCKED: network calls remain ALLOWED regardless of args', () => {
    expect(isSandboxScopedCapability('network:http_read')).toBe(false);
    expect(isSandboxScopedCapability('network:http_write')).toBe(false);
  });

  it('CAUGHT: every database capability is sandbox-scoped', () => {
    expect(isSandboxScopedCapability('database:read')).toBe(true);
    expect(isSandboxScopedCapability('database:write')).toBe(true);
    expect(isSandboxScopedCapability('database:migrate')).toBe(true);
  });

  it('CAUGHT: every secrets capability is sandbox-scoped', () => {
    expect(isSandboxScopedCapability('secrets:env_read')).toBe(true);
    expect(isSandboxScopedCapability('secrets:env_inject')).toBe(true);
    expect(isSandboxScopedCapability('secrets:vault_read')).toBe(true);
  });

  it('CAUGHT: every deployment capability is sandbox-scoped', () => {
    expect(isSandboxScopedCapability('deployment:git_read')).toBe(true);
    expect(isSandboxScopedCapability('deployment:git_write')).toBe(true);
    expect(isSandboxScopedCapability('deployment:deploy_trigger')).toBe(true);
  });

  it('BLOCKED: unknown / malformed capability strings default to NOT sandbox-scoped', () => {
    expect(isSandboxScopedCapability('')).toBe(false);
    expect(isSandboxScopedCapability('notacap')).toBe(false);
    expect(isSandboxScopedCapability('DATABASE:READ')).toBe(false); // case-sensitive
  });
});
