// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tests for agent-bridge WS PoP challenge verification RPC.
 *
 * The failure-mode classification is security-critical: signature_invalid
 * is an attack signal that MUST close the WS, whereas session_not_found
 * is a benign lifecycle race (rotated cookie / GC'd session) that MUST
 * NOT close the WS — otherwise every rotation kicks the user out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyPopChallenge } from './auth';

// Minimal fetch mock so we don't need a real shield on the socket.
const originalFetch = globalThis.fetch;

describe('verifyPopChallenge', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns valid=true when shield accepts', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ valid: true }),
    } as Response);
    const result = await verifyPopChallenge('session-xyz', 'challenge-abc', 'sig-base64');
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('propagates signature_invalid reason (hostile — caller MUST close WS)', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ valid: false, reason: 'signature_invalid' }),
    } as Response);
    const result = await verifyPopChallenge('session-xyz', 'challenge-abc', 'forged-sig');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_invalid');
  });

  it('propagates session_not_found reason (benign — caller should NOT close WS)', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ valid: false, reason: 'session_not_found' }),
    } as Response);
    const result = await verifyPopChallenge('rotated-or-gc-session', 'challenge-abc', 'valid-sig');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('session_not_found');
  });

  it('propagates no_pop_key reason (bind race — benign)', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ valid: false, reason: 'no_pop_key' }),
    } as Response);
    const result = await verifyPopChallenge('session-xyz', 'challenge-abc', 'sig');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_pop_key');
  });

  it('returns rpc_error when shield is unreachable (benign — shield restart, do not flap)', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    );
    const result = await verifyPopChallenge('session-xyz', 'challenge-abc', 'sig');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('rpc_error');
  });

  it('returns unknown when shield response has no reason field', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ valid: false }),
    } as Response);
    const result = await verifyPopChallenge('s', 'c', 'x');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unknown');
  });
});
