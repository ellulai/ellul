// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';

/**
 * Shell escape function — extracted for testing.
 * Must match the implementation in env-inject.ts.
 */
function shellEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
}

describe('shellEscape', () => {
  it('escapes dollar signs', () => {
    expect(shellEscape('pk_$live_key')).toBe('pk_\\$live_key');
  });

  it('escapes backticks', () => {
    expect(shellEscape('value`injection`')).toBe('value\\`injection\\`');
  });

  it('escapes double quotes', () => {
    expect(shellEscape('has"quote')).toBe('has\\"quote');
  });

  it('escapes backslashes', () => {
    expect(shellEscape('path\\to\\thing')).toBe('path\\\\to\\\\thing');
  });

  it('escapes exclamation marks (bash history expansion)', () => {
    expect(shellEscape('secret!value')).toBe('secret\\!value');
  });

  it('handles all dangerous chars together', () => {
    const input = 'a$b`c"d\\e!f';
    const expected = 'a\\$b\\`c\\"d\\\\e\\!f';
    expect(shellEscape(input)).toBe(expected);
  });

  it('passes through safe values unchanged', () => {
    expect(shellEscape('sk_test_abc123')).toBe('sk_test_abc123');
    expect(shellEscape('postgresql://user:pass@host:5432/db')).toBe(
      'postgresql://user:pass@host:5432/db',
    );
  });

  it('handles empty string', () => {
    expect(shellEscape('')).toBe('');
  });

  it('handles single-char dangerous values', () => {
    expect(shellEscape('$')).toBe('\\$');
    expect(shellEscape('\\')).toBe('\\\\');
  });

  it('escapes real-world API keys with special chars', () => {
    // Some API keys contain $ or + or /
    const key = 'sk_live_a$b+c/d=e';
    const escaped = shellEscape(key);
    // Only $ needs escaping; + / = are safe in double quotes
    expect(escaped).toBe('sk_live_a\\$b+c/d=e');
  });
});
