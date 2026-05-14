// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tests for the canonical `SandboxId` scope module (`@ellul.ai/types/scope`).
 *
 * Lives here (in vps) rather than in `packages/types` because the types
 * package has no test runner wired up and vitest is already configured for
 * the vps package. The module under test is cross-cutting, so exercising
 * it from a consumer is appropriate anyway.
 */

import { describe, it, expect } from 'vitest';

import {
  SANDBOX_ID_RE,
  SandboxIdSchema,
  InvalidSandboxIdError,
  ScopeMismatchError,
  isSandboxId,
  parseSandboxId,
  tryParseSandboxId,
  assertSandboxId,
  sandboxIdFromPath,
  type SandboxId,
} from '@ellul.ai/types';

const VALID: readonly string[] = [
  'sbx-abcdefg',
  'sbx-0123456',
  'sbx-a1b2c3d',
  'sbx-zzzzzzz',
  'sbx-d91qavo',
];

const INVALID: readonly unknown[] = [
  '',
  'sbx-',
  'sbx-abcdef',         // 6 chars
  'sbx-abcdefgh',       // 8 chars
  'sbx-ABCDEFG',        // uppercase
  'sbx-abc defg',       // space
  'SBX-abcdefg',        // uppercase prefix
  'prefix-abcdefg',     // wrong prefix
  'sbx-abcdefg/app',    // slash
  '../sbx-abcdefg',     // traversal
  'sbx-abcdefg\n',      // trailing newline
  ' sbx-abcdefg',       // leading whitespace
  null,
  undefined,
  42,
  {},
  [],
  Symbol('x'),
];

describe('SANDBOX_ID_RE', () => {
  it.each(VALID)('accepts %s', (s) => {
    expect(SANDBOX_ID_RE.test(s)).toBe(true);
  });

  it.each(VALID)('anchored both ends — rejects suffix %s', (s) => {
    expect(SANDBOX_ID_RE.test(`${s}extra`)).toBe(false);
    expect(SANDBOX_ID_RE.test(`prefix${s}`)).toBe(false);
  });
});

describe('isSandboxId', () => {
  it.each(VALID)('returns true for %s', (s) => {
    expect(isSandboxId(s)).toBe(true);
  });

  it.each(INVALID)('returns false for %p', (v) => {
    expect(isSandboxId(v)).toBe(false);
  });
});

describe('parseSandboxId', () => {
  it.each(VALID)('returns branded value for %s', (s) => {
    const id = parseSandboxId(s);
    expect(id).toBe(s);
    // Compile-time check: `id` is `SandboxId`, not `string`.
    const _typed: SandboxId = id;
    void _typed;
  });

  it.each(INVALID)('throws InvalidSandboxIdError for %p', (v) => {
    expect(() => parseSandboxId(v)).toThrow(InvalidSandboxIdError);
  });

  it('attaches stable error code', () => {
    try {
      parseSandboxId('not-valid');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSandboxIdError);
      expect((e as InvalidSandboxIdError).code).toBe('INVALID_SANDBOX_ID');
    }
  });

  it('truncates input in safeInput to cap log leakage', () => {
    const bigInput = 'x'.repeat(10_000);
    try {
      parseSandboxId(bigInput);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as InvalidSandboxIdError).safeInput.length).toBeLessThanOrEqual(64);
    }
  });

  it('never emits the raw unknown input in its message', () => {
    const nasty = '"><script>alert(1)</script>';
    try {
      parseSandboxId(nasty);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('<script');
    }
  });
});

describe('tryParseSandboxId', () => {
  it.each(VALID)('returns branded value for %s', (s) => {
    expect(tryParseSandboxId(s)).toBe(s);
  });

  it.each(INVALID)('returns null for %p', (v) => {
    expect(tryParseSandboxId(v)).toBeNull();
  });
});

describe('assertSandboxId', () => {
  it.each(VALID)('narrows %s to SandboxId', (s) => {
    expect(() => assertSandboxId(s)).not.toThrow();
  });

  it('throws on invalid string input', () => {
    expect(() => assertSandboxId('bogus')).toThrow(InvalidSandboxIdError);
  });
});

describe('sandboxIdFromPath', () => {
  it('extracts slug from app directory', () => {
    expect(sandboxIdFromPath('sbx-d91qavo/my-app')).toBe('sbx-d91qavo');
  });

  it('extracts slug from package directory', () => {
    expect(sandboxIdFromPath('sbx-d91qavo/my-turbo/packages/web')).toBe('sbx-d91qavo');
  });

  it('accepts a bare sandbox slug', () => {
    expect(sandboxIdFromPath('sbx-d91qavo')).toBe('sbx-d91qavo');
  });

  it('rejects paths where the head segment is not a valid slug', () => {
    expect(() => sandboxIdFromPath('notasandbox/my-app')).toThrow(InvalidSandboxIdError);
    expect(() => sandboxIdFromPath('../sbx-d91qavo')).toThrow(InvalidSandboxIdError);
    expect(() => sandboxIdFromPath('/sbx-d91qavo')).toThrow(InvalidSandboxIdError);
  });

  it('rejects non-string input', () => {
    expect(() => sandboxIdFromPath(null as unknown as string)).toThrow(InvalidSandboxIdError);
    expect(() => sandboxIdFromPath(42 as unknown as string)).toThrow(InvalidSandboxIdError);
  });
});

describe('SandboxIdSchema (zod)', () => {
  it.each(VALID)('parses %s to branded SandboxId', (s) => {
    const out = SandboxIdSchema.parse(s);
    expect(out).toBe(s);
    const _typed: SandboxId = out;
    void _typed;
  });

  it.each(INVALID)('rejects %p', (v) => {
    expect(() => SandboxIdSchema.parse(v)).toThrow();
  });

  it('safeParse yields structured error on bad input', () => {
    const r = SandboxIdSchema.safeParse('bogus');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/sbx-/);
    }
  });
});

describe('ScopeMismatchError', () => {
  it('attaches stable code and retains both scopes', () => {
    const a = parseSandboxId('sbx-aaaaaaa');
    const b = parseSandboxId('sbx-bbbbbbb');
    const err = new ScopeMismatchError(a, b);
    expect(err.code).toBe('SCOPE_MISMATCH');
    expect(err.sessionScope).toBe(a);
    expect(err.requestedScope).toBe(b);
    expect(err.message).toContain('sbx-aaaaaaa');
    expect(err.message).toContain('sbx-bbbbbbb');
  });
});

describe('property — parseSandboxId is deterministic & idempotent', () => {
  it('parse(parse(x).toString()) === parse(x) for every valid slug', () => {
    for (const s of VALID) {
      const once = parseSandboxId(s);
      const twice = parseSandboxId(once); // SandboxId IS a string at runtime
      expect(twice).toBe(once);
    }
  });

  it('fuzz — only values matching the regex are accepted', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-/.ABCXYZ_ ';
    for (let i = 0; i < 500; i++) {
      const len = 1 + Math.floor(Math.random() * 20);
      let s = '';
      for (let j = 0; j < len; j++) {
        s += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      const shouldAccept = SANDBOX_ID_RE.test(s);
      expect(isSandboxId(s)).toBe(shouldAccept);
      if (shouldAccept) {
        expect(() => parseSandboxId(s)).not.toThrow();
      } else {
        expect(() => parseSandboxId(s)).toThrow(InvalidSandboxIdError);
      }
    }
  });
});
