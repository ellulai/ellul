// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * In-memory fakes for the application-layer ports.
 *
 * Used by application-level tests to verify command behavior without
 * touching the filesystem, network, or real time. Each fake exposes
 * its internal state for assertion.
 */

import type {
  AuditLog,
  Clock,
  CredentialCipher,
  IssuanceRecord,
  IssuanceStore,
  RandomBytes,
  StoreRepository,
} from "../application/ports";
import type { WrappedCredential } from "../domain/credential";
import { emptyStore, type ClaudeOatStoreV1 } from "../domain/store";
import type {
  AuditEntryDraft,
  ClaudeOatAuditEntry,
} from "../domain/audit";
import { AesGcmCipher } from "../infrastructure/aes-gcm-cipher";

export class InMemoryStore implements StoreRepository {
  private state: ClaudeOatStoreV1 = emptyStore();
  load(): ClaudeOatStoreV1 {
    return this.state;
  }
  save(store: ClaudeOatStoreV1): void {
    this.state = store;
  }
  /** @internal — for tests only */
  raw(): ClaudeOatStoreV1 {
    return this.state;
  }
}

export class InMemoryAuditLog implements AuditLog {
  readonly entries: ClaudeOatAuditEntry[] = [];
  private seq = 0;
  resume(): { lastSeq: number; lastHash: string } {
    return { lastSeq: 0, lastHash: "0".repeat(64) };
  }
  append(draft: AuditEntryDraft): ClaudeOatAuditEntry {
    const seq = ++this.seq;
    const entry: ClaudeOatAuditEntry = {
      seq,
      ts: new Date().toISOString(),
      type: draft.type,
      actor: draft.actor,
      details: draft.details,
      prevHash: "x",
      hash: `h${seq}`,
    };
    this.entries.push(entry);
    return entry;
  }
  /** Helpers for assertions */
  byType(type: string): ClaudeOatAuditEntry[] {
    return this.entries.filter((e) => e.type === type);
  }
  types(): string[] {
    return this.entries.map((e) => e.type);
  }
}

/**
 * In-process AES-GCM cipher with a random per-test key. Simulates the
 * production cipher without touching disk for the wrap secret.
 */
export class TestCipher implements CredentialCipher {
  private readonly delegate: AesGcmCipher;
  constructor() {
    // We need a wrap-secret file to exist; use a temp path.
    const os = require("os") as typeof import("os");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ellul-claude-oat-cipher-"));
    this.delegate = new AesGcmCipher({
      wrapSecretPath: path.join(dir, ".wrap"),
      serverIdPath: path.join(dir, ".server-id"),
      dataDir: dir,
    });
  }
  wrap(plaintext: string, createdAt: string): WrappedCredential {
    return this.delegate.wrap(plaintext, createdAt);
  }
  unwrap(cred: WrappedCredential): string {
    return this.delegate.unwrap(cred);
  }
}

export class InMemoryIssuance implements IssuanceStore {
  private readonly map = new Map<string, IssuanceRecord>();
  put(record: IssuanceRecord): void {
    this.map.set(record.token, record);
  }
  get(token: string): IssuanceRecord | null {
    return this.map.get(token) ?? null;
  }
  consume(token: string): IssuanceRecord | null {
    const record = this.map.get(token);
    if (!record) return null;
    this.map.delete(token);
    return record;
  }
  sweepExpired(now: number): void {
    for (const [token, record] of this.map) {
      if (now > record.expiresAt) this.map.delete(token);
    }
  }
  size(): number {
    return this.map.size;
  }
}

export class FixedClock implements Clock {
  current = 0;
  now(): number {
    return this.current;
  }
  iso(): string {
    return new Date(this.current).toISOString();
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export class CountingRandom implements RandomBytes {
  counter = 0;
  hex(byteCount: number): string {
    const v = (++this.counter).toString(16).padStart(byteCount * 2, "0");
    return v;
  }
}
