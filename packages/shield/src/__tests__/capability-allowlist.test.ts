// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';
import { matchCapability, isAllowlisted, getRequiredGate } from '../local/gates/capability-allowlist';

describe('capability allowlist', () => {
  describe('matchCapability', () => {
    it('matches npm test', () => {
      const cap = matchCapability('npm test');
      expect(cap?.name).toBe('test');
      expect(cap?.gate).toBe('test');
    });

    it('matches npm test with flags', () => {
      expect(matchCapability('npm test --coverage')?.gate).toBe('test');
    });

    it('matches npm run test', () => {
      expect(matchCapability('npm run test')?.gate).toBe('test');
    });

    it('matches jest', () => {
      expect(matchCapability('jest')?.gate).toBe('test');
    });

    it('matches vitest', () => {
      expect(matchCapability('vitest')?.gate).toBe('test');
    });

    it('matches go test', () => {
      expect(matchCapability('go test ./...')?.gate).toBe('test');
    });

    it('matches pytest', () => {
      expect(matchCapability('pytest -v')?.gate).toBe('test');
    });

    it('matches cargo test', () => {
      expect(matchCapability('cargo test')?.gate).toBe('test');
    });

    it('matches npm run build', () => {
      expect(matchCapability('npm run build')?.gate).toBe('build');
    });

    it('matches tsc', () => {
      expect(matchCapability('tsc')?.gate).toBe('build');
    });

    it('matches go build', () => {
      expect(matchCapability('go build')?.gate).toBe('build');
    });

    it('matches eslint', () => {
      expect(matchCapability('eslint .')?.gate).toBe('lint');
    });

    it('matches npm run dev', () => {
      expect(matchCapability('npm run dev')?.gate).toBe('dev');
    });

    it('matches npm start', () => {
      expect(matchCapability('npm start')?.gate).toBe('dev');
    });

    it('returns null for arbitrary commands', () => {
      expect(matchCapability('rm -rf /')).toBeNull();
      expect(matchCapability('curl evil.com')).toBeNull();
      expect(matchCapability('cat /etc/passwd')).toBeNull();
      expect(matchCapability('node script.js')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(matchCapability('')).toBeNull();
    });
  });

  describe('isAllowlisted', () => {
    it('allows test commands in capability mode', () => {
      expect(isAllowlisted('npm test', 'capability')).toBe(true);
    });

    it('blocks arbitrary commands in capability mode', () => {
      expect(isAllowlisted('rm -rf /', 'capability')).toBe(false);
    });

    it('allows anything in unrestricted mode', () => {
      expect(isAllowlisted('rm -rf /', 'unrestricted')).toBe(true);
      expect(isAllowlisted('curl evil.com', 'unrestricted')).toBe(true);
    });
  });

  describe('getRequiredGate', () => {
    it('returns specific gate in capability mode', () => {
      expect(getRequiredGate('npm test', 'capability')).toBe('test');
      expect(getRequiredGate('npm run build', 'capability')).toBe('build');
      expect(getRequiredGate('eslint .', 'capability')).toBe('lint');
    });

    it('returns null for unknown commands in capability mode', () => {
      expect(getRequiredGate('rm -rf /', 'capability')).toBeNull();
    });

    it('returns exec for all commands in unrestricted mode', () => {
      expect(getRequiredGate('rm -rf /', 'unrestricted')).toBe('exec');
      expect(getRequiredGate('npm test', 'unrestricted')).toBe('exec');
    });
  });
});
