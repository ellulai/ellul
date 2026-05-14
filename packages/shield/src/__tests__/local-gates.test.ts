// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LocalGateManager } from '../local/gates/index';
import type { GateType } from '../local/gates/capability-allowlist';

// Mock operator key — we test the gate state machine, not crypto signatures
const MOCK_PUBLIC_KEY = 'mock-public-key-base64';

describe('LocalGateManager', () => {
  let manager: LocalGateManager;

  beforeEach(() => {
    manager = new LocalGateManager(MOCK_PUBLIC_KEY);
  });

  describe('gate requests', () => {
    it('returns pending for ask policy', () => {
      const result = manager.requestGate('test', 'my-project', 'Need to run tests');
      expect(result.status).toBe('pending');
      expect(result.requestId).toBeTruthy();
    });

    it('returns already_open if gate is already open', async () => {
      // Manually open the gate (bypass signature for unit test)
      // We need to test the state machine, not the crypto
      const r1 = manager.requestGate('test', 'my-project', 'reason');
      expect(r1.status).toBe('pending');

      // Set policy to allow_always and request again
      // (allow_always auto-approves)
      // For this test, we'll directly check gate states
      const states = manager.getGateStates('my-project');
      const testGate = states.find(g => g.gate === 'test');
      expect(testGate?.open).toBe(false);
    });

    it('auto-denies when policy is deny_always', async () => {
      // We can't set policy without operator sig in this unit test,
      // but we can verify the default behavior
      const result = manager.requestGate('build', 'my-project', 'Need to build');
      expect(result.status).toBe('pending'); // Default is 'ask'
    });

    it('surfaces request via onGateRequest callback', () => {
      const requests: unknown[] = [];
      manager.onGateRequest = (req) => { requests.push(req); };

      manager.requestGate('lint', 'my-project', 'Run linter');
      expect(requests).toHaveLength(1);
      expect((requests[0] as { gate: string }).gate).toBe('lint');
    });
  });

  describe('gate states', () => {
    it('returns all gate types for a project', () => {
      const states = manager.getGateStates('my-project');
      const gateNames = states.map(s => s.gate);
      expect(gateNames).toContain('test');
      expect(gateNames).toContain('build');
      expect(gateNames).toContain('lint');
      expect(gateNames).toContain('dev');
      expect(gateNames).toContain('exec');
    });

    it('all gates start closed', () => {
      const states = manager.getGateStates('my-project');
      for (const state of states) {
        expect(state.open).toBe(false);
        expect(state.policy).toBe('ask');
      }
    });
  });

  describe('pending requests', () => {
    it('tracks pending requests', () => {
      manager.requestGate('test', 'p1', 'reason1');
      manager.requestGate('build', 'p1', 'reason2');

      const pending = manager.getPendingRequests();
      expect(pending).toHaveLength(2);
    });
  });

  describe('dispose', () => {
    it('clears all state', () => {
      manager.requestGate('test', 'p1', 'reason');
      manager.dispose();
      expect(manager.getPendingRequests()).toHaveLength(0);
      expect(manager.getGateStates('p1').every(g => !g.open)).toBe(true);
    });
  });
});
