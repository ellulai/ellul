// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Audit Logger — Tamper-evident security event log
 *
 * Separate from the general daemon log. Records only security-relevant events:
 *   - gate approvals/denials
 *   - secret access (reveal, import, set, delete)
 *   - guardrail rule changes (create, toggle, delete, proposal approve/deny)
 *   - integrity restoration events
 *   - authentication events (peer credential verification failures)
 *   - exec pipeline decisions (blocked, halted, approved)
 *
 * Tamper evidence: each entry includes a chained hash.
 *   hash_n = SHA-256(hash_{n-1} + JSON(entry_n))
 *
 * This does NOT prevent tampering by a same-user process (they can rewrite the
 * file), but it detects tampering after the fact — any modification to a
 * historical entry breaks the hash chain.
 *
 * File: ~/.ellul/logs/audit.log (append-only, mode 0600)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface AuditEntry {
  seq: number;
  timestamp: string;
  event: string;
  actor: 'operator' | 'agent' | 'daemon' | 'system';
  project?: string;
  details?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export class AuditLogger {
  private fd: number;
  private seq: number = 0;
  private prevHash: string = GENESIS_HASH;
  private filePath: string;

  constructor(logDir: string) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(logDir, 'audit.log');

    // Load existing chain state
    this.loadChainState();

    // Open for append
    this.fd = fs.openSync(this.filePath, 'a', 0o600);
  }

  /** Load the last entry's seq and hash to continue the chain. */
  private loadChainState(): void {
    try {
      const content = fs.readFileSync(this.filePath, 'utf8').trim();
      if (!content) return;

      const lines = content.split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return;

      const entry = JSON.parse(lastLine) as AuditEntry;
      this.seq = entry.seq;
      this.prevHash = entry.hash;
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  /**
   * Record a security event.
   * The entry is hash-chained to the previous entry.
   */
  record(
    event: string,
    actor: AuditEntry['actor'],
    options?: {
      project?: string;
      details?: Record<string, unknown>;
    },
  ): void {
    this.seq++;

    const entry: Omit<AuditEntry, 'hash'> = {
      seq: this.seq,
      timestamp: new Date().toISOString(),
      event,
      actor,
      project: options?.project,
      details: options?.details,
      prevHash: this.prevHash,
    };

    // Compute hash: SHA-256(prevHash + JSON(entry without hash field))
    const entryJson = JSON.stringify(entry);
    const hash = crypto.createHash('sha256')
      .update(this.prevHash)
      .update(entryJson)
      .digest('hex');

    const fullEntry: AuditEntry = { ...entry, hash };
    this.prevHash = hash;

    const line = JSON.stringify(fullEntry) + '\n';
    try {
      fs.writeSync(this.fd, line);
    } catch {
      // Audit write failure — non-fatal but logged to stderr
      process.stderr.write(`[AUDIT] Write failed for event: ${event}\n`);
    }
  }

  /**
   * Verify the integrity of the audit log.
   * Returns { valid, entries, brokenAt } where brokenAt is the first
   * entry where the hash chain is broken (null if all valid).
   */
  static verify(logPath: string): { valid: boolean; entries: number; brokenAt: number | null } {
    try {
      const content = fs.readFileSync(logPath, 'utf8').trim();
      if (!content) return { valid: true, entries: 0, brokenAt: null };

      const lines = content.split('\n');
      let prevHash = GENESIS_HASH;

      for (let i = 0; i < lines.length; i++) {
        const entry = JSON.parse(lines[i]) as AuditEntry;

        if (entry.prevHash !== prevHash) {
          return { valid: false, entries: lines.length, brokenAt: i + 1 };
        }

        // Recompute hash
        const { hash, ...rest } = entry;
        const entryJson = JSON.stringify(rest);
        const expectedHash = crypto.createHash('sha256')
          .update(prevHash)
          .update(entryJson)
          .digest('hex');

        if (hash !== expectedHash) {
          return { valid: false, entries: lines.length, brokenAt: i + 1 };
        }

        prevHash = hash;
      }

      return { valid: true, entries: lines.length, brokenAt: null };
    } catch {
      return { valid: false, entries: 0, brokenAt: 0 };
    }
  }

  close(): void {
    try { fs.closeSync(this.fd); } catch {}
  }
}
