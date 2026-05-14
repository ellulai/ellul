// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setJsonMode, success, fail, info, status, EXIT, isJsonMode } from './output';

describe('output', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    setJsonMode(false);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    setJsonMode(false);
  });

  // ── JSON mode ──

  describe('success()', () => {
    it('writes JSON envelope to stdout in json mode', () => {
      setJsonMode(true);
      success({ projectId: '123', projectName: 'test' });

      expect(stdoutWrite).toHaveBeenCalledOnce();
      const output = JSON.parse((stdoutWrite.mock.calls[0]![0] as string).trim());
      expect(output).toEqual({
        ok: true,
        data: { projectId: '123', projectName: 'test' },
      });
    });

    it('is a no-op in human mode', () => {
      setJsonMode(false);
      success({ projectId: '123' });

      expect(stdoutWrite).not.toHaveBeenCalled();
    });
  });

  // ── info() ──

  describe('info()', () => {
    it('writes to stderr in human mode', () => {
      setJsonMode(false);
      info('init', 'Something happened');

      expect(stderrWrite).toHaveBeenCalledWith('[init] Something happened\n');
    });

    it('is suppressed in json mode', () => {
      setJsonMode(true);
      info('init', 'Something happened');

      expect(stderrWrite).not.toHaveBeenCalled();
    });
  });

  // ── status() ──

  describe('status()', () => {
    it('writes indented status in human mode', () => {
      setJsonMode(false);
      status('✓', 'Done');

      expect(stderrWrite).toHaveBeenCalledWith('  ✓ Done\n');
    });

    it('is suppressed in json mode', () => {
      setJsonMode(true);
      status('✓', 'Done');

      expect(stderrWrite).not.toHaveBeenCalled();
    });
  });

  // ── isJsonMode() ──

  describe('isJsonMode()', () => {
    it('returns false by default', () => {
      expect(isJsonMode()).toBe(false);
    });

    it('returns true after setJsonMode(true)', () => {
      setJsonMode(true);
      expect(isJsonMode()).toBe(true);
    });
  });

  // ── fail() ──

  describe('fail()', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('writes JSON error envelope to stdout in json mode', () => {
      setJsonMode(true);
      try { fail(EXIT.AUTH, 'test', 'Auth failed', 'Run login'); } catch {}

      expect(stdoutWrite).toHaveBeenCalledOnce();
      const output = JSON.parse((stdoutWrite.mock.calls[0]![0] as string).trim());
      expect(output).toEqual({
        ok: false,
        error: {
          code: 'AUTH_ERROR',
          message: 'Auth failed',
          hint: 'Run login',
        },
      });
    });

    it('writes to stderr in human mode', () => {
      setJsonMode(false);
      try { fail(EXIT.USAGE, 'init', 'Missing arg', 'Usage: ellul init'); } catch {}

      expect(stderrWrite).toHaveBeenCalledWith('[init] Missing arg\n');
      expect(stderrWrite).toHaveBeenCalledWith('[init] Usage: ellul init\n');
    });

    it('exits with correct code', () => {
      setJsonMode(false);
      try { fail(EXIT.NETWORK, 'test', 'timeout'); } catch {}

      expect(exitSpy).toHaveBeenCalledWith(EXIT.NETWORK);
    });

    it('omits hint from JSON when not provided', () => {
      setJsonMode(true);
      try { fail(EXIT.USAGE, 'test', 'bad input'); } catch {}

      const output = JSON.parse((stdoutWrite.mock.calls[0]![0] as string).trim());
      expect(output.error.hint).toBeUndefined();
    });

    it('maps all exit codes to error code strings', () => {
      const mappings: [number, string][] = [
        [EXIT.USAGE, 'USAGE_ERROR'],
        [EXIT.AUTH, 'AUTH_ERROR'],
        [EXIT.NETWORK, 'NETWORK_ERROR'],
        [EXIT.CONFLICT, 'CONFLICT'],
      ];
      for (const [exitCode, errorCode] of mappings) {
        stdoutWrite.mockClear();
        setJsonMode(true);
        try { fail(exitCode as any, 'test', 'msg'); } catch {}
        const output = JSON.parse((stdoutWrite.mock.calls[0]![0] as string).trim());
        expect(output.error.code).toBe(errorCode);
      }
    });
  });

  // ── EXIT codes ──

  describe('EXIT codes', () => {
    it('has correct values', () => {
      expect(EXIT.SUCCESS).toBe(0);
      expect(EXIT.USAGE).toBe(1);
      expect(EXIT.AUTH).toBe(2);
      expect(EXIT.NETWORK).toBe(3);
      expect(EXIT.CONFLICT).toBe(4);
    });
  });
});
