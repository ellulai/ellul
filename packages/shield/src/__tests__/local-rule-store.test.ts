// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalRuleStore } from '../local/guardrails/rule-store';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ellul-rules-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LocalRuleStore', () => {
  it('seeds default locked rules on first init', () => {
    const store = new LocalRuleStore(tmpDir);
    const rules = store.listRules();

    expect(rules.length).toBeGreaterThanOrEqual(3);
    const locked = rules.filter(r => r.locked);
    expect(locked.length).toBe(3);

    const names = locked.map(r => r.name);
    expect(names).toContain('no-drop-table');
    expect(names).toContain('no-drop-database');
    expect(names).toContain('no-recursive-delete');
    store.close();
  });

  it('materializes .scm files on init', () => {
    const store = new LocalRuleStore(tmpDir);
    const globalDir = path.join(tmpDir, 'global');
    const files = fs.readdirSync(globalDir).filter(f => f.endsWith('.scm'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    store.close();
  });

  it('creates checksums.json', () => {
    const store = new LocalRuleStore(tmpDir);
    const checksumFile = path.join(tmpDir, 'checksums.json');
    expect(fs.existsSync(checksumFile)).toBe(true);
    const checksums = JSON.parse(fs.readFileSync(checksumFile, 'utf8'));
    expect(Object.keys(checksums).length).toBeGreaterThanOrEqual(3);
    store.close();
  });

  it('adds a custom rule', () => {
    const store = new LocalRuleStore(tmpDir);
    const id = store.addRule({
      language: 'javascript',
      name: 'no-eval',
      query_scm: '(call_expression function: (identifier) @fn (#eq? @fn "eval")) @violation',
      message: 'eval() is blocked',
    });

    expect(id).toContain('custom:');
    const rules = store.listRules();
    const custom = rules.find(r => r.name === 'no-eval');
    expect(custom).toBeDefined();
    expect(custom?.enabled).toBe(1);
    expect(custom?.locked).toBe(0);
    store.close();
  });

  it('prevents deleting locked rules', () => {
    const store = new LocalRuleStore(tmpDir);
    const locked = store.listRules().find(r => r.locked);
    expect(locked).toBeDefined();

    expect(() => store.deleteRule(locked!.id)).toThrow('locked');
    store.close();
  });

  it('prevents disabling locked rules', () => {
    const store = new LocalRuleStore(tmpDir);
    const locked = store.listRules().find(r => r.locked);
    expect(locked).toBeDefined();

    expect(() => store.setRuleEnabled(locked!.id, false)).toThrow('locked');
    store.close();
  });

  it('deletes custom rules', () => {
    const store = new LocalRuleStore(tmpDir);
    const id = store.addRule({
      language: 'go', name: 'temp-rule',
      query_scm: '(identifier) @v', message: 'test',
    });

    store.deleteRule(id);
    const rules = store.listRules();
    expect(rules.find(r => r.id === id)).toBeUndefined();
    store.close();
  });

  describe('proposals', () => {
    it('creates a pending proposal', () => {
      const store = new LocalRuleStore(tmpDir);
      const id = store.createProposal({
        action: 'create', reason: 'Need new rule',
        payload: { language: 'go', name: 'no-panic', query_scm: 'test', message: 'msg' },
      });

      const proposals = store.listPendingProposals();
      expect(proposals).toHaveLength(1);
      expect(proposals[0].id).toBe(id);
      expect(proposals[0].status).toBe('pending');
      store.close();
    });

    it('approves a proposal and materializes rule', () => {
      const store = new LocalRuleStore(tmpDir);
      const id = store.createProposal({
        action: 'create', reason: 'test',
        payload: {
          language: 'go', name: 'test-rule',
          query_scm: '(identifier) @v', message: 'test msg',
          scope: 'workspace', severity: 'warning',
        },
      });

      store.approveProposal(id);

      // Proposal no longer pending
      expect(store.listPendingProposals()).toHaveLength(0);

      // Rule was created
      const rules = store.listRules();
      const created = rules.find(r => r.name === 'test-rule');
      expect(created).toBeDefined();
      expect(created?.enabled).toBe(1);
      store.close();
    });

    it('denies a proposal', () => {
      const store = new LocalRuleStore(tmpDir);
      const id = store.createProposal({ action: 'disable', reason: 'not needed' });

      store.denyProposal(id);
      expect(store.listPendingProposals()).toHaveLength(0);
      store.close();
    });

    it('enforces max pending proposals', () => {
      const store = new LocalRuleStore(tmpDir);
      for (let i = 0; i < 10; i++) {
        store.createProposal({ action: 'create', reason: `reason ${i}` });
      }

      expect(() => store.createProposal({ action: 'create', reason: 'one too many' }))
        .toThrow('Maximum pending proposals');
      store.close();
    });
  });

  it('creates analyzers.json', () => {
    const store = new LocalRuleStore(tmpDir);
    const analyzerFile = path.join(tmpDir, 'analyzers.json');
    expect(fs.existsSync(analyzerFile)).toBe(true);
    const config = JSON.parse(fs.readFileSync(analyzerFile, 'utf8'));
    expect(config.aesthetics_max_depth).toBeDefined();
    expect(config.aesthetics_max_depth.enabled).toBe(true);
    store.close();
  });
});
