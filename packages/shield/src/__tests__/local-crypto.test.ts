// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  deriveKeys,
  signLocalSts,
  verifyLocalSts,
  computeWorkspaceFingerprint,
  gateApprovePayload,
  gateDenyPayload,
  ruleApprovePayload,
  secretRevealPayload,
  policySetPayload,
} from '../local/crypto/index';

const TEST_MASTER = crypto.randomBytes(32);

describe('deriveKeys', () => {
  it('derives three 32-byte keys from master secret', () => {
    const keys = deriveKeys(TEST_MASTER);
    expect(keys.stsSigningKey.length).toBe(32);
    expect(keys.receiptKey.length).toBe(32);
    expect(keys.secretsEncKey.length).toBe(32);
  });

  it('derives different keys for each domain', () => {
    const keys = deriveKeys(TEST_MASTER);
    expect(keys.stsSigningKey.equals(keys.receiptKey)).toBe(false);
    expect(keys.stsSigningKey.equals(keys.secretsEncKey)).toBe(false);
    expect(keys.receiptKey.equals(keys.secretsEncKey)).toBe(false);
  });

  it('is deterministic for the same master secret', () => {
    const a = deriveKeys(TEST_MASTER);
    const b = deriveKeys(TEST_MASTER);
    expect(a.stsSigningKey.equals(b.stsSigningKey)).toBe(true);
    expect(a.receiptKey.equals(b.receiptKey)).toBe(true);
    expect(a.secretsEncKey.equals(b.secretsEncKey)).toBe(true);
  });

  it('produces different keys for different master secrets', () => {
    const other = crypto.randomBytes(32);
    const a = deriveKeys(TEST_MASTER);
    const b = deriveKeys(other);
    expect(a.stsSigningKey.equals(b.stsSigningKey)).toBe(false);
  });
});

describe('workspace fingerprint', () => {
  it('is deterministic for same slug + path', () => {
    const a = computeWorkspaceFingerprint('my-project', '/Users/joe/code');
    const b = computeWorkspaceFingerprint('my-project', '/Users/joe/code');
    expect(a).toBe(b);
  });

  it('differs for different slugs', () => {
    const a = computeWorkspaceFingerprint('project-a', '/same/path');
    const b = computeWorkspaceFingerprint('project-b', '/same/path');
    expect(a).not.toBe(b);
  });

  it('differs for different paths', () => {
    const a = computeWorkspaceFingerprint('same-slug', '/path/a');
    const b = computeWorkspaceFingerprint('same-slug', '/path/b');
    expect(a).not.toBe(b);
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const fpr = computeWorkspaceFingerprint('test', '/test');
    expect(fpr).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('local STS tokens', () => {
  const keys = deriveKeys(TEST_MASTER);
  const slug = 'local-test-a1b2';
  const dir = '/Users/joe/test-project';

  it('signs and verifies a valid token', () => {
    const token = signLocalSts(slug, dir, keys.stsSigningKey);
    const result = verifyLocalSts(token, keys.stsSigningKey);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.sub).toBe(slug);
      expect(result.payload.dir).toBe(dir);
      expect(result.payload.typ).toBe('STS');
      expect(result.payload.fpr).toBe(computeWorkspaceFingerprint(slug, dir));
    }
  });

  it('rejects a token signed with a different key', () => {
    const token = signLocalSts(slug, dir, keys.stsSigningKey);
    const otherKey = crypto.randomBytes(32);
    const result = verifyLocalSts(token, otherKey);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signature_invalid');
  });

  it('rejects an expired token', () => {
    const token = signLocalSts(slug, dir, keys.stsSigningKey, -1); // TTL = -1s → already expired
    const result = verifyLocalSts(token, keys.stsSigningKey);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('expired');
  });

  it('rejects a tampered token (modified payload)', () => {
    const token = signLocalSts(slug, dir, keys.stsSigningKey);
    const parts = token.split('.');
    // Modify the payload
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.sub = 'different-project';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tampered = parts.join('.');

    const result = verifyLocalSts(tampered, keys.stsSigningKey);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signature_invalid');
  });

  it('verifies fingerprint binding', () => {
    const token = signLocalSts(slug, dir, keys.stsSigningKey);
    const correctFpr = computeWorkspaceFingerprint(slug, dir);
    const wrongFpr = computeWorkspaceFingerprint(slug, '/different/path');

    const goodResult = verifyLocalSts(token, keys.stsSigningKey, correctFpr);
    expect(goodResult.valid).toBe(true);

    const badResult = verifyLocalSts(token, keys.stsSigningKey, wrongFpr);
    expect(badResult.valid).toBe(false);
    if (!badResult.valid) expect(badResult.reason).toBe('fingerprint_mismatch');
  });

  it('rejects malformed tokens', () => {
    expect(verifyLocalSts('', keys.stsSigningKey).valid).toBe(false);
    expect(verifyLocalSts('a.b', keys.stsSigningKey).valid).toBe(false);
    expect(verifyLocalSts('a.b.c.d', keys.stsSigningKey).valid).toBe(false);
    expect(verifyLocalSts('not-a-jwt', keys.stsSigningKey).valid).toBe(false);
  });
});

describe('domain-separated signing payloads', () => {
  it('gate-approve includes all fields', () => {
    const payload = gateApprovePayload('test', 'my-project', 300);
    expect(payload).toBe('gate-approve|test|my-project|300');
  });

  it('gate-deny has different domain from gate-approve', () => {
    const approve = gateApprovePayload('test', 'my-project', 300);
    const deny = gateDenyPayload('test', 'my-project');
    expect(approve.startsWith('gate-approve|')).toBe(true);
    expect(deny.startsWith('gate-deny|')).toBe(true);
    expect(approve).not.toBe(deny);
  });

  it('rule-approve has different domain from gate-approve', () => {
    const gatePayload = gateApprovePayload('test', 'my-project', 300);
    const rulePayload = ruleApprovePayload('prop_abc123');
    expect(gatePayload.split('|')[0]).not.toBe(rulePayload.split('|')[0]);
  });

  it('secret-reveal has its own domain', () => {
    const payload = secretRevealPayload('DB_URL', 'my-project');
    expect(payload).toBe('secret-reveal|DB_URL|my-project');
    expect(payload.startsWith('secret-reveal|')).toBe(true);
  });

  it('policy-set includes gate, policy, and project', () => {
    const payload = policySetPayload('exec', 'allow_always', 'my-project');
    expect(payload).toBe('policy-set|exec|allow_always|my-project');
  });

  it('all domain prefixes are unique', () => {
    const prefixes = [
      gateApprovePayload('x', 'y', 1).split('|')[0],
      gateDenyPayload('x', 'y').split('|')[0],
      ruleApprovePayload('x').split('|')[0],
      secretRevealPayload('x', 'y').split('|')[0],
      policySetPayload('x', 'y', 'z').split('|')[0],
    ];
    const unique = new Set(prefixes);
    expect(unique.size).toBe(prefixes.length);
  });
});
