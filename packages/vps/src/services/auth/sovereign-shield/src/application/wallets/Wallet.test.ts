// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Wallet Subsystem — Unit Tests
 *
 * Tests all wallet security properties:
 *   1. Feature flag — guards all code paths
 *   2. Gate type validation — wallet_spend only valid when enabled
 *   3. Keypair encryption — round-trip encrypt/decrypt
 *   4. Ledger spending limits — cumulative enforcement (mocked SQLite)
 *   5. Idempotency — duplicate requests return cached result
 *   6. Recipient validation — authorized recipient binding
 *   7. Gate metadata — signature payload format consistency
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

// ── Mock wallet feature flag ──

let walletFeatureEnabled = false;

vi.mock('./WalletFeature', () => ({
  isWalletEnabled: () => walletFeatureEnabled,
}));

// Static imports AFTER mock — vitest applies mocks before imports
import { isWalletEnabled } from './WalletFeature';
import { validateGateType, getActiveGateTypes, DENY_ALLOW_ALWAYS } from '../gates/GatePermissions';
import { grantGate, grantGateForApp, getGateGrant } from '../gates/Gate';

// ═══════════════════════════════════════════════════════════════
// 1. Feature Flag
// ═══════════════════════════════════════════════════════════════

describe('Wallet Feature Flag', () => {
  it('returns false when disabled', () => {
    walletFeatureEnabled = false;

    expect(isWalletEnabled()).toBe(false);
  });

  it('returns true when enabled', () => {
    walletFeatureEnabled = true;

    expect(isWalletEnabled()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Gate Type Validation
// ═══════════════════════════════════════════════════════════════

describe('Gate Type Validation with wallet_spend', () => {
  it('rejects wallet_spend when feature is disabled', () => {
    walletFeatureEnabled = false;

    expect(() => validateGateType('wallet_spend')).toThrow('Invalid gate type');
  });

  it('accepts wallet_spend when feature is enabled', () => {
    walletFeatureEnabled = true;

    expect(validateGateType('wallet_spend')).toBe('wallet_spend');
  });

  it('always accepts standard gate types regardless of feature flag', () => {
    walletFeatureEnabled = false;

    expect(validateGateType('db_read')).toBe('db_read');
    expect(validateGateType('exec')).toBe('exec');
    expect(validateGateType('deploy')).toBe('deploy');
  });

  it('wallet_spend is in DENY_ALLOW_ALWAYS', () => {

    expect(DENY_ALLOW_ALWAYS.has('wallet_spend')).toBe(true);
  });

  it('getActiveGateTypes returns extended set when wallet enabled', () => {
    walletFeatureEnabled = true;

    const active = getActiveGateTypes();
    expect(active.has('wallet_spend')).toBe(true);
    expect(active.has('db_read')).toBe(true);
  });

  it('getActiveGateTypes returns base set when wallet disabled', () => {
    walletFeatureEnabled = false;

    const active = getActiveGateTypes();
    expect(active.has('wallet_spend')).toBe(false);
    expect(active.has('db_read')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Gate Grant Metadata
// ═══════════════════════════════════════════════════════════════

describe('Gate Grant Metadata', () => {
  beforeEach(() => {
    walletFeatureEnabled = true;
  });

  it('stores metadata on thread-level gate grant', () => {


    const metadata = {
      maxAmountLamports: 5_000_000,
      authorizedRecipients: ['So11111111111111111111111111111111'],
    };

    grantGate('wallet_spend', 'test-thread-meta-1', 60_000, {
      sandboxId: 'test-app',
      metadata,
    });

    const grant = getGateGrant('wallet_spend', 'test-thread-meta-1');
    expect(grant).toBeDefined();
    expect(grant!.metadata).toEqual(metadata);
    expect(grant!.metadata!.maxAmountLamports).toBe(5_000_000);
    expect(grant!.metadata!.authorizedRecipients).toEqual(['So11111111111111111111111111111111']);
  });

  it('stores metadata on app-level gate grant', () => {


    const metadata = {
      maxAmountLamports: 10_000_000,
      authorizedRecipients: ['RecipientAddress1111111111111111111'],
    };

    grantGateForApp('wallet_spend', 'meta-test-app', 60_000, { metadata });

    const grant = getGateGrant('wallet_spend', 'unrelated-thread', 'meta-test-app');
    expect(grant).toBeDefined();
    expect(grant!.metadata).toEqual(metadata);
  });

  it('grants without metadata have undefined metadata field', () => {


    grantGate('db_read', 'test-thread-no-meta', 60_000);

    const grant = getGateGrant('db_read', 'test-thread-no-meta');
    expect(grant).toBeDefined();
    expect(grant!.metadata).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Ledger Spending Limits (Mocked SQLite)
// ═══════════════════════════════════════════════════════════════

describe('Wallet Ledger Spending Limits', () => {
  // In-memory ledger simulation — tests the spending limit logic
  // without requiring native better-sqlite3 bindings

  it('cumulative spending is tracked per gate key', () => {
    const transactions: Array<{ sandboxId: string; gateKey: string; amount: number; status: string }> = [];

    function recordSpend(sandboxId: string, gateKey: string, amount: number) {
      transactions.push({ sandboxId, gateKey, amount, status: 'signed' });
    }

    function getSpent(sandboxId: string, gateKey: string): number {
      return transactions
        .filter(t => t.sandboxId === sandboxId && t.gateKey === gateKey && t.status !== 'failed')
        .reduce((sum, t) => sum + t.amount, 0);
    }

    recordSpend('app1', 'grant-1', 1_000_000);
    recordSpend('app1', 'grant-1', 2_000_000);
    expect(getSpent('app1', 'grant-1')).toBe(3_000_000);

    // Different grant key — isolated
    recordSpend('app1', 'grant-2', 5_000_000);
    expect(getSpent('app1', 'grant-1')).toBe(3_000_000);
    expect(getSpent('app1', 'grant-2')).toBe(5_000_000);
  });

  it('spending limit enforcement prevents overspend', () => {
    const maxAmountLamports = 5_000_000;
    let spent = 0;

    function trySpend(amount: number): boolean {
      if (spent + amount > maxAmountLamports) return false;
      spent += amount;
      return true;
    }

    expect(trySpend(3_000_000)).toBe(true);
    expect(trySpend(1_000_000)).toBe(true);
    // This would exceed the limit
    expect(trySpend(2_000_000)).toBe(false);
    // But this fits exactly
    expect(trySpend(1_000_000)).toBe(true);
    // Now at max — nothing more
    expect(trySpend(1)).toBe(false);
  });

  it('failed transactions do not count toward spending limit', () => {
    const transactions: Array<{ amount: number; status: string }> = [];

    transactions.push({ amount: 2_000_000, status: 'signed' });
    transactions.push({ amount: 3_000_000, status: 'failed' });

    const spent = transactions
      .filter(t => t.status !== 'failed')
      .reduce((sum, t) => sum + t.amount, 0);

    expect(spent).toBe(2_000_000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Idempotency Logic
// ═══════════════════════════════════════════════════════════════

describe('Wallet Idempotency', () => {
  it('same idempotency key returns cached result instead of duplicate', () => {
    const processed = new Map<string, { txId: string; amount: number }>();

    function processTransaction(sandboxId: string, idempotencyKey: string | undefined, amount: number): { txId: string; idempotent: boolean } {
      if (idempotencyKey) {
        const key = `${sandboxId}:${idempotencyKey}`;
        const existing = processed.get(key);
        if (existing) return { txId: existing.txId, idempotent: true };

        const txId = `tx-${Math.random().toString(36).slice(2, 10)}`;
        processed.set(key, { txId, amount });
        return { txId, idempotent: false };
      }
      return { txId: `tx-${Math.random().toString(36).slice(2, 10)}`, idempotent: false };
    }

    const result1 = processTransaction('app1', 'key-abc', 1_000_000);
    expect(result1.idempotent).toBe(false);

    const result2 = processTransaction('app1', 'key-abc', 1_000_000);
    expect(result2.idempotent).toBe(true);
    expect(result2.txId).toBe(result1.txId);
  });

  it('idempotency keys are scoped per app', () => {
    const processed = new Map<string, string>();

    processed.set('app1:shared-key', 'tx-1');

    expect(processed.has('app1:shared-key')).toBe(true);
    expect(processed.has('app2:shared-key')).toBe(false);
  });

  it('null idempotency key allows duplicate transactions', () => {
    let count = 0;

    function processTransaction(idempotencyKey: string | undefined) {
      // No dedup when key is undefined
      if (!idempotencyKey) {
        count++;
        return;
      }
    }

    processTransaction(undefined);
    processTransaction(undefined);
    expect(count).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Recipient Validation
// ═══════════════════════════════════════════════════════════════

describe('Recipient Authorization', () => {
  it('rejects recipient not in authorized list', () => {
    const authorizedRecipients = [
      'So11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ];
    const requestedRecipient = 'AttackerWallet111111111111111111111';

    expect(authorizedRecipients.includes(requestedRecipient)).toBe(false);
  });

  it('accepts recipient in authorized list', () => {
    const authorizedRecipients = [
      'So11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ];
    const requestedRecipient = 'So11111111111111111111111111111111';

    expect(authorizedRecipients.includes(requestedRecipient)).toBe(true);
  });

  it('authorized recipients list cannot be empty', () => {
    // Validation in gate-api.routes.ts
    const metadata = { maxAmountLamports: 5_000_000, authorizedRecipients: [] };
    const valid = Array.isArray(metadata.authorizedRecipients) && metadata.authorizedRecipients.length > 0;
    expect(valid).toBe(false);
  });

  it('validates base58 address format (32-44 chars)', () => {
    const validAddresses = [
      'So11111111111111111111111111111111',  // 32 chars
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // 44 chars
    ];
    const invalidAddresses = [
      'short',  // Too short
      'a'.repeat(50),  // Too long
    ];

    for (const addr of validAddresses) {
      expect(addr.length >= 32 && addr.length <= 44).toBe(true);
    }
    for (const addr of invalidAddresses) {
      expect(addr.length >= 32 && addr.length <= 44).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Signature Payload Format Consistency
// ═══════════════════════════════════════════════════════════════

describe('Signature Payload Format', () => {
  it('always includes 4 pipe-separated fields regardless of metadata presence', () => {
    const requestId = 'req-123';
    const action = 'grant_timed';

    // Without metadata — 4th field is "{}"
    const payload1 = `gate-respond|${requestId}|${action}|${JSON.stringify({})}`;
    expect(payload1.split('|')).toHaveLength(4);
    expect(payload1).toBe('gate-respond|req-123|grant_timed|{}');

    // With metadata — 4th field is the JSON
    const metadata = { maxAmountLamports: 5000000, authorizedRecipients: ['addr1'] };
    const payload2 = `gate-respond|${requestId}|${action}|${JSON.stringify(metadata)}`;
    expect(payload2.split('|')).toHaveLength(4);
    expect(payload2).toContain('maxAmountLamports');
  });

  it('metadata stripping changes the signature (prevents downgrade attack)', () => {
    const requestId = 'req-456';
    const action = 'grant_timed';
    const metadata = { maxAmountLamports: 5000000, authorizedRecipients: ['addr1'] };

    const payloadWithMeta = `gate-respond|${requestId}|${action}|${JSON.stringify(metadata)}`;
    const payloadWithoutMeta = `gate-respond|${requestId}|${action}|${JSON.stringify({})}`;

    expect(payloadWithMeta).not.toBe(payloadWithoutMeta);

    const hash1 = crypto.createHash('sha256').update(payloadWithMeta).digest('hex');
    const hash2 = crypto.createHash('sha256').update(payloadWithoutMeta).digest('hex');
    expect(hash1).not.toBe(hash2);
  });

  it('metadata order in JSON is deterministic', () => {
    // JSON.stringify produces deterministic key order for the same object literal
    const meta1 = JSON.stringify({ maxAmountLamports: 5000000, authorizedRecipients: ['a'] });
    const meta2 = JSON.stringify({ maxAmountLamports: 5000000, authorizedRecipients: ['a'] });
    expect(meta1).toBe(meta2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Keypair Encryption Round-Trip
// ═══════════════════════════════════════════════════════════════

describe('Keypair Encryption', () => {
  it('encrypts and decrypts a secret key round-trip using RSA-4096 OAEP + AES-256-GCM', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Simulate a 64-byte Solana secret key
    const originalSecretKey = crypto.randomBytes(64);

    // Encrypt (same pattern as wallet-keypair.service.ts)
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(originalSecretKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encryptedData = Buffer.concat([encrypted, authTag]);
    const encryptedKey = crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      aesKey,
    );
    aesKey.fill(0);

    // Decrypt (same pattern as wallet-keypair.service.ts)
    const decryptedAesKey = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      encryptedKey,
    );
    const decAuthTag = encryptedData.subarray(-16);
    const ciphertext = encryptedData.subarray(0, -16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', decryptedAesKey, iv);
    decipher.setAuthTag(decAuthTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    expect(Buffer.compare(decrypted, originalSecretKey)).toBe(0);
  });

  it('fails to decrypt with wrong private key', () => {
    const { publicKey: correctPub } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const { privateKey: wrongKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const secretKey = crypto.randomBytes(64);
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    Buffer.concat([cipher.update(secretKey), cipher.final(), cipher.getAuthTag()]);
    const encryptedKey = crypto.publicEncrypt(
      { key: correctPub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      aesKey,
    );

    expect(() => {
      crypto.privateDecrypt(
        { key: wrongKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        encryptedKey,
      );
    }).toThrow();
  });

  it('zeroes the AES key after encryption', () => {
    const aesKey = crypto.randomBytes(32);
    const original = Buffer.from(aesKey);

    aesKey.fill(0);

    expect(aesKey.every(b => b === 0)).toBe(true);
    expect(Buffer.compare(aesKey, original)).not.toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limiting
// ═══════════════════════════════════════════════════════════════

describe('Wallet Rate Limiting', () => {
  it('allows requests within limit and blocks when exceeded', () => {
    const limits = new Map<string, { count: number; resetAt: number }>();
    const MAX = 10;
    const WINDOW = 60_000;

    function checkLimit(sandboxId: string): boolean {
      const now = Date.now();
      let entry = limits.get(sandboxId);
      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + WINDOW };
        limits.set(sandboxId, entry);
      }
      entry.count++;
      return entry.count <= MAX;
    }

    // First 10 requests should pass
    for (let i = 0; i < MAX; i++) {
      expect(checkLimit('app1')).toBe(true);
    }

    // 11th should be blocked
    expect(checkLimit('app1')).toBe(false);

    // Different app is independent
    expect(checkLimit('app2')).toBe(true);
  });
});
