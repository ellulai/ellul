// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// AES-256-GCM per-value (unique 12-byte IV + 16-byte tag). HKDF-derived key in daemon RAM only.
// SQLite 0600 + WAL. Values leave RAM only via: redaction DFA / guarded-exec env / operator-signed REPL reveal.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SecretEntry } from '@ellul.ai/shield-proxy';

// ── Constants ──

const IV_LENGTH = 12;   // AES-GCM standard
const TAG_LENGTH = 16;  // AES-GCM standard
const ALGORITHM = 'aes-256-gcm';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS secrets (
    name       TEXT PRIMARY KEY,
    value      BLOB NOT NULL,
    iv         BLOB NOT NULL,
    tag        BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// ── Encryption Helpers ──

function encrypt(key: Buffer, plaintext: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ct, iv, tag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}

// ── Public API ──

export class LocalSecretStore {
  private db: InstanceType<typeof Database>;
  private encKey: Buffer;

  constructor(dbPath: string, encKey: Buffer) {
    if (encKey.length !== 32) {
      throw new Error('Secret encryption key must be 32 bytes (AES-256)');
    }
    this.encKey = encKey;

    // Ensure parent directory exists
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    // Restrict DB file permissions
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch { /* non-fatal on first create */ }
  }

  /**
   * Store a secret (encrypt + upsert).
   * If the secret already exists, it is overwritten.
   */
  set(name: string, value: string): void {
    const { ciphertext, iv, tag } = encrypt(this.encKey, value);

    this.db.prepare(`
      INSERT INTO secrets (name, value, iv, tag, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        value = excluded.value,
        iv = excluded.iv,
        tag = excluded.tag,
        updated_at = datetime('now')
    `).run(name, ciphertext, iv, tag);
  }

  /**
   * Retrieve and decrypt a single secret.
   *
   * DAEMON-INTERNAL ONLY. This method is never exposed via HTTP.
   * Used by: REPL /secrets reveal (operator-signed), redaction loading, exec env injection.
   */
  get(name: string): string | null {
    const row = this.db.prepare(
      'SELECT value, iv, tag FROM secrets WHERE name = ?',
    ).get(name) as { value: Buffer; iv: Buffer; tag: Buffer } | undefined;

    if (!row) return null;

    try {
      return decrypt(this.encKey, row.value, row.iv, row.tag);
    } catch {
      // Decryption failed — corrupt data or wrong key
      return null;
    }
  }

  /**
   * List secret names (no values). Safe to return via HTTP.
   */
  list(): string[] {
    const rows = this.db.prepare('SELECT name FROM secrets ORDER BY name').all() as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  /** Delete a secret by name. */
  delete(name: string): boolean {
    const result = this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
    return result.changes > 0;
  }

  /**
   * Bulk import from .env content (KEY=VALUE lines).
   * Returns the number of secrets imported.
   */
  importEnv(content: string): number {
    let count = 0;
    const insertTx = this.db.transaction(() => {
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;

        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();

        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        if (key && value) {
          this.set(key, value);
          count++;
        }
      }
    });

    insertTx();
    return count;
  }

  /**
   * Get all secrets as {name, value} entries for the redaction engine.
   *
   * DAEMON-INTERNAL ONLY. Decrypted values exist in the returned array
   * and then in the Aho-Corasick DFA — never sent over IPC.
   */
  getAllForRedaction(): SecretEntry[] {
    const rows = this.db.prepare(
      'SELECT name, value, iv, tag FROM secrets ORDER BY name',
    ).all() as Array<{ name: string; value: Buffer; iv: Buffer; tag: Buffer }>;

    const entries: SecretEntry[] = [];
    for (const row of rows) {
      try {
        const plaintext = decrypt(this.encKey, row.value, row.iv, row.tag);
        entries.push({ name: row.name, value: plaintext });
      } catch {
        // Skip corrupted entries
      }
    }
    return entries;
  }

  /**
   * Get all secrets as a key-value map for child process env injection.
   *
   * DAEMON-INTERNAL ONLY. Used by the exec pipeline to inject secrets
   * as environment variables into the child process.
   */
  getAllForExecEnv(): Record<string, string> {
    const entries = this.getAllForRedaction();
    const env: Record<string, string> = {};
    for (const { name, value } of entries) {
      env[name] = value;
    }
    return env;
  }

  /** Number of stored secrets. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM secrets').get() as { count: number };
    return row.count;
  }

  /** Close the SQLite database. */
  close(): void {
    this.db.close();
  }
}
