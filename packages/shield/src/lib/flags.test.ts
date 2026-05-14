// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';
import { parseArgs } from './flags';

describe('parseArgs', () => {
  // ── Existing format: --flag=value ──

  it('parses --flag=value format', () => {
    const args = parseArgs(['--domain=example.com']);
    expect(args.get('domain')).toBe('example.com');
    expect(args.has('domain')).toBe(true);
  });

  it('parses --flag=value with empty value', () => {
    const args = parseArgs(['--domain=']);
    expect(args.get('domain')).toBe('');
  });

  it('parses --flag=value with equals in value', () => {
    const args = parseArgs(['--query=a=b']);
    expect(args.get('query')).toBe('a=b');
  });

  // ── New format: --flag value ──

  it('parses --flag value format', () => {
    const args = parseArgs(['--domain', 'example.com']);
    expect(args.get('domain')).toBe('example.com');
  });

  it('does not consume next arg if it starts with --', () => {
    const args = parseArgs(['--domain', '--json']);
    expect(args.flags['domain']).toBe(true);
    expect(args.has('json')).toBe(true);
  });

  // ── Boolean flags ──

  it('parses known boolean flags', () => {
    const args = parseArgs(['--json', '--help', '--version', '--dry-run']);
    expect(args.has('json')).toBe(true);
    expect(args.has('help')).toBe(true);
    expect(args.has('version')).toBe(true);
    expect(args.has('dry-run')).toBe(true);
    // Boolean flags should not have string values
    expect(args.get('json')).toBeUndefined();
  });

  it('known booleans never consume next arg', () => {
    const args = parseArgs(['--json', 'init']);
    expect(args.has('json')).toBe(true);
    expect(args.positional).toEqual(['init']);
  });

  // ── Positional arguments ──

  it('collects positional arguments', () => {
    const args = parseArgs(['init', 'My App', '--json']);
    expect(args.positional).toEqual(['init', 'My App']);
    expect(args.has('json')).toBe(true);
  });

  it('handles mixed flags and positionals', () => {
    const args = parseArgs(['env', '--project=myapp', '--env=production', '--json']);
    expect(args.positional).toEqual(['env']);
    expect(args.get('project')).toBe('myapp');
    expect(args.get('env')).toBe('production');
    expect(args.has('json')).toBe(true);
  });

  // ── -- terminator ──

  it('stops parsing flags after --', () => {
    const args = parseArgs(['--json', '--', '--not-a-flag']);
    expect(args.has('json')).toBe(true);
    expect(args.positional).toEqual(['--not-a-flag']);
    expect(args.has('not-a-flag')).toBe(false);
  });

  // ── Edge cases ──

  it('returns empty results for no args', () => {
    const args = parseArgs([]);
    expect(args.positional).toEqual([]);
    expect(args.flags).toEqual({});
  });

  it('has() returns false for missing flags', () => {
    const args = parseArgs([]);
    expect(args.has('json')).toBe(false);
    expect(args.get('json')).toBeUndefined();
  });

  it('handles multiple flags together', () => {
    const args = parseArgs([
      'env', 'import',
      '.env',
      '--app=myapp',
      '--env', 'development',
      '--dry-run',
      '--json',
    ]);
    expect(args.positional).toEqual(['env', 'import', '.env']);
    expect(args.get('app')).toBe('myapp');
    expect(args.get('env')).toBe('development');
    expect(args.has('dry-run')).toBe(true);
    expect(args.has('json')).toBe(true);
  });

  it('unknown flag with no next arg is boolean', () => {
    const args = parseArgs(['--unknown']);
    expect(args.flags['unknown']).toBe(true);
    expect(args.get('unknown')).toBeUndefined();
  });

  // ── Edge cases: value consumption ──

  it('--flag value consumes positional-looking value', () => {
    // --name init → name="init", not name=true + positional "init"
    const args = parseArgs(['--name', 'init']);
    expect(args.get('name')).toBe('init');
    expect(args.positional).toEqual([]);
  });

  it('--flag value does not consume value starting with --', () => {
    // --name --other → name=true, other=true
    const args = parseArgs(['--name', '--other']);
    expect(args.flags['name']).toBe(true);
    expect(args.flags['other']).toBe(true);
  });

  it('handles value that looks like a flag via = syntax', () => {
    // --msg=--help → msg="--help"
    const args = parseArgs(['--msg=--help']);
    expect(args.get('msg')).toBe('--help');
  });

  it('preserves positional order with interleaved flags', () => {
    const args = parseArgs(['init', '--json', 'My App']);
    expect(args.positional).toEqual(['init', 'My App']);
    expect(args.has('json')).toBe(true);
  });

  it('-- allows flag-like positionals', () => {
    const args = parseArgs(['--', '--json', '--help']);
    expect(args.positional).toEqual(['--json', '--help']);
    expect(args.has('json')).toBe(false);
    expect(args.has('help')).toBe(false);
  });

  it('handles repeated flags (last wins)', () => {
    const args = parseArgs(['--env=production', '--env=development']);
    expect(args.get('env')).toBe('development');
  });

  it('handles - as positional (stdin marker)', () => {
    const args = parseArgs(['env', 'import', '-', '--json']);
    expect(args.positional).toEqual(['env', 'import', '-']);
    expect(args.has('json')).toBe(true);
  });

  it('empty string positional is preserved', () => {
    const args = parseArgs(['init', '']);
    expect(args.positional).toEqual(['init', '']);
  });
});
