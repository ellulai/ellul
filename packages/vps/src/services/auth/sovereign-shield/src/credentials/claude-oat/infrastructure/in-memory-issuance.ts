// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * In-memory IssuanceStore.
 *
 * Issuance tokens are short-lived (60s TTL, single-use) and intentionally
 * NOT persisted across shield restarts. A restart invalidates all
 * outstanding issuance tokens — bridge will simply mint fresh ones for
 * the next spawn, which is far cheaper than the alternative of stale
 * tokens surviving a security-relevant restart.
 */

import type {
  IssuanceRecord,
  IssuanceStore,
} from "../application/ports";

export class InMemoryIssuanceStore implements IssuanceStore {
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

  /** @internal — for tests + diagnostics */
  size(): number {
    return this.map.size;
  }
}
