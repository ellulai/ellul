// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalSecretStore } from '../local/secrets/index';

const TEST_KEY = crypto.randomBytes(32);
let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ellul-secrets-test-'));
  dbPath = path.join(tmpDir, 'secrets.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LocalSecretStore', () => {
  it('encrypts and decrypts a secret correctly', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    store.set('DATABASE_URL', 'postgres://user:pass@localhost/db');
    const value = store.get('DATABASE_URL');
    expect(value).toBe('postgres://user:pass@localhost/db');
    store.close();
  });

  it('stores values encrypted on disk (not plaintext)', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    store.set('API_KEY', 'sk-test-abc123xyz');
    store.close();

    // Read raw database file
    const rawContent = fs.readFileSync(dbPath);
    expect(rawContent.includes('sk-test-abc123xyz')).toBe(false);
  });

  it('cannot decrypt with wrong key', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    store.set('SECRET', 'sensitive-value');
    store.close();

    const wrongKey = crypto.randomBytes(32);
    const store2 = new LocalSecretStore(dbPath, wrongKey);
    const value = store2.get('SECRET');
    expect(value).toBeNull(); // Decryption fails
    store2.close();
  });

  it('lists secret names without values', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    store.set('A', 'value-a');
    store.set('B', 'value-b');
    store.set('C', 'value-c');

    const names = store.list();
    expect(names).toEqual(['A', 'B', 'C']);
    store.close();
  });

  it('deletes a secret', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    store.set('TO_DELETE', 'temp');
    expect(store.get('TO_DELETE')).toBe('temp');

    store.delete('TO_DELETE');
    expect(store.get('TO_DELETE')).toBeNull();
    store.close();
  });

  it('upserts on duplicate name', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    store.set('KEY', 'original');
    store.set('KEY', 'updated');
    expect(store.get('KEY')).toBe('updated');
    expect(store.count()).toBe(1);
    store.close();
  });

  it('imports .env content', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    const envContent = [
      '# Comment',
      'DB_HOST=localhost',
      'DB_PORT=5432',
      'DB_PASSWORD="s3cret"',
      "API_KEY='key123'",
      '',
      'EMPTY=',
    ].join('\n');

    const count = store.importEnv(envContent);
    expect(count).toBe(4); // EMPTY= is skipped (empty value)

    expect(store.get('DB_HOST')).toBe('localhost');
    expect(store.get('DB_PORT')).toBe('5432');
    expect(store.get('DB_PASSWORD')).toBe('s3cret');   // quotes stripped
    expect(store.get('API_KEY')).toBe('key123');        // quotes stripped
    store.close();
  });

  it('getAllForRedaction returns name+value entries', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    store.set('A', 'value-a');
    store.set('B', 'value-b');

    const entries = store.getAllForRedaction();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: 'A', value: 'value-a' });
    expect(entries[1]).toEqual({ name: 'B', value: 'value-b' });
    store.close();
  });

  it('getAllForExecEnv returns key-value map', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    store.set('X', 'y');
    store.set('FOO', 'bar');

    const env = store.getAllForExecEnv();
    expect(env).toEqual({ FOO: 'bar', X: 'y' });
    store.close();
  });

  it('handles unicode values', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    store.set('EMOJI', '🔑🔒');
    expect(store.get('EMOJI')).toBe('🔑🔒');
    store.close();
  });

  it('handles large values', () => {
    const store = new LocalSecretStore(dbPath, TEST_KEY);
    const largeValue = 'x'.repeat(100_000);
    store.set('LARGE', largeValue);
    expect(store.get('LARGE')).toBe(largeValue);
    store.close();
  });

  it('rejects 16-byte key (must be 32)', () => {
    expect(() => new LocalSecretStore(dbPath, crypto.randomBytes(16)))
      .toThrow('32 bytes');
  });
});
